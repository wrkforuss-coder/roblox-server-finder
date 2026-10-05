// GET /api/roblox?action=servers&placeId=123&maxPages=5
// GET /api/roblox?action=info&placeId=123
// Only talks to a fixed allowlist of Roblox hosts. placeId must be digits only (no SSRF).

const ALLOWED_HOSTS = new Set(['games.roblox.com', 'apis.roblox.com', 'thumbnails.roblox.com']);
const DEFAULT_PAGES = 5;
const MAX_PAGES_CAP = 10;      // hard ceiling: 10 pages x 100 = 1000 servers
const PAGE_DELAY_MS = 300;     // pause between Roblox page requests
const CACHE_TTL_MS = 20000;    // per-instance cache
const RATE_LIMIT = 30;         // requests per IP per minute (per warm instance)
const TIMEOUT_MS = 8000;

const cache = new Map();
const hits = new Map();

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

async function rbx(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new ApiError(400, 'BAD_HOST', 'Request blocked.');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (res.status === 429) throw new ApiError(429, 'RATE_LIMIT', 'Roblox is temporarily rate-limiting requests. Please wait 20 seconds and try again.');
    if (res.status === 400 || res.status === 404) throw new ApiError(404, 'NOT_FOUND', 'This game is unavailable or the Place ID does not exist.');
    if (!res.ok) throw new ApiError(502, 'UPSTREAM', 'Roblox API is unavailable right now. Please try again shortly.');
    return await res.json();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'AbortError') throw new ApiError(504, 'TIMEOUT', 'Roblox took too long to respond. Please try again.');
    throw new ApiError(502, 'NETWORK', 'Could not reach Roblox. Please try again.');
  } finally {
    clearTimeout(timer);
  }
}

async function getServers(placeId, maxPages) {
  const key = `${placeId}:${maxPages}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return { ...hit.data, cached: true };

  const seen = new Map();
  let cursor = '';
  let pages = 0;
  let warning = null;

  while (pages < maxPages) {
    const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    let page;
    try {
      page = await rbx(url);
    } catch (e) {
      // Keep what we already have if a later page fails.
      if (seen.size && ['RATE_LIMIT', 'TIMEOUT', 'UPSTREAM', 'NETWORK'].includes(e.code)) {
        warning = 'Scan stopped early (' + e.message + ') Showing what was collected so far.';
        break;
      }
      throw e;
    }
    pages++;
    for (const s of Array.isArray(page.data) ? page.data : []) {
      if (s && typeof s.id === 'string' && !seen.has(s.id)) {
        seen.set(s.id, {
          id: s.id,
          playing: Number(s.playing) || 0,
          maxPlayers: Number(s.maxPlayers) || 0,
          fps: typeof s.fps === 'number' ? Math.round(s.fps) : null,
          ping: typeof s.ping === 'number' ? Math.round(s.ping) : null,
        });
      }
    }
    cursor = page.nextPageCursor;
    if (!cursor) break;
    if (pages < maxPages) await sleep(PAGE_DELAY_MS);
  }

  const servers = [...seen.values()].sort(
    (a, b) => a.playing - b.playing || (b.fps ?? 0) - (a.fps ?? 0) || a.id.localeCompare(b.id)
  );
  const data = { placeId, servers, scanned: servers.length, pages, exhausted: !cursor, warning, fetchedAt: Date.now(), cached: false };
  if (!warning) {
    if (cache.size > 50) cache.clear();
    cache.set(key, { t: Date.now(), data });
  }
  return data;
}

async function getInfo(placeId) {
  const uni = await rbx(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
  const universeId = uni && uni.universeId;
  if (!universeId || !/^\d+$/.test(String(universeId))) throw new ApiError(404, 'NOT_FOUND', 'This game is unavailable or the Place ID does not exist.');
  const g = await rbx(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
  const game = g && g.data && g.data[0];
  if (!game) throw new ApiError(404, 'NOT_FOUND', 'This game is unavailable or the Place ID does not exist.');
  let thumbnail = null;
  try {
    const t = await rbx(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&returnPolicy=PlaceHolder&size=256x256&format=Png&isCircular=false`);
    thumbnail = (t && t.data && t.data[0] && t.data[0].imageUrl) || null;
  } catch (_) { /* thumbnail is optional */ }
  return {
    placeId,
    name: game.name || 'Unknown game',
    creator: game.creator ? game.creator.name : 'Unknown',
    playing: typeof game.playing === 'number' ? game.playing : null,
    thumbnail,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed.' });

  const ip = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || 'unknown';
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (rec.length >= RATE_LIMIT) return json(429, { error: 'Too many requests. Please wait a minute and try again.' });
  rec.push(now);
  hits.set(ip, rec);
  if (hits.size > 500) hits.clear();

  const q = event.queryStringParameters || {};
  const placeId = String(q.placeId || '').trim();
  if (!/^\d{1,15}$/.test(placeId) || /^0+$/.test(placeId)) {
    return json(400, { error: 'Invalid Place ID. Use digits only (or paste a roblox.com/games/... link).' });
  }

  try {
    if (q.action === 'info') return json(200, await getInfo(placeId));
    if (q.action === 'servers') {
      let n = parseInt(q.maxPages, 10);
      if (!Number.isFinite(n)) n = DEFAULT_PAGES;
      n = Math.min(Math.max(n, 1), MAX_PAGES_CAP);
      const data = await getServers(placeId, n);
      if (!data.servers.length) return json(200, { ...data, message: 'No public servers found for this game right now.' });
      return json(200, data);
    }
    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    if (e instanceof ApiError) return json(e.status, { error: e.message, code: e.code });
    console.error('Unhandled error:', e && e.message);
    return json(500, { error: 'Something went wrong on our side. Please try again.' });
  }
};
