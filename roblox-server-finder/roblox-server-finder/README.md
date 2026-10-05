# Roblox Server Finder

Find the lowest-population **public** servers for any Roblox game. No Roblox login, no cookies, no database.

## Structure
```
roblox-server-finder/
├── netlify.toml                 # publish dir, functions dir, /api/* redirect
├── package.json                 # only netlify-cli (dev)
├── netlify/functions/roblox.js  # serverless proxy to Roblox public APIs
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

## Run locally (needs Node 18+)
```
npm install
npm run dev
```
Open http://localhost:8888 and paste e.g. `https://www.roblox.com/games/<placeId>/Name` or just the Place ID.

## Deploy to Netlify (free)
**Option A: GitHub (works from a phone browser too)**
1. Create a GitHub repo and upload all files (keep the folder layout above).
2. Netlify → Add new site → Import an existing project → pick the repo.
3. Build command: leave empty. Publish directory: `public`. Functions: `netlify/functions` (already in netlify.toml). Click Deploy.

**Option B: CLI**
```
npx netlify login
npx netlify init      # or: npx netlify link
npm run deploy
```

## How it works
- `GET /api/roblox?action=servers&placeId=ID&maxPages=5` calls `https://games.roblox.com/v1/games/{placeId}/servers/Public?sortOrder=Asc&limit=100&cursor=...`, follows `nextPageCursor`, dedupes, sorts by players (then fps), and returns `{id, playing, maxPlayers, fps, ping}`.
- `action=info` fetches name, creator and thumbnail from `apis.roblox.com` / `games.roblox.com` / `thumbnails.roblox.com`.
- Config at the top of `roblox.js`: default/max pages (5/10), delay between pages (300 ms), cache (20 s), per-IP limit (30/min).
- Security: Place ID must be digits only; the function only fetches from three fixed Roblox hosts (no SSRF); no credentials are read, sent or stored; errors are returned as friendly messages, never stack traces.

## Limitations (please read)
- **Join button.** Roblox has no officially documented "join this exact server" link for websites. The button uses `https://www.roblox.com/games/start?placeId=...&gameInstanceId=...`, the same style of link Roblox's own site uses to launch the app. It usually works if you're logged in to Roblox in that browser and have the app installed, but Roblox can change or block it, and some games disable joining by instance. The server ID is shown with a **Copy ID** button as a fallback. The site can't make Roblox's server list verify a server is joinable: servers may fill up or close before you click.
- **Not a live snapshot.** Server lists change every second, and Roblox may return servers in imperfect order, so scanning more pages finds more low-population servers. Large games can have thousands of servers; the cap protects Roblox and your function usage.
- **Unofficial endpoint.** The server-list endpoint is on Roblox's documented `games.roblox.com` domain, but it can change or rate-limit at any time. Rate limiting shows a clear message.
- Netlify's in-memory cache and rate limit are per warm function instance (best effort, not global).
