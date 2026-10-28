// Подложка из растровых тайлов Esri (не требуют ключа) на плоскости y = 0.
// Базовый слой (z11) покрывает весь город, детальный слой подгружается вокруг точки обзора.
// Детальные тайлы пишут трафарет, и базовый слой под ними не рисуется — без двойного наложения.
import * as THREE from 'three';
import { project, unproject } from './projection.js';
import { ORDER } from './scene.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const STYLES = {
  dark: { path: 'Canvas/World_Dark_Gray_Base', maxZoom: 16 },
  light: { path: 'Canvas/World_Light_Gray_Base', maxZoom: 16 },
  streets: { path: 'World_Street_Map', maxZoom: 18 },
  satellite: { path: 'World_Imagery', maxZoom: 18 },
};
const BASE_ZOOM = 11;
const MAX_DETAIL_TILES = 90;

const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2tile = (lat, z) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

export class Basemap {
  constructor(renderer, bounds) {
    this.group = new THREE.Group();
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin('anonymous');
    this.anisotropy = renderer.capabilities.getMaxAnisotropy();
    this.bounds = bounds; // { minLat, maxLat, minLon, maxLon }
    this.opacity = 0.85;
    this.style = 'light';
    this.cache = new Map(); // key -> mesh
    this.detailKeys = new Set();
    this.baseTiles = [];
    this.#buildBase();
  }

  #url(z, x, y) {
    return `${ESRI}/${STYLES[this.style].path}/MapServer/tile/${z}/${y}/${x}`;
  }

  #tileMesh(z, x, y, detail) {
    // Углы тайла переводим в локальные метры (сетка 4×4, чтобы повторить искривление проекции)
    const seg = 4;
    const geo = new THREE.PlaneGeometry(1, 1, seg, seg);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      const [px, pz] = project(tile2lat(y + 1 - v, z), tile2lon(x + u, z));
      pos.setXYZ(i, px, 0, pz);
    }
    geo.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: this.opacity, depthWrite: false, side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: detail ? THREE.AlwaysStencilFunc : THREE.NotEqualStencilFunc,
      stencilZPass: detail ? THREE.ReplaceStencilOp : THREE.KeepStencilOp,
    });
    mat.visible = false; // пока не загрузилась текстура
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = detail ? ORDER.ground : ORDER.ground2;
    mesh.userData = { z, x, y, style: this.style };
    this.#load(mesh);
    return mesh;
  }

  #load(mesh, attempt = 1) {
    const { z, x, y } = mesh.userData;
    const style = this.style;
    mesh.userData.style = style;
    this.loader.load(this.#url(z, x, y), (tex) => {
      if (mesh.userData.style !== style) { tex.dispose(); return; }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.anisotropy;
      mesh.material.map?.dispose();
      mesh.material.map = tex;
      mesh.material.visible = true;
      mesh.material.needsUpdate = true;
    }, undefined, () => {
      // сетевые сбои случаются — пробуем ещё, пока тайл нужен
      if (attempt >= 5 || mesh.userData.style !== style) return;
      setTimeout(() => {
        if (mesh.userData.style === style && (mesh.parent || this.baseTiles.includes(mesh))) this.#load(mesh, attempt + 1);
      }, 1000 * attempt);
    });
  }

  #buildBase() {
    const z = BASE_ZOOM;
    const { minLat, maxLat, minLon, maxLon } = this.bounds;
    const x0 = Math.floor(lon2tile(minLon, z)), x1 = Math.floor(lon2tile(maxLon, z));
    const y0 = Math.floor(lat2tile(maxLat, z)), y1 = Math.floor(lat2tile(minLat, z));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const m = this.#tileMesh(z, x, y, false);
        this.baseTiles.push(m);
        this.group.add(m);
      }
    }
  }

  // Подгрузка детальных тайлов вокруг точки, на которую смотрит камера
  update(camera, target) {
    if (this.style === 'none') return;
    const dist = camera.position.distanceTo(target);
    const height = Math.max(Math.abs(camera.position.y - target.y), dist * 0.25);
    const viewWidth = height * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect;
    const [lat, lon] = unproject(target.x, target.z);
    const metersPerTileZ0 = 40075016 * Math.cos((lat * Math.PI) / 180);
    let z = Math.round(Math.log2(metersPerTileZ0 / (viewWidth / 3)));
    z = Math.min(STYLES[this.style].maxZoom, z);

    const keys = new Set();
    if (z > BASE_ZOOM) {
      const cx = lon2tile(lon, z), cy = lat2tile(lat, z);
      const tileMeters = metersPerTileZ0 / 2 ** z;
      const r = Math.min(Math.ceil((viewWidth * 0.9) / tileMeters), Math.floor(Math.sqrt(MAX_DETAIL_TILES) / 2));
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          const x = Math.floor(cx) + dx, y = Math.floor(cy) + dy;
          keys.add(`${z}/${x}/${y}`);
        }
      }
    }
    if (setsEqual(keys, this.detailKeys)) return;
    this.detailKeys = keys;

    for (const [key, mesh] of this.cache) {
      const show = keys.has(key);
      if (show && !mesh.parent) this.group.add(mesh);
      if (!show && mesh.parent) this.group.remove(mesh);
    }
    for (const key of keys) {
      if (this.cache.has(key)) continue;
      const [tz, tx, ty] = key.split('/').map(Number);
      const mesh = this.#tileMesh(tz, tx, ty, true);
      this.cache.set(key, mesh);
      this.group.add(mesh);
    }
    this.#evict();
  }

  #evict() {
    if (this.cache.size < 400) return;
    for (const [key, mesh] of this.cache) {
      if (mesh.parent) continue;
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
      this.cache.delete(key);
      if (this.cache.size < 250) break;
    }
  }

  setStyle(style) {
    this.style = style;
    this.group.visible = style !== 'none';
    for (const mesh of this.cache.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
    }
    this.cache.clear();
    this.detailKeys = new Set();
    if (style === 'none') return;
    for (const m of this.baseTiles) {
      m.material.visible = false;
      this.#load(m);
    }
  }

  setOpacity(o) {
    this.opacity = o;
    for (const m of [...this.baseTiles, ...this.cache.values()]) m.material.opacity = o;
  }
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}
