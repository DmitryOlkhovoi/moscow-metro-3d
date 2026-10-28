// Объекты метро в сцене: пути, станции, вертикали до поверхности, пересадки, подписи, подсветка маршрута.
// Все координаты — реальные метры; вертикальное преувеличение применяется масштабом по Y.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const STATION_RADIUS_PX = 4.5;
const LABEL_DISTANCE = 9000; // подписи видны, когда камера ближе, м
const DIM_OPACITY = 0.14;    // линии вне маршрута

// Слои поверх карты: карта не пишет глубину и рисуется первой, поэтому метро видно сквозь землю
export const ORDER = { ground: 0, ground2: 1, shafts: 2, tracks: 3, route: 4, stations: 5, overlay: 6 };

export class MetroScene {
  constructor(data, resolution) {
    this.data = data;
    this.exaggeration = 10;
    this.root = new THREE.Group();
    this.scaled = new THREE.Group(); // всё, что растягивается по Y целиком
    this.root.add(this.scaled);

    this.lineById = new Map(data.lines.map((l) => [l.id, l]));
    this.stationById = new Map(data.stations.map((s, i) => [s.id, Object.assign(s, { index: i })]));
    this.hiddenLines = new Set();
    this.materials = [];
    this.selected = null;
    this.hovered = null;
    this.showLabels = true;
    this.showShafts = true;
    this.route = null;
    this.routeStations = null;
    this.resolution = resolution;

    this.#buildTracks();
    this.#buildShafts();
    this.#buildTransfers();
    this.#buildStations();
    this.#buildLabels();
    this.setExaggeration(this.exaggeration);
  }

