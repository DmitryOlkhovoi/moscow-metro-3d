import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { MetroScene, ORDER, fmtDist } from './scene.js';
import { Basemap } from './basemap.js';
import { Router } from './router.js';
import { TrainRide } from './train.js';
import { MetroAudio, readSetting, writeSetting } from './audio.js';
import { unproject } from './projection.js';
import { initUI } from './ui.js';

const BACKGROUNDS = { light: 0xe9ecef, dark: 0x0d1117 };
const TUNNEL_FOG = new THREE.Color(0x07080a);

const data = await (await fetch('data/metro.json')).json();
const container = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
container.append(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
container.append(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BACKGROUNDS.light);
const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 2.2);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(-1, 2, 1);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 5, 500000);
scene.add(camera); // кабина машиниста — дочерние объекты камеры
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.screenSpacePanning = false; // панорама по плоскости земли, как на карте
controls.zoomToCursor = true;
controls.minDistance = 60;
controls.maxDistance = 160000;
controls.maxPolarAngle = Math.PI * 0.98;

const resolution = new THREE.Vector2(innerWidth, innerHeight);
const metro = new MetroScene(data, resolution);
scene.add(metro.root);
const router = new Router(data, metro.stationById);

// Границы подложки: охват станций + запас 6 км
const xs = data.stations.map((s) => s.x), zs = data.stations.map((s) => s.z);
const margin = 6000;
const [maxLat, minLon] = unproject(Math.min(...xs) - margin, Math.min(...zs) - margin);
const [minLat, maxLon] = unproject(Math.max(...xs) + margin, Math.max(...zs) + margin);
const basemap = new Basemap(renderer, { minLat, maxLat, minLon, maxLon });
scene.add(basemap.group);

// ---------- линейка ----------

const ruler = {
  active: false,
  picks: [],
  line: new Line2(new LineGeometry(), new LineMaterial({
    color: 0x1a1a1a, linewidth: 2.5, dashed: true, dashSize: 6, gapSize: 4, worldUnits: false, transparent: true,
  })),
  label: new CSS2DObject(Object.assign(document.createElement('div'), { className: 'label ruler' })),
};
ruler.line.material.resolution.copy(resolution);
ruler.line.renderOrder = ORDER.overlay;
ruler.line.visible = ruler.label.visible = false;
scene.add(ruler.line, ruler.label);

function updateRulerGeometry() {
  if (ruler.picks.length < 2) { ruler.line.visible = ruler.label.visible = false; return; }
  const [a, b] = ruler.picks.map((s) => metro.position(s));
  ruler.line.geometry.dispose();
  ruler.line.geometry = new LineGeometry().setPositions([a.x, a.y, a.z, b.x, b.y, b.z]);
  ruler.line.computeLineDistances();
  ruler.label.position.copy(a).add(b).multiplyScalar(0.5);
  ruler.line.visible = ruler.label.visible = true;
}

// ---------- камера ----------

let tween = null;
function flyTo(target, offset, duration = 800) {
  const fromPos = camera.position.clone(), fromTarget = controls.target.clone();
  const toTarget = target.clone(), toPos = target.clone().add(offset);
  const start = performance.now();
  tween = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    controls.target.lerpVectors(fromTarget, toTarget, e);
    camera.position.lerpVectors(fromPos, toPos, e);
    if (t >= 1) tween = null;
  };
}

function setView(view) {
  const ex = metro.exaggeration;
  const target = controls.target.clone();
  const dist = Math.min(camera.position.distanceTo(controls.target), 70000);
  if (view === 'top') {
    target.y = 0;
    flyTo(target, new THREE.Vector3(0, dist, 1));
  } else if (view === 'side') {
    // разрез: смотрим горизонтально с юга на уровне средней глубины
    target.y = -30 * ex;
    flyTo(target, new THREE.Vector3(0, 0, dist));
  } else {
    target.y = 0;
    flyTo(target, new THREE.Vector3(-0.35, 0.6, 0.72).normalize().multiplyScalar(dist));
  }
}

function focusStation(s) {
  const p = metro.position(s);
  const dir = camera.position.clone().sub(controls.target).normalize();
  const dist = Math.min(camera.position.distanceTo(controls.target), 4000);
  flyTo(p, dir.multiplyScalar(dist));
}

// Показать маршрут целиком: центр охвата станций, расстояние по размеру
function fitStations(stations) {
  const box = new THREE.Box3();
  for (const s of stations) box.expandByPoint(metro.position(s));
  const center = box.getCenter(new THREE.Vector3());
  center.y = 0;
  const size = box.getSize(new THREE.Vector3());
  const dist = Math.max(size.x, size.z, 1500) * 1.25 + 800;
  const panelShift = innerWidth > 760 ? -dist * 0.12 : 0; // панель закрывает левую часть экрана
  center.x += panelShift;
  flyTo(center, new THREE.Vector3(-0.25, 0.75, 0.6).normalize().multiplyScalar(dist), 1000);
}

