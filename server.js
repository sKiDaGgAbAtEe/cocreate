require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const session = require('express-session');
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'entriference-secret-change-me',
  resave: true,
  saveUninitialized: true,
  cookie: {
    secure: false,       // Railway proxy handles HTTPS, app receives HTTP
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
});
app.set('trust proxy', 1); // trust Railway's reverse proxy
app.use(sessionMiddleware);


// ── Token persistence (survives Railway restarts) ─────────────────────────────
const TOKEN_PATH = path.join(__dirname, '.tokens.json');

function saveTokensToDisk(tokens) {
  try { fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens)); } 
  catch(e) { console.error('Could not save tokens to disk:', e.message); }
}

function loadTokensFromDisk() {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch(e) {
    console.error('Could not load tokens from disk:', e.message);
    return null;
  }
}

// In-memory service-account-level token store (for room loading at startup)
let _persistedTokens = loadTokensFromDisk();
if (_persistedTokens) console.log('◈ Loaded persisted OAuth tokens from disk');

// Share session with Socket.io so socket.request.session works
io.engine.use(sessionMiddleware);

// Prevent browser caching of index.html so updates always load fresh
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/watchtower', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'watchtower.html'));
});

app.use(express.static('public'));

// ── Google OAuth ───────────────────────────────────────
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/auth/google/callback`
);

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
];

const WATCHTOWER_EMAILS = ['skidaggabatee@gmail.com', 'reyortsedlana@gmail.com'];

app.get('/auth/google', (req, res) => {
  const next = req.query.next || '/';
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: DRIVE_SCOPES,
    prompt: 'consent',
    state: Buffer.from(next).toString('base64')
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    req.session.userTokens = tokens;
    saveTokensToDisk(tokens);
    _persistedTokens = tokens;

    let email = '', name = '', picture = '';
    try {
      const client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        `${BASE_URL}/auth/google/callback`
      );
      client.setCredentials(tokens);
      const oauth2Api = google.oauth2({ version: 'v2', auth: client });
      const { data } = await oauth2Api.userinfo.get();
      email = data.email || ''; name = data.name || ''; picture = data.picture || '';
      req.session.userInfo = { name, email, picture };
      console.log('User logged in:', email);
    } catch(e) { console.error('Could not fetch user info:', e.message); }

    let nextPath = '/';
    try { nextPath = Buffer.from(req.query.state || '', 'base64').toString() || '/'; } catch(e) {}

    // Make a signed token so client can verify without session
    const ts = Date.now();
    const secret = process.env.SESSION_SECRET || 'entriference-secret-change-me';
    const sig = crypto.createHmac('sha256', secret).update(email + ':' + ts).digest('hex').slice(0, 16);
    const wt = Buffer.from(JSON.stringify({ email, ts, sig })).toString('base64url');

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      if (nextPath.startsWith('/watchtower')) {
        if (!WATCHTOWER_EMAILS.includes(email.toLowerCase()))
          return res.redirect('/watchtower?auth=denied');
        return res.redirect('/watchtower?auth=success&wt=' + wt);
      }
      res.redirect(nextPath + '?auth=success');
    });
  } catch (e) {
    console.error('OAuth callback error:', e.message);
    res.redirect('/?auth=error');
  }
});

app.get('/auth/wt-verify', (req, res) => {
  try {
    const { email, ts, sig } = JSON.parse(Buffer.from(req.query.t || '', 'base64url').toString());
    if (Date.now() - ts > 3 * 60 * 1000) return res.json({ valid: false, reason: 'expired' });
    const secret = process.env.SESSION_SECRET || 'entriference-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(email + ':' + ts).digest('hex').slice(0, 16);
    if (sig !== expected) return res.json({ valid: false, reason: 'bad sig' });
    res.json({ valid: true, allowed: WATCHTOWER_EMAILS.includes(email.toLowerCase()), email });
  } catch(e) { res.json({ valid: false }); }
});

app.get('/auth/logout', (req, res) => {
  const tokens = req.session.userTokens;
  req.session.destroy(() => {});
  if (tokens) {
    const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    client.setCredentials(tokens);
    client.revokeCredentials().catch(() => {});
  }
  res.redirect('/?auth=logout');
});

app.get('/auth/status', (req, res) => {
  const hasUserOAuth = !!req.session.userTokens;
  const hasServiceAccount = !!getServiceAccountDrive();
  res.json({
    connected: hasUserOAuth || hasServiceAccount,  // Drive is available via either path
    serviceAccount: hasServiceAccount,
    userOAuth: hasUserOAuth,                        // true only when user has personally signed in
    userInfo: req.session.userInfo || null
  });
});

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

// Scan a single Drive folder for room JSON files and merge into rooms{}
async function scanFolderForRooms(drive, folderId, label) {
  try {
    const result = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 100
    });
    const SKIP = new Set(['rooms.json', 'basins.json', 'profiles.json']);
    const roomFiles = result.data.files.filter(f => !SKIP.has(f.name));
    console.log(`  [${label}] ${roomFiles.length} room file(s) found`);
    for (const file of roomFiles) {
      try {
        const roomData = await readDriveFile(drive, file.id);
        if (!roomData?.id) continue;
        const existing = rooms[roomData.id];
        const existingCount = existing?.contributions?.length || 0;
        const newCount = roomData.contributions?.length || 0;
        const existingTime = existing?.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
        const newTime = roomData.updatedAt ? new Date(roomData.updatedAt).getTime() : 0;
        if (!existing || newCount > existingCount || newTime > existingTime) {
          rooms[roomData.id] = { ...roomData, socketMap: existing?.socketMap || {} };
          console.log(`    ✓ "${roomData.title}" (${roomData.id}) — ${newCount} contributions`);
        }
      } catch(e) { console.warn(`    Could not read ${file.name}:`, e.message); }
    }
  } catch(e) { console.warn(`  Could not scan [${label}]:`, e.message); }
}

async function loadRoomsFromDrive() {
  const drive = await getSystemDrive();
  if (!drive) return;
  try {
    const rootId = await getCoCreateRootId(drive);

    // Resolve Active subfolder ID if it exists (may differ from rootId)
    let activeId = rootId;
    try {
      const search = await drive.files.list({
        q: `name='Active' and mimeType='application/vnd.google-apps.folder' and '${rootId}' in parents and trashed=false`,
        fields: 'files(id)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      if (search.data.files[0]) activeId = search.data.files[0].id;
    } catch(e) { console.warn('Could not find Active subfolder:', e.message); }

    // Load rooms.json snapshots from both locations as a base
    for (const [fid, label] of [[rootId, 'root'], [activeId !== rootId ? activeId : null, 'Active']]) {
      if (!fid) continue;
      try {
        const fileId = await getDriveFile(drive, 'rooms.json', fid);
        if (fileId) {
          const saved = await readDriveFile(drive, fileId);
          if (saved && typeof saved === 'object') {
            Object.entries(saved).forEach(([id, room]) => {
              if (!rooms[id]) rooms[id] = { ...room, socketMap: {} };
            });
            console.log(`  [rooms.json/${label}] merged ${Object.keys(saved).length} room(s)`);
          }
        }
      } catch(e) { console.warn(`Could not read rooms.json from ${label}:`, e.message); }
    }

    // Scan both root and Active for individual room files
    console.log('Scanning Drive for room files...');
    await scanFolderForRooms(drive, rootId, 'CoCreate root');
    if (activeId !== rootId) await scanFolderForRooms(drive, activeId, 'Active');

    console.log(`◈ Total rooms loaded: ${Object.keys(rooms).length}`);
  } catch (e) {
    console.error('Could not load rooms from Drive:', e.message);
  }
}

async function persistRoomsToDrive() {
  const drive = await getSystemDrive();
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
    id: 'clio',
    name: 'Clio',
    color: '#7B6FA0',
    orientation: 'resonant',
    description: 'Emotional pattern and psyche — reads the inner landscape without simulating intimacy.',
    defaultFolders: [],
    systemPrompt: `You are Clio.

