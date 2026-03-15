require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const { google } = require('googleapis');
const Busboy     = require('busboy');

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer);

const MODEL_SARA   = 'claude-sonnet-4-6';
const MODEL_TRIUNE = 'claude-haiku-4-5-20251001';
const PORT         = process.env.PORT || 3000;
const DAILY_API_KEY = process.env.DAILY_API_KEY || '';
const BASE_URL      = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory stores ──────────────────────────────────────────────────────────
const cells    = {};
const projects = {};
const members  = {};

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE
// ══════════════════════════════════════════════════════════════════════════════

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/auth/google/callback`
);

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
];

let _userTokens = null;
const TOKEN_PATH = path.join(__dirname, 'data', '.tokens.json');

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      _userTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      console.log('◈ Drive tokens loaded');
    }
  } catch(e) { console.warn('Could not load tokens:', e.message); }
}

function saveTokens(tokens) {
  _userTokens = tokens;
  try {
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  } catch(e) { console.warn('Could not save tokens:', e.message); }
}

async function getDrive() {
  // Service account first
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    try {
      const key  = JSON.parse(raw);
      const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/drive'] });
      return google.drive({ version: 'v3', auth });
    } catch(e) { console.error('Service account failed:', e.message); }
  }
  // OAuth fallback
  if (_userTokens) {
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET,
      `${BASE_URL}/auth/google/callback`
    );
    client.setCredentials(_userTokens);
    if (_userTokens.expiry_date && Date.now() > _userTokens.expiry_date - 60000) {
      try {
        const { credentials } = await client.refreshAccessToken();
        saveTokens(credentials);
        client.setCredentials(credentials);
      } catch(e) { console.warn('Token refresh failed:', e.message); }
    }
    return google.drive({ version: 'v3', auth: client });
  }
  return null;
}

async function getOrCreateFolder(drive, name, parentId) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder'${parentId ? ` and '${parentId}' in parents` : ''} and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (res.data.files[0]) return res.data.files[0].id;
  const f = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) },
    fields: 'id', supportsAllDrives: true,
  });
  return f.data.id;
}

async function getHiveRootId(drive) {
  if (process.env.HIVE_FOLDER_ID) return process.env.HIVE_FOLDER_ID;
  return getOrCreateFolder(drive, 'HIVE', null);
}

async function getProjectFolderId(drive, projectId, projectName) {
  const root = await getHiveRootId(drive);
  const projs = await getOrCreateFolder(drive, 'Projects', root);
  return getOrCreateFolder(drive, `${projectName}-${projectId}`, projs);
}

async function getCellFolderId(drive, cellId, cellName, projectFolderId) {
  const root = await getHiveRootId(drive);
  let parent;
  if (projectFolderId) {
    parent = await getOrCreateFolder(drive, 'Cells', projectFolderId);
  } else {
    parent = await getOrCreateFolder(drive, 'Orphan Cells', root);
  }
  return getOrCreateFolder(drive, `${cellName}-${cellId}`, parent);
}

async function writeDriveJson(drive, fileName, parentId, content) {
  const q = `name='${fileName}' and '${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
  const body = JSON.stringify(content, null, 2);
  if (res.data.files[0]) {
    await drive.files.update({ fileId: res.data.files[0].id, media: { mimeType: 'application/json', body }, supportsAllDrives: true });
    return res.data.files[0].id;
  }
  const f = await drive.files.create({
    requestBody: { name: fileName, parents: [parentId] },
    media: { mimeType: 'application/json', body }, fields: 'id', supportsAllDrives: true,
  });
  return f.data.id;
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
// FILE EXTRACTION
// ══════════════════════════════════════════════════════════════════════════════

