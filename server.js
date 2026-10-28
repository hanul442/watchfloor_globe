// Watchfloor local server
// Pulls live public feeds, keeps them in memory, and pushes new events to the browser (Server-Sent Events).
//   USGS        : M4.5+ earthquakes worldwide (every 60 s)
//   P2PQuake    : Japan Meteorological Agency quake reports, Earthquake Early Warnings, tsunami notices (every 15 s)
//   ADS-B       : live aircraft around a point (airplanes.live / adsb.fi / adsb.lol, on request)
//   Windy       : live webcams around a point (on request, needs WINDY_API_KEY)
//   Claude      : AI situation briefing (on request, needs ANTHROPIC_API_KEY)
// Run:  node server.js        (live)
//       node server.js --demo (offline, replays a bundled snapshot)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { createNews } from './news.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------- .env ----------
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env is fine */ }

const PORT = +process.env.PORT || 3117;
const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
const WINDY_KEY = process.env.WINDY_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const HOSTED = !!(process.env.RENDER || process.env.HOST === '0.0.0.0');
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
// On a public site the paid AI briefing only runs with a password.
const AI_ON = !!ANTHROPIC_KEY && (!HOSTED || !!ADMIN_PASSWORD);
const UA = 'watchfloor-local/1.0 (personal OSINT dashboard)';

// ---------- state ----------
const quakes = new Map();          // id -> event
const alerts = [];                 // EEW / tsunami, newest first
const seenP2P = new Set();
const status = { usgs: 'wait', jma: 'wait', aircraft: 'idle', news: 'wait', webcams: WINDY_KEY ? 'ready' : 'off', ai: AI_ON ? 'ready' : 'off', aiNeedsPassword: !!ADMIN_PASSWORD, demo: DEMO };
const clients = new Set();
let news = null;              // set up after broadcast/log exist

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

news = createNews({ broadcast, status, log, UA, root: ROOT });

async function getJSON(url, opts = {}, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

function pruneOld() {
  const cutoff = Date.now() - 8 * 864e5;
  for (const [id, q] of quakes) if (q.time < cutoff) quakes.delete(id);
  while (alerts.length > 40) alerts.pop();
}

// ---------- USGS ----------
let usgsFirst = true;
async function pollUSGS() {
  try {
    const j = await getJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson');
    const fresh = [];
    for (const f of j.features) {
      const [lng, lat, depth] = f.geometry.coordinates;
      const p = f.properties;
      const ev = { id: 'us-' + f.id, src: 'usgs', mag: +(p.mag ?? 0), place: p.place || p.title, time: p.time, lat, lng, depth: Math.max(0, depth ?? 0), url: p.url, tsunami: !!p.tsunami, alert: p.alert || null };
      const old = quakes.get(ev.id);
      quakes.set(ev.id, ev);
      if (!old && !usgsFirst) fresh.push(ev);
    }
    if (usgsFirst) log(`USGS: ${quakes.size} events loaded`);
    fresh.sort((a, b) => a.time - b.time).forEach(ev => { log(`USGS new: M${ev.mag} ${ev.place}`); broadcast('quake', ev); });
    usgsFirst = false;
    status.usgs = 'ok';
  } catch (e) {
    status.usgs = 'error';
    log('USGS error:', e.message);
    if (usgsFirst && quakes.size === 0) { loadSnapshot(); status.usgs = 'snapshot'; }
  }
  pruneOld();
}

// ---------- JMA via P2PQuake ----------
const SCALE = { 10: '1', 20: '2', 30: '3', 40: '4', 45: '5-', 46: '5-', 50: '5+', 55: '6-', 60: '6+', 70: '7' };
let p2pFirst = true;
function jmaTime(s) { // "2026/10/28 03:12:00" (JST) -> ms
  if (!s) return Date.now();
  const m = s.match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+):?(\d+)?/);
  if (!m) return Date.parse(s) || Date.now();
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] || 0));
}
async function pollP2P() {
  try {
    const list = await getJSON('https://api.p2pquake.net/v2/history?codes=551&codes=552&codes=556&limit=30');
    for (const it of list.reverse()) {
      const key = it.id || it._id;
      if (seenP2P.has(key)) continue;
      seenP2P.add(key);
      if (it.code === 551) {
        const h = it.earthquake?.hypocenter || {};
        if (h.latitude == null || h.latitude < -90 || h.magnitude == null || h.magnitude < 0) continue; // intensity-only report, no epicentre yet
        const pts = (it.points || []).filter(p => p.scale > 0).sort((a, b) => b.scale - a.scale);
        const ev = {
          id: 'jma-' + key, src: 'jma', mag: +h.magnitude, place: `${h.name || '일본'} (일본 기상청)`, time: jmaTime(it.earthquake.time),
          lat: h.latitude, lng: h.longitude, depth: Math.max(0, h.depth ?? 10), maxScale: SCALE[it.earthquake.maxScale] || null,
          maxScaleRaw: it.earthquake.maxScale ?? -1, tsunamiNote: it.earthquake.domesticTsunami || null,
          points: pts.slice(0, 8).map(p => ({ addr: p.addr, pref: p.pref, scale: SCALE[p.scale] || String(p.scale) }))
        };
        quakes.set(ev.id, ev);
        if (!p2pFirst) { log(`JMA quake: M${ev.mag} ${ev.place} max ${ev.maxScale}`); broadcast('quake', ev); }
      } else if (it.code === 556) {
        const h = it.earthquake?.hypocenter || {};
        const a = {
          id: 'eew-' + key, kind: 'eew', cancelled: !!it.cancelled, time: jmaTime(it.earthquake?.originTime || it.time),
          lat: h.latitude, lng: h.longitude, depth: Math.max(0, h.depth ?? 10), mag: h.magnitude > 0 ? h.magnitude : null, place: h.name || '일본 부근',
          areas: (it.areas || []).slice(0, 12).map(x => ({ pref: x.pref, name: x.name, from: SCALE[x.scaleFrom] || '?', to: SCALE[x.scaleTo] || (x.scaleTo === 99 ? '이상' : '?'), arrival: x.arrivalTime ? jmaTime(x.arrivalTime) : null }))
        };
        alerts.unshift(a);
        if (!p2pFirst) { log(`EEW: ${a.place} M${a.mag}${a.cancelled ? ' (cancelled)' : ''}`); broadcast('eew', a); }
      } else if (it.code === 552) {
        const a = { id: 'tsu-' + key, kind: 'tsunami', cancelled: !!it.cancelled, time: jmaTime(it.time), areas: (it.areas || []).slice(0, 20).map(x => ({ name: x.name, grade: x.grade, immediate: !!x.immediate })) };
        alerts.unshift(a);
        if (!p2pFirst) { log(`Tsunami notice: ${a.areas.length} areas${a.cancelled ? ' (cancelled)' : ''}`); broadcast('tsunami', a); }
      }
    }
    if (p2pFirst) log(`JMA (P2PQuake): ${[...quakes.values()].filter(q => q.src === 'jma').length} quakes, ${alerts.length} alerts loaded`);
    p2pFirst = false;
    status.jma = 'ok';
  } catch (e) {
    status.jma = 'error';
    log('P2PQuake error:', e.message);
  }
}

