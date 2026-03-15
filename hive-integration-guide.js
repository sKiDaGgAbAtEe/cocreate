// ══════════════════════════════════════════════════════════════════════════════
// ADD THIS TO YOUR ORYCL server.js
// ══════════════════════════════════════════════════════════════════════════════

// 1. At the top with your other requires:
const hive = require('./hive');

// 2. After your app, httpServer, and io are created but BEFORE httpServer.listen()
//    Pass in your existing getSystemDrive function — HIVE reuses it, no new auth needed.
//    If your function is named differently (getDrive, getUserDrive, etc.) adjust accordingly.
hive.mount(app, io, { getDrive: getSystemDrive });

// That's it. HIVE is now live at /hive
// All HIVE socket events are prefixed hive: so they don't clash with Orycl events
// All HIVE REST routes are under /api/hive/ so they don't clash with Orycl routes
// HIVE data persists to data/hive/cells.json and data/hive/projects.json

// ══════════════════════════════════════════════════════════════════════════════
// FILE STRUCTURE IN YOUR REPO
// ══════════════════════════════════════════════════════════════════════════════
//
// orycl-repo/
//   public/
//     index.html          ← Orycl (unchanged)
//     hive.html           ← add this
//     pyxis-core.js       ← already there
//     watchtower.html     ← already there
//   server.js             ← add the two lines above
//   hive.js               ← add this (the module)
//   package.json          ← add busboy and mammoth (see below)
//   data/
//     hive/               ← auto-created on first run
//       cells.json
//       projects.json
//
// ══════════════════════════════════════════════════════════════════════════════
// PACKAGE.JSON — add these two if not already present
// ══════════════════════════════════════════════════════════════════════════════
//
//   "busboy": "^1.6.0",
//   "mammoth": "^1.6.0"
//
// Then run: npm install
//
// ══════════════════════════════════════════════════════════════════════════════
// RAILWAY ENV VARS — add this one new var
// ══════════════════════════════════════════════════════════════════════════════
//
//   HIVE_FOLDER_ID = [Google Drive folder ID for HIVE data]
//
//   Everything else (ANTHROPIC_API_KEY, DAILY_API_KEY, GOOGLE_SERVICE_ACCOUNT_JSON,
//   BASE_URL, SESSION_SECRET) is already set in your Orycl deployment.
//
// ══════════════════════════════════════════════════════════════════════════════
// WHAT getSystemDrive LOOKS LIKE (already in your server.js)
// ══════════════════════════════════════════════════════════════════════════════
//
// async function getSystemDrive() {
//   const sa = getServiceAccountDrive();
//   if (sa) return sa;
//   if (_persistedTokens) {
//     const drive = await getDriveFromTokens(_persistedTokens);
//     if (drive) return drive;
//   }
//   return null;
// }
//
// This is exactly what HIVE needs. Just pass it in.