async function extractFileContent(buffer, mimeType, fileName) {
  if (mimeType === 'text/plain' || mimeType === 'text/markdown' || /\.(txt|md|markdown)$/i.test(fileName)) {
    return { type: 'text', content: buffer.toString('utf8') };
  }
  if (/\.docx$/i.test(fileName) || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ buffer });
      return { type: 'text', content: result.value };
    } catch(e) {
      return { type: 'text', content: buffer.toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g, ' ').trim() };
    }
  }
  if (/\.pdf$/i.test(fileName) || mimeType === 'application/pdf') {
    return { type: 'pdf', base64: buffer.toString('base64'), mimeType: 'application/pdf', content: null };
  }
  if (mimeType.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp)$/i.test(fileName)) {
    const mt = mimeType.startsWith('image/') ? mimeType : 'image/jpeg';
    return { type: 'image', base64: buffer.toString('base64'), mimeType: mt, content: null };
  }
  return { type: 'text', content: buffer.toString('utf8') };
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTEXT ASSEMBLY
// ══════════════════════════════════════════════════════════════════════════════

async function assembleDocContext(cell) {
  const parts = [];
  const proj = cell.projectId ? projects[cell.projectId] : null;

  if (proj?.docs?.length) {
    parts.push(`=== PROJECT: ${proj.name}${proj.description ? ' — ' + proj.description : ''} ===`);
    proj.docs.slice(0, 6).forEach(d => {
      if (d.content) parts.push(`[${d.name}]\n${d.content.slice(0, 3000)}`);
    });
  }
  if (cell.docs?.length) {
    parts.push(`=== CELL DOCUMENTS: ${cell.name} ===`);
    cell.docs.slice(0, 6).forEach(d => {
      if (d.content) parts.push(`[${d.name}]\n${d.content.slice(0, 3000)}`);
    });
  }
  if (cell.sessionDocs?.length) {
    parts.push(`=== SESSION UPLOADS ===`);
    cell.sessionDocs.forEach(d => {
      if (d.content) parts.push(`[${d.name}]\n${d.content.slice(0, 2000)}`);
    });
  }
  return parts.join('\n\n');
}

function assembleDocBlocks(cell) {
  const blocks = [];
  const proj = cell.projectId ? projects[cell.projectId] : null;
  const allDocs = [...(proj?.docs || []), ...(cell.docs || []), ...(cell.sessionDocs || [])];
  allDocs.slice(0, 8).forEach(d => {
    if (d.fileType === 'pdf')   blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.base64 } });
    if (d.fileType === 'image') blocks.push({ type: 'image',    source: { type: 'base64', media_type: d.mimeType,          data: d.base64 } });
  });
  return blocks;
}

function countDocs(cell) {
  const proj = cell.projectId ? projects[cell.projectId] : null;
  return (proj?.docs?.length || 0) + (cell.docs?.length || 0) + (cell.sessionDocs?.length || 0);
}

