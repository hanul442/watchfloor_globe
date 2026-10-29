// Extra live layers: satellites (CelesTrak), natural hazards (NASA EONET), ships (aisstream.io, optional key).

// ---------- satellites ----------
const SAT_GROUPS = [
  { group: 'stations', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle' },
  { group: 'resource', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=resource&FORMAT=tle' },   // Earth observation (Landsat, Sentinel …)
  { group: 'visual', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle' }
];

export function parseTLE(text, group) {
  const lines = String(text).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      out.push({ name: lines[i].trim(), l1: lines[i + 1], l2: lines[i + 2], group, id: lines[i + 1].slice(2, 7).trim() });
      i += 2;
    }
  }
  return out;
}

// ---------- natural hazards ----------
const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30&limit=400';
const HAZARD_CATS = {
  wildfires: '산불', severeStorms: '폭풍·태풍', volcanoes: '화산', floods: '홍수', drought: '가뭄',
  dustHaze: '황사·연무', landslides: '산사태', snow: '폭설', tempExtremes: '이상 기온', manmade: '인위적 재해'
};

function centroid(geom) {
  if (geom.type === 'Point') return [geom.coordinates[1], geom.coordinates[0]];
  const ring = (geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates?.[0]?.[0]) || [];
  if (!ring.length) return null;
  const s = ring.reduce((a, p) => [a[0] + p[1], a[1] + p[0]], [0, 0]);
  return [s[0] / ring.length, s[1] / ring.length];
}

export function parseEONET(j) {
  const out = [];
  for (const ev of j.events || []) {
    const cat = ev.categories?.[0]?.id;
    if (!HAZARD_CATS[cat]) continue;
    const g = (ev.geometry || []).slice(-1)[0];
    if (!g) continue;
    const c = centroid(g);
    if (!c || !isFinite(c[0]) || !isFinite(c[1])) continue;
    // storm tracks: keep the recent path of point positions
    const track = cat === 'severeStorms' ? (ev.geometry || []).filter(x => x.type === 'Point').slice(-80).map(x => [x.coordinates[1], x.coordinates[0], Date.parse(x.date) || 0, x.magnitudeValue ?? null]) : null;
    const mag = g.magnitudeValue != null ? `${g.magnitudeValue} ${g.magnitudeUnit || ''}`.trim() : null;
    out.push({
      id: 'h-' + ev.id, type: 'hazard', cat, catKo: HAZARD_CATS[cat], title: ev.title,
      lat: c[0], lng: c[1], time: Date.parse(g.date) || Date.now(), mag, track,
      link: ev.sources?.[0]?.url || `https://eonet.gsfc.nasa.gov/api/v3/events/${ev.id}`
    });
  }
  return out.sort((a, b) => b.time - a.time);
}

// ---------- ships (AIS) ----------
// Watch boxes: chokepoints and the seas around Korea/Japan. [[south, west], [north, east]]
const AIS_BOXES = [
  [[30, 120], [42, 142]],        // Korea / Japan
  [[22, 116], [27, 123]],        // Taiwan Strait
  [[0, 98], [6, 105]],           // Malacca / Singapore
  [[24, 54], [28, 58]],          // Hormuz
  [[11, 41], [15, 45]],          // Bab el-Mandeb
  [[29, 31.5], [32, 33.5]],      // Suez
  [[35, -7], [37, -4]],          // Gibraltar
  [[50, 0], [52, 3]],            // Dover Strait
  [[8, -80.5], [9.6, -79]]       // Panama
];

const AIS_BOX_NAMES = ['한·일 근해', '대만 해협', '말라카 해협', '호르무즈 해협', '바브엘만데브', '수에즈', '지브롤터', '도버 해협', '파나마'];
const inBox = (b, lat, lng, pad = 0) => lat >= b[0][0] + pad && lat <= b[1][0] - pad && lng >= b[0][1] + pad && lng <= b[1][1] - pad;
export const boxOf = (lat, lng) => AIS_BOXES.findIndex(b => inBox(b, lat, lng));
// Position after `min` minutes at speed `sog` (knots) on course `cog` (degrees).
export function deadReckon(lat, lng, sog, cog, min) {
  const d = sog * 1.852 * min / 60 / 6371, br = cog * Math.PI / 180, la = lat * Math.PI / 180, lo = lng * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
  const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 * 180 / Math.PI, ((lo2 * 180 / Math.PI + 540) % 360) - 180];
}
// "Dark" ship: it was under way, stopped reporting, the rest of its watch box is still
// reporting (so the feed is fine), and its course would not have taken it out of the box.
export const DARK_AFTER = 20 * 60000;
export function darkCheck(ships, boxLast, now = Date.now()) {
  const changed = [];
  for (const s of ships.values()) {
    if (s.dark || !isFinite(s.lat) || !(s.sog >= 3) || s.sog > 60 || !isFinite(s.cog) || s.cog >= 360) continue;
    if (now - s.t < DARK_AFTER) continue;
    const b = boxOf(s.lat, s.lng);
    if (b < 0 || !(now - (boxLast[b] || 0) < 5 * 60000)) continue;
    const [la, lo] = deadReckon(s.lat, s.lng, s.sog, s.cog, (now - s.t) / 60000);
    if (!inBox(AIS_BOXES[b], la, lo, 0.05)) continue;   // probably just sailed out of coverage
    s.dark = true; s.darkAt = now; s.box = b; s.boxName = AIS_BOX_NAMES[b];
    changed.push(s);
  }
  return changed;
}