// ---------- snapshot / demo ----------
function loadSnapshot() {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'snapshot.json'), 'utf8'));
  // In demo mode, slide the snapshot so its newest event is one hour old (keeps it inside the 7-day window).
  const newest = Math.max(...s.quakes.map(q => Date.parse(q.time)));
  const shift = DEMO ? Date.now() - 36e5 - newest : 0;
  for (const q of s.quakes) quakes.set(q.id, { ...q, time: Date.parse(q.time) + shift });
  log(`Snapshot: ${s.quakes.length} events loaded`);
}

// (kept for reference; the browser now builds its own test warning so other viewers never see it)
function demoEEW() {
  const now = Date.now();
  return {
    id: 'eew-demo-' + now, kind: 'eew', demo: true, cancelled: false, time: now - 3000,
    lat: 33.2, lng: 135.9, depth: 30, mag: 7.4, place: '기이반도 남쪽 앞바다 (데모)',
    areas: [['와카야마', 'Wakayama', '6-', 18], ['미에', 'Mie', '5+', 32], ['나라', 'Nara', '5+', 30], ['오사카', 'Osaka', '5-', 42], ['효고', 'Hyogo', '4', 55], ['아이치', 'Aichi', '4', 60], ['교토', 'Kyoto', '4', 55], ['도쿠시마', 'Tokushima', '5-', 40]]
      .map(([pref, name, sc, sec]) => ({ pref, name, from: sc, to: sc, arrival: now + sec * 1000 }))
  };
}

