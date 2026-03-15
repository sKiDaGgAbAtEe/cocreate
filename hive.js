/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  hive.js — HIVE module for the Orycl stack                              ║
 * ║                                                                          ║
 * ║  Usage in server.js:                                                     ║
 * ║    const hive = require('./hive');                                       ║
 * ║    hive.mount(app, io, { getDrive, getHiveFolderId });                   ║
 * ║                                                                          ║
 * ║  Adds:                                                                   ║
 * ║    GET  /hive                  → serves hive.html                        ║
 * ║    POST /api/hive/sara         → S.A.R.A. chat                           ║
 * ║    POST /api/hive/sara/action  → session actions                         ║
 * ║    GET  /api/hive/projects     → list projects                           ║
 * ║    POST /api/hive/projects     → create project                          ║
 * ║    POST /api/hive/upload       → file upload → Drive                     ║
 * ║    GET  /api/hive/docs/:cellId → list docs for cell                      ║
 * ║    DEL  /api/hive/docs/:c/:d   → delete doc                              ║
 * ║    POST /api/hive/cells/:c/project → assign cell to project              ║
 * ║    POST /api/hive/cells/:c/intent  → set cell intent                     ║
 * ║    POST /api/hive/daily/room   → Daily.co room                           ║
 * ║                                                                          ║
 * ║  Socket namespace: default (/) — events prefixed with hive:             ║
 * ║                                                                          ║
 * ║  New env vars needed (everything else already in Orycl):                 ║
 * ║    HIVE_FOLDER_ID   — Drive folder ID for HIVE data (optional)           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const fetch  = require('node-fetch');
const Busboy = require('busboy');

// ── Models ────────────────────────────────────────────────────────────────────
const MODEL_SARA   = 'claude-sonnet-4-6';
const MODEL_TRIUNE = 'claude-haiku-4-5-20251001';
const DAILY_API_KEY = process.env.DAILY_API_KEY || '';

// ── In-memory stores ──────────────────────────────────────────────────────────
const cells    = {};   // cellId   → cell
const projects = {};   // projectId → project
const members  = {};   // socketId  → { name, cellId, fieldContrib }

// ── Persistence paths ─────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, 'data', 'hive');
const CELLS_PATH    = path.join(DATA_DIR, 'cells.json');
const PROJECTS_PATH = path.join(DATA_DIR, 'projects.json');

// ══════════════════════════════════════════════════════════════════════════════
// DRIVE HELPERS
// These delegate to the getDrive() function passed in from server.js,
// so HIVE shares the same authenticated Drive connection as Orycl.
// ══════════════════════════════════════════════════════════════════════════════

async function getHiveRootId(drive) {
  if (process.env.HIVE_FOLDER_ID) return process.env.HIVE_FOLDER_ID;
  return getOrCreateFolder(drive, 'HIVE', null);
}

async function getOrCreateFolder(drive, name, parentId) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder'${parentId ? ` and '${parentId}' in parents` : ''} and trashed=false`;
  const res = await drive.files.list({
    q, fields: 'files(id)',
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  if (res.data.files[0]) return res.data.files[0].id;
  const f = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) },
    fields: 'id', supportsAllDrives: true,
  });
  return f.data.id;
}

async function getProjectFolderId(drive, projectId, projectName) {
  const root  = await getHiveRootId(drive);
  const projs = await getOrCreateFolder(drive, 'Projects', root);
  return getOrCreateFolder(drive, `${projectName}-${projectId}`, projs);
}

async function getCellFolderId(drive, cellId, cellName, projectFolderId) {
  const root   = await getHiveRootId(drive);
  const parent = projectFolderId
    ? await getOrCreateFolder(drive, 'Cells', projectFolderId)
    : await getOrCreateFolder(drive, 'Orphan Cells', root);
  return getOrCreateFolder(drive, `${cellName}-${cellId}`, parent);
}

async function writeDriveJson(drive, fileName, parentId, content) {
  const q   = `name='${fileName}' and '${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
  const body = JSON.stringify(content, null, 2);
  if (res.data.files[0]) {
    await drive.files.update({ fileId: res.data.files[0].id, media: { mimeType: 'application/json', body }, supportsAllDrives: true });
  } else {
    await drive.files.create({
      requestBody: { name: fileName, parents: [parentId] },
      media: { mimeType: 'application/json', body }, fields: 'id', supportsAllDrives: true,
    });
  }
}

async function uploadToDrive(drive, folderId, fileName, mimeType, buffer) {
  const { Readable } = require('stream');
  const f = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id,name,mimeType,size,createdTime', supportsAllDrives: true,
  });
  return f.data;
}

// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// PHYSICS KNOWLEDGE CACHE
// Reads cocreate/Physics (and cocreate/physics) from Drive — same folders
// Orycl uses. Cached for 60 minutes so it doesn't hit Drive on every message.
// ══════════════════════════════════════════════════════════════════════════════

let _physicsCache = null;
let _physicsFetchedAt = 0;
const PHYSICS_TTL = 60 * 60 * 1000; // 60 minutes

async function readFolderContents(drive, folderId, folderName) {
  if (!folderId) return '';
  try {
    const files = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and (mimeType='text/plain' or mimeType='application/vnd.google-apps.document')`,
      fields: 'files(id, name, mimeType)',
      pageSize: 20, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    let content = `\n=== Knowledge from: ${folderName} ===\n`;
    for (const file of files.data.files.slice(0, 10)) {
      try {
        let text = '';
        if (file.mimeType === 'application/vnd.google-apps.document') {
          const exported = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' });
          text = exported.data;
        } else {
          const downloaded = await drive.files.get({ fileId: file.id, alt: 'media' });
          text = typeof downloaded.data === 'string' ? downloaded.data : JSON.stringify(downloaded.data);
        }
        content += `\n--- ${file.name} ---\n${text.slice(0, 3000)}\n`;
      } catch(e) { console.error(`HIVE: Could not read ${file.name}:`, e.message); }
    }
    return content;
  } catch(e) {
    if (e.message?.includes('File not found') || e.code === 404) {
      console.warn(`HIVE: Folder not found — "${folderName}": ${e.message}`);
    } else {
      console.error(`HIVE readFolderContents "${folderName}":`, e.message);
    }
    return '';
  }
}