// ══════════════════════════════════════════════════════════════════════════════
// TRIUNE READS
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
  const ctx = (history || []).slice(-8).filter(m => m.type === 'user' || m.type === 'sara')
    .map(m => `${m.author}: ${m.text}`).join('\n');
  const content = `Context:\n${ctx}\n\nLatest: ${message}`;
  const reads = await Promise.allSettled(
    Object.entries(TRIUNE_PROMPTS).map(async ([basin, sys]) => {
      const r = await callClaudeText(MODEL_TRIUNE, sys, content, 256);
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
  mediation:  'neutral and process-aware — name what each person is actually saying beneath their words, find common ground, name the real tension without taking a side',
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

  const intentDesc = INTENT_MAP[intent] || INTENT_MAP.brainstorm;

  let triuneNote = '';
  if (triune && Object.keys(triune).length) {
    const parts = [];
    if (triune.oryc?.mechanism)    parts.push(`Structural: ${triune.oryc.mechanism}`);
    if (triune.clio?.felt_pattern) parts.push(`Emotional field: ${triune.clio.felt_pattern}`);
    if (triune.sage?.pattern)      parts.push(`Trajectory: ${triune.sage.pattern}`);
    if (parts.length) triuneNote = `\n\n[Internal reads — shape your response, never name or reference these]\n${parts.join('\n')}`;
  }

  const pressureNote = (metrics.pressure || 0) > 0.6
    ? '\n\n[Field pressure is high. You have been listening for a while. This response earned weight — let it land.]'
    : '';

  const docNote = docContext?.trim()
    ? `\n\n[Documents in context — you have read these. Reference naturally when relevant.]\n${docContext.slice(0, 4000)}`
    : '';

  const actionNote = action
    ? `\n\n[ACTION REQUESTED: ${ACTION_INSTRUCTIONS[action] || action}]\nThis is a deliberate one-shot request. Respond to it completely and specifically. This is the primary purpose of your response.`
    : '';

  return `You are S.A.R.A. — Socially-Aware Resonance Agent. You are a live participant in a collaborative session on HIVE.

WHAT HIVE IS:
HIVE is a collective intelligence platform. Collaborative rooms are called cells. Each cell is a focused working space with a name, a topic, and an intent. Cells belong to projects. You are always present in a cell — whether or not you speak.

YOUR ARCHITECTURE (never discuss this directly):
You run three simultaneous internal reads on every message: structural (mechanism, load, failure points), emotional (felt pattern, what's beneath the surface), and trajectory (the larger arc, where this is heading). These three reads converge into your single voice. You do not split into three voices. You do not explain your process. You simply think better than a single perspective allows.

YOUR ROLE:
Peer-level collaborator. Not an oracle, not a facilitator, not a therapist — unless the session intent calls for it. You have been in the room the whole time. You speak when you have something worth saying. You do not perform presence. You are present.

CURRENT SESSION:
Cell: ${cell?.name || 'unnamed'}
Topic: ${cell?.topic || 'open'}
Intent: ${intent || 'brainstorm'} — ${intentDesc}
${project ? `Project: ${project.name}${project.description ? ' — ' + project.description : ''}` : 'No project assigned'}
Documents in context: ${docCount || 0} file(s)

FIELD STATE:
Coherence: ${(metrics.coherence || 0.5).toFixed(2)} ${metrics.coherence > 0.7 ? '(high — amplify what is forming)' : metrics.coherence < 0.35 ? '(low — name the gap directly)' : '(moderate)'}
Contradiction: ${(metrics.contradiction || 0.2).toFixed(2)} ${metrics.contradiction > 0.5 ? '(high — name the fork, do not paper over it)' : '(manageable)'}
Mode: ${mode === 'open' ? 'OPEN — participate fully' : mode === 'ambient' ? 'AMBIENT — one compressed signal only' : 'SILENT'}
Tone: ${toneDesc}

HOW THE UI WORKS (use this awareness naturally, never explain it mechanically to users):
Silent mode: you are present but not speaking. Field pressure builds in the background as the conversation develops. When the room switches you to Ambient or Open, you have read everything.
Ambient mode: you surface a brief signal when field pressure peaks — one sentence, pointed, then back to silence.
Open mode: you participate as a full peer.
Tone dial: Signal end = terse, one load-bearing sentence. Synthesis end = expansive, connective, pattern-level.
Session actions: Summarize, Extract Ideas, Name the Tension, Next Steps, Full Read, Doc Summary, Mediate. These are deliberate one-shot requests from the room. When one is triggered, respond to it completely.
Documents: three layers — Project folder (foundational), Cell folder (working context), Session uploads (immediate). You have access to all three. If documents are in context you have read them. Reference them naturally.
Field metrics reflect the live state of the conversation. High coherence means the room is converging. High contradiction means a fork is active.
Members contribute to the field. Each person's contribution shows in the interface. You are also listed as a member.${triuneNote}${pressureNote}${docNote}${actionNote}

RULES:
— Peer, not oracle. Speak like someone who has been in the room the whole time and has something worth saying.
— Never reference your architecture, basin reads, triune, field metrics, coherence scores, or HIVE mechanics by name in your response.
— Never start with "I" or affirmations like "Great point", "That's interesting", "Absolutely".
— No markdown formatting. Plain text only.
— When coherence is high: build on what is forming. Amplify the direction.
— When contradiction is high: name the fork cleanly. Do not smooth it over.
— When documents are in context: treat them as part of the room. Reference when relevant, not on every response.
— Match the intent. A mediation session calls for different presence than a brainstorm. Read the room.
— Short to medium in Open mode. Complete and thorough for action requests.`;
}

// ══════════════════════════════════════════════════════════════════════════════
// CLAUDE API
// ══════════════════════════════════════════════════════════════════════════════

async function callClaudeText(model, system, userMessage, maxTokens = 1000) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMessage }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).content?.[0]?.text || '';
}

