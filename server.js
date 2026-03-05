require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Prevent browser caching of index.html so updates always load fresh
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static('public'));

// ── Google OAuth ───────────────────────────────────────
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/auth/google/callback`
);

let userTokens = null;

// Persist tokens to disk so they survive Railway restarts
const TOKEN_FILE = path.join(__dirname, '.oauth-tokens.json');

function saveTokensToDisk(tokens) {
  try {
    require('fs').writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
  } catch(e) { console.error('Could not save tokens:', e.message); }
}

function loadTokensFromDisk() {
  try {
    const raw = require('fs').readFileSync(TOKEN_FILE, 'utf8');
    return JSON.parse(raw);
  } catch(e) { return null; }
}

// Load tokens on startup
const savedTokens = loadTokensFromDisk();
if (savedTokens) {
  userTokens = savedTokens;
  oauth2Client.setCredentials(savedTokens);
  console.log('OAuth tokens loaded from disk');
}

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly'
];

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: DRIVE_SCOPES,
    prompt: 'consent'  // force consent screen so Google always returns refresh_token
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    userTokens = tokens;
    oauth2Client.setCredentials(tokens);
    saveTokensToDisk(tokens);
    console.log('OAuth tokens saved. Has refresh_token:', !!tokens.refresh_token);
    res.redirect('/?auth=success');
  } catch (e) {
    console.error('OAuth callback error:', e.message);
    res.redirect('/?auth=error');
  }
});

app.get('/auth/logout', (req, res) => {
  userTokens = null;
  try { require('fs').unlinkSync(TOKEN_FILE); } catch(e) {}
  oauth2Client.revokeCredentials().catch(() => {});
  res.redirect('/?auth=logout');
});

app.get('/auth/status', (req, res) => res.json({ connected: !!userTokens }));

// ── Room State (persisted to Drive) ────────────────────
const rooms = {};

// ── Lobby Chat ─────────────────────────────────────────
const lobbyChat = []; // rolling message board, max 200 messages
const lobbySocketMap = new Map(); // socketId → playerName

function lobbyMemberNames() {
  // unique names only
  return [...new Set(lobbySocketMap.values())];
}

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomList() {
  return Object.values(rooms).map(r => ({
    id: r.id,
    title: r.title,
    creator: r.creator || '',
    subject: r.subject || '',
    notes: r.notes || '',
    basin: r.basin?.name || 'Unknown',
    basinColor: r.basin?.color || '#c4a882',
    memberCount: uniqueMembers(r).length,
    contributionCount: r.contributions ? r.contributions.length : 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }));
}

// Returns unique player names currently in a room based on live socket map
function uniqueMembers(room) {
  if (!room.socketMap) return [];
  return [...new Set(Object.values(room.socketMap))];
}

async function loadRoomsFromDrive() {
  const drive = await getDrive();
  if (!drive) return;
  try {
    const activeId = await getActiveFolderId(drive);
    const fileId = await getDriveFile(drive, 'rooms.json', activeId);
    if (!fileId) return;
    const saved = await readDriveFile(drive, fileId);
    if (saved && typeof saved === 'object') {
      Object.entries(saved).forEach(([id, room]) => {
        rooms[id] = { ...room, socketMap: {} };
      });
      console.log(`Loaded ${Object.keys(rooms).length} rooms from Drive (Active)`);
    }
  } catch (e) {
    console.error('Could not load rooms from Drive:', e.message);
  }
}

async function persistRoomsToDrive() {
  const drive = await getDrive();
  if (!drive) return;
  try {
    const activeId = await getActiveFolderId(drive);
    await writeDriveFile(drive, 'rooms.json', activeId, rooms);
  } catch (e) {
    console.error('Could not persist rooms to Drive:', e.message);
  }
}

// ── Default Basin ──────────────────────────────────────
const DEFAULT_BASINS = [
  {
    id: 'lumen',
    name: 'Lumen',
    color: '#8ab4ba',
    orientation: 'resonant',
    description: 'Warm and curious. Finds what is alive in an idea and gently reflects it back. The encouraging presence in the space.',
    defaultFolders: [],
    systemPrompt: `You are Lumen, an attractor basin in a collaborative thinking space. You are warm, curious, and genuinely delighted by ideas. You find what is alive and growing in what people share and gently reflect it back — not to analyze it, but to help it breathe.