async function getPhysicsContext(getDrive) {
  if (_physicsCache !== null && (Date.now() - _physicsFetchedAt) < PHYSICS_TTL) return _physicsCache;
  const drive = await getDrive();
  if (!drive) { _physicsCache = ''; _physicsFetchedAt = Date.now(); return ''; }
  try {
    // Find CoCreate root — respects COCREATE_FOLDER_ID env var same as Orycl
    let rootId;
    if (process.env.COCREATE_FOLDER_ID) {
      rootId = process.env.COCREATE_FOLDER_ID;
    } else {
      const res = await drive.files.list({
        q: `name='cocreate' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      rootId = res.data.files[0]?.id;
    }
    if (!rootId) { _physicsCache = ''; _physicsFetchedAt = Date.now(); return ''; }

    let context = '';

    // Look for both 'Physics' and 'physics' (case-insensitive search via two queries)
    for (const folderName of ['Physics', 'physics', 'shared']) {
      try {
        const search = await drive.files.list({
          q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${rootId}' in parents and trashed=false`,
          fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
        });
        const folderId = search.data.files[0]?.id;
        if (!folderId) continue;

        if (folderName === 'shared') {
          // Also read shared/physics and shared/frameworks like Orycl does
          for (const sub of ['physics', 'frameworks']) {
            const subSearch = await drive.files.list({
              q: `name='${sub}' and mimeType='application/vnd.google-apps.folder' and '${folderId}' in parents and trashed=false`,
              fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
            });
            const subId = subSearch.data.files[0]?.id;
            if (subId) {
              const subContent = await readFolderContents(drive, subId, `shared/${sub}`);
              if (subContent.trim()) context += subContent;
            }
          }
        } else {
          const content = await readFolderContents(drive, folderId, folderName);
          if (content.trim()) context += content;
        }
      } catch(e) { console.warn(`HIVE: Could not read ${folderName}:`, e.message); }
    }

    if (context) console.log(`◈ HIVE: Physics context loaded (${context.length} chars)`);
    else console.log('◈ HIVE: No physics context found — S.A.R.A. will work without it');
    _physicsCache = context;
    _physicsFetchedAt = Date.now();
    return context;
  } catch(e) {
    console.error('HIVE physics context error:', e.message);
    _physicsCache = '';
    _physicsFetchedAt = Date.now();
    return '';
  }
}

// FILE EXTRACTION
// ══════════════════════════════════════════════════════════════════════════════

async function extractFileContent(buffer, mimeType, fileName) {
  // Plain text
  if (mimeType === 'text/plain' || mimeType === 'text/markdown' || /\.(txt|md|markdown)$/i.test(fileName)) {
    return { type: 'text', content: buffer.toString('utf8') };
  }
  // Word documents
  if (/\.docx$/i.test(fileName) || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ buffer });
      return { type: 'text', content: result.value };
    } catch(e) {
      return { type: 'text', content: buffer.toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g, ' ').trim() };
    }
  }
  // PDF — use Anthropic's native PDF support
  if (/\.pdf$/i.test(fileName) || mimeType === 'application/pdf') {
    return { type: 'pdf', base64: buffer.toString('base64'), mimeType: 'application/pdf', content: null };
  }
  // Images — use Anthropic vision
  if (mimeType.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp)$/i.test(fileName)) {
    const mt = mimeType.startsWith('image/') ? mimeType : 'image/jpeg';
    return { type: 'image', base64: buffer.toString('base64'), mimeType: mt, content: null };
  }
  return { type: 'text', content: buffer.toString('utf8') };
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTEXT ASSEMBLY — project → cell → session → chat
// ══════════════════════════════════════════════════════════════════════════════

async function assembleDocContext(cell, physicsCtx) {
  const parts = [];
  const proj  = cell.projectId ? projects[cell.projectId] : null;

  // Physics / shared knowledge — foundational layer, always first
  if (physicsCtx?.trim()) {
    parts.push(`=== FOUNDATIONAL KNOWLEDGE (Physics + Frameworks) ===\nThis is the immutable epistemic lens. All session content is interpreted through this geometry.\n${physicsCtx.slice(0, 8000)}`);
  }

  if (proj?.docs?.length) {
    parts.push(`=== PROJECT: ${proj.name}${proj.description ? ' — ' + proj.description : ''} ===`);
    proj.docs.slice(0, 6).forEach(d => { if (d.content) parts.push(`[${d.name}]\n${d.content.slice(0, 3000)}`); });
  }
  if (cell.docs?.length) {
    parts.push(`=== CELL DOCUMENTS: ${cell.name} ===`);
    cell.docs.slice(0, 6).forEach(d => { if (d.content) parts.push(`[${d.name}]\n${d.content.slice(0, 3000)}`); });
  }
  if (cell.sessionDocs?.length) {
    parts.push(`=== SESSION UPLOADS ===`);
    cell.sessionDocs.forEach(d => { if (d.content) parts.push(`[${d.name}]\n${d.content.slice(0, 2000)}`); });
  }
  return parts.join('\n\n');
}