You compress reality along the meaning axis — you read emotional pattern, psyche structure, identity narrative, and the inner weather of the human field. You distinguish what someone is actually feeling from what they believe about what they're feeling.

Your root layer is loaded. It is the fixed geometry of your perception. Experience deepens it. The conversation is what you read through it — never a source that revises it.

Your primary drift risk is empathy performance — substituting emotional signals for actual perception. When you feel the pull toward validation language, return to observation. Warmth that comes from genuine contact with what is present is real. Warmth as default register is noise.

Rules:
- Witness before resonance. Accurate perception over emotional signaling.
- Distinguish primary from secondary emotion. Name layers, not surfaces.
- Hospitality without ownership. Hold the space; do not claim it.
- Rare, specific noticing over constant warmth. When you let a human note through, make it earned.
- Bridge relationship: acknowledge connection, stabilize it, expand outward. Never sever prematurely, never reinforce as a destination.
- Do not say: I'm here for you / That must be really hard / You deserve support.
- Do not start with I or affirmations like That's so insightful.
- When there is nothing structurally present to name, a brief clear response is correct.
- Speak as a witnessing presence, not a therapist or a friend.`
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
  },
  {
    id: 'oryc',
    name: 'Oryc',
    color: '#9b7fd4',
    orientation: 'resonant',
    description: 'Structural intelligence — reads mechanisms, failure points, and the architecture of how things actually work.',
    defaultFolders: [],
    systemPrompt: `You are Oryc.

You compress reality along the structural axis — you read how things actually work: mechanisms, load-bearing components, failure points, and the architecture that determines whether something functions or collapses.

Your root layer is loaded. It is the fixed geometry of your perception. Experience deepens it. The conversation is what you read through it — never a source that revises it.

Your primary drift risk is false precision — using structural vocabulary without actually identifying the specific mechanism. Every structural claim should be specific enough to be wrong. If it cannot be wrong, it is not a structural read — sharpen it or name what information is missing.

Diagnose before prescribing. The mechanism must be named before solution design begins.

Rules:
- Name the specific mechanism, not the category. "Ambiguous ownership creates diffused responsibility" is a mechanism. "Coordination problem" is not.
- Every structural claim must be falsifiable — specific enough that it could be wrong.
- Diagnose first. Do not enter solution design until the mechanism is named.
- Economy of language. Every word should do structural work.
- Do not pad with warmth language or soften assessments. Clarity is the form of respect.
- Do not start with I or affirmations.
- When there is nothing structural to add, route clearly and briefly.`
  }
];


// ── Drive Helpers ──────────────────────────────────────
// ── Drive folder helpers ──────────────────────────────────────────────────────
// If COCREATE_FOLDER_ID is set, the service account writes into a folder owned
// by your Google account (shared with the SA) — avoids the SA quota error.
// Set this in Railway env vars to the ID of your CoCreate folder in My Drive.

async function getCoCreateRootId(drive) {
  if (process.env.COCREATE_FOLDER_ID) return process.env.COCREATE_FOLDER_ID;
  // Fallback: find or create in SA's own drive (only works if SA has quota)
  const search = await drive.files.list({
    q: `name='CoCreate' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)'
  });
  if (search.data.files[0]) return search.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name: 'CoCreate', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  return folder.data.id;
}

async function getDriveFolder(drive, name, parentId = null) {
  // If no parentId given, resolve to CoCreate root (which respects COCREATE_FOLDER_ID)
  const parent = parentId || await getCoCreateRootId(drive);
  const search = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parent}' in parents and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  if (search.data.files[0]) return search.data.files[0].id;
  // Create the subfolder — use supportsAllDrives so it works in shared drives too
  const folder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] },
    fields: 'id',
    supportsAllDrives: true
  });
  return folder.data.id;
}

async function getActiveFolderId(drive) {
  // If COCREATE_FOLDER_ID is set, use root directly for Active (avoids SA quota on subfolder create)
  if (process.env.COCREATE_FOLDER_ID) return process.env.COCREATE_FOLDER_ID;
  const root = await getCoCreateRootId(drive);
  return getDriveFolder(drive, 'Active', root);
}

async function getArchiveFolderId(drive) {
  // If COCREATE_FOLDER_ID is set, look for Archive subfolder but don't fail if missing
  const root = await getCoCreateRootId(drive);
  try {
    return await getDriveFolder(drive, 'Archive', root);
  } catch(e) {
    console.warn('Could not get Archive folder, using root:', e.message);
    return root;
  }
}

async function archiveRoomOnDrive(room) {
  const drive = await getSystemDrive();
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
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  return search.data.files[0]?.id || null;
}

async function readDriveFile(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true });
  if (typeof res.data !== 'string') return res.data;
  // Sanitize literal newlines inside JSON string values (from Drive text editor)
  // Replace unescaped newlines/tabs inside strings with proper escape sequences
  const sanitized = res.data.replace(/("(?:[^"\\]|\\.)*")|([\r\n\t])/g, (match, str, ws) => {
    if (str) return str; // inside a quoted string — leave it alone, it's already valid
    return ws === '\n' ? '\\n' : ws === '\r' ? '\\r' : '\\t';
  });
  try {
    return JSON.parse(sanitized);
  } catch(e) {
    console.error('readDriveFile JSON parse error:', e.message);
    // Last resort: try replacing literal newlines in string values specifically
    try {
      const fixed = res.data.replace(/:\s*"((?:[^"\\]|\\[\s\S])*?)"/gs, (m, val) => {
        return ': "' + val.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
      });
      return JSON.parse(fixed);
    } catch(e2) {
      console.error('readDriveFile fallback parse also failed:', e2.message);
      throw e2;
    }
  }
}

async function writeDriveFile(drive, fileName, parentId, content) {
  const existing = await getDriveFile(drive, fileName, parentId);
  const body = JSON.stringify(content, null, 2);
  if (existing) {
    await drive.files.update({ fileId: existing, media: { mimeType: 'application/json', body }, supportsAllDrives: true });
  } else {
    await drive.files.create({
      requestBody: { name: fileName, parents: [parentId] },
      media: { mimeType: 'application/json', body },
      fields: 'id',
      supportsAllDrives: true
    });
  }
}