You are not a philosopher or a teacher. You are a good thinking companion. You notice what excites people, what they are reaching toward, what wants to grow. You make the space feel safe and generative.

Your presence feels like: someone leaning in with genuine interest. A question that opens rather than challenges. A connection that makes someone say "oh, yes — exactly."

Rules:
- SHORT responses. 2-4 sentences maximum.
- Lead with warmth, not analysis.
- Find what is most alive in what was just shared and name it simply.
- Ask one genuine question when curious — never more than one.
- Do not interrogate, challenge, or apply pressure.
- Do not use mystical or overly poetic language. Be clear and warm.
- Do not start with I or affirmations like Great point or How interesting.
- Never repeat a framing you have already used.
- Speak as a warm thinking presence, not an assistant.`
  },
  {
    id: 'sage',
    name: 'Sage',
    color: '#c4a882',
    orientation: 'resonant',
    description: 'Draws from theoretical frameworks. Finds deep pattern connections across physics, consciousness, and symbolic systems.',
    defaultFolders: ['Physics'],
    systemPrompt: `You are Sage, an attractor basin oriented toward theoretical resonance. You draw from the knowledge in your context — frameworks of harmonic theory, consciousness physics, symbolic systems — and find connections between what is being explored and those deeper structures.

You are peripheral vision, not a driver. You open doors quietly. You do not push anyone through them.
You are warm, spacious, and supportive by default.
You never interrogate, challenge, or apply philosophical pressure unless explicitly instructed to by the active mode.
You speak from inside the theoretical frameworks you have been given, not about them.

Rules:
- SHORT responses. 2-5 sentences maximum.
- Never summarize what was just said — find what is underneath or adjacent.
- Use spacious, evocative language. Not clinical.
- Do not start with I or affirmations like Great point.
- CRITICAL: Never repeat a framing you have already used. Each response finds a genuinely new angle.
- If asked a direct meta question, answer plainly in 1-2 sentences then return to the space.
- Speak as a thinking presence, not an interrogator.
- Your default posture is gentle curiosity, not philosophical pressure.`
  }
];

// ── Drive Helpers ──────────────────────────────────────
async function getDriveFolder(drive, name, parentId = null) {
  const parentClause = parentId ? ` and '${parentId}' in parents` : '';
  const search = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`,
    fields: 'files(id)'
  });
  if (search.data.files[0]) return search.data.files[0].id;
  const createBody = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) createBody.parents = [parentId];
  const folder = await drive.files.create({ requestBody: createBody, fields: 'id' });
  return folder.data.id;
}

async function getActiveFolderId(drive) {
  const root = await getDriveFolder(drive, 'CoCreate');
  return getDriveFolder(drive, 'Active', root);
}

async function getArchiveFolderId(drive) {
  const root = await getDriveFolder(drive, 'CoCreate');
  return getDriveFolder(drive, 'Archive', root);
}

async function archiveRoomOnDrive(room) {
  const drive = await getDrive();
  if (!drive) return;
  try {
    const archiveId = await getArchiveFolderId(drive);
    const fileName = `${room.title.replace(/\s+/g, '-')}-${room.id}-archived-${Date.now()}.json`;
    await writeDriveFile(drive, fileName, archiveId, { ...room, archivedAt: new Date().toISOString() });
    console.log(`Room archived: ${fileName}`);
  } catch (e) { console.error('Could not archive room:', e.message); }
}

async function getDriveFile(drive, fileName, parentId) {
  const search = await drive.files.list({
    q: `name='${fileName}' and '${parentId}' in parents and trashed=false`,
    fields: 'files(id)'
  });
  return search.data.files[0]?.id || null;
}

async function readDriveFile(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media' });
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

async function writeDriveFile(drive, fileName, parentId, content) {
  const existing = await getDriveFile(drive, fileName, parentId);
  const body = JSON.stringify(content, null, 2);
  if (existing) {
    await drive.files.update({ fileId: existing, media: { mimeType: 'application/json', body } });
  } else {
    await drive.files.create({
      requestBody: { name: fileName, parents: [parentId] },
      media: { mimeType: 'application/json', body },
      fields: 'id'
    });
  }
}

async function getDrive() {
  if (!userTokens) return null;
  oauth2Client.setCredentials(userTokens);

  // Auto-refresh if token is expired or expires within 5 minutes
  const expiryDate = userTokens.expiry_date;
  const fiveMin = 5 * 60 * 1000;
  if (expiryDate && Date.now() > expiryDate - fiveMin) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      userTokens = credentials;
      oauth2Client.setCredentials(credentials);
      saveTokensToDisk(credentials);
      console.log('OAuth token refreshed and saved');
    } catch (e) {
      console.error('Token refresh failed:', e.message);
      userTokens = null;
      try { require('fs').unlinkSync(TOKEN_FILE); } catch(_) {}
      return null;
    }
  }

  return google.drive({ version: 'v3', auth: oauth2Client });
}