camera.position.set(-18000, 38000, 48000);
controls.target.set(-3000, 0, 0);

// ---------- маршрут и поездка ----------

let route = null;
let ride = null;
const audio = new MetroAudio();

// ---------- тема ----------

let theme = readSetting('theme', 'light');
function applyTheme(t) {
  theme = t;
  document.body.dataset.theme = t;
  scene.background.set(BACKGROUNDS[t]);
  writeSetting('theme', t);
}

// ---------- кабина машиниста ----------

const cabSaved = {};
// В портретной ориентации расширяем вертикальный угол, чтобы по горизонтали было видно ~80°
const cabFov = () => {
  const aspect = innerWidth / innerHeight;
  if (aspect >= 1.2) return 70;
  return Math.min(100, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(40)) / aspect)));
};
function setCabMode(on) {
  document.body.classList.toggle('cab', on);
  metro.root.visible = !on;
  ruler.line.visible = ruler.label.visible = false;
  controls.enabled = !on;
  if (on) {
    // в кабине реальные уклоны и масштаб: преувеличение глубины ×1
    const panel = document.getElementById('panel');
    Object.assign(cabSaved, {
      ex: metro.exaggeration, fov: camera.fov, near: camera.near, opacity: basemap.opacity,
      collapsed: panel.classList.contains('collapsed'),
    });
    panel.classList.add('collapsed'); // кабине нужен весь экран
    ui.setExaggeration(1);
    basemap.setOpacity(1);
    camera.fov = cabFov();
    camera.near = 0.05;
  } else {
    ui.setExaggeration(cabSaved.ex);
    basemap.setOpacity(cabSaved.opacity);
    document.getElementById('panel').classList.toggle('collapsed', cabSaved.collapsed);
    camera.fov = cabSaved.fov;
    camera.near = cabSaved.near;
    scene.fog = null;
    hemi.intensity = 2.2;
    sun.intensity = 1.2;
    scene.background.set(BACKGROUNDS[theme]);
    updateRulerGeometry();
  }
  camera.updateProjectionMatrix();
}

// k: 0 — на поверхности, 1 — в тоннеле
const dayFog = new THREE.Color();
function setCabLight(k) {
  hemi.intensity = THREE.MathUtils.lerp(2.2, 0.35, k);
  sun.intensity = THREE.MathUtils.lerp(1.2, 0.02, k);
  dayFog.set(BACKGROUNDS.light);
  const color = dayFog.clone().lerp(TUNNEL_FOG, k);
  scene.background.copy(color);
  if (!scene.fog) scene.fog = new THREE.Fog(color, 30, 400);
  scene.fog.color.copy(color);
  scene.fog.near = THREE.MathUtils.lerp(400, 25, k);
  scene.fog.far = THREE.MathUtils.lerp(4000, 380, k);
}

function setRoute(from, to) {
  route = from && to ? router.route(from.id, to.id, metro.hiddenLines) : null;
  metro.setRoute(route);
  if (from && to) {
    ui.showRoute(route);
    if (route) fitStations(route.stations);
    // на телефоне панель закрывает полэкрана — сворачиваем, чтобы был виден маршрут
    if (route && innerWidth <= 760) document.getElementById('panel').classList.add('collapsed');
  }
}

function startRide(mode) {
  stopRide();
  if (!mode || !route) return;
  ui.setRuler(false);
  metro.select(null);
  ui.showStation(null);
  tween = null;
  audio.ensure(); // клик по кнопке — жест пользователя, звук можно включать
  ride = new TrainRide({
    metro, scene, camera, controls, audio,
    hud: ui.hud,
    toast: ui.toast,
    onFinish: (summary) => ui.showResult(summary),
    onCab: setCabMode,
    onCabLight: setCabLight,
  }, route, mode);
  ui.hud.show(mode, {
    onScale: (scale) => { if (ride) ride.timeScale = scale; },
    onExit: () => stopRide(true),
    onControl: (ctl, on) => { if (ride) ride.input[ctl] = on; },
    onCab: () => ride?.setCab(!ride.cab),
  });
  ui.toast(mode === 'manual'
    ? 'Машинист: ↑ — ход, ↓ — тормоз. Остановитесь у платформы!'
    : `Поездка: ${route.from.name} → ${route.to.name}`, 'info');
}

function stopRide(refit = false) {
  if (!ride) return;
  ride.dispose();
  ride = null;
  ui.hud.hide();
  if (refit && route) fitStations(route.stations);
}

