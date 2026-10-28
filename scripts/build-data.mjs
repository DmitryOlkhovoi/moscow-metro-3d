// Собирает data/metro.json из OpenStreetMap (геометрия путей, станции, порядок)
// и Wikidata (глубина заложения). Запуск: node scripts/build-data.mjs [--refresh]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, CENTER } from '../src/projection.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT = join(ROOT, 'data', 'metro.json');
const REFRESH = process.argv.includes('--refresh');
const UA = 'moscow-metro-3d/1.0 (personal visualization project)';

const BBOX = '55.3,36.9,56.1,38.2';
const MCC_RELATION = 6548266;

const MAX_GRADE = 0.04;      // максимальный уклон тоннеля у портала (40‰)
const BRIDGE_HEIGHT = 8;     // высота пути на мосту/эстакаде, м
const SHALLOW_DEPTH = 12;    // типичная глубина станции мелкого заложения, м
const TRANSFER_RADIUS = 150; // станции разных линий ближе этого считаем пересадкой, м
const INTERCHANGE_MAX = 1200; // пересадки из Wikidata длиннее этого считаем ошибкой, м
// Пересадки МЦК со станциями метро с другим названием, которых нет в Wikidata
const MANUAL_TRANSFERS = [
  ['Лужники', 'Спортивная'], ['Верхние Котлы', 'Нагатинская'], ['Измайлово', 'Партизанская'],
  ['Локомотив', 'Черкизовская'], ['Балтийская', 'Войковская'], ['Зорге', 'Полежаевская'],
  ['Хорошёво', 'Хорошёвская'], ['Панфиловская', 'Октябрьское поле'], ['Москва-Сити', 'Деловой центр'],
  ['Москва-Сити', 'Международная'], ['Шоссе Энтузиастов', 'Шоссе Энтузиастов'], ['Андроновка', 'Авиамоторная'],
];

// Цвета, которые в OSM заданы неудобно или неточно
const COLOR_OVERRIDES = { '14': '#E05A86', '17': '#7A7F8A' };
const LINE_LABELS = { '4А': '4', '8А': '8А' };

// ---------- загрузка с кэшем ----------

async function cached(name, fetcher) {
  const file = join(CACHE, name);
  if (!REFRESH && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  console.log(`  загрузка ${name}…`);
  const data = await fetcher();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}

async function post(url, body, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body,
    });
    if (res.ok) return res.json();
    if (attempt >= 3) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
    console.log(`  HTTP ${res.status}, повтор через ${attempt * 10} с`);
    await new Promise((r) => setTimeout(r, attempt * 10000));
  }
}

const overpass = (q) => post('https://overpass-api.de/api/interpreter', new URLSearchParams({ data: q }));

const loadOsm = () => cached('osm.json', () => overpass(`
[out:json][timeout:300];
(
  relation["route"="subway"]["network"="Московский метрополитен"](${BBOX});
  relation(${MCC_RELATION});
)->.r;
.r out geom;
way(r.r); out tags;
node(r.r); out;
`));

const loadWikidata = () => cached('wikidata.json', () => post(
  'https://query.wikidata.org/sparql',
  new URLSearchParams({ query: `
SELECT ?s ?sLabel ?coord ?depth ?lineLabel WHERE {
  ?s wdt:P16 wd:Q5499 .
  OPTIONAL { ?s p:P4511/psv:P4511 [ wikibase:quantityAmount ?depth ; wikibase:quantityUnit wd:Q11573 ] }
  OPTIONAL { ?s wdt:P625 ?coord }
  OPTIONAL { ?s wdt:P81 ?line }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ru". }
}` }),
  { Accept: 'application/sparql-results+json' },
));

// Пересадочные станции (P833) — точнее, чем просто близость
const loadInterchanges = () => cached('wd-interchange.json', () => post(
  'https://query.wikidata.org/sparql',
  new URLSearchParams({ query: 'SELECT ?s ?t WHERE { ?s wdt:P16 wd:Q5499 . ?s wdt:P833 ?t . }' }),
  { Accept: 'application/sparql-results+json' },
));

