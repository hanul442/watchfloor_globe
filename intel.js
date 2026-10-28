// Extra live layers: satellites (CelesTrak), natural hazards (NASA EONET), ships (aisstream.io, optional key).

// ---------- satellites ----------
const SAT_GROUPS = [
  { group: 'stations', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle' },
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
    const mag = g.magnitudeValue != null ? `${g.magnitudeValue} ${g.magnitudeUnit || ''}`.trim() : null;
    out.push({
      id: 'h-' + ev.id, type: 'hazard', cat, catKo: HAZARD_CATS[cat], title: ev.title,
      lat: c[0], lng: c[1], time: Date.parse(g.date) || Date.now(), mag,
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

export function createIntel({ broadcast, status, log, UA, aisKey, onHazard = () => {} }) {
  let sats = [], hazards = [];
  const ships = new Map();
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
      sats = all.filter(s => !seen.has(s.id) && seen.add(s.id)).slice(0, 260);
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
          ships.set(md.MMSI, { ...prev, mmsi: md.MMSI, name: (md.ShipName || prev.name || '').trim(), lat: md.latitude, lng: md.longitude, sog: pr.Sog, cog: pr.Cog, t: Date.now() });
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
    const cut = Date.now() - maxAge;
    for (const [k, s] of ships) if (s.t < cut || !isFinite(s.lat)) ships.delete(k);
  }

  function start() {
    status.sats = 'wait'; status.hazards = 'wait'; status.ships = aisKey ? 'wait' : 'off';
    pollSats(); setInterval(pollSats, 6 * 3600e3);
    pollHazards(); setInterval(pollHazards, 30 * 60000);
    connectAIS(); setInterval(() => pruneShips(), 5 * 60000);
  }

  return {
    start,
    sats: () => sats,
    hazards: () => hazards,
    ships: () => [...ships.values()].filter(s => isFinite(s.lat) && isFinite(s.lng)).slice(0, 4000)
  };
}
