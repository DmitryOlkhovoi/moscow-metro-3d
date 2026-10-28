// Локальная проекция в метрах (синусоидальная, центр — Кремль).
// x — на восток, z — на юг, y — вверх. Используется и в браузере, и в скрипте сборки данных.
export const CENTER = { lat: 55.752, lon: 37.6175 };
const R = 6371008.8;
const RAD = Math.PI / 180;

export function project(lat, lon) {
  const x = R * (lon - CENTER.lon) * RAD * Math.cos(lat * RAD);
  const z = -R * (lat - CENTER.lat) * RAD;
  return [x, z];
}

export function unproject(x, z) {
  const lat = CENTER.lat - z / (R * RAD);
  const lon = CENTER.lon + x / (R * RAD * Math.cos(lat * RAD));
  return [lat, lon];
}