export function createIntel({ broadcast, status, log, UA, aisKey, onHazard = () => {} }) {
  let sats = [], hazards = [];
  const ships = new Map();
  const boxLast = AIS_BOXES.map(() => 0);   // last report time in each watch box
  const hazardSeen = new Set();
  let hazardFirst = true;

  async function get(url, type = 'json') {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`${r.status}`);
      return type === 'json' ? await r.json() : await r.text();
    } finally { clearTimeout(t); }
  }

  async function pollSats() {
    const all = [];
    for (const g of SAT_GROUPS) {
      try { all.push(...parseTLE(await get(g.url, 'text'), g.group)); }
      catch (e) { log(`satellites error (${g.group}):`, e.message); }
    }
    if (all.length) {
      const seen = new Set();
      sats = all.filter(s => !seen.has(s.id) && seen.add(s.id)).slice(0, 480);
      status.sats = 'ok';
      log(`satellites: ${sats.length}`);
    } else if (!sats.length) status.sats = 'error';
  }

  async function pollHazards() {
    try {
      const list = parseEONET(await get(EONET_URL));
      const fresh = list.filter(h => !hazardSeen.has(h.id));
      list.forEach(h => hazardSeen.add(h.id));
      hazards = list;
      status.hazards = 'ok';
      fresh.forEach(h => { if (!hazardFirst) { log(`hazard: ${h.catKo} ${h.title}`); broadcast('hazard', h); } onHazard(h, !hazardFirst); });
      hazardFirst = false;
    } catch (e) {
      status.hazards = 'error';
      log('hazards error:', e.message);
    }
  }

  let aisBackoff = 5000;
  function connectAIS() {
    if (!aisKey) { status.ships = 'off'; return; }
    if (typeof WebSocket === 'undefined') { status.ships = 'error'; log('ships: Node 22 이상이 필요해요 (WebSocket 없음)'); return; }
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(JSON.stringify({ APIKey: aisKey, BoundingBoxes: AIS_BOXES, FilterMessageTypes: ['PositionReport', 'ShipStaticData'] }));
      status.ships = 'ok'; aisBackoff = 5000; log('ships: AIS stream connected');
    };
    ws.onmessage = m => {
      try {
        const txt = typeof m.data === 'string' ? m.data : new TextDecoder().decode(m.data);
        const j = JSON.parse(txt);
        const md = j.MetaData; if (!md || !md.MMSI) return;
        const prev = ships.get(md.MMSI) || {};
        if (j.MessageType === 'PositionReport') {
          const pr = j.Message.PositionReport;
          const now = Date.now(), lat = md.latitude, lng = md.longitude;
          const b = boxOf(lat, lng); if (b >= 0) boxLast[b] = now;
          const trk = (prev.trk || []).slice(-29);
          const last = trk[trk.length - 1];
          if (!last || now - last[2] > 120000 || Math.abs(last[0] - lat) + Math.abs(last[1] - lng) > 0.01) trk.push([+lat.toFixed(4), +lng.toFixed(4), now]);
          const next = { ...prev, mmsi: md.MMSI, name: (md.ShipName || prev.name || '').trim(), lat, lng, sog: pr.Sog, cog: pr.Cog, hdg: pr.TrueHeading, t: now, trk };
          if (prev.dark) {
            // it came back: remember the gap and how far it moved while silent
            next.dark = false; next.back = { at: now, gapMin: Math.round((now - prev.t) / 60000), fromLat: prev.lat, fromLng: prev.lng };
            log(`ship back: ${next.name || md.MMSI} after ${next.back.gapMin} min`);
            broadcast('ship', { ...next, trk: undefined });
          }
          ships.set(md.MMSI, next);
        } else if (j.MessageType === 'ShipStaticData') {
          const sd = j.Message.ShipStaticData;
          ships.set(md.MMSI, { ...prev, mmsi: md.MMSI, name: (sd.Name || md.ShipName || '').trim(), shipType: sd.Type, dest: (sd.Destination || '').trim(), lat: prev.lat ?? md.latitude, lng: prev.lng ?? md.longitude, t: prev.t || Date.now() });
        }
        if (ships.size > 6000) pruneShips(15 * 60000);
      } catch { /* ignore bad frame */ }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      status.ships = 'error';
      log(`ships: AIS stream closed, retrying in ${aisBackoff / 1000}s`);
      setTimeout(connectAIS, aisBackoff);
      aisBackoff = Math.min(aisBackoff * 2, 300000);
    };
  }
  function pruneShips(maxAge = 30 * 60000) {
    const now = Date.now(), cut = now - maxAge;
    // dark ships and ships that just came back are kept for 12 hours
    for (const s of ships.values()) if (s.back && now - s.back.at > 12 * 3600e3) delete s.back;
    for (const [k, s] of ships) if (!isFinite(s.lat) || (s.t < cut && !(s.dark && now - s.t < 12 * 3600e3))) ships.delete(k);
  }
  function checkDark() {
    for (const s of darkCheck(ships, boxLast)) {
      log(`ship dark: ${s.name || s.mmsi} (${s.boxName}) silent ${Math.round((Date.now() - s.t) / 60000)} min`);
      broadcast('ship', { ...s, trk: undefined });
    }
  }

  function start() {
    status.sats = 'wait'; status.hazards = 'wait'; status.ships = aisKey ? 'wait' : 'off';
    pollSats(); setInterval(pollSats, 6 * 3600e3);
    pollHazards(); setInterval(pollHazards, 30 * 60000);
    connectAIS(); setInterval(() => pruneShips(), 5 * 60000); if (aisKey) setInterval(checkDark, 60000);
  }

  return {
    start,
    sats: () => sats,
    hazards: () => hazards,
    // dark and returned ships first so they survive the cap; tracks only for those
    ships: () => [...ships.values()].filter(s => isFinite(s.lat) && isFinite(s.lng))
      .sort((a, b) => (b.dark || b.back ? 1 : 0) - (a.dark || a.back ? 1 : 0)).slice(0, 4000)
      .map(s => s.dark || s.back ? s : { ...s, trk: undefined }),
    boxes: () => AIS_BOXES.map((b, i) => ({ name: AIS_BOX_NAMES[i], box: b, last: boxLast[i] }))
  };
}