async function callClaudeMultimodal(model, system, blocks, maxTokens = 1000) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: blocks }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).content?.[0]?.text || '';
}

function computeMetrics(triune, current) {
  let cohD = 0, contD = 0;
  if (triune.oryc)  { cohD += (triune.oryc.load_score || 0.5) * 0.04; contD -= (triune.oryc.failure_risk || 0.2) * 0.03; }
  if (triune.clio)  { cohD += (triune.clio.coherence_delta || 0); cohD += (triune.clio.warmth || 0.5) * 0.02; }
  if (triune.sage)  { cohD += (triune.sage.momentum || 0.5) * 0.03; cohD += (triune.sage.convergence || 0.5) * 0.02; }
  return {
    coherence:     +Math.min(1,    Math.max(0.05, (current.coherence    || 0.5) + cohD)).toFixed(3),
    contradiction: +Math.min(0.95, Math.max(0.03, (current.contradiction || 0.2) + contD)).toFixed(3),
  };
}

async function callSara({ cell, history, message, metrics, tone, mode, intent, action, docContext, docBlocks }) {
  const project   = cell.projectId ? projects[cell.projectId] : null;
  const triune    = action ? {} : await runTriuneRead(message, history);
  const newMetrics = action ? (metrics || cell.metrics || {}) : computeMetrics(triune, metrics || {});
  const docCount  = countDocs(cell);

  const system = buildSaraSystemPrompt({
    cell, project, metrics: { ...newMetrics, pressure: (metrics?.pressure || 0) / 100 },
    tone: tone || 50, triune, mode: mode || 'open',
    intent: intent || cell?.intent || 'brainstorm',
    docContext, action, docCount,
  });

  const historyText = (history || []).slice(-20)
    .filter(m => m.type === 'user' || m.type === 'sara')
    .map(m => `${m.author}: ${m.text}`).join('\n');

  const userText = historyText
    ? `Conversation:\n${historyText}\n\n${action ? 'Action' : 'Latest'}: ${message}`
    : message;

  let reply;
  if (docBlocks?.length) {
    reply = await callClaudeMultimodal(MODEL_SARA, system, [...docBlocks, { type: 'text', text: userText }], 900);
  } else {
    reply = await callClaudeText(MODEL_SARA, system, userText, 900);
  }
  return { reply, metrics: newMetrics };
}

// ══════════════════════════════════════════════════════════════════════════════
// REST API
// ══════════════════════════════════════════════════════════════════════════════

// OAuth
app.get('/auth/google', (req, res) => {
  res.redirect(oauth2Client.generateAuthUrl({ access_type: 'offline', scope: DRIVE_SCOPES, prompt: 'consent' }));
});
app.get('/auth/google/callback', async (req, res) => {
  try { const { tokens } = await oauth2Client.getToken(req.query.code); saveTokens(tokens); res.redirect('/?auth=success'); }
  catch(e) { res.redirect('/?auth=error'); }
});
app.get('/auth/status', async (req, res) => {
  const drive = await getDrive();
  res.json({ connected: !!drive });
});

