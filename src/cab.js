// Вид из кабины машиниста: мир вдоль ноги маршрута (тоннель, станции, рельсы) в реальных метрах
// и кабина с пультом, привязанная к камере.
import * as THREE from 'three';

const TUNNEL_R = 2.75;
const TUNNEL_CY = 1.9;       // центр тоннеля над головкой рельса
const HALL_HALF = 85;        // половина длины зала станции, м
const UNDERGROUND = 4;       // глубже этого — тоннель
const EYE = 2.4;             // глаза машиниста над рельсом
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// ---------- путь ----------

// Точка пути (реальные метры) на длине дуги s, с продолжением за концы по касательной
export function samplePath(path, s, out = new THREE.Vector3()) {
  const { pts, s: cum } = path;
  if (s <= 0) return out.copy(pts[1]).sub(pts[0]).setLength(s).add(pts[0]);
  const n = pts.length - 1;
  if (s >= cum[n]) return out.copy(pts[n]).sub(pts[n - 1]).setLength(s - cum[n]).add(pts[n]);
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return out.lerpVectors(pts[lo], pts[hi], t);
}

function frameAt(path, s) {
  const p = samplePath(path, s);
  const t = samplePath(path, s + 3).sub(samplePath(path, s - 3)).normalize();
  const right = new THREE.Vector3().crossVectors(t, WORLD_UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, t).normalize();
  return { p, t, right, up };
}