const KEYS = { ArrowUp: 'throttle', KeyW: 'throttle', ArrowDown: 'brake', KeyS: 'brake', Space: 'emergency' };
addEventListener('keydown', (e) => {
  if (!ride || e.target.matches('input, select')) return;
  if (KEYS[e.code]) { ride.input[KEYS[e.code]] = true; e.preventDefault(); }
  if (e.code === 'KeyC') ride.toggleFollow();
  if (e.code === 'KeyV') ride.setCab(!ride.cab);
  if (e.code === 'KeyM') ui.setSound(!audio.enabled);
  if (e.code === 'Escape') stopRide(true);
});
addEventListener('keyup', (e) => {
  if (ride && KEYS[e.code]) ride.input[KEYS[e.code]] = false;
});
addEventListener('blur', () => { if (ride) ride.input = { throttle: false, brake: false, emergency: false }; });

// ---------- UI ----------

const ui = initUI({
  data, metro,
  onSelect: (s, { focus } = {}) => selectStation(s, focus),
  onRoute: (from, to) => setRoute(from, to),
  onRide: (mode) => (mode ? startRide(mode) : stopRide()),
  onExaggeration: (ex) => {
    const k = ex / metro.exaggeration;
    metro.setExaggeration(ex);
    if (!ride) {
      const oldY = controls.target.y;
      controls.target.y *= k;
      camera.position.y += controls.target.y - oldY;
    }
    updateRulerGeometry();
  },
  onBasemap: (style) => basemap.setStyle(style),
  onTheme: applyTheme,
  onSound: (on) => audio.setEnabled(on),
  soundEnabled: audio.enabled,
  audio,
  theme,
  onOpacity: (o) => basemap.setOpacity(o),
  onView: setView,
  onRuler: (on) => {
    ruler.active = on;
    ruler.picks = [];
    updateRulerGeometry();
    if (on) ui.showRuler([]);
    else ui.showStation(metro.selected);
  },
});

function selectStation(s, focus = false) {
  if (ruler.active && s) {
    ruler.picks = ruler.picks.length >= 2 ? [s] : [...ruler.picks, s];
    metro.select(s);
    updateRulerGeometry();
    const res = ui.showRuler(ruler.picks);
    if (res) ruler.label.element.textContent = res;
  } else {
    metro.select(s);
    if (s || !ride?.done) ui.showStation(s);
  }
  if (s && focus && !ride) focusStation(s);
}

// ---------- выбор мышью ----------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;
let hoverPending = false;
let lastMove = null;

function pickAt(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return metro.pick(raycaster);
}

renderer.domElement.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; tween = null; });
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (ride?.cab) return;
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;
  const s = pickAt(ev);
  if (s || !ruler.active) selectStation(s);
});
renderer.domElement.addEventListener('dblclick', () => ride?.cab && ride.resetLook());
renderer.domElement.addEventListener('pointermove', (ev) => {
  // в кабине перетаскивание — осмотреться
  if (ride?.cab) { if (ev.buttons) ride.lookAround(ev.movementX, ev.movementY); return; }
  lastMove = ev;
  if (hoverPending || ev.buttons) return;
  hoverPending = true;
  requestAnimationFrame(() => {
    hoverPending = false;
    const s = pickAt(lastMove);
    metro.hovered = s;
    renderer.domElement.style.cursor = s ? 'pointer' : '';
  });
});

// ---------- шкала масштаба ----------

const scalebar = document.querySelector('#scalebar');
const scaleBarEl = scalebar.querySelector('.bar');
const scaleText = scalebar.querySelector('span');
function updateScalebar() {
  const dist = camera.position.distanceTo(controls.target);
  const mpp = (dist * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / innerHeight;
  const raw = mpp * 110;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map((k) => k * pow).filter((v) => v <= raw).pop();
  scaleBarEl.style.width = `${nice / mpp}px`;
  scaleText.textContent = fmtDist(nice);
}

// ---------- цикл ----------

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  if (ride?.cab) camera.fov = cabFov();
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  resolution.set(innerWidth, innerHeight);
  metro.setResolution(innerWidth, innerHeight);
  ruler.line.material.resolution.copy(resolution);
});

let lastBasemapUpdate = 0;
let lastFrame = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (tween) tween(now);
  ride?.update(dt);
  controls.update();
  metro.update(camera, innerHeight);
  if (now - lastBasemapUpdate > 250) {
    basemap.update(camera, controls.target);
    updateScalebar();
    lastBasemapUpdate = now;
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

applyTheme(theme);
document.getElementById('loading').classList.add('done');

// для экспериментов из консоли браузера
window.metro3d = {
  THREE, scene, camera, controls, metro, basemap, router, ui, audio, selectStation, setView, flyTo,
  get ride() { return ride; }, get route() { return route; }, startRide,
};