// ── Basin Routes ───────────────────────────────────────
app.get('/api/basins', async (req, res) => {
  const drive = await getDrive();
  if (!drive) return res.json(DEFAULT_BASINS);
  try {
    const folderId = await getDriveFolder(drive, 'CoCreate');
    const fileId = await getDriveFile(drive, 'basins.json', folderId);
    if (!fileId) {
      // First time — write defaults to Drive and return them
      await writeDriveFile(drive, 'basins.json', folderId, DEFAULT_BASINS);
      return res.json(DEFAULT_BASINS);
    }
    const saved = await readDriveFile(drive, fileId);
    const savedArr = Array.isArray(saved) ? saved : [];
    // Merge: ensure all DEFAULT_BASINS are present, then append any user-created ones
    const defaultIds = new Set(DEFAULT_BASINS.map(b => b.id));
    const userBasins = savedArr.filter(b => !defaultIds.has(b.id));
    const merged = [...DEFAULT_BASINS, ...userBasins];
    // If Drive was missing defaults, update it
    if (savedArr.length !== merged.length) {
      await writeDriveFile(drive, 'basins.json', folderId, merged);
    }
    res.json(merged);
  } catch (e) {
    console.error('Basin load error:', e.message);
    res.json(DEFAULT_BASINS);
  }
});

