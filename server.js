require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
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

// ── Basin Profiles ─────────────────────────────────────
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

// ── Drive Basin Helpers ────────────────────────────────
async function getDriveBasinsFileId(drive) {
  // Look for basins.json inside the CoCreate folder
  const folderSearch = await drive.files.list({
    q: "name='CoCreate' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id)'
  });
  let cocreateId = folderSearch.data.files[0]?.id;
  if (!cocreateId) {
    const folder = await drive.files.create({
      requestBody: { name: 'CoCreate', mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id'
    });
    cocreateId = folder.data.id;
  }
  const fileSearch = await drive.files.list({
    q: `name='basins.json' and '${cocreateId}' in parents and trashed=false`,
    fields: 'files(id)'
  });
  return { fileId: fileSearch.data.files[0]?.id || null, cocreateId };
}

async function loadBasinsFromDrive(drive) {
  try {
    const { fileId } = await getDriveBasinsFileId(drive);
    if (!fileId) return DEFAULT_BASINS;
    const res = await drive.files.get({ fileId, alt: 'media' });
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return Array.isArray(data) ? data : DEFAULT_BASINS;
  } catch (e) {
    console.error('Could not load basins from Drive:', e.message);
    return DEFAULT_BASINS;
  }
}

async function saveBasinsToDrive(drive, basins) {
  try {
    const { fileId, cocreateId } = await getDriveBasinsFileId(drive);
    const content = JSON.stringify(basins, null, 2);
    if (fileId) {
      await drive.files.update({ fileId, media: { mimeType: 'application/json', body: content } });
    } else {
      await drive.files.create({
        requestBody: { name: 'basins.json', parents: [cocreateId] },
        media: { mimeType: 'application/json', body: content },
        fields: 'id'
      });
    }
  } catch (e) {
    console.error('Could not save basins to Drive:', e.message);
  }
}

// ── Basin Routes ───────────────────────────────────────
app.get('/api/basins', async (req, res) => {
  if (!userTokens) return res.json(DEFAULT_BASINS);
  oauth2Client.setCredentials(userTokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const basins = await loadBasinsFromDrive(drive);
  res.json(basins);
});

app.post('/api/basins', async (req, res) => {
  if (!userTokens) return res.status(401).json({ error: 'Not authenticated' });
  oauth2Client.setCredentials(userTokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const basins = await loadBasinsFromDrive(drive);
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
  await saveBasinsToDrive(drive, basins);
  res.json(newBasin);
});

app.put('/api/basins/:id', async (req, res) => {
  if (!userTokens) return res.status(401).json({ error: 'Not authenticated' });
  oauth2Client.setCredentials(userTokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const basins = await loadBasinsFromDrive(drive);
  const idx = basins.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Basin not found' });
  basins[idx] = { ...basins[idx], ...req.body };
  await saveBasinsToDrive(drive, basins);
  res.json(basins[idx]);
});

app.delete('/api/basins/:id', async (req, res) => {
  if (!userTokens) return res.status(401).json({ error: 'Not authenticated' });
  oauth2Client.setCredentials(userTokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  let basins = await loadBasinsFromDrive(drive);
  basins = basins.filter(b => b.id !== req.params.id);
  await saveBasinsToDrive(drive, basins);
  res.json({ success: true });
});

// ── Drive Folder Routes ────────────────────────────────
app.get('/api/drive/folders', async (req, res) => {
  if (!userTokens) return res.json({ folders: [] });
  oauth2Client.setCredentials(userTokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  try {
    const result = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id, name)',
      pageSize: 50
    });
    res.json({ folders: result.data.files });
  } catch (e) {
    console.error('Folder list error:', e.message);
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
        const truncated = text.slice(0, 3000);
        content += `\n--- ${file.name} ---\n${truncated}\n`;
      } catch (e) {
        console.error(`Could not read file ${file.name}:`, e.message);
      }
    }
    return content;
  } catch (e) {
    console.error(`Could not read folder ${folderName}:`, e.message);
    return '';
  }
}

// ── Resonate Route ─────────────────────────────────────
app.post('/api/resonate', async (req, res) => {
  const { contributions, basin, activeFolders, folderMap } = req.body;

  let knowledgeContext = '';

  if (userTokens && activeFolders && activeFolders.length > 0 && folderMap) {
    oauth2Client.setCredentials(userTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    for (const folderName of activeFolders) {
      const folderId = folderMap[folderName];
      if (folderId) {
        const content = await readFolderContents(drive, folderId, folderName);
        knowledgeContext += content;
      }
    }
  }

  const systemPrompt = basin?.systemPrompt || DEFAULT_BASINS[0].systemPrompt;
  const fullSystem = knowledgeContext
    ? `${systemPrompt}\n\n=== YOUR KNOWLEDGE BASE ===\nThe following materials inform your understanding. Reason from within them, not about them:\n${knowledgeContext}`
    : systemPrompt;

  const history = contributions
    .map(c => c.type === 'resonance'
      ? `[${basin?.name || 'Resonance'}]: ${c.text}`
      : `${c.author}: ${c.text}`)
    .join('\n\n');

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
        max_tokens: 1000,
        system: fullSystem,
        messages: [{
          role: 'user',
          content: `Here is the full collaborative thinking space so far:\n\n${history}\n\nContribute as ${basin?.name || 'the resonance finder'}. Find a genuinely new angle. Open doors. Do not drive.`
        }]
      })
    });

    const data = await response.json();
    if (data.error) {
      console.error('Claude API error:', data.error);
      return res.status(500).json({ error: data.error.message });
    }
    res.json({ text: data.content?.[0]?.text || '' });
  } catch (e) {
    console.error('Claude error:', e);
    res.status(500).json({ error: 'Claude API error' });
  }
});