// ---------- aircraft ----------
const acCache = new Map();
// Free ADS-B aggregators that share the readsb "v2" JSON shape. Tried in order; the last one that worked goes first next time.
const AC_PROVIDERS = [
  { name: 'airplanes.live', url: (la, lo) => `https://api.airplanes.live/v2/point/${la}/${lo}/250` },
  { name: 'adsb.fi', url: (la, lo) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/250` },
  { name: 'adsb.lol', url: (la, lo) => `https://api.adsb.lol/v2/point/${la}/${lo}/250` }
];
let acLastGood = null;
async function aircraft(lat, lng) {
  if (DEMO) return { demo: true, ac: [] };
  const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
  const hit = acCache.get(key);
  if (hit && Date.now() - hit.t < 20000) return hit.v;
  const order = [...AC_PROVIDERS].sort((a, b) => (b.name === acLastGood) - (a.name === acLastGood));
  const errors = [];
  for (const prov of order) {
    try {
      const j = await getJSON(prov.url(lat.toFixed(3), lng.toFixed(3)), {}, 10000);
      const list = j.ac || j.aircraft || [];
      const ac = list.filter(a => a.lat != null && a.lon != null).slice(0, 400).map(a => ({
        hex: a.hex, flight: (a.flight || '').trim() || a.r || a.hex, type: a.t || '', lat: a.lat, lng: a.lon,
        alt: typeof a.alt_baro === 'number' ? a.alt_baro : 0, ground: a.alt_baro === 'ground', gs: a.gs ?? null, track: a.track ?? null
      }));
      status.aircraft = 'ok';
      if (acLastGood !== prov.name) log(`aircraft: using ${prov.name}`);
      acLastGood = prov.name;
      const v = { ac, source: prov.name };
      acCache.set(key, { t: Date.now(), v });
      return v;
    } catch (e) {
      errors.push(`${prov.name}: ${e.message}`);
    }
  }
  status.aircraft = 'error';
  log('aircraft error:', errors.join(' | '));
  return { error: '항공기 데이터를 가져오지 못했어요 (' + errors.join(', ') + ')', ac: [] };
}

// ---------- webcams ----------
function loadCamList() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'cams.json'), 'utf8')).cams || []; } catch { return []; }
}
function distKm(a1, o1, a2, o2) {
  const r = x => x * Math.PI / 180, dA = r(a2 - a1), dO = r(o2 - o1);
  const h = Math.sin(dA / 2) ** 2 + Math.cos(r(a1)) * Math.cos(r(a2)) * Math.sin(dO / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
async function webcams(lat, lng) {
  const out = [];
  // 1) your own list of YouTube live cameras (cams.json)
  for (const c of loadCamList()) {
    const d = distKm(lat, lng, c.lat, c.lng);
    if (d < (c.radiusKm || 800) && c.youtube) out.push({ title: c.name, youtube: c.youtube, distKm: Math.round(d), source: 'cams.json' });
  }
  // 2) Windy webcams near the point
  if (WINDY_KEY && !DEMO) {
    try {
      const j = await getJSON(`https://api.windy.com/webcams/api/v3/webcams?nearby=${lat.toFixed(3)},${lng.toFixed(3)},250&include=player,images,location&limit=6`, { headers: { 'x-windy-api-key': WINDY_KEY } });
      for (const w of j.webcams || []) {
        const p = w.player || {};
        out.push({
          title: w.title, player: p.live || p.day || p.month || null, image: w.images?.current?.preview || null,
          distKm: w.location ? Math.round(distKm(lat, lng, w.location.latitude, w.location.longitude)) : null, source: 'windy'
        });
      }
      status.webcams = 'ok';
    } catch (e) { status.webcams = 'error'; log('Windy error:', e.message); }
  }
  out.sort((a, b) => (a.distKm ?? 9999) - (b.distKm ?? 9999));
  return { cams: out.slice(0, 6) };
}

// ---------- AI briefing (Claude) ----------
let anthropic = null, lastBrief = 0;
async function aiBrief(payload, password) {
  if (!AI_ON) return { status: 501, body: { error: ANTHROPIC_KEY ? '사이트 모드에서는 ADMIN_PASSWORD를 설정해야 켜져요' : 'ANTHROPIC_API_KEY가 설정되지 않았어요' } };
  if (ADMIN_PASSWORD && password !== ADMIN_PASSWORD) return { status: 401, body: { error: '비밀번호가 맞지 않아요' } };
  if (Date.now() - lastBrief < 30000) return { status: 429, body: { error: '30초에 한 번만 요청할 수 있어요' } };
  lastBrief = Date.now();
  if (!anthropic) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
  }
  const recent = [...quakes.values()].sort((a, b) => b.time - a.time).slice(0, 60)
    .map(q => `${new Date(q.time).toISOString().slice(0, 16)}Z | ${q.src} | M${q.mag} | ${q.place} | ${q.lat.toFixed(2)},${q.lng.toFixed(2)} | ${Math.round(q.depth)}km${q.maxScale ? ' | max shindo ' + q.maxScale : ''}`).join('\n');
  const al = alerts.slice(0, 10).map(a => `${new Date(a.time).toISOString().slice(0, 16)}Z | ${a.kind}${a.cancelled ? ' (cancelled)' : ''} | ${a.place || ''} ${a.mag ? 'M' + a.mag : ''} | areas: ${(a.areas || []).map(x => x.name || x.pref).slice(0, 8).join(', ')}`).join('\n');
  const nw = news.list().slice(0, 25).map(n => `${new Date(n.time).toISOString().slice(0, 16)}Z | ${n.place} | ${n.outlet} | ${n.title}`).join('\n');
  try {
    const r = await anthropic.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: '당신은 지진·재난 상황실의 분석관입니다. 주어진 데이터만 근거로 한국어 브리핑을 씁니다. 뉴스 헤드라인은 보도된 내용으로만 다루고 사실로 단정하지 마세요. 데이터에 없는 피해나 사상자를 추측하지 마세요. 5~7개의 짧은 문단으로, 각 문단은 [개요] [주목 지역] [일본] [원전·인프라] [해양·쓰나미] [뉴스] [다음 확인할 것] 같은 꼬리표로 시작하세요. 마크다운 기호는 쓰지 마세요.',
      messages: [{ role: 'user', content: `현재 시각 ${new Date().toISOString()}.\n\n최근 지진 (최신순):\n${recent}\n\n최근 경보:\n${al || '없음'}\n\n최근 뉴스 헤드라인 (위치 자동 추정):\n${nw || '없음'}\n\n화면에서 사용자가 보고 있는 것: ${JSON.stringify(payload?.focus || null)}\n\n브리핑을 써 주세요.` }]
    });
    if (r.stop_reason === 'refusal') return { status: 200, body: { text: '모델이 이 요청에 답하지 않았어요. 잠시 뒤 다시 시도해 주세요.' } };
    const text = r.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return { status: 200, body: { text, model: r.model } };
  } catch (e) {
    log('Claude error:', e.status || '', e.message);
    const msg = e.status === 401 ? 'API 키가 올바르지 않아요' : e.status === 429 ? '요청 한도에 걸렸어요. 잠시 뒤 다시 시도해 주세요' : 'AI 브리핑을 받지 못했어요';
    return { status: 502, body: { error: msg } };
  }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.geojson': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(ok => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  try {
    if (p === '/api/state') {
      return send(res, 200, { quakes: [...quakes.values()].sort((a, b) => a.time - b.time), alerts, news: news.list().slice(0, 120), status, now: Date.now() });
    }
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ status })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (p === '/api/aircraft') {
      const lat = +u.searchParams.get('lat'), lng = +u.searchParams.get('lng');
      if (!isFinite(lat) || !isFinite(lng)) return send(res, 400, { error: 'lat, lng가 필요해요' });
      return send(res, 200, await aircraft(lat, lng));
    }
    if (p === '/api/webcams') {
      const lat = +u.searchParams.get('lat'), lng = +u.searchParams.get('lng');
      if (!isFinite(lat) || !isFinite(lng)) return send(res, 400, { error: 'lat, lng가 필요해요' });
      return send(res, 200, await webcams(lat, lng));
    }
    if (p === '/api/brief' && req.method === 'POST') {
      const r = await aiBrief(await readBody(req), req.headers['x-admin-password'] || '');
      return send(res, r.status, r.body);
    }
    if (p === '/api/news') return send(res, 200, { news: news.list(), feeds: news.feeds() });
    if (p === '/api/health') return send(res, 200, { ok: true });
    // static
    let fp = path.normalize(path.join(ROOT, 'public', p === '/' ? 'index.html' : decodeURIComponent(p)));
    if (!fp.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    log('request error:', e.message);
    send(res, 500, { error: '서버 오류' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Watchfloor 실행 중  →  http://localhost:${PORT}${HOSTED ? '  (사이트 모드: 외부 접속 허용)' : ''}\n`);
  console.log(`  모드: ${DEMO ? '데모 (오프라인 스냅샷)' : '실시간'}   웹캠: ${WINDY_KEY ? 'Windy 연결' : 'cams.json / 링크'}   AI 브리핑: ${AI_ON ? '켜짐' : '꺼짐'}${ADMIN_PASSWORD ? ' (비밀번호)' : ''}`);
  console.log('  끄려면 이 창에서 Ctrl+C\n');
  if (process.argv.includes('--open')) {
    const url = `http://localhost:${PORT}`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\n  포트 ${PORT}을(를) 이미 쓰고 있어요. Watchfloor가 이미 켜져 있는지 확인하거나 .env에서 PORT를 바꿔 주세요.\n`);
  else console.error(e);
  process.exit(1);
});

if (DEMO) { loadSnapshot(); status.usgs = 'snapshot'; status.jma = 'off'; status.aircraft = 'off'; status.news = 'off'; }
else {
  pollUSGS(); setInterval(pollUSGS, 60000);
  pollP2P(); setInterval(pollP2P, 15000);
  news.start(180000);
}