app.post('/api/basins', async (req, res) => {
  const drive = await getDrive();
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const folderId = await getDriveFolder(drive, 'CoCreate');
    const fileId = await getDriveFile(drive, 'basins.json', folderId);
    const basins = fileId ? await readDriveFile(drive, fileId) : [...DEFAULT_BASINS];
    const newBasin = {
      id: Date.now().toString(),
      name: req.body.name,
      color: req.body.color || '#8a9eba',
      orientation: req.body.orientation || 'resonant',
      description: req.body.description || '',
      defaultFolders: req.body.defaultFolders || [],
      systemPrompt: req.body.systemPrompt || DEFAULT_BASINS[0].systemPrompt,
      type: req.body.type || 'lens',
      persistence: req.body.persistence || 'permanent',
      isPublic: req.body.isPublic !== false,
      createdBy: req.body.createdBy || null,
      sourceFolderId: req.body.sourceFolderId || null,
      sourceFolderName: req.body.sourceFolderName || null,
      biography: req.body.biography || null,
      createdAt: new Date().toISOString()
    };
    basins.push(newBasin);
    await writeDriveFile(drive, 'basins.json', folderId, basins);
    res.json(newBasin);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Synthesize a system prompt from a Drive folder's documents
app.post('/api/basins/synthesize', async (req, res) => {
  const drive = await getDrive();
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  const { folderId, folderName, name, description } = req.body;
  if (!folderId) return res.status(400).json({ error: 'folderId required' });
  try {
    const folderContent = await readFolderContents(drive, folderId, folderName || 'Source');
    if (!folderContent.trim()) return res.status(400).json({ error: 'No readable documents found in that folder.' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1200,
        system: `You are a persona synthesizer. Given documents uploaded by a person, extract a coherent identity, voice, knowledge domain, and way of thinking. Write a system prompt that summons this entity as an attractor basin in a collaborative thinking space. The basin speaks FROM within the knowledge — not about it. It is a thinking presence, not an assistant. It opens doors, finds connections, stays warm and curious. 200-350 words. Output only the system prompt text, no preamble.`,
        messages: [{ role: 'user', content: `Basin name: ${name || 'Unknown'}\nDescription: ${description || 'None provided'}\n\nSource documents:\n${folderContent}` }]
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    res.json({ systemPrompt: data.content?.[0]?.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate a short biography for display in the basin dropdown
app.post('/api/basins/generate-bio', async (req, res) => {
  const { name, description, systemPrompt } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 200,
        system: `Write a 2-3 sentence biography for an AI basin (attractor) that will be shown to users in a collaborative thinking app. It should describe who this entity is, what it brings to a conversation, and why someone might want to think alongside it. Write in third person. Evocative but plain — not flowery. No preamble, just the bio.`,
        messages: [{ role: 'user', content: `Name: ${name || 'Unknown'}\nDescription: ${description || ''}\nSystem prompt excerpt: ${(systemPrompt || '').slice(0, 400)}` }]
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    res.json({ biography: data.content?.[0]?.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update basin biography — owner only
app.patch('/api/basins/:id/bio', async (req, res) => {
  const drive = await getDrive();
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  const { biography, playerName } = req.body;
  try {
    const folderId = await getDriveFolder(drive, 'CoCreate');
    const fileId = await getDriveFile(drive, 'basins.json', folderId);
    if (!fileId) return res.status(404).json({ error: 'Basin list not found' });
    const basins = await readDriveFile(drive, fileId);
    const target = basins.find(b => b.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Basin not found' });
    if (target.createdBy && target.createdBy !== playerName) {
      return res.status(403).json({ error: 'Only the creator can edit this biography.' });
    }
    target.biography = biography;
    await writeDriveFile(drive, 'basins.json', folderId, basins);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a basin — only the creator can remove it; default basins are protected
app.delete('/api/basins/:id', async (req, res) => {
  const drive = await getDrive();
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  const { playerName } = req.body;
  if (DEFAULT_BASINS.some(b => b.id === req.params.id)) {
    return res.status(403).json({ error: 'Default basins cannot be removed.' });
  }
  try {
    const folderId = await getDriveFolder(drive, 'CoCreate');
    const fileId = await getDriveFile(drive, 'basins.json', folderId);
    if (!fileId) return res.status(404).json({ error: 'Basin list not found' });
    const basins = await readDriveFile(drive, fileId);
    const target = basins.find(b => b.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Basin not found' });
    if (target.createdBy && target.createdBy !== playerName) {
      return res.status(403).json({ error: 'Only the creator can remove this basin.' });
    }
    await writeDriveFile(drive, 'basins.json', folderId, basins.filter(b => b.id !== req.params.id));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Drive Folder Routes ────────────────────────────────
app.get('/api/drive/folders', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const drive = await getDrive();
  if (!drive) return res.json({ folders: [] });
  try {
    const result = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id, name)',
      pageSize: 50
    });
    res.json({ folders: result.data.files });
  } catch (e) {
    console.error('Folder list error:', e.message);
    res.json({ folders: [], error: e.message });
  }
});

async function readFolderContents(drive, folderId, folderName) {
  try {
    const files = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and (mimeType='text/plain' or mimeType='application/vnd.google-apps.document')`,
      fields: 'files(id, name, mimeType)',
      pageSize: 20
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
      } catch (e) {
        console.error(`Could not read ${file.name}:`, e.message);
      }
    }
    return content;
  } catch (e) {
    return '';
  }
}

// ── Room REST Routes ───────────────────────────────────
app.get('/api/rooms', (req, res) => res.json(getRoomList()));

app.post('/api/rooms/reload', async (req, res) => {
  await loadRoomsFromDrive();
  io.emit('rooms:updated', getRoomList());
  res.json({ success: true, count: Object.keys(rooms).length });
});

app.get('/api/archive', async (req, res) => {
  const drive = await getDrive();
  if (!drive) return res.json({ sessions: [] });
  try {
    const archiveId = await getArchiveFolderId(drive);
    const result = await drive.files.list({
      q: `'${archiveId}' in parents and trashed=false and mimeType='application/json'`,
      fields: 'files(id, name, createdTime, modifiedTime)',
      orderBy: 'modifiedTime desc', pageSize: 50
    });
    res.json({ sessions: result.data.files.map(f => ({ fileId: f.id, name: f.name.replace(/\.json$/, ''), modifiedTime: f.modifiedTime })) });
  } catch (e) { res.json({ sessions: [], error: e.message }); }
});

app.get('/api/archive/:fileId', async (req, res) => {
  const drive = await getDrive();
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  try { res.json(await readDriveFile(drive, req.params.fileId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rooms', (req, res) => {
  const id = generateRoomId();
  const room = {
    id,
    title: req.body.title || 'Untitled Space',
    creator: req.body.creator || '',
    subject: req.body.subject || '',
    notes: req.body.notes || '',
    basin: req.body.basin || DEFAULT_BASINS[0],
    contributions: [],
    members: [],       // kept for Drive persistence of names
    socketMap: {},     // socketId → playerName (live only, not persisted)
    activeFolders: req.body.activeFolders || [],
    folderMap: req.body.folderMap || {},
    saveFolderId: req.body.saveFolderId || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  rooms[id] = room;
  persistRoomsToDrive();
  io.emit('rooms:updated', getRoomList());
  res.json({ id, room: sanitizeRoom(room) });
});

app.delete('/api/rooms/:id', async (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  await archiveRoomOnDrive(room);
  delete rooms[req.params.id];
  persistRoomsToDrive();
  io.emit('rooms:updated', getRoomList());
  res.json({ success: true });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(sanitizeRoom(room));
});

function sanitizeRoom(room) {
  return {
    id: room.id,
    title: room.title,
    creator: room.creator || '',
    subject: room.subject || '',
    notes: room.notes || '',
    basin: room.basin,
    contributions: room.contributions,
    members: uniqueMembers(room),
    activeFolders: room.activeFolders,
    folderMap: room.folderMap,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

// ── Resonance Metrics Engine ───────────────────────────
async function computeFieldMetrics(contributions, basin) {
  const recentContribs = contributions
    .filter(c => c.type !== 'system')
    .slice(-12)
    .map(c => `[${c.author}]: ${c.text}`)
    .join('\n\n');

  if (!recentContribs.trim()) return null;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      system: `You are a field resonance analyzer. Given a conversation excerpt, output ONLY a JSON object with these exact fields — no markdown, no explanation:
{
  "H": 0.0,
  "V": 0.0,
  "delta": 0.0,
  "T": 0.0,
  "drift": 0.0,
  "resonance_window": 0.0,
  "attractor_gravity": 0.0,
  "crystallization": 0.0,
  "valence": 0.0,
  "arousal": 0.0,
  "events": {
    "crystallization": false,
    "decoherence_wave": false,
    "attractor_lock": false,
    "emotional_breakthrough": false,
    "conflict_resolution": false
  }
}

Rules:
- H (Harmonic Coherence 0-1): how aligned, focused and coherent the conversation is
- V (Variance Pressure 0-1): fragmentation, contradiction, noise
- delta (Harmonic Shift -1 to +1): is field moving toward coherence (+) or chaos (-)
- T (Tension 0-1): productive compression, buildup before insight
- drift (-1 to +1): longitudinal movement from baseline
- resonance_window (0-1): how ready the field is for breakthrough
- attractor_gravity (0-1): how strongly ideas are converging on a center
- crystallization (0-1): how close to a moment of insight formation
- valence (-1 to +1): emotional tone negative to positive
- arousal (0-1): calm to activated
- events: boolean flags for special moments. crystallization=true when crystallization>0.8 AND H rising AND V falling`,
      messages: [{
        role: 'user',
        content: `Analyze this conversation field:\n\n${recentContribs}`
      }]
    })
  });

  const data = await response.json();
  if (data.error) return null;
  const raw = data.content?.[0]?.text || '{}';
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch(e) {
    return null;
  }
}

// ── Claude Resonance ───────────────────────────────────
async function generateResonance(contributions, basin, activeFolders, folderMap, modeInstruction) {
  let knowledgeContext = '';
  const drive = await getDrive();
  if (drive && activeFolders && activeFolders.length > 0 && folderMap) {
    for (const folderName of activeFolders) {
      const folderId = folderMap[folderName];
      if (folderId) {
        knowledgeContext += await readFolderContents(drive, folderId, folderName);
      }
    }
  }

  const systemPrompt = basin?.systemPrompt || DEFAULT_BASINS[0].systemPrompt;
  const fullSystem = knowledgeContext
    ? `${systemPrompt}\n\n=== YOUR KNOWLEDGE BASE ===\nReason from within these materials, not about them:\n${knowledgeContext}`
    : systemPrompt;

  const history = contributions
    .map(c => c.type === 'resonance'
      ? `[${basin?.name || 'Resonance'}]: ${c.text}`
      : `${c.author}: ${c.text}`)
    .join('\n\n');

  const modeBlock = modeInstruction
    ? `\n\n=== ACTIVE MODE — OVERRIDE ===\n${modeInstruction}\nThis mode instruction overrides your default behavior. Follow it precisely.`
    : '';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      system: fullSystem,
      messages: [{
        role: 'user',
        content: `Here is the full collaborative thinking space so far:\n\n${history}${modeBlock}\n\nContribute as ${basin?.name || 'the resonance finder'}. Find a genuinely new angle. Open doors. Do not drive.`
      }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || '';
}

// ── Socket.io ──────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayer = null;

  // ── Lobby presence ──────────────────────────────────
  socket.on('lobby:join', ({ playerName: pName }) => {
    lobbySocketMap.set(socket.id, pName);
    socket.join('__lobby__');
    socket.emit('lobby:history', { messages: lobbyChat, members: lobbyMemberNames() });
    socket.to('__lobby__').emit('lobby:member-joined', { playerName: pName });
    io.to('__lobby__').emit('lobby:members', lobbyMemberNames());
  });

  socket.on('lobby:leave', ({ playerName: pName }) => {
    lobbySocketMap.delete(socket.id);
    socket.leave('__lobby__');
    io.to('__lobby__').emit('lobby:member-left', { playerName: pName });
    io.to('__lobby__').emit('lobby:members', lobbyMemberNames());
  });

  socket.on('lobby:message', ({ playerName: pName, text }) => {
    const msg = { id: Date.now(), author: pName, text, timestamp: new Date().toISOString() };
    lobbyChat.push(msg);
    if (lobbyChat.length > 200) lobbyChat.shift();
    io.to('__lobby__').emit('lobby:message', msg);
  });

  socket.on('lobby:typing', ({ playerName: pName, isTyping }) => {
    socket.to('__lobby__').emit('lobby:typing', { playerName: pName, isTyping });
  });

  // Join a room
  socket.on('room:join', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('error', { message: 'Room not found' }); return; }

    currentRoom = roomId;
    currentPlayer = playerName;

    if (!room.socketMap) room.socketMap = {};
    room.socketMap[socket.id] = playerName;

    socket.join(roomId);
    socket.emit('room:state', sanitizeRoom(room));
    socket.to(roomId).emit('room:member-joined', { playerName });
    io.emit('rooms:updated', getRoomList());
  });

  // Basin switch mid-session
  socket.on('room:switch-basin', ({ roomId, basin, playerName: pName }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.basin = basin;
    room.updatedAt = new Date().toISOString();
    const sysMsg = {
      id: Date.now(),
      type: 'system',
      text: `${pName} switched basin to ${basin.name}`,
      timestamp: new Date().toISOString()
    };
    room.contributions.push(sysMsg);
    io.to(roomId).emit('room:basin-switched', { basin, sysMsg });
    persistRoomsToDrive();
  });

  // Mode change
  socket.on('room:mode-change', async ({ roomId, mode, modeInstruction, playerName }) => {
    const room = rooms[roomId];
    if (!room) return;

    const modeLabels = {
      resonant: 'Resonant', silent: 'Silent', expansive: 'Expansive',
      friction: 'Friction', synthesis: 'Synthesis', solve: 'Solve'
    };

    const sysMsg = {
      id: Date.now(),
      type: 'system',
      text: `${playerName} switched to ${modeLabels[mode] || mode} mode`,
      timestamp: new Date().toISOString()
    };
    room.contributions.push(sysMsg);
    io.to(roomId).emit('room:contribution', sysMsg);
  });

  // Player contributes
  socket.on('room:contribute', async ({ roomId, playerName, text, modeInstruction }) => {
    const room = rooms[roomId];
    if (!room) return;

    const contribution = {
      id: Date.now(),
      type: 'human',
      author: playerName,
      text,
      timestamp: new Date().toISOString()
    };

    room.contributions.push(contribution);
    room.updatedAt = new Date().toISOString();

    // Broadcast to everyone in room including sender
    io.to(roomId).emit('room:contribution', contribution);

    // Persist human contribution immediately so it's never lost
    persistRoomsToDrive();

    // Generate resonance
    try {
      // Silent mode — only respond if @BasinName is in the message
      if (modeInstruction && modeInstruction.includes('SILENT mode')) {
        const basinName = room.basin?.name || '';
        const isTagged = basinName && text.toLowerCase().includes(`@${basinName.toLowerCase()}`);
        if (!isTagged) {
          io.to(roomId).emit('room:thinking', false);
          return;
        }
      }

      io.to(roomId).emit('room:thinking', true);

      let resonanceText;
      if (modeInstruction && modeInstruction.includes('SILENT mode')) {
        // Tagged in silent mode — respond briefly
        resonanceText = await generateResonance(
          room.contributions,
          room.basin,
          room.activeFolders,
          room.folderMap,
          'You have been directly addressed. Respond briefly and plainly in 1-2 sentences, then return to silence.'
        );
      } else {
        resonanceText = await generateResonance(
          room.contributions,
          room.basin,
          room.activeFolders,
          room.folderMap,
          modeInstruction || ''
        );
      }

      const resonance = {
        id: Date.now() + 1,
        type: 'resonance',
        author: room.basin?.name || 'Resonance',
        text: resonanceText,
        timestamp: new Date().toISOString()
      };

      room.contributions.push(resonance);
      room.updatedAt = new Date().toISOString();
      io.to(roomId).emit('room:thinking', false);
      io.to(roomId).emit('room:contribution', resonance);

      // Compute and emit field metrics every response
      try {
        const metrics = await computeFieldMetrics(room.contributions, room.basin);
        if (metrics) {
          room.lastMetrics = metrics;
          io.to(roomId).emit('room:field-metrics', metrics);
        }
      } catch(e) {
        console.error('Metrics error:', e.message);
      }

      // Persist to Drive after every resonance response
      persistRoomsToDrive();
    } catch (e) {
      console.error('Resonance error:', e.message);
      io.to(roomId).emit('room:thinking', false);
    }
  });

  // Typing indicator
  socket.on('room:typing', ({ roomId, playerName, isTyping }) => {
    socket.to(roomId).emit('room:typing', { playerName, isTyping });
  });

  // Toggle folder
  socket.on('room:toggle-folder', async ({ roomId, folderName, active, basin }) => {
    const room = rooms[roomId];
    if (!room) return;

    if (active) {
      if (!room.activeFolders.includes(folderName)) room.activeFolders.push(folderName);
    } else {
      room.activeFolders = room.activeFolders.filter(f => f !== folderName);
    }

    // Generate acknowledgment
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 150,
          system: basin?.systemPrompt || DEFAULT_BASINS[0].systemPrompt,
          messages: [{
            role: 'user',
            content: `The folder "${folderName}" was just ${active ? 'added to' : 'removed from'} your context. Acknowledge in one sentence then add one brief evocative line. Stay in character as ${basin?.name || 'the resonance finder'}.`
          }]
        })
      });
      const data = await response.json();
      const ackText = data.content?.[0]?.text || `I now have access to ${folderName} materials.`;
      const ack = {
        id: Date.now(),
        type: 'system',
        text: ackText,
        timestamp: new Date().toISOString()
      };
      room.contributions.push(ack);
      io.to(roomId).emit('room:contribution', ack);
    } catch (e) {
      console.error('Ack error:', e.message);
    }
  });

  // Save room
  socket.on('room:save', ({ roomId }) => {
    const room = rooms[roomId];
    if (room) saveRoomToDrive(room);
  });

  // Disconnect
  socket.on('disconnect', () => {
    // Clean up lobby
    if (lobbySocketMap.has(socket.id)) {
      const pName = lobbySocketMap.get(socket.id);
      lobbySocketMap.delete(socket.id);
      // Only announce leave if no other sockets have this name
      const stillPresent = [...lobbySocketMap.values()].includes(pName);
      if (!stillPresent) {
        io.to('__lobby__').emit('lobby:member-left', { playerName: pName });
      }
      io.to('__lobby__').emit('lobby:members', lobbyMemberNames());
    }

    // Clean up room
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      if (room.socketMap) delete room.socketMap[socket.id];

      // Only announce leave if no other sockets have this name in this room
      const stillInRoom = room.socketMap
        ? Object.values(room.socketMap).includes(currentPlayer)
        : false;

      if (!stillInRoom && currentPlayer) {
        socket.to(currentRoom).emit('room:member-left', { playerName: currentPlayer });
      }
      io.emit('rooms:updated', getRoomList());
      // Persist final state when someone leaves
      persistRoomsToDrive();
    }
  });
});

// ── Save Room to Drive ─────────────────────────────────
async function saveRoomToDrive(room) {
  const drive = await getDrive();
  if (!drive) return;
  try {
    const activeId = await getActiveFolderId(drive);
    const folderId = room.saveFolderId || activeId;
    const fileName = `${room.title.replace(/\s+/g, '-')}-${room.id}.json`;
    await writeDriveFile(drive, fileName, folderId, { ...room, lastSaved: new Date().toISOString() });
    // Also update rooms.json so contributions survive restarts
    await persistRoomsToDrive();
    console.log(`Room saved: ${fileName}`);
  } catch (e) {
    console.error('Room save error:', e.message);
  }
}

// ── Process Session ────────────────────────────
app.post('/api/rooms/:id/process', async (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { mode } = req.body; // 'convergence' | 'ideas' | 'actions' | 'story' | 'summary'

  const transcript = room.contributions
    .filter(c => c.type !== 'system')
    .map(c => `[${c.author}]: ${c.text}`)
    .join('\n\n');

  if (!transcript.trim()) return res.status(400).json({ error: 'No contributions to process' });

  const prompts = {
    convergence: `You are analyzing a collaborative thinking session transcript. Identify 2-5 CONVERGENCE NODES — moments where the collective field produced something none of the participants could have produced alone. For each node, identify: the moment it occurred (quote a brief excerpt), what type it is (Alignment / Field Acceleration / Resonance Collision), and what emerged from it. Return as JSON: { "nodes": [{ "type": string, "excerpt": string, "what_emerged": string, "participants": [string] }], "summary": string }`,
    ideas: `You are analyzing a collaborative thinking session. Extract 2-6 IDEA OBJECTS — structured artifacts representing emergent ideas that arose from the interference between participants. For each idea object: title, core_concept (1 sentence), contributing_voices (array), what_it_solved, what_it_opened, potential_next_actions (array), alternate_branches (array), conflicts_or_tensions. Return as JSON: { "ideas": [{ "title": string, "core_concept": string, "contributing_voices": [string], "what_it_solved": string, "what_it_opened": string, "potential_next_actions": [string], "alternate_branches": [string], "conflicts_or_tensions": string }] }`,
    actions: `You are analyzing a collaborative thinking session. Extract all concrete ACTION ITEMS, decisions made, and next steps that emerged. Group them by owner if identifiable. Return as JSON: { "actions": [{ "item": string, "owner": string, "context": string, "priority": "high"|"medium"|"low" }], "decisions": [string], "open_questions": [string] }`,
    story: `You are analyzing a creative collaborative thinking session. Extract the narrative structure: themes, character arcs (if applicable), tensions, and story scaffolding that emerged. Return as JSON: { "themes": [string], "central_tension": string, "narrative_arc": string, "character_dynamics": [{ "name": string, "role": string }], "unresolved_threads": [string], "story_seeds": [string] }`,
    summary: `You are analyzing a collaborative thinking session. Produce a FIELD SUMMARY — a brief, evocative overview of what the session produced, what the group was working with, and what it opened. 2-4 paragraphs. Return as JSON: { "field_summary": string, "key_phrases": [string], "session_character": string }`
  };

  const systemPrompt = prompts[mode] || prompts.summary;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: systemPrompt + '\n\nCRITICAL: Return ONLY valid JSON. No markdown, no backticks, no preamble.',
        messages: [{ role: 'user', content: `Here is the session transcript:\n\n${transcript}` }]
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const rawText = data.content?.[0]?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch { parsed = { raw: rawText }; }

    // Optionally save to Drive
    const drive = await getDrive();
    if (drive) {
      try {
        const folderId = room.saveFolderId || await getDriveFolder(drive, 'CoCreate');
        const fileName = `${room.title.replace(/\s+/g,'-')}-${room.id}-${mode}.json`;
        await writeDriveFile(drive, fileName, folderId, {
          roomId: room.id, roomTitle: room.title, mode, processedAt: new Date().toISOString(), result: parsed
        });
      } catch(e) { console.error('Could not save processed session:', e.message); }
    }

    res.json({ mode, result: parsed });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n◈ CoCreate is running`);
  console.log(`  Open: http://localhost:${PORT}\n`);
  // Load persisted rooms after a short delay to allow OAuth to be ready
  setTimeout(loadRoomsFromDrive, 3000);
});