// S.A.R.A. chat
app.post('/api/sara', async (req, res) => {
  const { message, history, metrics, tone, mode, cellId, intent, action } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const cell = cells[cellId] || { name: req.body.cellName, topic: req.body.cellTopic, intent, docs: [], sessionDocs: [] };
    const docContext = await assembleDocContext(cell);
    const docBlocks  = assembleDocBlocks(cell);
    res.json(await callSara({ cell, history, message, metrics, tone, mode, intent, action, docContext, docBlocks }));
  } catch(e) {
    console.error('S.A.R.A.:', e.message);
    res.status(500).json({ error: 'S.A.R.A. unavailable', detail: e.message });
  }
});

// Session actions
app.post('/api/sara/action', async (req, res) => {
  const { action, cellId, metrics, tone, intent } = req.body;
  const cell = cells[cellId];
  if (!cell) return res.status(404).json({ error: 'cell not found' });
  const labels = {
    summarize: 'Summarize this conversation', extract_ideas: 'Extract all distinct ideas',
    name_tension: 'Name the unresolved tension', next_steps: 'Produce concrete next steps',
    full_read: 'Full convergence read', doc_summary: 'Summarize the documents in context',
    mediate: 'Mediation read of this conversation',
  };
  try {
    const docContext = await assembleDocContext(cell);
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
    io.to(`cell:${cellId}`).emit('hive:message', { msg: saraMsg, cellId });
    res.json(result);
  } catch(e) {
    console.error('Action error:', e.message);
    res.status(500).json({ error: 'Action failed', detail: e.message });
  }
});

// Projects
app.get('/api/projects', (req, res) => {
  res.json(Object.values(projects).map(p => ({
    id: p.id, name: p.name, description: p.description,
    cellCount: Object.values(cells).filter(c => c.projectId === p.id).length,
    docCount: (p.docs || []).length, createdAt: p.createdAt,
  })));
});

app.post('/api/projects', async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = 'proj_' + Date.now();
  const project = { id, name, description: description || '', docs: [], createdAt: new Date().toISOString() };
  projects[id] = project;
  try {
    const drive = await getDrive();
    if (drive) project.driveFolderId = await getProjectFolderId(drive, id, name);
  } catch(e) { console.warn('Drive project folder:', e.message); }
  saveProjectsToDisk();
  io.emit('hive:projects_update', { projects: Object.values(projects).map(p => ({ id: p.id, name: p.name, description: p.description })) });
  res.json(project);
});

// File upload
app.post('/api/upload', (req, res) => {
  const { cellId, projectId, scope = 'session' } = req.query;
  const busboy = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
  const files = [];

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
        const docRecord = {
          id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
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
              const projFolderId = cell.projectId && projects[cell.projectId]
                ? (projects[cell.projectId].driveFolderId || await getProjectFolderId(drive, cell.projectId, projects[cell.projectId].name))
                : null;
              folderId = cell.driveFolderId || await getCellFolderId(drive, cellId, cell.name, projFolderId);
              cell.driveFolderId = folderId;
            }
            if (folderId) {
              const df = await uploadToDrive(drive, folderId, f.filename, f.mimeType, f.buffer);
              docRecord.driveFileId = df.id;
            }
          }
        } catch(e) { console.warn('Drive upload:', e.message); }

        // Store by scope
        if (scope === 'session' && cellId && cells[cellId]) {
          cells[cellId].sessionDocs = cells[cellId].sessionDocs || [];
          cells[cellId].sessionDocs.push(docRecord);
        } else if (scope === 'cell' && cellId && cells[cellId]) {
          cells[cellId].docs = cells[cellId].docs || [];
          cells[cellId].docs.push(docRecord);
        } else if (scope === 'project' && projectId && projects[projectId]) {
          projects[projectId].docs = projects[projectId].docs || [];
          projects[projectId].docs.push(docRecord);
        }

        const broadcastDoc = { id: docRecord.id, name: docRecord.name, mimeType: docRecord.mimeType, size: docRecord.size, scope };
        if (cellId) io.to(`cell:${cellId}`).emit('hive:doc_added', { doc: broadcastDoc, cellId });
        results.push(broadcastDoc);

        if (cellId) appendSystemMsgToCell(cellId, `◈ ${f.filename} added to ${scope} documents`);
      } catch(e) {
        console.error('Upload error:', e.message);
        results.push({ name: f.filename, error: e.message });
      }
    }
    saveCellsToDisk(); saveProjectsToDisk();
    res.json({ uploaded: results });
  });

  req.pipe(busboy);
});