async function getJSON(url) {
  for (let attempt = 1; ; attempt++) {
    await new Promise((r) => setTimeout(r, 500)); // вежливая пауза между запросами
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res.json();
    if (attempt >= 5 || (res.status !== 429 && res.status < 500)) {
      throw new Error(`${url.slice(0, 120)}…: HTTP ${res.status}`);
    }
    const wait = Number(res.headers.get('retry-after')) || attempt * 15;
    console.log(`  HTTP ${res.status}, повтор через ${wait} с`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

// Инфобоксы статей русской Википедии: «Глубина заложения» и «Тип конструкции».
// Возвращает { qid: { depth, deep } }
const loadRuwiki = (qids) => cached('ruwiki.json', async () => {
  const titleOf = {};
  for (let i = 0; i < qids.length; i += 50) {
    const ids = qids.slice(i, i + 50).join('|');
    const j = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&props=sitelinks&sitefilter=ruwiki&format=json&ids=${ids}`);
    for (const [q, e] of Object.entries(j.entities)) if (e.sitelinks?.ruwiki) titleOf[q] = e.sitelinks.ruwiki.title;
  }
  const textOf = {};
  const titles = [...new Set(Object.values(titleOf))];
  for (let i = 0; i < titles.length; i += 15) {
    const batch = titles.slice(i, i + 15);
    const j = await getJSON('https://ru.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&redirects=1&titles='
      + encodeURIComponent(batch.join('|')));
    const alias = {};
    for (const n of [...(j.query.normalized || []), ...(j.query.redirects || [])]) alias[n.to] = n.from;
    for (const p of Object.values(j.query.pages)) {
      const text = p.revisions?.[0]?.slots.main['*'];
      if (!text) continue;
      textOf[p.title] = text;
      for (let t = p.title; alias[t]; t = alias[t]) textOf[alias[t]] = text;
    }
  }
  const out = {};
  for (const [q, title] of Object.entries(titleOf)) {
    const text = textOf[title];
    if (!text) continue;
    const field = (name) => text.match(new RegExp(`^\\s*\\|\\s*${name}\\s*=([^\\n]*)`, 'im'))?.[1]
      .replace(/<ref[^>]*\/>|<ref[\s\S]*?(<\/ref>|$)/g, '') ?? '';
    const nums = (field('Глубина заложения').match(/\d+(?:[.,]\d+)?/g) || []).slice(0, 2).map((n) => +n.replace(',', '.'));
    const type = field('Тип конструкции').toLowerCase();
    out[q] = {
      depth: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
      deep: /глубокого/.test(type) ? true : /мелкого/.test(type) ? false : null,
    };
  }
  return out;
});

// ---------- утилиты ----------

const STOP_WORDS = new Set(['станция', 'платформа', 'метро', 'мцк', 'линия']);
const words = (s) => s.toLowerCase().replace(/ё/g, 'е').split(/[\s«»"().,\-–—]+/).filter((w) => w && !STOP_WORDS.has(w));
const norm = (s) => words(s).join(' ');
const lineKey = norm;
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const keyOf = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;

function lineNameFromRelation(name) {
  return name.split(/[:(]/)[0].replace(/\s+$/, '').trim();
}

// Простейшая двоичная куча для Дейкстры
class Heap {
  constructor() { this.a = []; }
  push(v) { const a = this.a; a.push(v); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) { a[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top; }
  get size() { return this.a.length; }
}

// Граф путей одной линии: вершины — точки OSM, рёбра — отрезки путей
function buildTrackGraph(ways, wayTags) {
  const verts = new Map(); // key -> {id, xz, kind}
  const list = [];
  const adj = [];
  const vertex = (p, kind) => {
    const k = keyOf(p);
    let v = verts.get(k);
    if (!v) {
      v = { id: list.length, xz: project(p.lat, p.lon), kind };
      verts.set(k, v); list.push(v); adj.push([]);
    } else if (kind > v.kind) v.kind = kind; // точка на стыке портала: «надземнее» побеждает
    return v.id;
  };
  for (const w of ways) {
    const t = wayTags.get(w.ref) || {};
    // 0 — тоннель, 1 — на поверхности, 2 — мост/эстакада
    const kind = t.tunnel && t.tunnel !== 'no' ? 0
      : (t.bridge && t.bridge !== 'no') ? 2
      : (Number(t.layer) < 0 || t.location === 'underground') ? 0 : 1;
    let prev = null;
    for (const p of w.geometry) {
      const id = vertex(p, kind);
      if (prev !== null && prev !== id) {
        const d = dist2(list[prev].xz, list[id].xz);
        adj[prev].push([id, d]); adj[id].push([prev, d]);
      }
      prev = id;
    }
  }
  return { verts, list, adj };
}

function nearestVertex(g, xz, maxDist = 80) {
  let best = -1, bd = maxDist;
  for (const v of g.list) { const d = dist2(v.xz, xz); if (d < bd) { bd = d; best = v.id; } }
  return best;
}

function shortestPath(g, from, to) {
  const dist = new Float64Array(g.list.length).fill(Infinity);
  const prev = new Int32Array(g.list.length).fill(-1);
  const h = new Heap();
  dist[from] = 0; h.push([0, from]);
  while (h.size) {
    const [d, u] = h.pop();
    if (u === to) break;
    if (d > dist[u]) continue;
    for (const [v, w] of g.adj[u]) {
      const nd = d + w;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; h.push([nd, v]); }
    }
  }
  if (!isFinite(dist[to])) return null;
  const path = [];
  for (let u = to; u !== -1; u = prev[u]) path.push(u);
  return path.reverse();
}

// Упрощение ломаной (Douglas–Peucker) по горизонтали, с сохранением точек смены типа пути
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  for (let i = 1; i < pts.length; i++) if (pts[i].kind !== pts[i - 1].kind) keep[i] = keep[i - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a].xz, [bx, bz] = pts[b].xz;
    const len = Math.hypot(bx - ax, bz - az) || 1;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = pts[i].xz;
      const d = Math.abs((bx - ax) * (az - pz) - (ax - px) * (bz - az)) / len;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------- сборка ----------

async function main() {
  console.log('Загрузка исходных данных');
  const osm = await loadOsm();
  const wd = await loadWikidata();

  const relations = osm.elements.filter((e) => e.type === 'relation');
  const wayTags = new Map(osm.elements.filter((e) => e.type === 'way').map((e) => [e.id, e.tags || {}]));
  const nodeTags = new Map(osm.elements.filter((e) => e.type === 'node').map((e) => [e.id, e.tags || {}]));

  // Группируем маршруты по линиям (4 и 4А — одна линия с ответвлением)
  const lineOf = (r) => (r.id === MCC_RELATION || r.tags.ref === '14' ? '14' : r.tags.ref === '4А' ? '4' : r.tags.ref);
  const linesById = new Map();
  for (const r of relations) {
    if (r.id !== MCC_RELATION && r.tags.route !== 'subway') continue;
    const id = lineOf(r);
    if (!linesById.has(id)) {
      linesById.set(id, {
        id,
        name: id === '14' ? 'Московское центральное кольцо' : lineNameFromRelation(r.tags.name),
        color: COLOR_OVERRIDES[id] || r.tags.colour,
        relations: [],
      });
    }
    const line = linesById.get(id);
    if (r.tags.ref === id) line.name = id === '14' ? line.name : lineNameFromRelation(r.tags.name);
    line.relations.push(r);
  }

  // Объекты Wikidata (одна станция может относиться к нескольким линиям)
  const items = new Map();
  for (const b of wd.results.bindings) {
    const qid = b.s.value.split('/').pop();
    if (!items.has(qid)) {
      const m = b.coord?.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
      items.set(qid, { qid, name: b.sLabel.value, lines: new Set(), xz: m ? project(+m[2], +m[1]) : null, depth: null });
    }
    const it = items.get(qid);
    if (b.lineLabel) it.lines.add(lineKey(b.lineLabel.value));
    if (b.depth) it.depth = Math.abs(Number(b.depth.value));
  }
  const ruwiki = await loadRuwiki([...items.keys()]);
  const wdByName = new Map();
  for (const it of items.values()) {
    const k = norm(it.name);
    if (!wdByName.has(k)) wdByName.set(k, []);
    wdByName.get(k).push(it);
  }

  // Объект Wikidata для станции: то же имя и линия; иначе ближайший без «чужой» линии
  function matchItem(k, lk, xz) {
    const cands = (wdByName.get(k) || []).filter((c) => !c.xz || dist2(c.xz, xz) < 1500);
    const sameLine = cands.filter((c) => c.lines.has(lk));
    const known = (c) => c.depth != null || ruwiki[c.qid]?.depth != null;
    const rank = (c) => (known(c) ? 0 : 1e6) + (c.xz ? dist2(c.xz, xz) : 1e5);
    if (sameLine.length) return sameLine.sort((a, b) => rank(a) - rank(b))[0];
    return cands.filter((c) => c.xz && dist2(c.xz, xz) < 400 && c.lines.size === 0)[0] || null;
  }

  const stations = [];
  const segments = [];
  const stats = { wikidata: 0, ruwiki: 0, surface: 0, estimated: 0, straight: 0 };

  for (const line of linesById.values()) {
    const ways = line.relations.flatMap((r) => r.members.filter((m) => m.type === 'way' && m.role === '' && m.geometry));
    const g = buildTrackGraph(ways, wayTags);

    // Станции линии: остановки из всех маршрутов, сгруппированные по имени
    const byName = new Map();
    const routes = [];
    for (const r of line.relations) {
      const seq = [];
      for (const m of r.members) {
        if (m.type !== 'node' || !/^stop/.test(m.role)) continue;
        const tags = nodeTags.get(m.ref) || {};
        const name = (tags.name || '').replace(/\s*\(.*\)\s*$/, '').trim();
        if (!name) continue;
        const k = norm(name);
        if (!byName.has(k)) byName.set(k, { name, stops: [] });
        const xz = project(m.lat, m.lon);
        byName.get(k).stops.push({ xz, v: g.verts.get(keyOf(m))?.id ?? nearestVertex(g, xz) });
        if (seq[seq.length - 1] !== k) seq.push(k);
      }
      routes.push(seq);
    }

    const lineStations = new Map();
    for (const [k, s] of byName) {
      const x = s.stops.reduce((a, p) => a + p.xz[0], 0) / s.stops.length;
      const z = s.stops.reduce((a, p) => a + p.xz[1], 0) / s.stops.length;
      const kinds = s.stops.map((p) => (p.v >= 0 ? g.list[p.v].kind : 0));
      const st = {
        id: `${line.id}:${k}`,
        name: s.name,
        line: line.id,
        x: round(x), z: round(z),
        kind: Math.max(...kinds), // 0 подземная, 1 наземная, 2 эстакада
        stops: s.stops,
      };
      const item = matchItem(k, lineKey(line.name), [x, z]);
      const wiki = item && ruwiki[item.qid];
      if (item) st.wikidata = item.qid;
      if (wiki?.deep != null) st.deep = wiki.deep;
      if (st.kind > 0 || line.id === '14') {
        st.depth = st.kind === 2 ? -BRIDGE_HEIGHT : 0;
        st.depthSource = 'surface';
        stats.surface++;
      } else if (item?.depth != null) {
        st.depth = item.depth;
        st.depthSource = 'wikidata';
        stats.wikidata++;
      } else if (wiki?.depth != null) {
        st.depth = round(wiki.depth);
        st.depthSource = 'ruwiki';
        stats.ruwiki++;
      } else {
        st.depth = null;
      }
      lineStations.set(k, st);
    }

    // Перегоны: соседние остановки во всех маршрутах, без повторов
    const seen = new Set();
    const lineSegs = [];
    for (const seq of routes) {
      for (let i = 1; i < seq.length; i++) {
        const a = lineStations.get(seq[i - 1]), b = lineStations.get(seq[i]);
        const key = [a.id, b.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        lineSegs.push({ a, b });
      }
    }

    // Оценка недостающих глубин: станции мелкого заложения ~12 м,
    // остальные — среднее известных подземных соседей по линии (итеративно)
    const nb = new Map([...lineStations.values()].map((s) => [s.id, []]));
    for (const { a, b } of lineSegs) { nb.get(a.id).push(b); nb.get(b.id).push(a); }
    const unknown = [...lineStations.values()].filter((s) => !s.depthSource);
    const fixed = new Set();
    for (const s of unknown) {
      // одноимённая станция узла рядом (часто кросс-платформенная пересадка на той же глубине)
      const twin = (wdByName.get(norm(s.name)) || []).find((c) => c.depth != null && c.xz && dist2(c.xz, [s.x, s.z]) < 300);
      if (twin) s.depth = twin.depth;
      else if (s.deep === false) s.depth = SHALLOW_DEPTH;
      if (s.depth != null) fixed.add(s);
    }
    for (let iter = 0; iter < 10; iter++) {
      for (const s of unknown) {
        if (fixed.has(s)) continue;
        const known = nb.get(s.id).filter((n) => n.depth != null && n.depthSource !== 'surface');
        if (!known.length) continue;
        const avg = known.reduce((a, n) => a + n.depth, 0) / known.length;
        s.depth = round(s.deep ? Math.max(avg, 30) : avg, 0);
      }
    }
    for (const s of unknown) {
      if (s.depth == null) s.depth = s.deep ? 40 : SHALLOW_DEPTH;
      s.depthSource = 'estimate';
      stats.estimated++;
    }

    // Геометрия перегонов по путям OSM + профиль глубины
    for (const { a, b } of lineSegs) {
      let best = null;
      for (const sa of a.stops) for (const sb of b.stops) {
        if (sa.v < 0 || sb.v < 0) continue;
        const p = shortestPath(g, sa.v, sb.v);
        if (!p) continue;
        let len = 0;
        for (let i = 1; i < p.length; i++) len += dist2(g.list[p[i - 1]].xz, g.list[p[i]].xz);
        if (!best || len < best.len) best = { p, len };
      }
      let pts;
      const direct = dist2([a.x, a.z], [b.x, b.z]);
      if (best && best.len < direct * 3 + 500) {
        pts = best.p.map((id) => ({ xz: g.list[id].xz, kind: g.list[id].kind }));
        // концы — в центры станций
        pts[0] = { xz: [a.x, a.z], kind: pts[0].kind };
        pts[pts.length - 1] = { xz: [b.x, b.z], kind: pts[pts.length - 1].kind };
      } else {
        stats.straight++;
        const kind = Math.min(a.kind, b.kind);
        pts = [{ xz: [a.x, a.z], kind }, { xz: [b.x, b.z], kind }];
      }
      pts = simplify(pts, 2);

      // Длина вдоль пути и линейная интерполяция глубины между станциями
      const s = [0];
      for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + dist2(pts[i - 1].xz, pts[i].xz));
      const total = s[s.length - 1] || 1;
      // расстояние до ближайшего портала (смены тоннель/поверхность) вдоль пути
      const portals = [];
      const bridgeEnds = [];
      for (let i = 1; i < pts.length; i++) {
        if ((pts[i].kind === 0) !== (pts[i - 1].kind === 0)) portals.push((s[i] + s[i - 1]) / 2);
        if ((pts[i].kind === 2) !== (pts[i - 1].kind === 2)) bridgeEnds.push(pts[i].kind === 2 ? s[i] : s[i - 1]);
      }
      const y = pts.map((p, i) => {
        // мост: плавный подъём от насыпи, короткие мосты почти не поднимаются
        if (p.kind === 2) return bridgeEnds.reduce((h, q) => Math.min(h, Math.abs(s[i] - q) * MAX_GRADE), BRIDGE_HEIGHT);
        if (p.kind === 1) return 0;
        let d = a.depth + (b.depth - a.depth) * (s[i] / total);
        for (const q of portals) d = Math.min(d, Math.abs(s[i] - q) * MAX_GRADE);
        return -Math.max(d, 0);
      });
      y[0] = -a.depth; y[y.length - 1] = -b.depth;

      let len3d = 0;
      for (let i = 1; i < pts.length; i++) {
        len3d += Math.hypot(pts[i].xz[0] - pts[i - 1].xz[0], pts[i].xz[1] - pts[i - 1].xz[1], y[i] - y[i - 1]);
      }
      segments.push({
        line: line.id,
        a: a.id, b: b.id,
        length: Math.round(len3d),
        direct: Math.round(Math.hypot(b.x - a.x, b.z - a.z, b.depth - a.depth)),
        pts: pts.map((p, i) => [round(p.xz[0]), round(p.xz[1]), round(y[i])]),
      });
    }

    for (const st of lineStations.values()) { delete st.stops; stations.push(st); }
  }

  // Пересадки: P833 из Wikidata, одноимённые рядом или очень близко, на разных линиях
  const interchange = new Set();
  const byQid = new Map();
  for (const s of stations) if (s.wikidata) byQid.set(s.wikidata, [...(byQid.get(s.wikidata) || []), s]);
  for (const b of (await loadInterchanges()).results.bindings) {
    for (const a of byQid.get(b.s.value.split('/').pop()) || []) {
      for (const c of byQid.get(b.t.value.split('/').pop()) || []) interchange.add([a.id, c.id].sort().join('|'));
    }
  }
  const manual = MANUAL_TRANSFERS.map((p) => p.map(norm));
  const isManual = (a, b) => manual.some(([p, q]) => (norm(a.name) === p && norm(b.name) === q) || (norm(a.name) === q && norm(b.name) === p));
  const transfers = [];
  const transferStats = { wikidata: 0, proximity: 0 };
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i], b = stations[j];
      if (a.line === b.line) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      const wdPair = (interchange.has([a.id, b.id].sort().join('|')) || isManual(a, b)) && d < INTERCHANGE_MAX;
      if (wdPair || d < TRANSFER_RADIUS || (norm(a.name) === norm(b.name) && d < 800)) {
        transferStats[wdPair ? 'wikidata' : 'proximity']++;
        transfers.push({ a: a.id, b: b.id, length: Math.round(Math.hypot(a.x - b.x, a.z - b.z, a.depth - b.depth)) });
      }
    }
  }

  const lines = [...linesById.values()].map((l) => ({
    id: l.id, name: l.name, color: l.color.toUpperCase(), label: LINE_LABELS[l.id] || l.id,
  })).sort((p, q) => parseInt(p.id) - parseInt(q.id) || p.id.localeCompare(q.id));

  const out = {
    generated: new Date().toISOString().slice(0, 10),
    center: CENTER,
    sources: ['© участники OpenStreetMap (ODbL)', 'Wikidata (CC0)'],
    lines, stations, segments, transfers,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));

  console.log(`Линий: ${lines.length}, станций: ${stations.length}, перегонов: ${segments.length}, пересадок: ${transfers.length} (Wikidata ${transferStats.wikidata}, по близости ${transferStats.proximity})`);
  console.log(`Глубина: Wikidata ${stats.wikidata}, Википедия ${stats.ruwiki}, наземные ${stats.surface}, оценка ${stats.estimated}`);
  console.log(`Перегонов без геометрии путей (прямая): ${stats.straight}`);
  console.log(`→ ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
