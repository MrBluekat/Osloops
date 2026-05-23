# Oslo Ops Center — Server Deploy Guide

## What's in this folder

```
oslo-ops-server/
  server.js          ← Node.js backend (proxies DATEX II)
  package.json       ← dependencies
  .env.example       ← copy to .env and fill in credentials
  .gitignore         ← keeps .env and node_modules out of Git
  public/
    index.html       ← the full dashboard frontend
```

---

## Option A — Deploy to Render.com (free, easiest)

### 1. Put the files on GitHub
1. Go to github.com → sign up / log in
2. Click **New repository** → name it `oslo-ops-center` → Create
3. Upload all files from this folder (drag and drop in the browser)
   - Make sure `.env` is NOT uploaded (it's in .gitignore for safety)

### 2. Connect to Render
1. Go to render.com → sign up with your GitHub account
2. Click **New** → **Web Service**
3. Select your `oslo-ops-center` repository
4. Fill in these settings:
   - **Name:** oslo-ops-center
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Click **Advanced** → **Add Environment Variable**:
   - Key: `DATEX_USER` → Value: your Vegvesen username
   - Key: `DATEX_PASS` → Value: your Vegvesen password
6. Click **Create Web Service**

Render will build and deploy automatically. In ~2 minutes you get a URL like:
`https://oslo-ops-center.onrender.com`

---

## Option B — Run locally on your PC (no server needed)

Requires Node.js from nodejs.org

```
1. Copy .env.example to .env
2. Fill in your DATEX credentials in .env
3. Open a terminal in this folder
4. Run: npm install
5. Run: npm start
6. Open: http://localhost:3000
```

---

## Updating the dashboard

If you want to change something in `public/index.html`, just:
1. Edit the file
2. Push to GitHub
3. Render redeploys automatically within ~1 minute

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| DATEX shows error | Check DATEX_USER and DATEX_PASS in Render environment variables |
| Site won't load | Check Render logs (Dashboard → your service → Logs) |
| Google Maps blank | Click ⚙ API KEY and enter your Google Maps key |