  #lineMaterial(color, width, extra = {}) {
    const m = new LineMaterial({
      color, linewidth: width, worldUnits: false, transparent: true, depthWrite: true, ...extra,
    });
    m.resolution.copy(this.resolution);
    this.materials.push(m);
    return m;
  }

  #buildTracks() {
    this.tracks = new Map();
    for (const line of this.data.lines) {
      const pos = [];
      for (const seg of this.data.segments) {
        if (seg.line !== line.id) continue;
        for (let i = 1; i < seg.pts.length; i++) {
          const [x0, z0, y0] = seg.pts[i - 1], [x1, z1, y1] = seg.pts[i];
          pos.push(x0, y0, z0, x1, y1, z1);
        }
      }
      const geo = new LineSegmentsGeometry().setPositions(pos);
      const obj = new LineSegments2(geo, this.#lineMaterial(line.color, 3.5));
      obj.renderOrder = ORDER.tracks;
      this.tracks.set(line.id, obj);
      this.scaled.add(obj);
    }
  }

  #buildShafts() {
    this.shafts = new Map();
    for (const line of this.data.lines) {
      const pos = [];
      for (const s of this.data.stations) {
        if (s.line !== line.id || s.depth <= 0) continue;
        pos.push(s.x, -s.depth, s.z, s.x, 0, s.z);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const mat = new THREE.LineBasicMaterial({ color: line.color, transparent: true, opacity: 0.55 });
      const obj = new THREE.LineSegments(geo, mat);
      obj.renderOrder = ORDER.shafts;
      this.shafts.set(line.id, obj);
      this.scaled.add(obj);
    }
  }

  #buildTransfers() {
    this.transferList = this.data.transfers.map((t) => ({ ...t, a: this.stationById.get(t.a), b: this.stationById.get(t.b) }));
    this.transfers = new LineSegments2(new LineSegmentsGeometry(), this.#lineMaterial(0x8a94a6, 2, { opacity: 0.85 }));
    this.transfers.renderOrder = ORDER.tracks;
    this.showTransfers = true;
    this.scaled.add(this.transfers);
    this.#rebuildTransfers();
  }

  #buildStations() {
    const n = this.data.stations.length;
    const geo = new THREE.SphereGeometry(1, 16, 12);
    const mat = new THREE.MeshLambertMaterial({ transparent: true });
    this.stationMesh = new THREE.InstancedMesh(geo, mat, n);
    this.stationMesh.renderOrder = ORDER.stations;
    this.stationMesh.frustumCulled = false;
    const c = new THREE.Color();
    for (const s of this.data.stations) {
      c.set(this.lineById.get(s.line).color).lerp(new THREE.Color(0xffffff), 0.3);
      this.stationMesh.setColorAt(s.index, c);
    }
    this.root.add(this.stationMesh);

    // ореол выделения
    const ring = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xd9231d, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    ring.renderOrder = ORDER.overlay;
    ring.visible = false;
    this.selectRing = ring;
    this.root.add(ring);
  }

  #buildLabels() {
    for (const s of this.data.stations) {
      const el = document.createElement('div');
      el.className = 'label';
      const dot = document.createElement('i');
      dot.style.background = this.lineById.get(s.line).color;
      const depth = document.createElement('small');
      depth.textContent = s.depth > 0 ? `−${fmtDepth(s.depth)} м` : s.depth < 0 ? 'эстакада' : 'наземная';
      el.append(dot, s.name, depth);
      const obj = new CSS2DObject(el);
      obj.center.set(0, 0.5);
      s.label = obj;
      this.root.add(obj);
    }
  }

  // Позиция станции в сцене (с учётом преувеличения)
  position(s, target = new THREE.Vector3()) {
    return target.set(s.x, -s.depth * this.exaggeration, s.z);
  }

  setExaggeration(ex) {
    this.exaggeration = ex;
    this.scaled.scale.y = ex;
    for (const s of this.data.stations) this.position(s, s.label.position);
  }

  setLineVisible(id, visible) {
    if (visible) this.hiddenLines.delete(id); else this.hiddenLines.add(id);
    this.tracks.get(id).visible = visible;
    this.#applyShafts();
    this.#rebuildTransfers();
  }

  setShafts(on) {
    this.showShafts = on;
    this.#applyShafts();
  }

  #applyShafts() {
    for (const [id, obj] of this.shafts) obj.visible = this.showShafts && !this.route && !this.hiddenLines.has(id);
  }

  setTransfers(on) {
    this.showTransfers = on;
    this.#rebuildTransfers();
  }

  #rebuildTransfers() {
    const pos = [];
    for (const { a, b } of this.transferList) {
      if (this.hiddenLines.has(a.line) || this.hiddenLines.has(b.line)) continue;
      pos.push(a.x, -a.depth, a.z, b.x, -b.depth, b.z);
    }
    this.transfers.geometry.dispose();
    this.transfers.geometry = new LineSegmentsGeometry().setPositions(pos.length ? pos : [0, 0, 0, 0, 0, 0]);
    this.transfers.visible = this.showTransfers && pos.length > 0;
  }

  isVisible(s) { return !this.hiddenLines.has(s.line); }

  setResolution(w, h) {
    for (const m of this.materials) m.resolution.set(w, h);
    if (this.routeLine) this.routeLine.material.resolution.set(w, h);
  }

  select(s) {
    if (this.selected) this.selected.label.element.classList.remove('selected');
    this.selected = s;
    if (s) s.label.element.classList.add('selected');
  }

  // ---------- маршрут ----------

  // Точки перегона a→b в направлении движения
  segmentPoints(seg, fromId) {
    return seg.a === fromId ? seg.pts : [...seg.pts].reverse();
  }

  setRoute(route) {
    this.route = route;
    this.routeStations = route ? new Set(route.stations) : null;
    for (const [, obj] of this.tracks) obj.material.opacity = route ? DIM_OPACITY : 1;
    this.transfers.material.opacity = route ? DIM_OPACITY : 0.85;
    this.#applyShafts();
    if (this.routeLine) {
      this.scaled.remove(this.routeLine);
      this.routeLine.geometry.dispose();
      this.routeLine.material.dispose();
      this.routeLine = null;
    }
    if (!route) return;

    const pos = [], col = [];
    const c = new THREE.Color();
    for (const leg of route.legs) {
      c.set(this.lineById.get(leg.line).color);
      leg.segments.forEach((seg) => {
        for (let i = 1; i < seg.pts.length; i++) {
          const [x0, z0, y0] = seg.pts[i - 1], [x1, z1, y1] = seg.pts[i];
          pos.push(x0, y0, z0, x1, y1, z1);
          col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        }
      });
    }
    for (const t of route.transfers) {
      pos.push(t.from.x, -t.from.depth, t.from.z, t.to.x, -t.to.depth, t.to.z);
      col.push(0.35, 0.38, 0.45, 0.35, 0.38, 0.45);
    }
    const geo = new LineSegmentsGeometry().setPositions(pos).setColors(col);
    const mat = new LineMaterial({ linewidth: 7, vertexColors: true, worldUnits: false, transparent: true });
    mat.resolution.copy(this.resolution);
    this.routeLine = new LineSegments2(geo, mat);
    this.routeLine.renderOrder = ORDER.route;
    this.scaled.add(this.routeLine);
  }

  // Сплошная 3D-полилиния ноги маршрута (реальные метры) с длиной дуги до каждой станции
  routePath(leg) {
    const pts = [];
    const stationS = [0];
    leg.segments.forEach((seg, i) => {
      const p = this.segmentPoints(seg, leg.stations[i].id);
      for (let k = pts.length ? 1 : 0; k < p.length; k++) pts.push(new THREE.Vector3(p[k][0], p[k][2], p[k][1]));
      stationS.push(pts.length - 1);
    });
    const s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + pts[i].distanceTo(pts[i - 1]));
    return { pts, s, total: s[s.length - 1], stationS: stationS.map((i) => s[i]), leg };
  }

  // Каждый кадр: постоянный экранный размер станций и видимость подписей
  update(camera, viewportHeight) {
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const pxToWorld = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewportHeight;
    for (const s of this.data.stations) {
      this.position(s, p);
      const dist = camera.position.distanceTo(p);
      const visible = this.isVisible(s);
      const onRoute = !this.routeStations || this.routeStations.has(s);
      let k = visible ? STATION_RADIUS_PX : 0;
      if (s === this.selected) k *= 1.6;
      else if (!onRoute) k *= 0.5;
      m.compose(p, q, sc.setScalar(dist * pxToWorld * k));
      this.stationMesh.setMatrixAt(s.index, m);
      const special = s === this.selected || s === this.hovered;
      const near = this.showLabels && dist < (this.routeStations ? LABEL_DISTANCE * 2.5 : LABEL_DISTANCE);
      s.label.visible = visible && (special || (near && onRoute));
    }
    this.stationMesh.instanceMatrix.needsUpdate = true;
    this.stationMesh.computeBoundingSphere();

    if (this.selected && this.isVisible(this.selected)) {
      this.position(this.selected, p);
      this.selectRing.position.copy(p);
      this.selectRing.scale.setScalar(camera.position.distanceTo(p) * pxToWorld * STATION_RADIUS_PX * 3);
      this.selectRing.visible = true;
    } else {
      this.selectRing.visible = false;
    }
  }

  pick(raycaster) {
    const hits = raycaster.intersectObject(this.stationMesh, false);
    for (const h of hits) {
      const s = this.data.stations[h.instanceId];
      if (this.isVisible(s)) return s;
    }
    return null;
  }

  neighbors(s) {
    const out = [];
    for (const seg of this.data.segments) {
      if (seg.a === s.id) out.push({ station: this.stationById.get(seg.b), seg });
      else if (seg.b === s.id) out.push({ station: this.stationById.get(seg.a), seg });
    }
    return out;
  }

  transfersOf(s) {
    return this.transferList.filter((t) => t.a === s || t.b === s).map((t) => ({ station: t.a === s ? t.b : t.a, length: t.length }));
  }
}

export function fmtDepth(d) {
  return Number.isInteger(d) ? String(d) : d.toFixed(1).replace('.', ',');
}

export function fmtDist(m) {
  if (m < 1000) return `${Math.round(m)} м`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} км`;
}

export function fmtMinutes(sec) {
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min} мин`;
  return `${Math.floor(min / 60)} ч ${min % 60} мин`;
}
