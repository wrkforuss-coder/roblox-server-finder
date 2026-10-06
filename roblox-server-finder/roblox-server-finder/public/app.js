(function () {
  const $ = (s) => document.querySelector(s);
  const MAX_RENDER = 150;
  const st = { placeId: null, servers: [], scanned: 0, fetchedAt: 0, busy: false, timer: null, warning: '', pauseUntil: 0 };

  function parsePlaceId(raw) {
    const s = (raw || '').trim();
    if (!s) return null;
    if (/^\d{1,15}$/.test(s) && !/^0+$/.test(s)) return s;
    let m = s.match(/^(?:https?:\/\/)?(?:www\.)?roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/(\d{1,15})(?:[\/?#]|$)/i);
    if (m) return m[1];
    m = s.match(/^(?:https?:\/\/)?(?:www\.)?roblox\.com\/games\/start\?(?:.*&)?placeId=(\d{1,15})/i);
    return m ? m[1] : null;
  }

  async function api(params) {
    let res;
    try { res = await fetch('/api/roblox?' + new URLSearchParams(params)); }
    catch (_) { throw new Error('Network problem. Check your connection and try again.'); }
    let data;
    try { data = await res.json(); } catch (_) { throw new Error('Unexpected response from the server.'); }
    if (!res.ok) { const err = new Error(data.error || 'Something went wrong.'); err.code = data.code; err.status = res.status; throw err; }
    return data;
  }

  // roblox:// opens the Roblox app straight onto that server (mobile app must be installed).
  const appUrl = (id) => 'roblox://experiences/start?placeId=' + encodeURIComponent(st.placeId) + '&gameInstanceId=' + encodeURIComponent(id);
  const webUrl = (id) => 'https://www.roblox.com/games/start?placeId=' + encodeURIComponent(st.placeId) + '&gameInstanceId=' + encodeURIComponent(id);

  function showError(msg) { const e = $('#error'); e.textContent = msg || ''; e.hidden = !msg; }

  function renderGame(info) {
    const box = $('#game');
    box.textContent = '';
    if (!info) { box.hidden = true; return; }
    if (info.thumbnail) { const img = document.createElement('img'); img.src = info.thumbnail; img.alt = ''; box.appendChild(img); }
    const d = document.createElement('div');
    const n = document.createElement('div'); n.className = 'name'; n.textContent = info.name;
    const m = document.createElement('div'); m.className = 'meta';
    m.textContent = 'By ' + info.creator + ' · Place ID ' + info.placeId + (info.playing != null ? ' · ' + info.playing.toLocaleString() + ' playing now' : '');
    d.append(n, m); box.appendChild(d); box.hidden = false;
  }

  function tier(p) { return p === 0 ? 'c0' : p <= 2 ? 'c1' : p <= 5 ? 'c2' : 'c3'; }
  function dot(p) { return p === 0 ? '🔵' : p <= 2 ? '🟢' : p <= 5 ? '🟡' : '🔴'; }

  function filtered() {
    const min = parseInt($('#min').value, 10) || 0;
    const maxRaw = parseInt($('#max').value, 10);
    const space = $('#space').checked;
    return st.servers.filter((s) =>
      s.playing >= min && (isNaN(maxRaw) || s.playing <= maxRaw) && (!space || s.playing < s.maxPlayers)
    ).sort((a, b) => a.playing - b.playing || (b.fps || 0) - (a.fps || 0) || a.id.localeCompare(b.id));
  }

  function render() {
    const list = filtered();
    $('#stats').textContent = 'Scanned ' + st.scanned + ' servers · Found ' + list.length + ' matching servers' + (list.length > MAX_RENDER ? ' (showing first ' + MAX_RENDER + ')' : '');
    const note = $('#note'); note.textContent = st.warning; note.hidden = !st.warning;
    const box = $('#list'); box.textContent = '';
    if (!list.length) {
      const p = document.createElement('p'); p.className = 'stats';
      p.textContent = st.scanned ? 'No servers match your filters. Try widening Min/Max or scanning more pages.' : 'No public servers found right now.';
      box.appendChild(p);
    }
    list.slice(0, MAX_RENDER).forEach((s, i) => {
      const row = document.createElement('div'); row.className = 'srv ' + tier(s.playing);
      const left = document.createElement('div');
      const t = document.createElement('div'); t.className = 't';
      t.textContent = 'Server #' + (i + 1) + '  ' + dot(s.playing) + ' ' + s.playing + ' / ' + s.maxPlayers + ' Players';
      const sub = document.createElement('div'); sub.className = 's';
      sub.textContent = s.id + (s.ping != null ? ' · ping ' + s.ping + 'ms' : '') + (s.fps != null ? ' · ' + s.fps + ' fps' : '');
      left.append(t, sub);
      const btns = document.createElement('div'); btns.className = 'btns';
      const a = document.createElement('a'); a.className = 'join'; a.textContent = 'JOIN';
      a.href = appUrl(s.id);
      a.addEventListener('click', (ev) => { ev.preventDefault(); smartJoin(s); });
      const w = document.createElement('a'); w.className = 'copy'; w.textContent = 'Web'; w.href = webUrl(s.id);
      w.target = '_blank'; w.rel = 'noopener noreferrer';
      const c = document.createElement('button'); c.type = 'button'; c.className = 'copy'; c.textContent = 'Copy ID';
      c.onclick = async () => { try { await navigator.clipboard.writeText(s.id); c.textContent = 'Copied'; } catch (_) { c.textContent = 'Copy failed'; } setTimeout(() => (c.textContent = 'Copy ID'), 1500); };
      btns.append(a, w, c); row.append(left, btns); box.appendChild(row);
    });
    $('#results').hidden = false; $('#controls').hidden = false; tick();
  }

  function tick() {
    if (!st.fetchedAt) return;
    $('#updated').textContent = 'Last updated: ' + Math.max(0, Math.round((Date.now() - st.fetchedAt) / 1000)) + ' seconds ago';
  }

  function setBusy(b) { st.busy = b; $('#find').disabled = b; $('#refresh').disabled = b; }

  async function loadServers() {
    if (st.busy || !st.placeId) return;
    setBusy(true); showError('');
    try {
      const d = await api({ action: 'servers', placeId: st.placeId, maxPages: $('#pages').value });
      st.servers = d.servers; st.scanned = d.scanned; st.fetchedAt = d.fetchedAt; st.warning = d.warning || '';
      render();
      if (!d.servers.length) showError(d.message || 'No public servers found.');
    } catch (e) {
      if (e.code === 'RATE_LIMIT' || e.status === 429) { st.pauseUntil = Date.now() + 60000; showError(e.message + ' Auto refresh paused for 60 seconds.'); }
      else showError(e.message);
    }
    setBusy(false);
  }

  // Before joining, re-fetch fresh data and make sure the server still fits the Min/Max filter.
  // If it no longer does, jump to the best server that does.
  async function smartJoin(target) {
    if (st.busy) return;
    setBusy(true); showError('');
    let go = target;
    try {
      const d = await api({ action: 'servers', placeId: st.placeId, maxPages: 3, fresh: 1 });
      st.servers = d.servers; st.scanned = d.scanned; st.fetchedAt = d.fetchedAt; st.warning = d.warning || '';
      const ok = filtered();
      go = ok.find((x) => x.id === target.id) || ok[0] || null;
    } catch (e) {
      if (e.code === 'RATE_LIMIT' || e.status === 429) st.pauseUntil = Date.now() + 60000;
      showError(e.message + ' Joining the selected server without re-check.');
    }
    setBusy(false);
    if (!go) { showError('No server matches your Min/Max filter right now. Press Refresh and try again.'); render(); return; }
    render();
    window.location.href = appUrl(go.id);
  }

  async function find(e) {
    e.preventDefault();
    const id = parsePlaceId($('#input').value);
    if (!id) { showError('That does not look like a Roblox game link or Place ID. Example: https://www.roblox.com/games/123456789/Game-Name'); return; }
    st.placeId = id; renderGame(null);
    api({ action: 'info', placeId: id }).then(renderGame).catch(() => {});
    await loadServers();
    setAuto();
  }

  function setAuto() {
    clearInterval(st.timer); st.timer = null;
    const s = parseInt($('#auto').value, 10);
    if (s > 0) st.timer = setInterval(() => { if (Date.now() >= st.pauseUntil) loadServers(); }, s * 1000);
  }

  $('#form').addEventListener('submit', find);
  $('#refresh').addEventListener('click', loadServers);
  $('#auto').addEventListener('change', setAuto);
  ['#min', '#max', '#space'].forEach((s) => $(s).addEventListener('input', () => st.servers.length && render()));
  setInterval(tick, 1000);
})();
