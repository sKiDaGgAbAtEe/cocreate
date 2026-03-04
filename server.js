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
app.use(express.static('public'));

// ── Google OAuth ───────────────────────────────────────
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/auth/google/callback`
);

let userTokens = null;

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly'
];

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: DRIVE_SCOPES });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    userTokens = tokens;
    oauth2Client.setCredentials(tokens);
    res.redirect('/?auth=success');
  } catch (e) {
    res.redirect('/?auth=error');
  }
});

app.get('/auth/status', (req, res) => res.json({ connected: !!userTokens }));

// ── Room State (in-memory, persisted to Drive) ─────────
const rooms = {}; // roomId -> { id, title, basin, contributions, members, activeFolders, folderMap, createdAt, updatedAt }

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomList() {
  return Object.values(rooms).map(r => ({
    id: r.id,
    title: r.title,
    basin: r.basin?.name || 'Unknown',
    basinColor: r.basin?.color || '#c4a882',
    memberCount: r.members ? r.members.length : 0,
    contributionCount: r.contributions ? r.contributions.length : 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }));
}

// ── Default Basin ──────────────────────────────────────
const DEFAULT_BASINS = [
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
async function getDriveFolder(drive, name) {
  const search = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)'
  });
  if (search.data.files[0]) return search.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  return folder.data.id;
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
  return google.drive({ version: 'v3', auth: oauth2Client });
}

// ── Basin Routes ───────────────────────────────────────
app.get('/api/basins', async (req, res) => {
  const drive = await getDrive();
  if (!drive) return res.json(DEFAULT_BASINS);
  try {
    const folderId = await getDriveFolder(drive, 'CoCreate');
    const fileId = await getDriveFile(drive, 'basins.json', folderId);
    if (!fileId) return res.json(DEFAULT_BASINS);
    const data = await readDriveFile(drive, fileId);
    res.json(Array.isArray(data) ? data : DEFAULT_BASINS);
  } catch (e) {
    res.json(DEFAULT_BASINS);
  }
});

app.post('/api/basins', async (req, res) => {
  const drive = await getDrive();
  if (!drive) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const folderId = await getDriveFolder(drive, 'CoCreate');
    const fileId = await getDriveFile(drive, 'basins.json', folderId);
    const basins = fileId ? await readDriveFile(drive, fileId) : DEFAULT_BASINS;
    const newBasin = {
      id: Date.now().toString(),
      name: req.body.name,
      color: req.body.color || '#8a9eba',
      orientation: req.body.orientation || 'resonant',
      description: req.body.description || '',
      defaultFolders: req.body.defaultFolders || [],
      systemPrompt: req.body.systemPrompt || DEFAULT_BASINS[0].systemPrompt
    };
    basins.push(newBasin);
    await writeDriveFile(drive, 'basins.json', folderId, basins);
    res.json(newBasin);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Drive Folder Routes ────────────────────────────────
app.get('/api/drive/folders', async (req, res) => {
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
    res.json({ folders: [] });
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

app.post('/api/rooms', (req, res) => {
  const id = generateRoomId();
  const room = {
    id,
    title: req.body.title || 'Untitled Space',
    basin: req.body.basin || DEFAULT_BASINS[0],
    contributions: [],
    members: [],
    activeFolders: req.body.activeFolders || [],
    folderMap: req.body.folderMap || {},
    saveFolderId: req.body.saveFolderId || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  rooms[id] = room;
  io.emit('rooms:updated', getRoomList());
  res.json({ id, room: sanitizeRoom(room) });
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
    basin: room.basin,
    contributions: room.contributions,
    members: room.members,
    activeFolders: room.activeFolders,
    folderMap: room.folderMap,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
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
    ? `${systemPrompt}\n\n${modeInstruction}\n\n=== YOUR KNOWLEDGE BASE ===\nReason from within these materials, not about them:\n${knowledgeContext}`
    : `${systemPrompt}\n\n${modeInstruction}`;

  const history = contributions
    .map(c => c.type === 'resonance'
      ? `[${basin?.name || 'Resonance'}]: ${c.text}`
      : `${c.author}: ${c.text}`)
    .join('\n\n');

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
        content: `Here is the full collaborative thinking space so far:\n\n${history}\n\nContribute as ${basin?.name || 'the resonance finder'}. Find a genuinely new angle. Open doors. Do not drive.`
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

  // Join a room
  socket.on('room:join', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    currentRoom = roomId;
    currentPlayer = playerName;

    socket.join(roomId);

    // Add member if not already present
    if (!room.members.includes(playerName)) {
      room.members.push(playerName);
    }

    // Send full room state to the joining player
    socket.emit('room:state', sanitizeRoom(room));

    // Notify others
    socket.to(roomId).emit('room:member-joined', { playerName });

    // Update room list for everyone
    io.emit('rooms:updated', getRoomList());
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

    // Generate resonance
    try {
      io.to(roomId).emit('room:thinking', true);
      const resonanceText = await generateResonance(
        room.contributions,
        room.basin,
        room.activeFolders,
        room.folderMap,
        modeInstruction || ''
      );

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

      // Auto-save every 3 resonance responses
      const resonanceCount = room.contributions.filter(c => c.type === 'resonance').length;
      if (resonanceCount % 3 === 0) {
        saveRoomToDrive(room);
      }
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
    if (currentRoom && currentPlayer && rooms[currentRoom]) {
      rooms[currentRoom].members = rooms[currentRoom].members.filter(m => m !== currentPlayer);
      socket.to(currentRoom).emit('room:member-left', { playerName: currentPlayer });
      io.emit('rooms:updated', getRoomList());
    }
  });
});

// ── Save Room to Drive ─────────────────────────────────
async function saveRoomToDrive(room) {
  const drive = await getDrive();
  if (!drive) return;
  try {
    const folderId = room.saveFolderId || await getDriveFolder(drive, 'CoCreate');
    const fileName = `${room.title.replace(/\s+/g, '-')}-${room.id}.json`;
    await writeDriveFile(drive, fileName, folderId, {
      ...room,
      lastSaved: new Date().toISOString()
    });
    console.log(`Room saved: ${fileName}`);
  } catch (e) {
    console.error('Room save error:', e.message);
  }
}

// ── Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n◈ CoCreate is running`);
  console.log(`  Open: http://localhost:${PORT}\n`);
});