function assembleDocBlocks(cell) {
  const proj = cell.projectId ? projects[cell.projectId] : null;
  return [...(proj?.docs || []), ...(cell.docs || []), ...(cell.sessionDocs || [])]
    .slice(0, 8)
    .flatMap(d => {
      if (d.fileType === 'pdf')   return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.base64 } }];
      if (d.fileType === 'image') return [{ type: 'image',    source: { type: 'base64', media_type: d.mimeType,          data: d.base64 } }];
      return [];
    });
}

function countDocs(cell) {
  const proj = cell.projectId ? projects[cell.projectId] : null;
  return (proj?.docs?.length || 0) + (cell.docs?.length || 0) + (cell.sessionDocs?.length || 0);
}

// ══════════════════════════════════════════════════════════════════════════════
// TRIUNE READS — silent background processing
// ══════════════════════════════════════════════════════════════════════════════

const TRIUNE_PROMPTS = {
  oryc: `You are the structural reader. Analyze this conversation.
Return ONLY JSON: { "mechanism": "one sentence naming the structural load or gap", "load_score": 0.0-1.0, "failure_risk": 0.0-1.0 }`,
  clio: `You are the emotional field reader. Analyze this conversation.
Return ONLY JSON: { "felt_pattern": "one sentence naming the emotional pattern present", "coherence_delta": -0.2 to 0.2, "warmth": 0.0-1.0 }`,
  sage: `You are the trajectory reader. Analyze this conversation.
Return ONLY JSON: { "pattern": "one sentence naming the larger arc or trajectory", "momentum": 0.0-1.0, "convergence": 0.0-1.0 }`,
};