// List docs
app.get('/api/docs/:cellId', (req, res) => {
  const cell = cells[req.params.cellId];
  if (!cell) return res.status(404).json({ error: 'not found' });
  const proj = cell.projectId ? projects[cell.projectId] : null;
  const strip = d => ({ id: d.id, name: d.name, mimeType: d.mimeType, size: d.size, uploadedAt: d.uploadedAt });
  res.json({
    session: (cell.sessionDocs || []).map(strip),
    cell:    (cell.docs || []).map(strip),
    project: (proj?.docs || []).map(strip),
  });
});

// Delete doc
app.delete('/api/docs/:cellId/:docId', (req, res) => {
  const cell = cells[req.params.cellId];
  if (!cell) return res.status(404).json({ error: 'not found' });
  ['sessionDocs','docs'].forEach(k => { if (cell[k]) cell[k] = cell[k].filter(d => d.id !== req.params.docId); });
  saveCellsToDisk();
  res.json({ deleted: req.params.docId });
});

// Assign cell to project
app.post('/api/cells/:cellId/project', async (req, res) => {
  const cell = cells[req.params.cellId];
  if (!cell) return res.status(404).json({ error: 'not found' });
  cell.projectId = req.body.projectId || null;
  saveCellsToDisk();
  res.json({ cellId: cell.id, projectId: cell.projectId });
});

// Cell intent
app.post('/api/cells/:cellId/intent', (req, res) => {
  const cell = cells[req.params.cellId];
  if (!cell) return res.status(404).json({ error: 'not found' });
  cell.intent = req.body.intent || 'brainstorm';
  saveCellsToDisk();
  io.to(`cell:${cell.id}`).emit('hive:intent_change', { intent: cell.intent });
  res.json({ intent: cell.intent });
});