// Протяжка профиля [[вбок, вверх], …] вдоль пути от s0 до s1
function sweep(path, s0, s1, step, profile, { closed = false, uScale = 1, vertical = false } = {}) {
  const n = Math.max(2, Math.ceil((s1 - s0) / step) + 1);
  const m = profile.length;
  const pos = new Float32Array(n * m * 3);
  const uv = new Float32Array(n * m * 2);
  const v = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    const s = s0 + ((s1 - s0) * k) / (n - 1);
    const f = frameAt(path, s);
    const up = vertical ? WORLD_UP : f.up;
    for (let j = 0; j < m; j++) {
      const [x, y] = profile[j];
      v.copy(f.p).addScaledVector(f.right, x).addScaledVector(up, y);
      pos.set([v.x, v.y, v.z], (k * m + j) * 3);
      uv.set([s / uScale, j / (m - 1)], (k * m + j) * 2);
    }
  }
  const idx = [];
  const segs = closed ? m : m - 1;
  for (let k = 0; k < n - 1; k++) {
    for (let j = 0; j < segs; j++) {
      const a = k * m + j, b = k * m + ((j + 1) % m), c = a + m, d = b + m;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ---------- текстуры ----------

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

const tubingTexture = () => canvasTexture(64, 256, (g, w, h) => {
  g.fillStyle = '#6d6a64';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 400; i++) { // пятна бетона
    g.fillStyle = `rgba(${Math.random() > 0.5 ? '255,255,255' : '0,0,0'},0.05)`;
    g.fillRect(Math.random() * w, Math.random() * h, 3, 3);
  }
  g.fillStyle = '#3d3b37'; // шов между кольцами тюбингов
  g.fillRect(0, 0, 3, h);
  for (let y = 0; y < h; y += h / 8) g.fillRect(0, y, w, 2); // швы сегментов
  g.fillStyle = '#26241f'; // кабели вдоль стены
  for (let i = 0; i < 4; i++) g.fillRect(0, h * 0.62 + i * 7, w, 4);
});

const signTexture = (name, color) => canvasTexture(1024, 160, (g, w, h) => {
  g.fillStyle = '#f4f2ec';
  g.fillRect(0, 0, w, h);
  g.fillStyle = color;
  g.fillRect(0, 0, 18, h);
  g.fillStyle = '#1a1a1a';
  g.font = '800 92px "Golos Text", system-ui, sans-serif';
  g.textBaseline = 'middle';
  g.fillText(name, 52, h / 2 + 4, w - 80);
});

// ---------- мир ----------

export class CabWorld {
  constructor(path, lineColor) {
    this.group = new THREE.Group();
    this.disposables = [];
    const leg = path.leg;
    const depthAt = (s) => -samplePath(path, s).y;
    const from = -40, to = path.total + 140;

    const mat = (opts) => { const m = new THREE.MeshLambertMaterial(opts); this.disposables.push(m); return m; };
    const add = (geo, material) => {
      this.disposables.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      this.group.add(mesh);
      return mesh;
    };

    // путь: балласт, рельсы, шпалы
    add(sweep(path, from, to, 4, [[-1.7, -0.32], [1.7, -0.32]]), mat({ color: 0x4a463f }));
    const railMat = mat({ color: 0x9a9da2, emissive: 0x2a2c30 });
    for (const x of [-0.76, 0.76]) {
      add(sweep(path, from, to, 4, [[x - 0.035, -0.16], [x + 0.035, -0.16], [x + 0.035, 0], [x - 0.035, 0]], { closed: true }), railMat);
    }
    const sleeperGeo = new THREE.BoxGeometry(2.6, 0.16, 0.24);
    this.disposables.push(sleeperGeo);
    const count = Math.floor((to - from) / 1.0);
    const sleepers = new THREE.InstancedMesh(sleeperGeo, mat({ color: 0x5a5148 }), count);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < count; i++) {
      const f = frameAt(path, from + i);
      q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.right, f.up, f.t.clone().negate()));
      m4.compose(f.p.clone().addScaledVector(f.up, -0.26), q, one);
      sleepers.setMatrixAt(i, m4);
    }
    this.group.add(sleepers);

    // станции: подземные — зал, наземные — платформа с навесом
    const halls = [];
    leg.stations.forEach((st, i) => {
      const c = path.stationS[i];
      const s0 = c - HALL_HALF, s1 = c + HALL_HALF;
      const platform = [[11, 1.1], [1.65, 1.1], [1.65, -0.3]];
      const lit = st.depth > UNDERGROUND ? 0x4d4a45 : 0x000000; // зал освещён сам по себе
      add(sweep(path, s0 + 5, s1 - 5, 5, platform, { vertical: true }), mat({ color: 0xa7a39b, emissive: lit }));
      add(sweep(path, s0 + 5, s1 - 5, 5, [[1.65, 1.12], [1.95, 1.12]], { vertical: true }), mat({ color: 0xffd34d, emissive: 0x554411 }));
      const sign = signTexture(st.name, lineColor);
      this.disposables.push(sign);
      const signMat = mat({ map: sign, emissive: 0xffffff, emissiveMap: sign, emissiveIntensity: 0.35 });
      if (st.depth > UNDERGROUND) {
        halls.push([s0, s1]);
        // сводчатый зал: полуэллипс над путём и платформой
        const vault = [];
        for (let a = 0; a <= 16; a++) {
          const ang = (Math.PI * a) / 16;
          vault.push([4.5 + Math.cos(ang) * 9, -0.3 + Math.sin(ang) * 7.5]);
        }
        add(sweep(path, s0, s1, 5, vault, { vertical: true }), mat({ color: 0xe9e4da, emissive: 0x77726a, side: THREE.DoubleSide }));
        for (const x of [1.5, 7.5]) {
          add(sweep(path, s0 + 6, s1 - 6, 5, [[x - 0.2, 6.4], [x + 0.2, 6.4]], { vertical: true }),
            mat({ color: 0xffffff, emissive: 0xfff4dc, side: THREE.DoubleSide }));
        }
        // торцевые стены зала
        for (const s of [s0, s1]) {
          const f = frameAt(path, s);
          const wall = add(new THREE.CircleGeometry(9, 24, 0, Math.PI), mat({ color: 0xd8d2c6, emissive: 0x55514b, side: THREE.DoubleSide }));
          wall.scale.y = 7.5 / 9;
          wall.position.copy(f.p).addScaledVector(f.right, 4.5).add(new THREE.Vector3(0, -0.3, 0));
          wall.lookAt(wall.position.clone().add(f.t));
        }
        // названия на путевой стене
        for (let s = s0 + 20; s < s1 - 10; s += 40) this.#sign(path, s, -4.2, 2.6, signMat, add);
      } else {
        add(sweep(path, s0 + 5, s1 - 5, 5, [[1.2, 4.6], [11.5, 4.6]], { vertical: true }), mat({ color: 0xc9ccd1, emissive: 0x6a6e75, side: THREE.DoubleSide }));
        for (let s = s0 + 20; s < s1 - 10; s += 40) this.#sign(path, s, 5, 3.1, signMat, add);
      }
    });

    // тоннель на подземных участках (кроме залов)
    const spans = [];
    let start = null;
    for (let s = from; s <= to; s += 5) {
      const under = depthAt(s) > UNDERGROUND && !halls.some(([a, b]) => s > a && s < b);
      if (under && start === null) start = s;
      if (!under && start !== null) { spans.push([start, s]); start = null; }
    }
    if (start !== null) spans.push([start, to]);
    const ring = [];
    for (let a = 0; a < 24; a++) {
      const ang = (Math.PI * 2 * a) / 24 - Math.PI / 2;
      ring.push([Math.cos(ang) * TUNNEL_R, Math.max(TUNNEL_CY + Math.sin(ang) * TUNNEL_R, -0.35)]);
    }
    const tubing = tubingTexture();
    this.disposables.push(tubing);
    const tunnelMat = mat({ map: tubing, side: THREE.DoubleSide });
    const lampGeo = new THREE.BoxGeometry(0.25, 0.12, 0.5);
    this.disposables.push(lampGeo);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1c9 });
    this.disposables.push(lampMat);
    for (const [a, b] of spans) {
      add(sweep(path, a, b, 2, ring, { closed: true, uScale: 1 }), tunnelMat);
      for (let s = a + 10; s < b; s += 25) {
        const f = frameAt(path, s);
        const lamp = new THREE.Mesh(lampGeo, lampMat);
        lamp.position.copy(f.p).addScaledVector(f.right, -2.45).addScaledVector(f.up, 2.3);
        lamp.lookAt(lamp.position.clone().add(f.t));
        this.group.add(lamp);
      }
    }
  }

  // табличка лицом к пути
  #sign(path, s, lateral, height, material, add) {
    const f = frameAt(path, s);
    const plane = add(new THREE.PlaneGeometry(7, 1.1), material);
    plane.position.copy(f.p).addScaledVector(f.right, lateral).add(new THREE.Vector3(0, height, 0));
    plane.lookAt(plane.position.clone().addScaledVector(f.right, -Math.sign(lateral)));
  }

  dispose() {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}