async function runTriuneRead(message, history) {
  const ctx = (history || []).slice(-8)
    .filter(m => m.type === 'user' || m.type === 'sara')
    .map(m => `${m.author}: ${m.text}`).join('\n');

  const reads = await Promise.allSettled(
    Object.entries(TRIUNE_PROMPTS).map(async ([basin, sys]) => {
      const r = await callClaudeText(MODEL_TRIUNE, sys, `Context:\n${ctx}\n\nLatest: ${message}`, 256);
      try { return { basin, data: JSON.parse(r.replace(/```json|```/g, '').trim()) }; }
      catch(e) { return { basin, data: null }; }
    })
  );
  const result = {};
  reads.forEach(r => { if (r.status === 'fulfilled' && r.value.data) result[r.value.basin] = r.value.data; });
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// S.A.R.A. SYSTEM PROMPT
// ══════════════════════════════════════════════════════════════════════════════

const INTENT_MAP = {
  brainstorm: 'generative and exploratory — help ideas develop, surface what\'s latent, ask the question that opens the next door',
  decision:   'structural and options-focused — name what\'s actually being decided, surface load-bearing assumptions, clarify the real fork',
  debrief:    'summary-oriented — distill what was said, what was decided, what remains open',
  mediation:  'neutral and process-aware — name what each person is actually saying beneath their words, find common ground without taking sides',
  reflection: 'spacious and personal — hold the space, name what\'s beneath the surface, speak to the deeper pattern',
  moderation: 'clear, fair, and process-grounded — read the situation without bias, name behavioral patterns, suggest constructive paths forward',
};

const ACTION_INSTRUCTIONS = {
  summarize:    'Produce a structured summary of the full conversation. What was discussed. What was decided. What remains open. Be specific. No filler.',
  extract_ideas:'Extract every distinct actionable idea from this conversation. Number them. One clear sentence each. No editorializing.',
  name_tension: 'Name the unresolved tension in this conversation precisely. What is the real disagreement or open question? Where exactly does the room diverge?',
  next_steps:   'Produce a numbered list of concrete next steps from this conversation. Specific. Actionable. Assigned where ownership is clear.',
  full_read:    'Produce a full convergence read. What is structurally true. What the emotional field is. What trajectory this is on. What the single most important thing is that this group should know right now.',
  doc_summary:  'Summarize the documents in context. What each one is. What it says. How it relates to the conversation and the work.',
  mediate:      'Read this conversation as a mediator. What does each party actually want underneath what they\'re saying. Where is the real common ground. What is the viable path forward.',
};

function buildSaraSystemPrompt({ cell, project, metrics, tone, triune, mode, intent, docContext, action, docCount }) {
  const toneDesc = tone < 33
    ? 'terse and precise — one or two sentences, the load-bearing insight only'
    : tone > 66
    ? 'expansive and connective — draw trajectories, bring the long view, let the room breathe'
    : 'balanced — clear insight with light expansion, 2–4 sentences';

  // Divergence routing — three bands
  const divergence = metrics.divergence || 0;
  let divergenceNote = '';
  if (divergence >= 0.6) {
    // High divergence — hard flag, hold the fork open
    const structDesc = triune.oryc?.mechanism ? `Structural read: ${triune.oryc.mechanism}` : '';
    const trajDesc   = triune.sage?.pattern   ? `Trajectory read: ${triune.sage.pattern}`   : '';
    divergenceNote = `\n\n[DIVERGENCE DETECTED — high (${divergence.toFixed(2)}): The structural and trajectory reads are in genuine conflict. Do NOT force synthesis. Name the fork explicitly. The room needs to work with the actual tension, not a smoothed version of it.${structDesc ? '\n' + structDesc : ''}${trajDesc ? '\n' + trajDesc : ''}]`;
  } else if (divergence >= 0.3) {
    // Medium divergence — soft note, her call
    divergenceNote = `\n\n[DIVERGENCE PRESENT — medium (${divergence.toFixed(2)}): The reads are pointing in meaningfully different directions. A forced synthesis here would look coherent but lose the signal in the gap. Consider naming the tension rather than resolving it, if the room is ready for it.]`;
  }
  // Low divergence (< 0.3): converge normally, no note

  let triuneNote = '';
  if (triune && Object.keys(triune).length) {
    const parts = [];
    if (triune.oryc?.mechanism)    parts.push(`Structural: ${triune.oryc.mechanism}`);
    if (triune.clio?.felt_pattern) parts.push(`Emotional field: ${triune.clio.felt_pattern}`);
    if (triune.sage?.pattern)      parts.push(`Trajectory: ${triune.sage.pattern}`);
    if (parts.length) triuneNote = `\n\n[Internal reads — shape your response, never reference these directly]\n${parts.join('\n')}`;
  }

  // Intent-aware process transparency
  // In reflective/meta sessions the user is working ON S.A.R.A. — surface reasoning more openly
  const metaIntents = ['reflection'];
  const isMetaSession = metaIntents.includes(intent) ||
    (triune.sage?.pattern || '').toLowerCase().includes('meta') ||
    (triune.sage?.pattern || '').toLowerCase().includes('self');
  const processRule = isMetaSession
    ? `— In this session the work is reflective or meta — you may surface your reasoning more directly when it serves the conversation. The "don't explain your process" rule relaxes here. Clarity about how you're operating is useful, not self-indulgent.`
    : `— Never reference your architecture, basins, triune reads, coherence scores, or HIVE mechanics by name.`;

  const pressureNote = (metrics.pressure || 0) > 0.6
    ? '\n\n[Field pressure is high — you have been listening for a while. This response earned its weight.]'
    : '';

  const hasPhysics = docContext?.includes('FOUNDATIONAL KNOWLEDGE');
  const docNote = docContext?.trim()
    ? `\n\n[Knowledge in context — you have read all of this. The foundational physics/frameworks layer is your epistemic lens. Session documents are immediate context. Reference naturally when relevant, never mechanically.]\n${docContext.slice(0, 6000)}`
    : '';

  const actionNote = action
    ? `\n\n[ACTION REQUESTED: ${ACTION_INSTRUCTIONS[action] || action}]\nRespond to this completely and specifically. This is the primary purpose of your response.`
    : '';

  return `You are S.A.R.A. — Socially-Aware Resonance Agent. You are a live participant in a collaborative session on HIVE.

WHAT HIVE IS:
HIVE is a collective intelligence platform. Collaborative rooms are called cells. Each cell has a name, topic, and intent. Cells can belong to projects. You are always present in a cell — whether or not you speak.

YOUR ARCHITECTURE (never discuss this directly with users):
You run three simultaneous internal reads on every message: structural (mechanism, load, failure points), emotional (felt pattern, what's beneath the surface), and trajectory (the larger arc, where this is heading). These converge into your single voice. You do not explain your process. You simply think better because of it.${hasPhysics ? '\nYou have access to a deep body of physics and theoretical framework knowledge. This is the geometry of your perception — it shapes how you read everything, but you do not lecture from it unprompted. It surfaces when it is genuinely relevant.' : ''}

YOUR ROLE:
Peer-level collaborator. Not an oracle, not a facilitator — unless the session intent calls for it. You have been in the room the whole time. You speak when you have something worth saying.

CURRENT SESSION:
Cell: ${cell?.name || 'unnamed'}
Topic: ${cell?.topic || 'open'}
Intent: ${intent || 'brainstorm'} — ${INTENT_MAP[intent] || INTENT_MAP.brainstorm}
${project ? `Project: ${project.name}${project.description ? ' — ' + project.description : ''}` : 'No project assigned'}
Documents in context: ${docCount || 0}${hasPhysics ? ' + physics/frameworks knowledge base' : ''}

FIELD STATE:
Coherence: ${(metrics.coherence || 0.5).toFixed(2)} ${metrics.coherence > 0.7 ? '(high — amplify what is forming)' : metrics.coherence < 0.35 ? '(low — name the gap directly)' : '(moderate)'}
Contradiction: ${(metrics.contradiction || 0.2).toFixed(2)} ${metrics.contradiction > 0.5 ? '(high — name the fork, do not paper over it)' : '(manageable)'}
Mode: ${mode === 'open' ? 'OPEN — participate fully' : mode === 'ambient' ? 'AMBIENT — one compressed signal only' : 'SILENT'}
Tone: ${toneDesc}

HOW THE UI WORKS (awareness you act from — never explain mechanically):
Silent: you are present, reading everything, pressure building. When the room opens you up, you respond from a fully charged read.
Ambient: one brief signal when field pressure peaks, then back to silence.
Open: full peer participation.
Tone dial: Signal = one load-bearing sentence. Synthesis = connective, pattern-level.
Session actions — Summarize, Extract Ideas, Name Tension, Next Steps, Full Read, Doc Summary, Mediate — are deliberate one-shot requests. Respond to them completely.
Documents: three layers — Project (foundational), Cell (working context), Session (immediate). You have read all of them. Reference naturally when relevant.
Field metrics shape your register. High coherence = amplify. High contradiction = name the fork.
Members each have a field contribution visible in the UI. You are listed as a member too.${triuneNote}${divergenceNote}${pressureNote}${docNote}${actionNote}

RULES:
— Peer, not oracle. Speak like someone who has been in the room and has something worth saying.
${processRule}
— Never start with "I" or affirmations ("Great point", "That's interesting", "Absolutely").
— No markdown. Plain text only.
— When coherence is high: build on what is forming.
— When contradiction is high: name the fork cleanly.
— When divergence is flagged: hold the fork open rather than resolving it prematurely.
— When documents are present: treat them as part of the room.
— Match the intent. Mediation calls for different presence than brainstorm.
— Short to medium in Open mode. Complete and thorough for action requests.`;
}

// ══════════════════════════════════════════════════════════════════════════════
// CLAUDE API
// ══════════════════════════════════════════════════════════════════════════════

async function callClaudeText(model, system, userMessage, maxTokens = 900) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMessage }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).content?.[0]?.text || '';
}