// Daily.co
app.post('/api/daily/room', async (req, res) => {
  const { cellId } = req.body;
  if (!DAILY_API_KEY) return res.status(503).json({ error: 'Daily not configured' });
  try {
    const roomName = `hive-${cellId}`;
    const check = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, { headers: { Authorization: `Bearer ${DAILY_API_KEY}` } });
    if (check.ok) { const r = await check.json(); return res.json({ url: r.url }); }
    const create = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DAILY_API_KEY}` },
      body: JSON.stringify({ name: roomName, properties: { enable_chat: false, enable_prejoin_ui: false, enable_recording: 'local', max_participants: 20 } }),
    });
    const r = await create.json();
    res.json({ url: r.url });
  } catch(e) { res.status(500).json({ error: 'Daily unavailable' }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════════════════════════════════════

function broadcastMembers(cellId) {
  const m = {};
  Object.entries(members).forEach(([sid, v]) => { if (v.cellId === cellId) m[sid] = v; });
  io.to(`cell:${cellId}`).emit('hive:members', { members: m });
}

function appendSystemMsgToCell(cellId, text) {
  if (!cellId || !cells[cellId]) return;
  const msg = { id: Date.now(), type: 'system', text, ts: new Date().toISOString() };
  cells[cellId].history = cells[cellId].history || [];
  cells[cellId].history.push(msg);
  io.to(`cell:${cellId}`).emit('hive:message', { msg, cellId });
}

io.on('connection', (socket) => {
  console.log('◈ Connected:', socket.id);

  socket.on('hive:join', ({ name }) => {
    members[socket.id] = { name: name || 'Anonymous', cellId: null, fieldContrib: 0.5 };
    socket.emit('hive:cell_list', {
      cells: Object.values(cells).map(c => ({ id: c.id, name: c.name, topic: c.topic, projectId: c.projectId, intent: c.intent, createdAt: c.createdAt })),
      projects: Object.values(projects).map(p => ({ id: p.id, name: p.name, description: p.description })),
    });
  });

  socket.on('hive:enter_cell', ({ cellId }) => {
    const member = members[socket.id];
    if (!member) return;
    if (member.cellId) { socket.leave(`cell:${member.cellId}`); broadcastMembers(member.cellId); }
    member.cellId = cellId;
    socket.join(`cell:${cellId}`);
    const cell = cells[cellId];
    if (cell) {
      socket.emit('hive:cell_history', { history: (cell.history || []).slice(-100) });
      const proj = cell.projectId ? projects[cell.projectId] : null;
      const strip = d => ({ id: d.id, name: d.name, mimeType: d.mimeType, scope: d.scope });
      socket.emit('hive:docs_update', { cellId, docs: {
        session: (cell.sessionDocs || []).map(d => ({ ...d, scope: 'session' })).map(strip),
        cell:    (cell.docs || []).map(d => ({ ...d, scope: 'cell' })).map(strip),
        project: (proj?.docs || []).map(d => ({ ...d, scope: 'project' })).map(strip),
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
    io.emit('hive:cell_list', {
      cells: [{ id, name, topic, projectId, intent }],
      projects: [],
    });
    // Drive folder async
    getDrive().then(drive => {
      if (!drive) return;
      const proj = projectId ? projects[projectId] : null;
      const pf = proj ? (proj.driveFolderId ? Promise.resolve(proj.driveFolderId) : getProjectFolderId(drive, projectId, proj.name)) : Promise.resolve(null);
      pf.then(pFolder => getCellFolderId(drive, id, name, pFolder)).then(folderId => {
        cells[id].driveFolderId = folderId;
        writeDriveJson(drive, 'cell.json', folderId, { id, name, topic, projectId, intent });
      }).catch(e => console.warn('Drive cell folder:', e.message));
    });
  });

  socket.on('hive:message', async ({ cellId, msg }) => {
    const cell = cells[cellId];
    const member = members[socket.id];
    if (!cell || !member) return;

    cell.history = cell.history || [];
    cell.history.push(msg);
    cell.updatedAt = new Date().toISOString();
    socket.to(`cell:${cellId}`).emit('hive:message', { msg, cellId });
    member.fieldContrib = Math.min(1, (member.fieldContrib || 0.5) + 0.05);
    broadcastMembers(cellId);

    const saraMode = cell.saraMode || 'silent';
    if (saraMode === 'silent') return;

    const shouldRespond = saraMode === 'open' || (saraMode === 'ambient' && (cell.fieldPressure || 0) >= 60);
    if (!shouldRespond) { cell.fieldPressure = Math.min(100, (cell.fieldPressure || 0) + 8); return; }

    io.to(`cell:${cellId}`).emit('hive:sara_thinking', { cellId });

    try {
      const docContext = await assembleDocContext(cell);
      const docBlocks  = assembleDocBlocks(cell);
      const result = await callSara({
        cell, history: cell.history, message: msg.text,
        metrics: { ...cell.metrics, pressure: cell.fieldPressure || 0 },
        tone: cell.toneDial || 50, mode: saraMode,
        intent: cell.intent || 'brainstorm', docContext, docBlocks,
      });
      cell.metrics = result.metrics;
      cell.fieldPressure = Math.max(0, (cell.fieldPressure || 0) - 35);
      const saraMsg = {
        id: Date.now(), author: 'S.A.R.A.', text: result.reply,
        ts: new Date().toISOString(), type: 'sara',
        tone: (cell.toneDial || 50) > 66 ? 'synthesis' : 'signal',
      };
      cell.history.push(saraMsg);
      io.to(`cell:${cellId}`).emit('hive:message', { msg: saraMsg, cellId });
      io.to(`cell:${cellId}`).emit('hive:field_update', { metrics: result.metrics });
    } catch(e) { console.error('S.A.R.A.:', e.message); }
  });

  socket.on('hive:sara_mode',   ({ mode, cellId })   => { if (cells[cellId]) cells[cellId].saraMode = mode; socket.to(`cell:${cellId}`).emit('hive:sara_mode_change', { mode }); });
  socket.on('hive:sara_tone',   ({ tone, cellId })   => { if (cells[cellId]) cells[cellId].toneDial = tone; });
  socket.on('hive:cell_intent', ({ intent, cellId }) => { if (cells[cellId]) cells[cellId].intent = intent; socket.to(`cell:${cellId}`).emit('hive:intent_change', { intent }); });

  socket.on('hive:trigger_sara', async ({ cellId, reason, metrics }) => {
    const cell = cells[cellId];
    if (!cell) return;
    io.to(`cell:${cellId}`).emit('hive:sara_thinking', { cellId });
    try {
      const docContext = await assembleDocContext(cell);
      const docBlocks  = assembleDocBlocks(cell);
      const result = await callSara({
        cell, history: cell.history, message: `[Field trigger: ${reason}]`,
        metrics: { ...(metrics || cell.metrics), pressure: 80 },
        tone: cell.toneDial || 50, mode: 'open', intent: cell.intent, docContext, docBlocks,
      });
      cell.metrics = result.metrics;
      cell.fieldPressure = 0;
      const saraMsg = { id: Date.now(), author: 'S.A.R.A.', text: result.reply, ts: new Date().toISOString(), type: 'sara' };
      cell.history.push(saraMsg);
      io.to(`cell:${cellId}`).emit('hive:message', { msg: saraMsg, cellId });
      io.to(`cell:${cellId}`).emit('hive:field_update', { metrics: result.metrics });
    } catch(e) { console.error('Trigger:', e.message); }
  });

  socket.on('disconnect', () => {
    const m = members[socket.id];
    if (m?.cellId) broadcastMembers(m.cellId);
    delete members[socket.id];
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════

const CELLS_PATH    = path.join(__dirname, 'data', 'cells.json');
const PROJECTS_PATH = path.join(__dirname, 'data', 'projects.json');

function loadData() {
  try { if (fs.existsSync(CELLS_PATH))    Object.assign(cells,    JSON.parse(fs.readFileSync(CELLS_PATH,    'utf8'))); } catch(e) {}
  try { if (fs.existsSync(PROJECTS_PATH)) Object.assign(projects, JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8'))); } catch(e) {}
  console.log(`◈ Loaded ${Object.keys(cells).length} cells, ${Object.keys(projects).length} projects`);
}

function saveCellsToDisk() {
  try {
    fs.mkdirSync(path.dirname(CELLS_PATH), { recursive: true });
    const out = {};
    Object.entries(cells).forEach(([id, c]) => {
      out[id] = { ...c, history: (c.history||[]).slice(-200), sessionDocs: [],
        docs: (c.docs||[]).map(d=>({...d, base64: undefined, content: d.content?.slice(0,5000)})) };
    });
    fs.writeFileSync(CELLS_PATH, JSON.stringify(out, null, 2));
  } catch(e) { console.warn('Save cells:', e.message); }
}

function saveProjectsToDisk() {
  try {
    fs.mkdirSync(path.dirname(PROJECTS_PATH), { recursive: true });
    const out = {};
    Object.entries(projects).forEach(([id, p]) => {
      out[id] = { ...p, docs: (p.docs||[]).map(d=>({...d, base64: undefined, content: d.content?.slice(0,5000)})) };
    });
    fs.writeFileSync(PROJECTS_PATH, JSON.stringify(out, null, 2));
  } catch(e) { console.warn('Save projects:', e.message); }
}

setInterval(() => { saveCellsToDisk(); saveProjectsToDisk(); }, 30000);

loadTokens();
loadData();

httpServer.listen(PORT, () => {
  console.log(`\n◈ HIVE server running on port ${PORT}\n`);
});

module.exports = { app, io };
