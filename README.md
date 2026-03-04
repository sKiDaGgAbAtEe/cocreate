# CoCreate — Setup Guide

A collaborative thinking space powered by Claude.

---

## Step 1 — Install Node.js

Download and install from: https://nodejs.org (choose the LTS version)

Verify it worked:
```
node --version
```

---

## Step 2 — Set up the app

Open a terminal, navigate to this folder, and install dependencies:

```
cd cocreate
npm install
```

---

## Step 3 — Add your Anthropic API key

Copy the example env file:
```
cp .env.example .env
```

Open `.env` and replace `your_key_here` with your actual Anthropic API key.

---

## Step 4 — Set up Google Drive (optional but recommended)

This lets the app save sessions directly to your Google Drive.

1. Go to https://console.cloud.google.com
2. Create a new project (call it "CoCreate")
3. Go to **APIs & Services → Library**
4. Search for **Google Drive API** and enable it
5. Go to **APIs & Services → Credentials**
6. Click **Create Credentials → OAuth 2.0 Client ID**
7. Choose **Web application**
8. Under "Authorized redirect URIs" add: `http://localhost:3000/auth/google/callback`
9. Copy your **Client ID** and **Client Secret**
10. Paste them into your `.env` file

If you skip this step, the app will fall back to downloading sessions as JSON files.

---

## Step 5 — Run it

```
npm start
```

Open your browser to: **http://localhost:3000**

---

## How it works

- Enter your name and a session title to open a space
- Type freely — Claude responds as a resonance finder after each contribution
- Click **Connect** on the home screen to link Google Drive
- Sessions auto-save to Drive every 3 resonance responses
- Click **save ↑** anytime to save manually

---

## Adding other players

Share your local IP address with friends on the same network:

1. Find your IP: run `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
2. Tell your friends to open `http://YOUR_IP:3000` in their browser
3. They enter their own name, same session title — you're in the same space

For remote players, you'll want to deploy to a hosting service.
Easiest options: **Railway**, **Render**, or **Fly.io** (all have free tiers).

---

## Files

```
cocreate/
  server.js        — Express backend, Claude + Drive API calls
  public/
    index.html     — The full frontend
  .env             — Your secrets (never share this)
  .env.example     — Template for the above
  package.json     — Dependencies
  README.md        — This file
```