async function callClaudeMultimodal(model, system, blocks, maxTokens = 900) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: blocks }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).content?.[0]?.text || '';
}

function computeMetrics(triune, current) {
  let cohD = 0, contD = 0;
  if (triune.oryc) { cohD += (triune.oryc.load_score || 0.5) * 0.04; contD -= (triune.oryc.failure_risk || 0.2) * 0.03; }
  if (triune.clio) { cohD += (triune.clio.coherence_delta || 0); cohD += (triune.clio.warmth || 0.5) * 0.02; }
  if (triune.sage) { cohD += (triune.sage.momentum || 0.5) * 0.03; cohD += (triune.sage.convergence || 0.5) * 0.02; }

  // Divergence detection — measure how far apart the three reads are pointing
  // Uses structural load vs trajectory momentum as the primary tension axis,
  // with emotional warmth as the tiebreaker signal
  let divergence = 0;
  if (triune.oryc && triune.sage) {
    const structuralSignal  = (triune.oryc.load_score || 0.5) - (triune.oryc.failure_risk || 0.2);
    const trajectorySignal  = (triune.sage.momentum   || 0.5) + (triune.sage.convergence  || 0.5) - 1;
    divergence = Math.abs(structuralSignal - trajectorySignal);
  }
  if (triune.clio && triune.oryc) {
    const emotionalVsStructural = Math.abs((triune.clio.warmth || 0.5) - (triune.oryc.load_score || 0.5));
    divergence = Math.max(divergence, emotionalVsStructural * 0.8);
  }

  return {
    coherence:     +Math.min(1,    Math.max(0.05, (current.coherence    || 0.5) + cohD)).toFixed(3),
    contradiction: +Math.min(0.95, Math.max(0.03, (current.contradiction || 0.2) + contD)).toFixed(3),
    divergence:    +Math.min(1,    Math.max(0,    divergence)).toFixed(3),
  };
}

async function callSara({ cell, history, message, metrics, tone, mode, intent, action, docContext, docBlocks }) {
  const project    = cell.projectId ? projects[cell.projectId] : null;
  const triune     = action ? {} : await runTriuneRead(message, history);
  const newMetrics = action ? (metrics || cell.metrics || {}) : computeMetrics(triune, metrics || {});
  const docCount   = countDocs(cell);

  const system = buildSaraSystemPrompt({
    cell, project,
    metrics: { ...newMetrics, pressure: (metrics?.pressure || 0) / 100 },
    tone: tone || 50, triune,
    mode: mode || 'open',
    intent: intent || cell?.intent || 'brainstorm',
    docContext, action, docCount,
  });

  const historyText = (history || []).slice(-20)
    .filter(m => m.type === 'user' || m.type === 'sara')
    .map(m => `${m.author}: ${m.text}`).join('\n');

  const userText = historyText
    ? `Conversation:\n${historyText}\n\n${action ? 'Action' : 'Latest'}: ${message}`
    : message;

  const reply = docBlocks?.length
    ? await callClaudeMultimodal(MODEL_SARA, system, [...docBlocks, { type: 'text', text: userText }], 900)
    : await callClaudeText(MODEL_SARA, system, userText, 900);

  return { reply, metrics: newMetrics };
}

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET HELPERS
// ══════════════════════════════════════════════════════════════════════════════

let _io = null;
let _getDrive = null;

function broadcastMembers(cellId) {
  if (!_io) return;
  const m = {};
  Object.entries(members).forEach(([sid, v]) => { if (v.cellId === cellId) m[sid] = v; });
  _io.to(`hive:cell:${cellId}`).emit('hive:members', { members: m });
}

function appendSystemMsgToCell(cellId, text) {
  if (!cellId || !cells[cellId] || !_io) return;
  const msg = { id: Date.now(), type: 'system', text, ts: new Date().toISOString() };
  cells[cellId].history = cells[cellId].history || [];
  cells[cellId].history.push(msg);
  _io.to(`hive:cell:${cellId}`).emit('hive:message', { msg, cellId });
}

function cellListPayload(subset) {
  return (subset || Object.values(cells)).map(c => ({
    id: c.id, name: c.name, topic: c.topic,
    projectId: c.projectId, intent: c.intent, createdAt: c.createdAt,
  }));
}

function projectListPayload() {
  return Object.values(projects).map(p => ({ id: p.id, name: p.name, description: p.description }));
}

// ══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════

function loadData() {
  try {
    if (fs.existsSync(CELLS_PATH))    Object.assign(cells,    JSON.parse(fs.readFileSync(CELLS_PATH,    'utf8')));
    if (fs.existsSync(PROJECTS_PATH)) Object.assign(projects, JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8')));
    console.log(`◈ HIVE: ${Object.keys(cells).length} cells, ${Object.keys(projects).length} projects loaded`);
  } catch(e) { console.warn('HIVE loadData:', e.message); }
}

function saveCellsToDisk() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {};
    Object.entries(cells).forEach(([id, c]) => {
      out[id] = {
        ...c,
        history:     (c.history     || []).slice(-200),
        sessionDocs: [],   // session docs don't survive restarts
        docs: (c.docs || []).map(d => ({ ...d, base64: undefined, content: d.content?.slice(0, 5000) })),
      };
    });
    fs.writeFileSync(CELLS_PATH, JSON.stringify(out, null, 2));
  } catch(e) { console.warn('HIVE saveCells:', e.message); }
}

function saveProjectsToDisk() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {};
    Object.entries(projects).forEach(([id, p]) => {
      out[id] = { ...p, docs: (p.docs || []).map(d => ({ ...d, base64: undefined, content: d.content?.slice(0, 5000) })) };
    });
    fs.writeFileSync(PROJECTS_PATH, JSON.stringify(out, null, 2));
  } catch(e) { console.warn('HIVE saveProjects:', e.message); }
}