// ── Folder Toggle Acknowledgment ───────────────────────
app.post('/api/acknowledge-folder', async (req, res) => {
  const { folderName, basin, action } = req.body;

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
          content: `The folder "${folderName}" was just ${action} your context. Acknowledge in one sentence starting with "I now have access to ${folderName} materials" (if added) or "I have released ${folderName} from my context" (if removed). Then add one brief evocative line about what this opens or closes. Stay in character as ${basin?.name || 'the resonance finder'}.`
        }]
      })
    });

    const data = await response.json();
    res.json({ text: data.content?.[0]?.text || `I now have access to ${folderName} materials.` });
  } catch (e) {
    res.json({ text: `I now have access to ${folderName} materials.` });
  }
});

// ── Save Session to Drive ──────────────────────────────
app.post('/api/save', async (req, res) => {
  if (!userTokens) return res.status(401).json({ error: 'Not authenticated' });

  oauth2Client.setCredentials(userTokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const { session, targetFolderId } = req.body;

  try {
    const fileName = `${session.title.replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.json`;
    const content = JSON.stringify(session, null, 2);

    let folderId = targetFolderId;
    if (!folderId) {
      const folderSearch = await drive.files.list({
        q: "name='CoCreate' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: 'files(id)'
      });
      folderId = folderSearch.data.files[0]?.id;
      if (!folderId) {
        const folder = await drive.files.create({
          requestBody: { name: 'CoCreate', mimeType: 'application/vnd.google-apps.folder' },
          fields: 'id'
        });
        folderId = folder.data.id;
      }
    }

    const fileSearch = await drive.files.list({
      q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id)'
    });

    if (fileSearch.data.files.length > 0) {
      await drive.files.update({
        fileId: fileSearch.data.files[0].id,
        media: { mimeType: 'application/json', body: content }
      });
    } else {
      await drive.files.create({
        requestBody: { name: fileName, parents: [folderId] },
        media: { mimeType: 'application/json', body: content },
        fields: 'id'
      });
    }

    res.json({ success: true, fileName });
  } catch (e) {
    console.error('Drive save error:', e.message);
    res.status(500).json({ error: 'Save failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n◈ CoCreate is running`);
  console.log(`  Open: http://localhost:${PORT}\n`);
});