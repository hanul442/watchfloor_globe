// Event engine. Every raw item (USGS/JMA quake, early warning, tsunami notice,
// news article, NASA hazard) is a "signal". Signals that describe the same
// happening are merged into one "event", which is what the screen shows.

const R = x => x * Math.PI / 180;
export function distKm(a1, o1, a2, o2) {
  const h = Math.sin(R(a2 - a1) / 2) ** 2 + Math.cos(R(a1)) * Math.cos(R(a2)) * Math.sin(R(o2 - o1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const TYPES = {
  quake: '지진', tsunami: '쓰나미', conflict: '분쟁', disaster: '재난', accident: '사고', news: '주요 뉴스'
};

const RE = {
  quake: /(지진|여진|진도|earthquake|quake|aftershock|seismic)/i,
  tsunami: /(쓰나미|해일|tsunami)/i,
  conflict: /(공습|교전|포격|폭격|미사일|드론|총격|테러|침공|전투|휴전|무력 충돌|사살|피격|군사 작전|airstrikes?|air strikes?|strikes?|shelling|clashes|missiles?|drones?|ceasefire|offensive|invasion|militants?|troops|gunmen|insurgents?|bombing|rocket)/i,
  disaster: /(홍수|태풍|허리케인|산불|화산|분화|폭우|폭설|가뭄|산사태|폭염|한파|사이클론|flood|typhoon|hurricane|cyclone|wildfire|bushfire|volcan|eruption|landslide|drought|heatwave|blizzard|storm)/i,
  accident: /(추락|충돌|화재|폭발|붕괴|탈선|침몰|사고|crash|collision|fire|explosion|blast|collapse|derail|capsiz|sank|accident)/i
};
const FLASH = /(속보|긴급|breaking)/i;

function classifyNews(t) {
  if (RE.tsunami.test(t)) return 'tsunami';
  if (RE.quake.test(t)) return 'quake';
  if (RE.conflict.test(t)) return 'conflict';
  if (RE.disaster.test(t)) return 'disaster';
  if (RE.accident.test(t)) return 'accident';
  return 'news';
}

function quakeSeverity(q) {
  const shindo = { '5-': 3, '5+': 4, '6-': 5, '6+': 5, '7': 5 }[q.maxScale] || 0;
  const bym = q.mag >= 7 ? 5 : q.mag >= 6.3 ? 4 : q.mag >= 5.8 ? 3 : q.mag >= 5 ? 2 : 1;
  const alert = { red: 5, orange: 4, yellow: 3 }[q.alert] || 0;
  return Math.max(bym, shindo, alert);
}
const HAZARD_SEV = { volcanoes: 3, severeStorms: 3, floods: 3, wildfires: 2, landslides: 2, drought: 2, dustHaze: 1, snow: 2, tempExtremes: 2, manmade: 2 };
const OFFICIAL = new Set(['usgs', 'jma', 'eew', 'tsunami', 'eonet']);

export function createEvents({ broadcast, log }) {
  const events = new Map();
  const bySignal = new Map();   // signal id -> event id
  let seq = 0;

  function newEvent(type, sig) {
    const id = `ev-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const ev = { id, type, typeKo: TYPES[type], title: sig.title, place: sig.place || '', lat: sig.lat, lng: sig.lng, start: sig.time, updated: sig.time, status: 'open', severity: 1, confidence: 0.4, signals: [], sources: [], flash: false };
    events.set(id, ev);
    return ev;
  }

  function recompute(ev) {
    const sigs = ev.signals.sort((a, b) => b.time - a.time);
    ev.start = Math.min(...sigs.map(s => s.time));
    ev.updated = Math.max(...sigs.map(s => s.time));
    ev.sources = [...new Set(sigs.map(s => s.src))];
    ev.flash = sigs.some(s => s.flash);
    const official = sigs.filter(s => OFFICIAL.has(s.kind));
    // anchor: the strongest official signal, else the newest article
    const anchor = official.sort((a, b) => (b.sev || 0) - (a.sev || 0))[0] || sigs.find(s => s.flash) || sigs[0];
    ev.anchor = anchor.id;
    ev.title = anchor.title;
    if (anchor.place) ev.place = anchor.place;
    if (ev.type === 'quake' && anchor.data && anchor.kind !== 'eew') {
      // English USGS place reads better than the JMA Japanese name; keep JMA's intensity
      const us = sigs.find(s => s.kind === 'usgs'), jma = sigs.find(s => s.kind === 'jma');
      ev.place = us ? us.place : anchor.place;
      ev.title = `M${(+anchor.data.mag).toFixed(1)} · ${ev.place}${jma?.data?.maxScale ? ' · 진도 ' + jma.data.maxScale : ''}`;
    }
    if (isFinite(anchor.lat) && anchor.lat > -90) { ev.lat = anchor.lat; ev.lng = anchor.lng; }
    const base = Math.max(...sigs.map(s => s.sev || 1));
    const articles = sigs.filter(s => s.kind === 'news');
    const outlets = new Set(articles.map(s => s.src)).size;
    let sev = base;
    if (!official.length) sev = Math.min(5, base + (outlets >= 3 ? 1 : 0) + (outlets >= 6 ? 1 : 0));
    ev.severity = Math.max(1, Math.min(5, sev));
    ev.confidence = official.length ? 0.95 : Math.min(0.9, 0.4 + 0.15 * (outlets - 1));
    ev.status = Date.now() - ev.updated > (ev.type === 'quake' ? 24 : 48) * 3600e3 ? 'closed' : 'open';
    ev.counts = { signals: sigs.length, articles: articles.length, outlets };
  }

  function findMatch(sig, types, maxKm, maxAgeMs) {
    let best = null, bestD = Infinity;
    for (const ev of events.values()) {
      if (!types.includes(ev.type)) continue;
      if (Math.abs(sig.time - ev.updated) > maxAgeMs && Math.abs(sig.time - ev.start) > maxAgeMs) continue;
      if (!isFinite(sig.lat) || !isFinite(ev.lat)) continue;
      const d = distKm(sig.lat, sig.lng, ev.lat, ev.lng);
      if (d <= maxKm && d < bestD) { best = ev; bestD = d; }
    }
    return best;
  }

  // Turn a raw item into a signal and attach it to an event.
  function ingest(kind, raw, live = true) {
    if (!raw) return null;
    let sig, type, match = null;
    if (kind === 'usgs' || kind === 'jma') {
      sig = { id: raw.id, kind, src: kind === 'usgs' ? 'USGS' : '일본 기상청', title: `M${(+raw.mag).toFixed(1)} · ${raw.place}`, place: raw.place, lat: raw.lat, lng: raw.lng, time: +raw.time, sev: quakeSeverity(raw), link: raw.url || null, data: raw };
      type = 'quake';
      // the same quake from the other agency: ±10 min, 150 km; also an earlier early warning
      for (const ev of events.values()) {
        if (ev.type !== 'quake') continue;
        if (ev.signals.some(s => (s.kind === 'usgs' || s.kind === 'jma' || s.kind === 'eew') && Math.abs(s.time - sig.time) < 10 * 60000 && isFinite(s.lat) && s.lat > -90 && distKm(s.lat, s.lng, sig.lat, sig.lng) < 150)) { match = ev; break; }
      }
    } else if (kind === 'eew') {
      sig = { id: raw.id, kind, src: '긴급지진속보', title: `긴급지진속보 · ${raw.place}${raw.mag ? ' M' + raw.mag : ''}${raw.cancelled ? ' (취소)' : ''}`, place: raw.place, lat: raw.lat, lng: raw.lng, time: +raw.time, sev: raw.cancelled ? 1 : (raw.mag >= 6.5 ? 5 : 4), data: raw };
      type = 'quake';
      if (isFinite(sig.lat) && sig.lat > -90) match = findMatch(sig, ['quake'], 200, 5 * 60000);
    } else if (kind === 'tsunami') {
      const grades = (raw.areas || []).map(a => a.grade);
      sig = { id: raw.id, kind, src: '일본 기상청', title: raw.cancelled ? '쓰나미 정보 해제' : `쓰나미 정보 · ${(raw.areas || []).length}개 해역`, place: '일본 연안', lat: 36, lng: 138, time: +raw.time, sev: raw.cancelled ? 1 : grades.includes('MajorWarning') || grades.includes('Warning') ? 5 : grades.includes('Watch') ? 4 : 3, data: raw };
      type = 'tsunami';
      // tie to a recent Japan quake if there is one
      let q = null;
      for (const ev of events.values()) if (ev.type === 'quake' && sig.time - ev.start < 2 * 3600e3 && sig.time >= ev.start - 60000 && distKm(36, 138, ev.lat, ev.lng) < 1200 && (!q || ev.severity > q.severity)) q = ev;
      match = q;
      if (!match) match = findMatch(sig, ['tsunami'], 2000, 6 * 3600e3);
    } else if (kind === 'news') {
      type = classifyNews(raw.title);
      const flash = !!raw.flash || FLASH.test(raw.title);
      sig = { id: raw.id, kind, src: raw.outlet || raw.feed || '뉴스', title: raw.title, place: raw.place, lat: raw.lat, lng: raw.lng, time: +raw.time, sev: flash ? (type === 'news' ? 2 : 3) : (type === 'news' ? 1 : 2), flash, link: raw.link, desc: raw.desc, scope: raw.scope };
      const radius = raw.scope === 'country' ? 900 : 350;
      if (type === 'quake' || type === 'tsunami') match = findMatch(sig, ['quake', 'tsunami'], 1200, 48 * 3600e3);
      else if (type === 'disaster') match = findMatch(sig, ['disaster'], 600, 7 * 864e5);
      else match = findMatch(sig, [type], radius, 48 * 3600e3);
      // an article about a quake with no matching quake event is filed as a disaster story
      if (!match && type === 'quake') type = 'disaster';
      if (!match && type === 'tsunami') type = 'disaster';
    } else if (kind === 'eonet') {
      sig = { id: raw.id, kind, src: 'NASA EONET', title: `${raw.catKo} · ${raw.title}`, place: raw.title, lat: raw.lat, lng: raw.lng, time: +raw.time, sev: HAZARD_SEV[raw.cat] || 2, link: raw.link, data: raw };
      type = 'disaster';
      match = findMatch(sig, ['disaster'], 300, 7 * 864e5);
    } else return null;

    // already known signal: update in place
    const knownEv = bySignal.get(sig.id);
    if (knownEv && events.has(knownEv)) {
      const ev = events.get(knownEv);
      const i = ev.signals.findIndex(s => s.id === sig.id);
      if (i >= 0) ev.signals[i] = sig;
      recompute(ev);
      if (live) emit(ev, false);
      return ev;
    }
    const ev = match || newEvent(type, sig);
    const prevSev = match ? ev.severity : 0;
    ev.signals.push(sig);
    bySignal.set(sig.id, ev.id);
    recompute(ev);
    if (live) emit(ev, !match, sig, prevSev);
    return ev;
  }

  function emit(ev, isNew, sig, prevSev = 0) {
    broadcast('event', { ...pack(ev), isNew, newSignal: sig ? sig.id : null, rose: ev.severity > prevSev });
  }

  // drop raw payload of old signals to keep the stream small
  function pack(ev) {
    return { ...ev, signals: ev.signals.slice(0, 40) };
  }

  function prune() {
    const cut = Date.now() - 8 * 864e5;
    for (const [id, ev] of events) {
      if (ev.updated < cut) { events.delete(id); ev.signals.forEach(s => bySignal.delete(s.id)); }
      else if (ev.status === 'open' && Date.now() - ev.updated > (ev.type === 'quake' ? 24 : 48) * 3600e3) ev.status = 'closed';
    }
  }
  setInterval(prune, 10 * 60000).unref?.();

  return {
    ingest,
    list: () => [...events.values()].sort((a, b) => b.updated - a.updated).map(pack),
    get: id => events.get(id),
    near: (lat, lng, km) => [...events.values()].filter(ev => isFinite(ev.lat) && distKm(lat, lng, ev.lat, ev.lng) <= km)
  };
}