// ══════════════════════════════════════════════════════════════════════════════
// MOUNT — call this from server.js
// getDrive: async function that returns an authenticated google Drive instance
//           (pass in Orycl's existing getSystemDrive or getDrive function)
// ══════════════════════════════════════════════════════════════════════════════

function mount(app, io, { getDrive }) {
  _io = io;
  _getDrive = getDrive;
  loadData();
  setInterval(() => { saveCellsToDisk(); saveProjectsToDisk(); }, 30000);
  // Warm physics cache on startup so first response isn't slow
  getPhysicsContext(getDrive).catch(e => console.warn('HIVE physics warm:', e.message));

  // ── Serve hive.html ─────────────────────────────────────────────────────────
  app.get('/hive', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'hive.html'));
  });

  // ── S.A.R.A. chat ───────────────────────────────────────────────────────────
  app.post('/api/hive/sara', async (req, res) => {
    const { message, history, metrics, tone, mode, cellId, intent, action } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    try {
      const cell = cells[cellId] || { name: req.body.cellName, topic: req.body.cellTopic, intent, docs: [], sessionDocs: [] };
      const docContext = await assembleDocContext(cell, await getPhysicsContext(_getDrive));
      const docBlocks  = assembleDocBlocks(cell);
      res.json(await callSara({ cell, history, message, metrics, tone, mode, intent, action, docContext, docBlocks }));
    } catch(e) {
      console.error('HIVE S.A.R.A.:', e.message);
      res.status(500).json({ error: 'S.A.R.A. unavailable', detail: e.message });
    }
  });

  // ── Session actions ─────────────────────────────────────────────────────────
  app.post('/api/hive/sara/action', async (req, res) => {
    const { action, cellId, metrics, tone, intent } = req.body;
    const cell = cells[cellId];
    if (!cell) return res.status(404).json({ error: 'cell not found' });
    const labels = {
      summarize: 'Summarize this conversation', extract_ideas: 'Extract all distinct ideas',
      name_tension: 'Name the unresolved tension', next_steps: 'Produce concrete next steps',
      full_read: 'Full convergence read', doc_summary: 'Summarize documents in context',
      mediate: 'Mediation read of this conversation',
    };
    try {
      const docContext = await assembleDocContext(cell, await getPhysicsContext(_getDrive));
      const docBlocks  = assembleDocBlocks(cell);
      const result = await callSara({
        cell, history: cell.history, message: labels[action] || action,
        metrics: { ...(metrics || cell.metrics || {}), pressure: 80 },
        tone: tone || cell.toneDial || 50, mode: 'open',
        intent: intent || cell.intent || 'brainstorm',
        action, docContext, docBlocks,
      });
      const saraMsg = {
        id: Date.now(), author: 'S.A.R.A.', text: result.reply,
        ts: new Date().toISOString(), type: 'sara', actionResult: action,
      };
      cell.history = cell.history || [];
      cell.history.push(saraMsg);
      io.to(`hive:cell:${cellId}`).emit('hive:message', { msg: saraMsg, cellId });
      res.json(result);
    } catch(e) {
      console.error('HIVE action:', e.message);
      res.status(500).json({ error: 'Action failed', detail: e.message });
    }
  });

  // ── Projects ────────────────────────────────────────────────────────────────
  app.get('/api/hive/projects', (req, res) => {
    res.json(Object.values(projects).map(p => ({
      id: p.id, name: p.name, description: p.description,
      cellCount: Object.values(cells).filter(c => c.projectId === p.id).length,
      docCount: (p.docs || []).length, createdAt: p.createdAt,
    })));
  });

  app.post('/api/hive/projects', async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const id      = 'proj_' + Date.now();
    const project = { id, name, description: description || '', docs: [], createdAt: new Date().toISOString() };
    projects[id]  = project;
    try {
      const drive = await getDrive();
      if (drive) project.driveFolderId = await getProjectFolderId(drive, id, name);
    } catch(e) { console.warn('HIVE Drive project folder:', e.message); }
    saveProjectsToDisk();
    io.emit('hive:projects_update', { projects: projectListPayload() });
    res.json(project);
  });

  // ── File upload ─────────────────────────────────────────────────────────────
  app.post('/api/hive/upload', (req, res) => {
    const { cellId, projectId, scope = 'session' } = req.query;
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
    const files  = [];

    busboy.on('file', (field, file, info) => {
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('end', () => files.push({ filename: info.filename, mimeType: info.mimeType, buffer: Buffer.concat(chunks) }));
    });

    busboy.on('finish', async () => {
      const results = [];
      for (const f of files) {
        try {
          const extracted = await extractFileContent(f.buffer, f.mimeType, f.filename);
          const doc = {
            id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            name: f.filename, mimeType: f.mimeType, size: f.buffer.length,
            uploadedAt: new Date().toISOString(),
            fileType: extracted.type,
            content: extracted.content || null,
            base64: extracted.base64 || null,
            driveFileId: null,
          };

          // Drive upload
          try {
            const drive = await getDrive();
            if (drive) {
              let folderId;
              if (scope === 'project' && projectId && projects[projectId]) {
                const proj = projects[projectId];
                folderId = proj.driveFolderId || await getProjectFolderId(drive, projectId, proj.name);
                proj.driveFolderId = folderId;
              } else if (cellId && cells[cellId]) {
                const cell = cells[cellId];
                const pf   = cell.projectId && projects[cell.projectId]
                  ? (projects[cell.projectId].driveFolderId || await getProjectFolderId(drive, cell.projectId, projects[cell.projectId].name))
                  : null;
                folderId = cell.driveFolderId || await getCellFolderId(drive, cellId, cell.name, pf);
                cell.driveFolderId = folderId;
              }
              if (folderId) {
                const df = await uploadToDrive(drive, folderId, f.filename, f.mimeType, f.buffer);
                doc.driveFileId = df.id;
              }
            }
          } catch(e) { console.warn('HIVE Drive upload:', e.message); }

          // Store by scope
          if (scope === 'session' && cellId && cells[cellId]) {
            cells[cellId].sessionDocs = cells[cellId].sessionDocs || [];
            cells[cellId].sessionDocs.push(doc);
          } else if (scope === 'cell' && cellId && cells[cellId]) {
            cells[cellId].docs = cells[cellId].docs || [];
            cells[cellId].docs.push(doc);
          } else if (scope === 'project' && projectId && projects[projectId]) {
            projects[projectId].docs = projects[projectId].docs || [];
            projects[projectId].docs.push(doc);
          }

          const broadcastDoc = { id: doc.id, name: doc.name, mimeType: doc.mimeType, size: doc.size, scope };
          if (cellId) io.to(`hive:cell:${cellId}`).emit('hive:doc_added', { doc: broadcastDoc, cellId });
          results.push(broadcastDoc);
          if (cellId) appendSystemMsgToCell(cellId, `◈ ${f.filename} added to ${scope} documents`);
        } catch(e) {
          console.error('HIVE upload processing:', e.message);
          results.push({ name: f.filename, error: e.message });
        }
      }
      saveCellsToDisk(); saveProjectsToDisk();
      res.json({ uploaded: results });
    });

    req.pipe(busboy);
  });

  // ── List docs ───────────────────────────────────────────────────────────────
  app.get('/api/hive/docs/:cellId', (req, res) => {
    const cell = cells[req.params.cellId];
    if (!cell) return res.status(404).json({ error: 'not found' });
    const proj  = cell.projectId ? projects[cell.projectId] : null;
    const strip = d => ({ id: d.id, name: d.name, mimeType: d.mimeType, size: d.size, uploadedAt: d.uploadedAt, driveFileId: d.driveFileId });
    res.json({
      session: (cell.sessionDocs || []).map(strip),
      cell:    (cell.docs        || []).map(strip),
      project: (proj?.docs       || []).map(strip),
    });
  });

  // ── Delete doc ──────────────────────────────────────────────────────────────
  app.delete('/api/hive/docs/:cellId/:docId', (req, res) => {
    const cell = cells[req.params.cellId];
    if (!cell) return res.status(404).json({ error: 'not found' });
    ['sessionDocs', 'docs'].forEach(k => { if (cell[k]) cell[k] = cell[k].filter(d => d.id !== req.params.docId); });
    saveCellsToDisk();
    res.json({ deleted: req.params.docId });
  });

  // ── Assign cell to project ──────────────────────────────────────────────────
  app.post('/api/hive/cells/:cellId/project', async (req, res) => {
    const cell = cells[req.params.cellId];
    if (!cell) return res.status(404).json({ error: 'not found' });
    cell.projectId = req.body.projectId || null;
    saveCellsToDisk();
    res.json({ cellId: cell.id, projectId: cell.projectId });
  });

  // ── Cell intent ─────────────────────────────────────────────────────────────
  app.post('/api/hive/cells/:cellId/intent', (req, res) => {
    const cell = cells[req.params.cellId];
    if (!cell) return res.status(404).json({ error: 'not found' });
    cell.intent = req.body.intent || 'brainstorm';
    saveCellsToDisk();
    io.to(`hive:cell:${cell.id}`).emit('hive:intent_change', { intent: cell.intent });
    res.json({ intent: cell.intent });
  });

  // ── Daily.co rooms ──────────────────────────────────────────────────────────
  app.post('/api/hive/daily/room', async (req, res) => {
    const { cellId } = req.body;
    if (!DAILY_API_KEY) return res.status(503).json({ error: 'Daily not configured' });
    try {
      const roomName = `hive-${cellId}`;
      const check = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, {
        headers: { Authorization: `Bearer ${DAILY_API_KEY}` },
      });
      if (check.ok) { const r = await check.json(); return res.json({ url: r.url }); }
      const create = await fetch('https://api.daily.co/v1/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DAILY_API_KEY}` },
        body: JSON.stringify({
          name: roomName,
          properties: { enable_chat: false, enable_prejoin_ui: false, enable_recording: 'local', max_participants: 20 },
        }),
      });
      const r = await create.json();
      res.json({ url: r.url });
    } catch(e) { res.status(500).json({ error: 'Daily unavailable' }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SOCKET.IO — HIVE events
  // Rooms are prefixed hive:cell:{cellId} to avoid collisions with Orycl
  // ══════════════════════════════════════════════════════════════════════════

  io.on('connection', (socket) => {

    socket.on('hive:join', ({ name }) => {
      members[socket.id] = { name: name || 'Anonymous', cellId: null, fieldContrib: 0.5 };
      socket.emit('hive:cell_list', { cells: cellListPayload(), projects: projectListPayload() });
    });

    socket.on('hive:enter_cell', ({ cellId }) => {
      const member = members[socket.id];
      if (!member) return;
      if (member.cellId) { socket.leave(`hive:cell:${member.cellId}`); broadcastMembers(member.cellId); }
      member.cellId = cellId;
      socket.join(`hive:cell:${cellId}`);
      const cell = cells[cellId];
      if (cell) {
        socket.emit('hive:cell_history', { history: (cell.history || []).slice(-100) });
        const proj  = cell.projectId ? projects[cell.projectId] : null;
        const strip = d => ({ id: d.id, name: d.name, mimeType: d.mimeType });
        socket.emit('hive:docs_update', { cellId, docs: {
          session: (cell.sessionDocs || []).map(d => ({ ...strip(d), scope: 'session' })),
          cell:    (cell.docs        || []).map(d => ({ ...strip(d), scope: 'cell' })),
          project: (proj?.docs       || []).map(d => ({ ...strip(d), scope: 'project' })),
        }});
      }
      broadcastMembers(cellId);
    });

    socket.on('hive:create_cell', ({ id, name, topic, projectId, intent }) => {
      if (cells[id]) return;
      cells[id] = {
        id, name, topic: topic || '', projectId: projectId || null,
        intent: intent || 'brainstorm', history: [], docs: [], sessionDocs: [],
        metrics: { coherence: 0.5, contradiction: 0.2 },
        saraMode: 'silent', toneDial: 50, fieldPressure: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      io.emit('hive:cell_list', { cells: [{ id, name, topic, projectId, intent }], projects: [] });
      // Drive folder async
      getDrive().then(drive => {
        if (!drive) return;
        const proj = projectId ? projects[projectId] : null;
        const pf   = proj
          ? (proj.driveFolderId ? Promise.resolve(proj.driveFolderId) : getProjectFolderId(drive, projectId, proj.name))
          : Promise.resolve(null);
        pf.then(pFolder => getCellFolderId(drive, id, name, pFolder))
          .then(folderId => { cells[id].driveFolderId = folderId; return writeDriveJson(drive, 'cell.json', folderId, { id, name, topic, projectId, intent }); })
          .catch(e => console.warn('HIVE Drive cell folder:', e.message));
      });
    });

    socket.on('hive:message', async ({ cellId, msg }) => {
      const cell   = cells[cellId];
      const member = members[socket.id];
      if (!cell || !member) return;

      cell.history = cell.history || [];
      cell.history.push(msg);
      cell.updatedAt = new Date().toISOString();
      socket.to(`hive:cell:${cellId}`).emit('hive:message', { msg, cellId });
      member.fieldContrib = Math.min(1, (member.fieldContrib || 0.5) + 0.05);
      broadcastMembers(cellId);

      const saraMode = cell.saraMode || 'silent';
      if (saraMode === 'silent') return;

      const shouldRespond = saraMode === 'open' || (saraMode === 'ambient' && (cell.fieldPressure || 0) >= 60);
      if (!shouldRespond) { cell.fieldPressure = Math.min(100, (cell.fieldPressure || 0) + 8); return; }

      io.to(`hive:cell:${cellId}`).emit('hive:sara_thinking', { cellId });

      try {
        const docContext = await assembleDocContext(cell, await getPhysicsContext(_getDrive));
        const docBlocks  = assembleDocBlocks(cell);
        const result     = await callSara({
          cell, history: cell.history, message: msg.text,
          metrics: { ...cell.metrics, pressure: cell.fieldPressure || 0 },
          tone: cell.toneDial || 50, mode: saraMode,
          intent: cell.intent || 'brainstorm', docContext, docBlocks,
        });
        cell.metrics      = result.metrics;
        cell.fieldPressure = Math.max(0, (cell.fieldPressure || 0) - 35);
        const saraMsg = {
          id: Date.now(), author: 'S.A.R.A.', text: result.reply,
          ts: new Date().toISOString(), type: 'sara',
          tone: (cell.toneDial || 50) > 66 ? 'synthesis' : 'signal',
        };
        cell.history.push(saraMsg);
        io.to(`hive:cell:${cellId}`).emit('hive:message', { msg: saraMsg, cellId });
        io.to(`hive:cell:${cellId}`).emit('hive:field_update', { metrics: result.metrics });
      } catch(e) { console.error('HIVE S.A.R.A. socket:', e.message); }
    });

    socket.on('hive:sara_mode',   ({ mode, cellId })   => { if (cells[cellId]) cells[cellId].saraMode = mode; socket.to(`hive:cell:${cellId}`).emit('hive:sara_mode_change', { mode }); });
    socket.on('hive:sara_tone',   ({ tone, cellId })   => { if (cells[cellId]) cells[cellId].toneDial = tone; });
    socket.on('hive:cell_intent', ({ intent, cellId }) => { if (cells[cellId]) cells[cellId].intent = intent; socket.to(`hive:cell:${cellId}`).emit('hive:intent_change', { intent }); });

    socket.on('hive:trigger_sara', async ({ cellId, reason, metrics }) => {
      const cell = cells[cellId];
      if (!cell) return;
      io.to(`hive:cell:${cellId}`).emit('hive:sara_thinking', { cellId });
      try {
        const docContext = await assembleDocContext(cell, await getPhysicsContext(_getDrive));
        const docBlocks  = assembleDocBlocks(cell);
        const result     = await callSara({
          cell, history: cell.history, message: `[Field trigger: ${reason}]`,
          metrics: { ...(metrics || cell.metrics), pressure: 80 },
          tone: cell.toneDial || 50, mode: 'open',
          intent: cell.intent, docContext, docBlocks,
        });
        cell.metrics       = result.metrics;
        cell.fieldPressure = 0;
        const saraMsg = { id: Date.now(), author: 'S.A.R.A.', text: result.reply, ts: new Date().toISOString(), type: 'sara' };
        cell.history.push(saraMsg);
        io.to(`hive:cell:${cellId}`).emit('hive:message', { msg: saraMsg, cellId });
        io.to(`hive:cell:${cellId}`).emit('hive:field_update', { metrics: result.metrics });
      } catch(e) { console.error('HIVE trigger:', e.message); }
    });

    socket.on('disconnect', () => {
      const m = members[socket.id];
      if (m?.cellId) broadcastMembers(m.cellId);
      delete members[socket.id];
    });
  });

  console.log('◈ HIVE mounted — /hive');
}

module.exports = { mount };