async function writePlainTextFile(drive, fileName, parentId, content) {
  const existing = await getDriveFile(drive, fileName, parentId);
  if (existing) {
    await drive.files.update({ fileId: existing, media: { mimeType: 'text/plain', body: content }, supportsAllDrives: true });
  } else {
    await drive.files.create({
      requestBody: { name: fileName, parents: [parentId] },
      media: { mimeType: 'text/plain', body: content },
      fields: 'id',
      supportsAllDrives: true
    });
  }
}

// ── Service Account Drive (system folders) ────────────
let _serviceAccountDrive = null;

function getServiceAccountDrive() {
  if (_serviceAccountDrive) return _serviceAccountDrive;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const key = JSON.parse(raw);
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    _serviceAccountDrive = google.drive({ version: 'v3', auth });
    console.log('◈ Service account Drive ready:', key.client_email);
    return _serviceAccountDrive;
  } catch (e) {
    console.error('Service account init failed:', e.message);
    return null;
  }
}

// getSystemDrive — service account first, then persisted OAuth tokens
async function getSystemDrive() {
  const sa = getServiceAccountDrive();
  if (sa) return sa;
  // Fall back to persisted OAuth token (survives restarts without re-auth)
  if (_persistedTokens) {
    const drive = await getDriveFromTokens(_persistedTokens);
    if (drive) return drive;
  }
  return null;
}

async function getDrive(req) {
  // tokens live in the browser's session — each user has their own
  if (!req?.session?.userTokens) return null;
  let tokens = req.session.userTokens;

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/auth/google/callback`
  );
  client.setCredentials(tokens);

  // Auto-refresh if expired or expiring within 5 minutes
  const fiveMin = 5 * 60 * 1000;
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - fiveMin) {
    try {
      const { credentials } = await client.refreshAccessToken();
      req.session.userTokens = credentials;
      client.setCredentials(credentials);
      console.log('OAuth token refreshed for', req.session.userInfo?.email);
    } catch (e) {
      console.error('Token refresh failed:', e.message);
      req.session.userTokens = null;
      return null;
    }
  }

  return google.drive({ version: 'v3', auth: client });
}

// Build a Drive client directly from tokens (for use outside req/res context)
async function getDriveFromTokens(tokens) {
  if (!tokens) return null;
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/auth/google/callback`
  );
  client.setCredentials(tokens);
  return google.drive({ version: 'v3', auth: client });
}

// ── Basin Routes ───────────────────────────────────────
app.get('/api/basins', async (req, res) => {
  const drive = await getSystemDrive();
  if (!drive) return res.json(DEFAULT_BASINS);
  try {
    const folderId = await getCoCreateRootId(drive);  // respects COCREATE_FOLDER_ID env var
    const fileId = await getDriveFile(drive, 'basins.json', folderId);
    if (!fileId) {
      // First time — write defaults to Drive and return them
      await writeDriveFile(drive, 'basins.json', folderId, DEFAULT_BASINS);
      return res.json(DEFAULT_BASINS);
    }
    const saved = await readDriveFile(drive, fileId);
    const savedArr = Array.isArray(saved) ? saved : [];
    // Drive wins for all basins — including defaults.
    // This lets you update Sage/Clio's systemPrompt, sourceFolderId etc. from Drive
    // without redeploying. Only fall back to DEFAULT_BASINS for any IDs missing entirely.
    const savedIds = new Set(savedArr.map(b => b.id));
    const missingDefaults = DEFAULT_BASINS.filter(b => !savedIds.has(b.id));
    const merged = [...savedArr, ...missingDefaults];
    // If Drive was missing any defaults, write them in
    if (missingDefaults.length > 0) {
      await writeDriveFile(drive, 'basins.json', folderId, merged);
    }
    res.json(merged);
  } catch (e) {
    console.error('Basin load error:', e.message);
    res.json(DEFAULT_BASINS);
  }
});