// ---------- кабина ----------

export class Cockpit {
  constructor() {
    this.group = new THREE.Group();
    const panel = new THREE.MeshLambertMaterial({ color: 0x6b867d, emissive: 0x1d2724 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2b3033, emissive: 0x0d0f10 });
    const box = (w, h, d, material, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, rz);
      this.group.add(mesh);
      return mesh;
    };
    // рама лобового окна: стойки по краям и козырёк — видны узкой полосой
    box(0.3, 2.2, 0.12, dark, -1.2, 0.1, -1.1, 0, 0, -0.05);
    box(0.3, 2.2, 0.12, dark, 1.2, 0.1, -1.1, 0, 0, 0.05);
    box(2.8, 0.4, 0.14, dark, 0, 0.95, -1.08);
    box(0.12, 2.4, 1.8, panel, -1.45, 0.1, -0.35);
    box(0.12, 2.4, 1.8, panel, 1.45, 0.1, -0.35);
    // пульт занимает нижнюю пятую часть обзора
    box(2.6, 0.06, 0.6, panel, 0, -0.56, -0.8, 0.35);
    box(2.6, 0.5, 0.08, dark, 0, -0.75, -1.1);

    // спидометр
    const dial = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#f1f0ea';
      g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 4, 0, Math.PI * 2); g.fill();
      g.lineWidth = 8; g.strokeStyle = '#1a1a1a'; g.stroke();
      const ang = (kmh) => (Math.PI * 3) / 4 + (kmh / 90) * (Math.PI * 3) / 2;
      g.lineWidth = 14; g.strokeStyle = '#d9231d';
      g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 26, ang(80), ang(90)); g.stroke();
      g.fillStyle = '#1a1a1a'; g.font = '700 26px "Golos Text", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let k = 0; k <= 90; k += 10) {
        const a = ang(k);
        g.save(); g.translate(w / 2, h / 2); g.rotate(a);
        g.fillRect(w / 2 - 40, -2, k % 20 === 0 ? 18 : 10, 4);
        g.restore();
        if (k % 20 === 0) g.fillText(k, w / 2 + Math.cos(a) * 78, h / 2 + Math.sin(a) * 78);
      }
      g.font = '600 18px "Golos Text", sans-serif'; g.fillText('км/ч', w / 2, h / 2 + 52);
    });
    const tilt = -0.35;
    const gauge = new THREE.Mesh(new THREE.CircleGeometry(0.075, 40), new THREE.MeshBasicMaterial({ map: dial }));
    gauge.position.set(-0.3, -0.385, -0.96);
    gauge.rotation.x = tilt;
    this.group.add(gauge);
    this.needle = new THREE.Group();
    const needleMesh = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.004, 0.002), new THREE.MeshBasicMaterial({ color: 0xd9231d }));
    needleMesh.position.x = 0.026;
    this.needle.add(needleMesh);
    this.needle.position.set(0, 0, 0.003);
    gauge.add(this.needle);

    // лампы допустимой скорости
    const lampsPanel = canvasTexture(512, 128, (g, w, h) => {
      g.fillStyle = '#20262a'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#c9d1cf'; g.font = '700 30px "Golos Text", sans-serif'; g.textAlign = 'center';
      ['0', '40', '60', '70', '80'].forEach((t, i) => g.fillText(t, 64 + i * 96, 112));
    });
    const lampsMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.07), new THREE.MeshBasicMaterial({ map: lampsPanel }));
    lampsMesh.position.set(0.08, -0.4, -0.96);
    lampsMesh.rotation.x = tilt;
    this.group.add(lampsMesh);
    this.lamps = [0, 40, 60, 70, 80].map((kmh, i) => {
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.0125, 20), new THREE.MeshBasicMaterial({ color: 0x333a3d }));
      lamp.position.set(-0.105 + i * 0.0525, 0.009, 0.001);
      lampsMesh.add(lamp);
      return { kmh, lamp };
    });

    // рукоятка контроллера: вперёд — ход, назад — тормоз
    this.handle = new THREE.Group();
    this.handle.position.set(-0.62, -0.56, -0.92);
    this.handle.rotation.x = 0.32;
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2), dark);
    stick.position.y = 0.1;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), new THREE.MeshLambertMaterial({ color: 0x1b1b1b, emissive: 0x0b0b0b }));
    knob.position.y = 0.21;
    this.handle.add(stick, knob);
    this.group.add(this.handle);

    this.light = new THREE.PointLight(0xfff0d8, 1.2, 4, 1);
    this.light.position.set(0, 0.6, -0.2);
    this.group.add(this.light);

    this.headlight = new THREE.SpotLight(0xfff2d6, 600, 320, 0.42, 0.55, 1.4);
    this.headlight.position.set(0, -0.6, -1);
    this.headlight.target.position.set(0, -1.6, -40);
    this.group.add(this.headlight, this.headlight.target);
  }

  update(state, input, time) {
    const frac = Math.min(state.speed / 90, 1);
    this.needle.rotation.z = -((Math.PI * 3) / 4 + frac * (Math.PI * 3) / 2);
    const target = input.throttle ? -0.5 : input.brake || input.emergency ? 0.55 : 0;
    this.handle.rotation.x += (0.32 + target - this.handle.rotation.x) * 0.2;
    const blink = Math.floor(time * 3) % 2 === 0;
    for (const { kmh, lamp } of this.lamps) {
      const on = kmh === 80 ? !state.overspeed : kmh === 0 ? state.overspeed && blink : false;
      lamp.material.color.set(on ? (kmh === 0 ? 0xff3b30 : 0x3dff7a) : 0x333a3d);
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
    });
  }
}

export { EYE };
