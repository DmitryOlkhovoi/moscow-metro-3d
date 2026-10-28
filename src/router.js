// Построение маршрута: Дейкстра по времени в пути.
// Время — оценка: средняя скорость в движении, стоянки, пешие пересадки и ожидание поезда.

const RIDE_SPEED = 13.9;      // м/с в движении (≈50 км/ч)
const DWELL = 30;             // стоянка на промежуточной станции, с
const WALK_SPEED = 1.2;       // м/с пешком
const WALK_DETOUR = 1.3;      // переходы длиннее прямой между центрами станций
const WAIT = 120;             // ожидание поезда после пересадки, с
const WAIT_MCC = 240;         // на МЦК интервалы больше
const TRANSFER_PENALTY = 60;  // штраф за пересадку, чтобы не выбирать лишние

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

export class Router {
  constructor(data, stationById) {
    this.stationById = stationById;
    this.adj = new Map(data.stations.map((s) => [s.id, []]));
    for (const seg of data.segments) {
      const t = seg.length / RIDE_SPEED + DWELL;
      this.adj.get(seg.a).push({ to: seg.b, time: t, seg, kind: 'ride' });
      this.adj.get(seg.b).push({ to: seg.a, time: t, seg, kind: 'ride' });
    }
    for (const tr of data.transfers) {
      const walk = (tr.length * WALK_DETOUR) / WALK_SPEED;
      const a = stationById.get(tr.a), b = stationById.get(tr.b);
      this.adj.get(tr.a).push({ to: tr.b, walk, time: walk + (b.line === '14' ? WAIT_MCC : WAIT) + TRANSFER_PENALTY, length: tr.length, kind: 'transfer' });
      this.adj.get(tr.b).push({ to: tr.a, walk, time: walk + (a.line === '14' ? WAIT_MCC : WAIT) + TRANSFER_PENALTY, length: tr.length, kind: 'transfer' });
    }
  }

  // Маршрут между станциями. Ноги — участки на одной линии.
  route(fromId, toId, hiddenLines = new Set()) {
    if (fromId === toId) return null;
    const dist = new Map([[fromId, 0]]);
    const prev = new Map();
    const heap = new Heap();
    heap.push([0, fromId]);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (u === toId) break;
      if (d > dist.get(u)) continue;
      for (const e of this.adj.get(u)) {
        if (hiddenLines.has(this.stationById.get(e.to).line)) continue;
        const nd = d + e.time;
        if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: u, edge: e }); heap.push([nd, e.to]); }
      }
    }
    if (!prev.has(toId)) return null;

    const steps = [];
    for (let v = toId; v !== fromId; v = prev.get(v).from) steps.push({ from: prev.get(v).from, to: v, edge: prev.get(v).edge });
    steps.reverse();
    // Переход в начале или конце не нужен: пассажиру всё равно, с какой линии узла начинать
    while (steps.length > 1 && steps[steps.length - 1].edge.kind === 'transfer') steps.pop();
    while (steps.length > 1 && steps[0].edge.kind === 'transfer') steps.shift();
    if (steps.every((st) => st.edge.kind === 'transfer')) return null;

    const legs = [];
    const transfers = [];
    let time = WAIT; // ожидание первого поезда
    let length = 0;
    for (const st of steps) {
      const a = this.stationById.get(st.from), b = this.stationById.get(st.to);
      if (st.edge.kind === 'transfer') {
        transfers.push({ from: a, to: b, length: st.edge.length, time: st.edge.walk + (b.line === '14' ? WAIT_MCC : WAIT) });
        time += st.edge.walk + (b.line === '14' ? WAIT_MCC : WAIT);
        continue;
      }
      let leg = legs[legs.length - 1];
      if (!leg || leg.line !== a.line || leg.stations[leg.stations.length - 1] !== a) {
        leg = { line: a.line, stations: [a], segments: [], length: 0, time: 0 };
        legs.push(leg);
      }
      leg.stations.push(b);
      leg.segments.push(st.edge.seg);
      leg.length += st.edge.seg.length;
      leg.time += st.edge.time;
      length += st.edge.seg.length;
      time += st.edge.time;
    }
    for (const leg of legs) leg.time -= DWELL; // на конечной ноги не стоим
    time -= DWELL * legs.length;
    const all = legs.flatMap((l) => l.stations);
    return {
      from: all[0],
      to: all[all.length - 1],
      legs,
      transfers,
      time,
      length,
      maxDepth: Math.max(...all.map((s) => s.depth)),
      stations: all,
    };
  }
}