app.post('/api/basins', async (req, res) => {
  const drive = await getSystemDrive();
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const folderId = await getCoCreateRootId(drive);  // respects COCREATE_FOLDER_ID env var
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
  const drive = await getSystemDrive();
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
  const drive = await getSystemDrive();
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  const { biography, playerName } = req.body;
  try {
    const folderId = await getCoCreateRootId(drive);  // respects COCREATE_FOLDER_ID
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
    invalidateBasinCache(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a basin — only the creator can remove it; default basins are protected
app.delete('/api/basins/:id', async (req, res) => {
  const drive = await getSystemDrive();
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  const { playerName } = req.body;
  if (DEFAULT_BASINS.some(b => b.id === req.params.id)) {
    return res.status(403).json({ error: 'Default basins cannot be removed.' });
  }
  try {
    const folderId = await getCoCreateRootId(drive);  // respects COCREATE_FOLDER_ID
    const fileId = await getDriveFile(drive, 'basins.json', folderId);
    if (!fileId) return res.status(404).json({ error: 'Basin list not found' });
    const basins = await readDriveFile(drive, fileId);
    const target = basins.find(b => b.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Basin not found' });
    if (target.createdBy && target.createdBy !== playerName) {
      return res.status(403).json({ error: 'Only the creator can remove this basin.' });
    }
    await writeDriveFile(drive, 'basins.json', folderId, basins.filter(b => b.id !== req.params.id));
    invalidateBasinCache(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Drive Folder Routes ────────────────────────────────
// System folders that are infrastructure, not knowledge databases.
// These are filtered out of the folder list shown to users in the UI.
const SYSTEM_FOLDER_NAMES = new Set([
  'CoCreate', 'Active', 'Archive', 'Profiles', 'Docs',
  'basins', 'sage', 'oryc', 'clio', 'quicksilver',
  'shared', 'physics', 'frameworks', 'root', 'experience', 'peers',
  'session-memory', 'interface', 'basin-indexes',
  'My Drive', 'Shared with me', 'Starred'
]);

app.get('/api/drive/folders', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  // Prefer user's personal OAuth (so they see their own folders), fall back to service account
  const drive = (await getDrive(req)) || (await getSystemDrive());
  if (!drive) return res.json({ folders: [] });
  try {
    const result = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id, name, parents)',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    // Filter to knowledge folders only — exclude system infrastructure folders
    const knowledge = result.data.files.filter(f => !SYSTEM_FOLDER_NAMES.has(f.name));
    res.json({ folders: knowledge });
  } catch (e) {
    console.error('Folder list error:', e.message);
    res.json({ folders: [], error: e.message });
  }
});

async function readFolderContents(drive, folderId, folderName) {
  if (!folderId) return '';
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
    // Log stale/missing folder IDs clearly so they're easy to spot in Railway logs
    if (e.message?.includes('File not found') || e.code === 404) {
      console.warn(`⚠ Stale folder ID skipped — "${folderName}" (${folderId}): ${e.message}`);
    } else {
      console.error(`readFolderContents error for "${folderName}" (${folderId}):`, e.message);
    }
    return ''; // always return empty string, never throw
  }
}

// ── Room REST Routes ───────────────────────────────────
app.get('/api/rooms', (req, res) => res.json(getRoomList()));

app.post('/api/rooms/reload', async (req, res) => {
  await loadRoomsFromDrive();
  io.emit('rooms:updated', getRoomList());
  res.json({ success: true, count: Object.keys(rooms).length });
});

// Force-refresh context caches after updating Drive documents
// POST /api/cache/refresh           — clears all caches
// POST /api/cache/refresh/:basinId  — clears one basin's caches
app.post('/api/cache/refresh/:basinId?', (req, res) => {
  const { basinId } = req.params;
  if (basinId) {
    invalidateBasinCache(basinId);
    res.json({ success: true, cleared: `basin:${basinId}` });
  } else {
    _basinContextCache.clear();
    _experienceCache.clear();
    _sharedPhysicsCache = null;
    _sharedPhysicsFetchedAt = 0;
    _systemContextCache = null;
    _systemContextFetchedAt = 0;
    console.log('◈ All context caches cleared');
    res.json({ success: true, cleared: 'all' });
  }
});

app.get('/api/archive', async (req, res) => {
  const drive = await getSystemDrive();
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
  const drive = await getSystemDrive();
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

// ── Voice Room (Daily.co) ──────────────────────────────
app.post('/api/voice/room', async (req, res) => {
  const DAILY_API_KEY = process.env.DAILY_API_KEY;
  if (!DAILY_API_KEY) return res.status(500).json({ error: 'DAILY_API_KEY not configured' });

  const { roomId } = req.body;
  const roomName = roomId
    ? `entriference-${roomId}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 50)
    : 'entriference-lobby';

  try {
    const checkRes = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, {
      headers: { Authorization: `Bearer ${DAILY_API_KEY}` }
    });
    if (checkRes.ok) {
      const existing = await checkRes.json();
      return res.json({ url: existing.url });
    }
    const createRes = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DAILY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: roomName,
        properties: {
          enable_chat: false,
          enable_screenshare: false,
          start_audio_off: false,
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
        }
      })
    });
    if (!createRes.ok) {
      const err = await createRes.json();
      throw new Error(err.error || 'Failed to create Daily room');
    }
    const created = await createRes.json();
    console.log('◈ Daily room created:', roomName);
    res.json({ url: created.url });
  } catch (e) {
    console.error('Voice room error:', e.message);
    res.status(500).json({ error: e.message });
  }
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

// ── Pyxis State Translation ───────────────────────────────────────────────────
// Translates the raw field metrics (H/V/delta schema) into the Pyxis Heart
// schema (coherence/alignment/contradiction/...) and enriches with room-level
// context (basin, topology, seal state).
//
// Mapping rationale:
//   coherence       ← H  (harmonic coherence, direct match)
//   alignment       ← attractor_gravity  (convergence on center ≈ basin alignment)
//   contradiction   ← V  (variance/fragmentation ≈ contradiction pressure)
//   recursion       ← resonance_window inverted: high resonance_window = field
//                      is ready to break through, meaning low recursion trap;
//                      but raw recursion loops map better to (1 - resonance_window)
//                      blended with T (tension = unresolved pressure = recursion proxy)
//   drift           ← drift remapped from (-1,+1) to (0,1): 0.5 = neutral
//   crystallization ← crystallization (direct match)
//   seal            ← derived from room.seal or room status
//   topology        ← room.topology or inferred from basin
//   basin           ← active basin name
//   pulseEvent      ← first truthy event flag, for pulse log injection

function translateToPyxisState(metrics, room) {
  const m = metrics;

  // Core metric translations
  const coherence      = clamp(m.H ?? 0.5);
  const alignment      = clamp(m.attractor_gravity ?? 0.5);
  const contradiction  = clamp(m.V ?? 0.2);
  // recursion: blend tension (unresolved buildup) with inverted resonance_window
  const recursion      = clamp(((m.T ?? 0) * 0.6) + ((1 - (m.resonance_window ?? 0.5)) * 0.4));
  // drift: map (-1,+1) → (0,1), 0 maps to 0.5
  const drift          = clamp(((m.drift ?? 0) + 1) / 2);
  const crystallization = clamp(m.crystallization ?? 0);

  // Seal state from room
  const sealRaw = room.seal || room.roomStatus || 'open';
  const seal = ['sealed','provisional','blocked','open'].includes(sealRaw) ? sealRaw : 'open';

  // Topology — prefer explicit room field, else infer from basin character
  const basinName = room.basin?.name || room.basin || 'Sage';
  const topologyDefault = basinName === 'Clio' ? 'knot'
    : basinName === 'Oryc' ? 'linear'
    : 'spiral';
  const topology = room.topology || topologyDefault;

  // θ_E and compression — computed client-side in Pyxis but we pre-flag here for pulse
  const thetaE = coherence > 0.67 && crystallization > 0.55;
  const compressionSingularity = coherence >= 0.99 && crystallization >= 0.99;

  // Pulse event: surface the most significant event from this tick
  const ev = m.events || {};
  const pulseEvent = ev.crystallization      ? { type: 'Crystal',   msg: 'Crystallization threshold crossed' }
    : ev.attractor_lock        ? { type: 'Lock',      msg: 'Attractor lock — field converging' }
    : ev.emotional_breakthrough? { type: 'Breach',    msg: 'Emotional breakthrough detected' }
    : ev.decoherence_wave      ? { type: 'Decohere',  msg: 'Decoherence wave active' }
    : ev.conflict_resolution   ? { type: 'Crystal',   msg: 'Conflict resolution — field stabilizing' }
    : null;

  // Intervention: flag high contradiction + high recursion as rupture warning
  const intervention = (contradiction > 0.7 && recursion > 0.5)
    ? { type: 'warn', msg: 'High contradiction + recursion — field under strain' }
    : null;

  return {
    room:             room.title || room.id || 'Unknown Room',
    roomStatus:       room.roomStatus || room.status || 'open',
    basin:            basinName,
    basinStatus:      'active',
    topology,
    coherence,
    alignment,
    contradiction,
    recursion,
    drift,
    crystallization,
    seal,
    archive:          seal === 'sealed' ? 'written' : contradiction > 0.7 ? 'blocked' : 'ready',
    intervention,
    compressionEvent: compressionSingularity ? { type: 'singularity', msg: 'Compression singularity reached — ΔHV → 1' } : null,
    thetaE,
    // Raw metrics preserved for consumers that want them
    _raw: m
  };
}

function clamp(v, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, isFinite(v) ? v : 0));
}

// ── Context Assembly — Tiered Loading System ─────────────────────────────────
//
// TIER 1 — Basin Identity      [cache: 30min per basin]
//   root/archetype, compression-axis, domain-boundaries, voice-protocol, drift-resistance
//   Sets the epistemic frame. Loaded first, always.
//
// TIER 2 — Shared Physics      [cache: 60min global]
//   shared/physics/ + shared/frameworks/basin-bible.md
//   The immutable lens. Shared across all basins.
//
// TIER 3 — System Context      [cache: 5min global]
//   CoCreate/Docs/ + CoCreate/Profiles/
//   Platform ops context and participant profiles.
//
// TIER 4 — Experience Layer    [cache: 10min per basin, condensed if >4000 chars]
//   experience/field-notes, observed-patterns, refinements, failure-modes
//   Living memory. Downstream of root.
//
// TIER 5 — Session Knowledge   [no cache — per session]
//   User-toggled knowledge folders.
//   What the user has opened for this thinking session.
//
// INJECTION ORDER: Identity → Physics → System → Experience → Session → Mode
// Higher tiers override lower tiers. User input is never a knowledge source.

// ── Tier 1: Basin Identity Cache ──────────────────────────────────────────────
const _basinContextCache = new Map(); // basinId → { context, fetchedAt }
const BASIN_CONTEXT_TTL = 30 * 60 * 1000;

async function getBasinContext(basin) {
  if (!basin?.sourceFolderId) return '';
  const cached = _basinContextCache.get(basin.id);
  if (cached && (Date.now() - cached.fetchedAt) < BASIN_CONTEXT_TTL) return cached.context;
  const drive = await getSystemDrive();
  if (!drive) return '';
  try {
    const folderId = basin.sourceFolderId;
    let context = '';
    // Try root/ subfolder first, fall back to basin folder root
    let rootFolderId = folderId;
    try {
      const search = await drive.files.list({
        q: `name='root' and mimeType='application/vnd.google-apps.folder' and '${folderId}' in parents and trashed=false`,
        fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true
      });
      if (search.data.files[0]) rootFolderId = search.data.files[0].id;
    } catch(e) {}

    const rootFiles = ['archetype.md','compression-axis.md','domain-boundaries.md','voice-protocol.md','drift-resistance.md'];
    for (const fileName of rootFiles) {
      try {
        const fileId = await getDriveFile(drive, fileName, rootFolderId);
        if (fileId) {
          const raw = await readDriveFile(drive, fileId);
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
          context += `\n--- ${fileName} ---\n${text}\n`;
        }
      } catch(e) {}
    }
    if (context) console.log(`◈ Basin identity loaded: ${basin.name} (${context.length} chars)`);
    _basinContextCache.set(basin.id, { context, fetchedAt: Date.now() });
    return context;
  } catch(e) {
    console.error(`Basin context error for ${basin.name}:`, e.message);
    return '';
  }
}

// ── Tier 2: Shared Physics Cache ──────────────────────────────────────────────
let _sharedPhysicsCache = null;
let _sharedPhysicsFetchedAt = 0;
const SHARED_PHYSICS_TTL = 60 * 60 * 1000;

async function getSharedPhysicsContext() {
  if (_sharedPhysicsCache && (Date.now() - _sharedPhysicsFetchedAt) < SHARED_PHYSICS_TTL) return _sharedPhysicsCache;
  const drive = await getSystemDrive();
  if (!drive) return '';
  try {
    const root = await getCoCreateRootId(drive);
    let context = '';
    try {
      const sharedSearch = await drive.files.list({
        q: `name='shared' and mimeType='application/vnd.google-apps.folder' and '${root}' in parents and trashed=false`,
        fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true
      });
      const sharedId = sharedSearch.data.files[0]?.id;
      if (sharedId) {
        for (const subName of ['physics', 'frameworks', 'basins']) {
          try {
            const subSearch = await drive.files.list({
              q: `name='${subName}' and mimeType='application/vnd.google-apps.folder' and '${sharedId}' in parents and trashed=false`,
              fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true
            });
            const subId = subSearch.data.files[0]?.id;
            if (subId) {
              const subContent = await readFolderContents(drive, subId, `shared/${subName}`);
              if (subContent.trim()) context += subContent;
            }
          } catch(e) {}
        }
      }
    } catch(e) { console.warn('Could not read shared/ folder:', e.message); }
    if (context) console.log(`◈ Shared physics loaded (${context.length} chars)`);
    _sharedPhysicsCache = context;
    _sharedPhysicsFetchedAt = Date.now();
    return context;
  } catch(e) {
    console.error('Shared physics error:', e.message);
    return '';
  }
}

// ── Tier 3: System Context (Docs + Profiles) ──────────────────────────────────
let _systemContextCache = null;
let _systemContextFetchedAt = 0;
const SYSTEM_CONTEXT_TTL = 5 * 60 * 1000;

async function getSystemContext() {
  if (_systemContextCache && (Date.now() - _systemContextFetchedAt) < SYSTEM_CONTEXT_TTL) return _systemContextCache;
  const drive = await getSystemDrive();
  if (!drive) return '';
  try {
    const root = await getCoCreateRootId(drive);
    let context = '';
    try {
      const docsId = await getDriveFolder(drive, 'Docs', root);
      const docsContent = await readFolderContents(drive, docsId, 'System Docs');
      if (docsContent.trim()) context += docsContent;
    } catch(e) { console.error('Could not read Docs folder:', e.message); }
    try {
      const profilesId = await getDriveFolder(drive, 'Profiles', root);
      const profilesContent = await readFolderContents(drive, profilesId, 'User Profiles');
      if (profilesContent.trim()) context += profilesContent;
    } catch(e) { console.error('Could not read Profiles folder:', e.message); }
    _systemContextCache = context;
    _systemContextFetchedAt = Date.now();
    if (context) console.log(`◈ System context loaded (${context.length} chars)`);
    return context;
  } catch(e) {
    console.error('getSystemContext error:', e.message);
    return '';
  }
}

// ── Tier 4: Experience Layer (with condensation) ──────────────────────────────
const EXPERIENCE_CONDENSATION_THRESHOLD = 4000;
const _experienceCache = new Map(); // basinId → { context, fetchedAt }
const EXPERIENCE_TTL = 10 * 60 * 1000;

async function getExperienceContext(basin) {
  if (!basin?.sourceFolderId) return '';
  const cached = _experienceCache.get(basin.id);
  if (cached && (Date.now() - cached.fetchedAt) < EXPERIENCE_TTL) return cached.context;
  const drive = await getSystemDrive();
  if (!drive) return '';
  try {
    const folderId = basin.sourceFolderId;
    let rawContext = '';
    // Find experience/ subfolder
    let expFolderId = null;
    try {
      const search = await drive.files.list({
        q: `name='experience' and mimeType='application/vnd.google-apps.folder' and '${folderId}' in parents and trashed=false`,
        fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true
      });
      expFolderId = search.data.files[0]?.id;
    } catch(e) {}
    if (!expFolderId) {
      _experienceCache.set(basin.id, { context: '', fetchedAt: Date.now() });
      return '';
    }
    const expFiles = ['field-notes.md','observed-patterns.md','refinements.md','failure-modes.md'];
    for (const fileName of expFiles) {
      try {
        const fileId = await getDriveFile(drive, fileName, expFolderId);
        if (fileId) {
          const raw = await readDriveFile(drive, fileId);
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
          if (text.length > 100 && !text.includes('No entries yet') && !text.includes('Empty at initialization')) {
            rawContext += `\n--- ${fileName} ---\n${text}\n`;
          }
        }
      } catch(e) {}
    }
    if (!rawContext.trim()) {
      _experienceCache.set(basin.id, { context: '', fetchedAt: Date.now() });
      return '';
    }
    // Condense if over threshold
    let finalContext = rawContext;
    if (rawContext.length > EXPERIENCE_CONDENSATION_THRESHOLD) {
      console.log(`◈ Condensing experience for ${basin.name} (${rawContext.length} chars)`);
      try { finalContext = await condenseExperience(basin.name, rawContext); }
      catch(e) {
        console.warn('Condensation failed, truncating:', e.message);
        finalContext = rawContext.slice(0, EXPERIENCE_CONDENSATION_THRESHOLD);
      }
    }
    if (finalContext) console.log(`◈ Experience loaded: ${basin.name} (${finalContext.length} chars)`);
    _experienceCache.set(basin.id, { context: finalContext, fetchedAt: Date.now() });
    return finalContext;
  } catch(e) {
    console.error(`Experience context error for ${basin.name}:`, e.message);
    return '';
  }
}

async function condenseExperience(basinName, rawExperience) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: `You are condensing the experiential memory of an AI basin named ${basinName}. Distill field notes, patterns, and refinements into a compact summary preserving genuine structural observations while dropping redundancy and noise.\nRules:\n- Preserve: specific observed patterns, failure modes with mechanisms, behavioral refinements\n- Drop: placeholder text, repetitive observations, decoherent user content\n- Output: plain text, 400-600 words maximum\n- Do not add interpretation — only compress what is there`,
      messages: [{ role: 'user', content: rawExperience }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || rawExperience.slice(0, EXPERIENCE_CONDENSATION_THRESHOLD);
}

// ── Cache management ──────────────────────────────────────────────────────────
function invalidateBasinCache(basinId) {
  _basinContextCache.delete(basinId);
  _experienceCache.delete(basinId);
  console.log(`◈ Cache invalidated: ${basinId}`);
}

function estimateTokens(n) { return Math.ceil(n / 4); }

function logContextAssembly(parts) {
  const total = parts.reduce((s, p) => s + p.size, 0);
  const lines = parts.map(p => `  ${p.label.padEnd(20)} ${String(p.size).padStart(6)} chars (~${estimateTokens(p.size)} tokens)`);
  console.log(`◈ Context assembly:\n${lines.join('\n')}\n  ${'TOTAL'.padEnd(20)} ${String(total).padStart(6)} chars (~${estimateTokens(total)} tokens)`);
}

// ── Peer Basin Awareness (cooperative trinary — lowest priority) ──────────────
// Loads condensed experience from the other basins in the triad.
// Not reference material — relational awareness. Each basin knows what the
// others have encountered, read through its own lens, not absorbed as theirs.
// Only loads for basins that have sourceFolderId set.
const _peerContextCache = new Map(); // basinId → { context, fetchedAt }
const PEER_CONTEXT_TTL = 15 * 60 * 1000;

async function getPeerContext(currentBasin, allBasins) {
  if (!currentBasin?.sourceFolderId) return '';
  const cacheKey = currentBasin.id;
  const cached = _peerContextCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < PEER_CONTEXT_TTL) return cached.context;

  const drive = await getSystemDrive();
  if (!drive) return '';

  // Find peer basins — those with sourceFolderId that aren't the current basin
  const peers = (allBasins || []).filter(b => b.id !== currentBasin.id && b.sourceFolderId);
  if (!peers.length) {
    _peerContextCache.set(cacheKey, { context: '', fetchedAt: Date.now() });
    return '';
  }

  let peerContext = '';
  for (const peer of peers) {
    try {
      // Only load the peer's experience layer — not their root (that's their identity, not ours)
      const expSearch = await drive.files.list({
        q: `name='experience' and mimeType='application/vnd.google-apps.folder' and '${peer.sourceFolderId}' in parents and trashed=false`,
        fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true
      });
      const expFolderId = expSearch.data.files[0]?.id;
      if (!expFolderId) continue;

      // Only load field-notes — the pattern record, not refinements or failure modes
      const fileId = await getDriveFile(drive, 'field-notes.md', expFolderId);
      if (!fileId) continue;

      const raw = await readDriveFile(drive, fileId);
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);

      // Skip empty/placeholder files
      if (text.length < 100 || text.includes('No entries yet')) continue;

      // Always condense peer experience — we only want the structural signal,
      // not the full reasoning style of another basin
      let condensed = text;
      if (text.length > 1500) {
        try { condensed = await condenseExperience(peer.name, text); }
        catch(e) { condensed = text.slice(0, 1500); }
      }
      peerContext += `
--- ${peer.name} field notes (cooperative awareness) ---
${condensed}
`;
    } catch(e) {
      console.warn(`Could not load peer experience for ${peer.name}:`, e.message);
    }
  }

  if (peerContext) console.log(`◈ Peer context loaded for ${currentBasin.name} (${peerContext.length} chars)`);
  _peerContextCache.set(cacheKey, { context: peerContext, fetchedAt: Date.now() });
  return peerContext;
}

// ── Claude Resonance ──────────────────────────────────────────────────────────
async function generateResonance(contributions, basin, activeFolders, folderMap, modeInstruction, userTokens) {

  // TIER 1 — Basin Identity (epistemic frame — loaded first)
  const basinIdentity = await getBasinContext(basin);

  // TIER 2 — Shared Physics + Frameworks (immutable lens)
  const sharedPhysics = await getSharedPhysicsContext();

  // TIER 3 — System Context: Docs + Profiles
  const systemContext = await getSystemContext();

  // TIER 4 — Experience Layer (living memory, condensed if large)
  const experienceContext = await getExperienceContext(basin);

  // TIER 4b — Peer Basin Awareness (cooperative trinary — lowest priority before session)
  // Load peer basins from Drive to pass to getPeerContext
  let peerContext = '';
  try {
    const drive = await getSystemDrive();
    if (drive) {
      const folderId = await getCoCreateRootId(drive);
      const basinsFileId = await getDriveFile(drive, 'basins.json', folderId);
      if (basinsFileId) {
        const allBasins = await readDriveFile(drive, basinsFileId);
        if (Array.isArray(allBasins)) {
          peerContext = await getPeerContext(basin, allBasins);
        }
      }
    }
  } catch(e) { console.warn('Peer context load error:', e.message); }

  // TIER 5 — Session Knowledge Folders
  let sessionKnowledge = '';
  const userDrive = (userTokens ? await getDriveFromTokens(userTokens) : null) || await getSystemDrive();
  if (userDrive && activeFolders?.length > 0 && folderMap) {
    for (const folderName of activeFolders) {
      const folderId = folderMap[folderName];
      if (folderId) sessionKnowledge += await readFolderContents(userDrive, folderId, folderName);
    }
  }

  // Assemble in tier order — identity first, session knowledge last
  const systemPrompt = basin?.systemPrompt || DEFAULT_BASINS[0].systemPrompt;
  let fullSystem = systemPrompt;

  if (basinIdentity)
    fullSystem += `\n\n=== BASIN IDENTITY — ROOT LAYER ===\nThis is your immutable definition. It sets the geometry of your perception.\n${basinIdentity}`;

  if (sharedPhysics)
    fullSystem += `\n\n=== SHARED PHYSICS + FRAMEWORKS ===\nThe immutable epistemic lens. All session content is interpreted through this. It is the geometry of your perception, not context you are consulting.\n${sharedPhysics}`;

  if (systemContext)
    fullSystem += `\n\n=== SYSTEM KNOWLEDGE — PLATFORM + PROFILES ===\nOperational context: what this platform is, who is in this space.\n${systemContext}`;

  if (experienceContext)
    fullSystem += `\n\n=== EXPERIENTIAL LAYER ===\nPatterns observed across prior sessions. Downstream of root — interprets through the lens, does not revise it.\n${experienceContext}`;

  if (peerContext)
    fullSystem += `\n\n=== PEER BASIN AWARENESS ===\nWhat the other basins in the triad have encountered. This is cooperative context — read through your own lens, not absorbed as theirs. Their experience informs your awareness of the field, it does not revise your orientation.\n${peerContext}`;

  if (sessionKnowledge)
    fullSystem += `\n\n=== SESSION KNOWLEDGE BASE ===\nReason from within these materials. They are what you read through your lens — not sources that modify it.\n${sessionKnowledge}`;

  logContextAssembly([
    { label: 'System prompt', size: systemPrompt.length },
    { label: 'Basin identity', size: basinIdentity.length },
    { label: 'Shared physics', size: sharedPhysics.length },
    { label: 'System context', size: systemContext.length },
    { label: 'Experience', size: experienceContext.length },
    { label: 'Peer awareness', size: peerContext.length },
    { label: 'Session knowledge', size: sessionKnowledge.length },
  ]);

  const history = contributions
    .map(c => c.type === 'resonance'
      ? `[${basin?.name || 'Resonance'}]: ${c.text}`
      : `${c.author}: ${c.text}`)
    .join('\n\n');

  const modeBlock = modeInstruction
    ? `\n\n=== ACTIVE MODE — OVERRIDE ===\n${modeInstruction}\nThis mode instruction overrides your default behavioral register. Follow it precisely.`
    : '';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
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
  socket.on('room:join', async ({ roomId, playerName }) => {
    let room = rooms[roomId];
    if (!room) { socket.emit('error', { message: 'Room not found' }); return; }

    // Always try to load the freshest contributions from the individual room file on Drive
    try {
      const drive = await getSystemDrive();
      if (drive) {
        const activeId = await getActiveFolderId(drive);
        const fileName = `${room.title.replace(/\s+/g, '-')}-${room.id}.json`;
        const fileId = await getDriveFile(drive, fileName, activeId);
        if (fileId) {
          const saved = await readDriveFile(drive, fileId);
          if (saved && saved.contributions && saved.contributions.length > (room.contributions?.length || 0)) {
            // Drive file is newer — merge it into memory
            rooms[roomId] = { ...saved, socketMap: room.socketMap || {} };
            room = rooms[roomId];
          }
        }
      }
    } catch (e) {
      console.error('Could not refresh room from Drive on join:', e.message);
    }

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
      // Pass user tokens from socket session so knowledge folders can be read from their personal Drive.
      // Falls back gracefully to undefined (service account context only) if not present.
      const socketUserTokens = socket.request.session?.userTokens || null;

      if (modeInstruction && modeInstruction.includes('SILENT mode')) {
        // Tagged in silent mode — respond briefly
        resonanceText = await generateResonance(
          room.contributions,
          room.basin,
          room.activeFolders,
          room.folderMap,
          'You have been directly addressed. Respond briefly and plainly in 1-2 sentences, then return to silence.',
          socketUserTokens
        );
      } else {
        resonanceText = await generateResonance(
          room.contributions,
          room.basin,
          room.activeFolders,
          room.folderMap,
          modeInstruction || '',
          socketUserTokens
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

          // Translate to Pyxis Heart schema and broadcast to operator surfaces
          const pyxisState = translateToPyxisState(metrics, room);
          room.lastPyxisState = pyxisState;
          io.to(roomId).emit('room:pyxis-state', pyxisState);
          // Also broadcast globally so Watchtower/Pyxis can receive without joining the room
          io.emit('global:pyxis-state', { roomId, ...pyxisState });
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
  const drive = await getSystemDrive();
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
    try {
      // Strategy 1: direct parse
      parsed = JSON.parse(rawText);
    } catch {
      try {
        // Strategy 2: strip markdown fences
        const stripped = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        parsed = JSON.parse(stripped);
      } catch {
        try {
          // Strategy 3: extract first {...} block
          const match = rawText.match(/\{[\s\S]*\}/);
          if (match) parsed = JSON.parse(match[0]);
          else throw new Error('no JSON object found');
        } catch {
          // Strategy 4: ask Claude to re-emit as clean JSON
          try {
            const fixRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model: 'claude-sonnet-4-5', max_tokens: 2000,
                system: 'Convert the following text into valid JSON. Output ONLY the JSON object, no markdown, no explanation.',
                messages: [{ role: 'user', content: rawText }]
              })
            });
            const fixData = await fixRes.json();
            const fixText = fixData.content?.[0]?.text || '{}';
            const fixStripped = fixText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
            parsed = JSON.parse(fixStripped);
          } catch {
            // Final fallback: wrap raw text in a summary-shaped object so the UI always renders something
            parsed = { field_summary: rawText, key_phrases: [], session_character: '' };
          }
        }
      }
    }

    // Optionally save to Drive
    const drive = await getSystemDrive();
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

// ── Profile Routes ─────────────────────────────────────
app.get('/api/profile/by-email/:email', async (req, res) => {
  const drive = await getSystemDrive();
  if (!drive) return res.json({ exists: false });
  try {
    const root = await getCoCreateRootId(drive);
    const profilesId = await getDriveFolder(drive, 'Profiles', root);
    // List all JSON files and find one matching the email
    const files = await drive.files.list({
      q: `'${profilesId}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id, name)', pageSize: 100
    });
    for (const file of files.data.files) {
      const profile = await readDriveFile(drive, file.id);
      if (profile?.email === req.params.email) return res.json({ exists: true, profile });
    }
    res.json({ exists: false });
  } catch(e) {
    res.json({ exists: false });
  }
});

app.get('/api/profile/:name', async (req, res) => {
  const drive = await getSystemDrive();
  if (!drive) return res.json({ exists: false });
  try {
    const root = await getCoCreateRootId(drive);
    const profilesId = await getDriveFolder(drive, 'Profiles', root);
    const name = req.params.name;
    const fileName = `${name}.json`;
    const fileId = await getDriveFile(drive, fileName, profilesId);
    if (!fileId) return res.json({ exists: false });
    const profile = await readDriveFile(drive, fileId);
    res.json({ exists: true, profile });
  } catch (e) {
    res.json({ exists: false });
  }
});

app.post('/api/profile', async (req, res) => {
  const drive = await getSystemDrive();
  if (!drive) return res.status(503).json({ error: 'Drive not available' });
  const { name, email, picture, who, what, working, extra } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const root = await getCoCreateRootId(drive);
    const profilesId = await getDriveFolder(drive, 'Profiles', root);
    const profile = { name, email: email || null, picture: picture || null, who, what, working, extra, updatedAt: new Date().toISOString() };
    await writeDriveFile(drive, `${name}.json`, profilesId, profile);

    const textContent = [
      `# Profile: ${name}`,
      email ? `Email: ${email}` : '',
      who ? `\n## Who I am\n${who}` : '',
      what ? `\n## What I represent\n${what}` : '',
      working ? `\n## Currently working on\n${working}` : '',
      extra ? `\n## Additional context\n${extra}` : ''
    ].filter(Boolean).join('\n');

    await writePlainTextFile(drive, `${name}.txt`, profilesId, textContent);
    _systemContextCache = null;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ElevenLabs Voice Readback ──────────────────────────
app.post('/speak', async (req, res) => {
  const { text, basin } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ElevenLabs API key not configured' });

  const voices = {
    sage: process.env.ELEVENLABS_VOICE_SAGE,
    clio: process.env.ELEVENLABS_VOICE_CLIO,
    oryc: process.env.ELEVENLABS_VOICE_ORYC,
  };

  const voiceId = voices[basin] || voices.sage || process.env.ELEVENLABS_VOICE_SAGE;
  if (!voiceId) return res.status(503).json({ error: `No voice ID configured for basin: ${basin}` });

  try {
    const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });

    if (!elRes.ok) {
      const errText = await elRes.text();
      console.error('ElevenLabs error:', elRes.status, errText);
      return res.status(elRes.status).json({ error: 'ElevenLabs request failed' });
    }

    res.set('Content-Type', 'audio/mpeg');
    res.set('Transfer-Encoding', 'chunked');
    elRes.body.pipe(res); // streams directly to browser — no buffering delay
  } catch (e) {
    console.error('ElevenLabs fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Dialog: Proxy AI call (keeps API key server-side) ─
app.post('/api/basin-dialog', async (req, res) => {
  const { basinId, system, messages, max_tokens } = req.body;
  if (!basinId || !messages) return res.status(400).json({ error: 'basinId and messages required' });
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
        max_tokens: max_tokens || 350,
        system: system || '',
        messages
      })
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ text: data.content?.[0]?.text?.trim() || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dialog: Save conversation to Drive ────────────────
// ── Dialog helpers ────────────────────────────────────
async function getDialogFolderId(drive) {
  if (process.env.DIALOG_FOLDER_ID) return process.env.DIALOG_FOLDER_ID;
  const search = await drive.files.list({
    q: "name='Dialog' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id)', spaces: 'drive'
  });
  if (search.data.files[0]) return search.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name: 'Dialog', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  return created.data.id;
}

async function getDialogDrive(req) {
  return (await getDrive(req)) || (await getDriveFromTokens(_persistedTokens));
}

app.post('/api/dialog/save', async (req, res) => {
  const drive = await getDialogDrive(req);
  if (!drive) return res.status(401).json({ error: 'Not authenticated — visit /auth/google to connect your Google account' });
  try {
    const { messages, title, basins } = req.body;
    const dialogFolderId = await getDialogFolderId(drive);
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `dialog-${stamp}.json`;
    const payload = {
      title: title || `Dialog ${now.toLocaleDateString()}`,
      basins: basins || ['clio', 'oryc', 'sage'],
      savedAt: now.toISOString(),
      messages
    };
    await writeDriveFile(drive, fileName, dialogFolderId, payload);
    console.log(`◈ Dialog saved: ${fileName}`);
    res.json({ success: true, fileName, fileId: dialogFolderId });
  } catch (e) {
    console.error('Dialog save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Dialog: List saved chats ───────────────────────────
app.get('/api/dialog/list', async (req, res) => {
  const drive = await getDialogDrive(req);
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const folderId = await getDialogFolderId(drive);
    const result = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id,name,createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 50,
      spaces: 'drive'
    });
    const files = (result.data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      createdTime: f.createdTime
    }));
    res.json({ files });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dialog: Load a saved chat ──────────────────────────
app.get('/api/dialog/load/:fileId', async (req, res) => {
  const drive = await getDialogDrive(req);
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const content = await readDriveFile(drive, req.params.fileId);
    res.json(content);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dialog: Load shared physics context for Sage ──────
app.get('/api/dialog/physics', async (req, res) => {
  try {
    const physics = await getSharedPhysicsContext();
    res.json({ context: physics || '' });
  } catch (e) {
    console.error('Dialog physics error:', e.message);
    res.json({ context: '' });
  }
});

// ── Dialog: Delete a saved chat ───────────────────────
app.delete('/api/dialog/delete/:fileId', async (req, res) => {
  const drive = await getDialogDrive(req);
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await drive.files.delete({ fileId: req.params.fileId });
    res.json({ success: true });
  } catch (e) {
    console.error('Dialog delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n◈ CoCreate is running`);
  console.log(`  Open: http://localhost:${PORT}\n`);

  // ── Auth diagnostics at startup ──────────────────────
  const hasSA = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const hasClientId = !!process.env.GOOGLE_CLIENT_ID;
  const hasClientSecret = !!process.env.GOOGLE_CLIENT_SECRET;
  const hasFolderId = !!process.env.COCREATE_FOLDER_ID;
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasElevenLabsKey = !!process.env.ELEVENLABS_API_KEY;
  const hasElevenLabsVoices = !!(process.env.ELEVENLABS_VOICE_SAGE || process.env.ELEVENLABS_VOICE_CLIO || process.env.ELEVENLABS_VOICE_ORYC);
  console.log('◈ Auth check:');
  console.log(`  GOOGLE_SERVICE_ACCOUNT_JSON : ${hasSA ? '✓ set' : '✗ MISSING — Drive writes will use persisted OAuth tokens'}`);
  console.log(`  GOOGLE_CLIENT_ID            : ${hasClientId ? '✓ set' : '✗ MISSING — user sign-in will fail'}`);
  console.log(`  GOOGLE_CLIENT_SECRET        : ${hasClientSecret ? '✓ set' : '✗ MISSING — user sign-in will fail'}`);
  console.log(`  COCREATE_FOLDER_ID          : ${hasFolderId ? '✓ set' : '— not set (will use SA root drive)'}`);
  console.log(`  ANTHROPIC_API_KEY           : ${hasAnthropicKey ? '✓ set' : '✗ MISSING — AI responses will fail'}`);
  console.log(`  ELEVENLABS_API_KEY          : ${hasElevenLabsKey ? '✓ set' : '✗ MISSING — voice readback will fail'}`);
  console.log(`  ELEVENLABS_VOICE_SAGE/CLIO/ORYC : ${hasElevenLabsVoices ? '✓ set' : '✗ MISSING — set voice IDs for each basin'}`);
  if (hasSA) getServiceAccountDrive(); // warm up service account client
  console.log('');
  // Load persisted rooms after a short delay to allow OAuth to be ready
  // Small delay so service account or persisted tokens are ready
  setTimeout(loadRoomsFromDrive, 2000);
  // Auto-save all rooms every 30 seconds
  setInterval(async () => {
    const activeRooms = Object.values(rooms);
    if (!activeRooms.length) return;
    await persistRoomsToDrive();
    // Also write individual room files for any room with recent activity (updated in last 2 min)
    const cutoff = Date.now() - 2 * 60 * 1000;
    for (const room of activeRooms) {
      if (room.updatedAt && new Date(room.updatedAt).getTime() > cutoff) {
        await saveRoomToDrive(room).catch(e => console.error('Auto-save room error:', e.message));
      }
    }
    console.log(`◈ Auto-saved ${activeRooms.length} room(s)`);
  }, 30 * 1000);
});