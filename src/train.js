// Поезд на маршруте: автопилот («Поездка») и ручное управление (мини-игра «Машинист»).
// Путь — реальные метры вдоль OSM-путей; при отрисовке высота умножается на преувеличение глубины.
// Два вида: снаружи (камера следует за составом) и из кабины машиниста.
import * as THREE from 'three';
import { ORDER } from './scene.js?v=4d6c4aae';
import { samplePath, CabWorld, Cockpit, EYE } from './cab.js?v=4d6c4aae';
import { arrivalText, departureText } from './audio.js?v=4d6c4aae';

const VMAX = 80 / 3.6;        // ограничение скорости, м/с
const VHARD = 90 / 3.6;       // больше поезд не разгоняется
const ACC = 1.0;              // разгон, м/с²
const BRAKE = 1.2;            // служебное торможение
const EBRAKE = 2.0;           // экстренное
const DRAG = 0.05;            // выбег
const STOP_ZONE = 80;         // остановка засчитывается в этих пределах от точки, м
const OVERSPEED_PENALTY = 5;  // очков в секунду
const MISS_PENALTY = 50;
const DWELL_REAL = 1.6;       // стоянка без звука, с реального времени
const TRANSFER_REAL = 2.2;

const CARS = 5;
const CAR_LEN = 19;
const CAR_GAP = 1.5;
const TRAIN_LEN = CARS * CAR_LEN + (CARS - 1) * CAR_GAP;
const CAR_W = 7;              // сечение утрировано, иначе поезд не видно
const CAR_H = 7;

export const GRADES = [
  { max: 3, points: 100, title: 'Идеально' },
  { max: 10, points: 70, title: 'Отлично' },
  { max: 30, points: 40, title: 'Хорошо' },
  { max: STOP_ZONE, points: 10, title: 'Неплохо' },
];

const toCenter = (from, to) => Math.hypot(to.x, to.z) < Math.hypot(from.x, from.z);

export class TrainRide {
  // app: { metro, scene, camera, controls, hud, toast, audio, onFinish, onCab, onCabLight }
  constructor(app, route, mode) {
    this.app = app;
    this.route = route;
    this.mode = mode;
    this.paths = route.legs.map((leg) => app.metro.routePath(leg));
    this.timeScale = 1; // реальное время; ускорить можно кнопками в HUD
    this.input = { throttle: false, brake: false, emergency: false };
    this.follow = true;
    this.score = 0;
    this.time = 0;
    this.clock = 0;
    this.stops = [];
    this.overspeed = false;
    this.done = false;
    this.cab = false;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.stopToken = 0;
    this.timers = []; // паузы на станциях идут по часам симуляции, а не setTimeout
    this.motion = { accelerating: false, braking: false };

    this.mesh = this.#buildMesh();
    app.scene.add(this.mesh);
    this.#startLeg(0);
    this.#placeCamera();
  }

  #buildMesh() {
    const group = new THREE.Group();
    this.carMaterial = new THREE.MeshLambertMaterial({ transparent: true });
    const roofMaterial = this.roofMaterial = new THREE.MeshLambertMaterial({ transparent: true });
    const carGeo = new THREE.BoxGeometry(CAR_W, CAR_H, CAR_LEN);
    const roofGeo = new THREE.BoxGeometry(CAR_W * 0.7, 1, CAR_LEN * 0.92);
    this.cars = [];
    for (let i = 0; i < CARS; i++) {
      const car = new THREE.Group();
      const body = new THREE.Mesh(carGeo, this.carMaterial);
      const roof = new THREE.Mesh(roofGeo, roofMaterial);
      roof.position.y = CAR_H / 2 + 0.5;
      body.renderOrder = roof.renderOrder = ORDER.overlay;
      car.add(body, roof);
      if (i === 0) {
        const light = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff6c8 }));
        light.position.set(0, 0, CAR_LEN / 2 + 0.6);
        light.renderOrder = ORDER.overlay;
        car.add(light);
      }
      this.cars.push(car);
      group.add(car);
    }
    return group;
  }

  get path() { return this.paths[this.legIndex]; }
  get line() { return this.app.metro.lineById.get(this.path.leg.line); }
  // Точка остановки головы поезда: состав по центру платформы
  stopS(i) { return this.path.stationS[i] + TRAIN_LEN / 2; }

  #startLeg(i) {
    this.legIndex = i;
    this.atStation = 0;
    this.next = 1;
    this.s = this.stopS(0);
    this.v = 0;
    this.carMaterial.color.set(this.line.color);
    this.roofMaterial.color.set(this.line.color).multiplyScalar(0.6);
    if (this.cab) this.#buildWorld();
    this.#stationStop(false);
  }

  pointAt(s, out = new THREE.Vector3()) {
    return samplePath(this.path, s, out);
  }

  scenePoint(s, out = new THREE.Vector3()) {
    this.pointAt(s, out);
    out.y *= this.app.metro.exaggeration;
    return out;
  }

  #placeCars() {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    this.cars.forEach((car, i) => {
      const center = this.s - i * (CAR_LEN + CAR_GAP) - CAR_LEN / 2;
      this.scenePoint(center, c);
      this.scenePoint(center - CAR_LEN / 2, a);
      this.scenePoint(center + CAR_LEN / 2, b);
      car.position.copy(c);
      car.lookAt(b.sub(a).add(c));
    });
  }

  // ---------- камера ----------

  #placeCamera() {
    const { camera, controls } = this.app;
    const head = this.scenePoint(this.s);
    const back = this.scenePoint(this.s - 60).sub(head).setY(0).normalize();
    controls.target.copy(head);
    camera.position.copy(head).addScaledVector(back, 480);
    camera.position.y = Math.max(head.y + 260, 160); // камера над землёй: поезд виден сквозь карту
    this.lastHead = head;
  }

  #followCamera() {
    const head = this.scenePoint(this.s);
    if (this.follow) {
      const delta = head.clone().sub(this.lastHead);
      this.app.controls.target.add(delta);
      this.app.camera.position.add(delta);
    }
    this.lastHead = head;
  }

  toggleFollow() {
    if (this.cab) return;
    this.follow = !this.follow;
    if (this.follow) this.#placeCamera();
    this.app.toast(this.follow ? 'Камера следует за поездом' : 'Свободная камера', 'info');
  }

  // ---------- кабина ----------

  #buildWorld() {
    this.world?.dispose();
    this.world = new CabWorld(this.path, this.line.color);
    this.app.scene.add(this.world.group);
    this.lookTarget = null;
  }

  setCab(on) {
    if (on === this.cab) return;
    this.cab = on;
    if (on) {
      this.app.onCab(true);
      this.cockpit = new Cockpit();
      this.app.camera.add(this.cockpit.group);
      this.#buildWorld();
      this.mesh.visible = false;
      this.underground = -this.pointAt(this.s).y > 3 ? 1 : 0;
    } else {
      this.cockpit.dispose();
      this.world?.dispose();
      this.cockpit = this.world = null;
      this.mesh.visible = true;
      this.app.onCab(false);
      this.#placeCamera();
    }
  }

  #cabCamera(dtR) {
    const cam = this.app.camera;
    const eye = this.pointAt(this.s - 1.5);
    eye.y += EYE;
    this.bob = (this.bob ?? 0) + dtR * this.v * 0.9;
    eye.y += Math.sin(this.bob) * 0.012 * Math.min(this.v / 8, 1);
    const look = new THREE.Vector3();
    for (const d of [20, 40, 60]) look.add(this.pointAt(this.s + d));
    look.multiplyScalar(1 / 3);
    look.y += EYE - 0.4;
    if (!this.lookTarget) this.lookTarget = look.clone();
    else this.lookTarget.lerp(look, 1 - Math.exp(-dtR * 4));
    cam.position.copy(eye);
    cam.lookAt(this.lookTarget);
    cam.rotateY(this.lookYaw);
    cam.rotateX(this.lookPitch);
    this.app.controls.target.copy(this.lookTarget); // для подгрузки тайлов карты вокруг

    // свет: под землёй темно и туман, на поверхности — день
    const target = -eye.y > 3 ? 1 : 0;
    this.underground += (target - this.underground) * (1 - Math.exp(-dtR * 2));
    this.app.onCabLight(this.underground);
  }

  // осмотреться в кабине мышью
  lookAround(dx, dy) {
    this.lookYaw = THREE.MathUtils.clamp(this.lookYaw - dx * 0.004, -1.4, 1.4);
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy * 0.004, -0.6, 0.5);
  }

  resetLook() { this.lookYaw = this.lookPitch = 0; }

  // ---------- станции ----------

  // Стоянка: двери, объявление станции, «Осторожно, двери закрываются…», отправление
  async #stationStop(arrived) {
    const token = ++this.stopToken;
    const alive = () => token === this.stopToken && !this.disposed;
    this.phase = 'dwell';
    const audio = this.app.audio;
    const sound = audio.enabled;
    const leg = this.path.leg;
    const i = this.atStation;
    const last = leg.stations.length - 1;
    const st = leg.stations[i];

    if (arrived) {
      audio.doors(true);
      await this.#sleep(sound ? 0.7 : 0);
      if (!alive()) return;
      const finalStop = i === last && this.legIndex === this.paths.length - 1;
      const lines = [...new Set(this.app.metro.transfersOf(st).map((t) => t.station.line))]
        .filter((id) => id !== st.line).map((id) => this.app.metro.lineById.get(id));
      await audio.say(arrivalText(st, lines, finalStop), { male: i > 0 ? toCenter(leg.stations[i - 1], st) : true });
    }
    await this.#sleep(sound ? 0.6 : DWELL_REAL);
    if (!alive()) return;

    if (i === last) {
      if (this.legIndex < this.paths.length - 1) {
        const tr = this.route.transfers[this.legIndex];
        const nextLine = this.app.metro.lineById.get(this.paths[this.legIndex + 1].leg.line);
        this.app.toast(`Пересадка${tr ? ` на «${tr.to.name}»` : ''} · ${nextLine.name}`, 'info');
        this.phase = 'transfer';
        this.phaseLeft = TRANSFER_REAL;
        if (tr) this.time += tr.time;
      } else {
        this.#finish();
      }
      return;
    }

    const next = leg.stations[i + 1];
    await audio.say(departureText(next), { male: toCenter(st, next) });
    if (!alive()) return;
    audio.doors(false);
    await this.#sleep(sound ? 1.1 : 0);
    if (!alive()) return;
    this.next = i + 1;
    this.phase = 'run';
  }

  // Пауза в секундах реального времени поездки. Когда вкладка скрыта, кадры не идут — пауза тоже стоит
  #sleep(sec) {
    if (sec <= 0) return Promise.resolve();
    return new Promise((resolve) => this.timers.push({ at: this.clock + sec, resolve }));
  }

  #arrive(offset) {
    const st = this.path.leg.stations[this.next];
    this.atStation = this.next;
    if (this.mode === 'manual') {
      const grade = GRADES.find((g) => Math.abs(offset) <= g.max);
      if (grade) {
        this.score += grade.points;
        this.app.toast(`${grade.title}! ${fmtOffset(offset)} · +${grade.points}`, grade.points >= 70 ? 'good' : 'ok');
      }
      this.stops.push({ station: st, offset, grade: grade?.title ?? 'Мимо' });
    } else {
      this.app.toast(`Станция «${st.name}»`, 'info');
    }
    this.#stationStop(true);
  }

  #missStation() {
    const st = this.path.leg.stations[this.next];
    this.score -= MISS_PENALTY;
    this.stops.push({ station: st, offset: null, grade: 'Проезд' });
    this.app.toast(`Проехали «${st.name}»! −${MISS_PENALTY}`, 'bad');
    this.next++;
  }

  #finish() {
    this.phase = 'done';
    this.done = true;
    this.app.onFinish({
      mode: this.mode,
      score: Math.round(this.score),
      time: this.time,
      planned: this.route.time,
      stops: this.stops,
      route: this.route,
    });
  }

  // ---------- кадр ----------

  update(dtReal) {
    const dtR = Math.min(dtReal, 0.1);
    const dt = dtR * this.timeScale;
    this.clock += dtR;
    if (this.timers.length) {
      const due = this.timers.filter((t) => t.at <= this.clock);
      this.timers = this.timers.filter((t) => t.at > this.clock);
      for (const t of due) t.resolve();
    }
    const v0 = this.v;

    if (this.phase === 'dwell') {
      this.time += dt;
    } else if (this.phase === 'transfer') {
      this.phaseLeft -= dtR;
      if (this.phaseLeft <= 0) {
        this.#startLeg(this.legIndex + 1);
        if (this.follow && !this.cab) {
          // камера переезжает вместе с пассажиром
          const head = this.scenePoint(this.s);
          const delta = head.clone().sub(this.lastHead);
          this.app.controls.target.add(delta);
          this.app.camera.position.add(delta);
          this.lastHead = head;
        }
      }
    } else if (this.phase === 'run') {
      this.#run(dt);
    }

    const dv = this.v - v0;
    this.motion.accelerating = this.mode === 'manual' ? this.input.throttle && this.phase === 'run' : dv > 1e-5;
    this.motion.braking = this.mode === 'manual' ? (this.input.brake || this.input.emergency) : dv < -1e-5;

    this.#placeCars();
    if (this.cab) this.#cabCamera(dtR);
    else this.#followCamera();
    const state = this.state();
    this.app.hud.update(state);
    this.cockpit?.update(state, { throttle: this.motion.accelerating, brake: this.motion.braking }, this.clock);
    this.app.audio.update({
      speed: state.speed,
      throttle: this.motion.accelerating,
      braking: this.motion.braking,
      underground: state.depth > 3,
      timeScale: this.timeScale,
    });
  }

  #run(dt) {
    this.time += dt;
    const last = this.path.leg.stations.length - 1;
    const target = this.stopS(this.next);
    const dist = target - this.s;

    if (this.mode === 'auto') {
      const vt = Math.min(VMAX * 0.95, Math.sqrt(2 * BRAKE * 0.85 * Math.max(dist, 0)));
      this.v = this.v < vt ? Math.min(vt, this.v + ACC * dt) : Math.max(vt, this.v - BRAKE * dt);
      this.s += this.v * dt;
      if (target - this.s < 0.5 && this.v < 0.6) {
        this.s = target;
        this.v = 0;
        this.#arrive(0);
      }
      return;
    }

    const { throttle, brake, emergency } = this.input;
    const a = emergency ? -EBRAKE : brake ? -BRAKE : throttle ? ACC : -DRAG;
    this.v = Math.min(VHARD, Math.max(0, this.v + a * dt));
    this.s += this.v * dt;

    this.overspeed = this.v > VMAX + 0.3;
    if (this.overspeed) this.score -= (OVERSPEED_PENALTY * dt) / this.timeScale; // за реальную секунду

    const offset = this.s - target; // >0 — проехали точку остановки
    // тупик за конечной
    if (this.next === last && offset > STOP_ZONE) {
      this.s = target + STOP_ZONE;
      this.v = 0;
      this.app.toast('Тупик! Экстренная остановка', 'bad');
      this.stops.push({ station: this.path.leg.stations[this.next], offset: STOP_ZONE, grade: 'Тупик' });
      this.atStation = this.next;
      this.#stationStop(true);
      return;
    }
    if (this.v === 0 && !throttle && Math.abs(offset) <= STOP_ZONE) {
      this.#arrive(offset);
      return;
    }
    if (offset > STOP_ZONE && this.next < last) this.#missStation();
  }

  state() {
    const leg = this.path.leg;
    // на стоянке — текущая станция, в пути — следующая
    const nextStation = leg.stations[this.phase === 'run' ? this.next : this.atStation];
    const p = this.pointAt(this.s - TRAIN_LEN / 2);
    return {
      mode: this.mode,
      phase: this.phase,
      cab: this.cab,
      speed: this.v * 3.6,
      limit: VMAX * 3.6,
      overspeed: this.overspeed,
      line: this.line,
      next: nextStation,
      distance: this.phase === 'run' ? this.stopS(this.next) - this.s : 0,
      depth: -p.y,
      score: Math.round(this.score),
      time: this.time,
      timeScale: this.timeScale,
      stopZone: STOP_ZONE,
      progress: (this.legIndex + this.s / (this.path.total + TRAIN_LEN)) / this.paths.length,
    };
  }

  dispose() {
    this.disposed = true;
    this.stopToken++;
    if (this.cab) this.setCab(false);
    this.app.audio.stop();
    this.app.scene.remove(this.mesh);
    this.mesh.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  }
}

function fmtOffset(m) {
  const r = Math.round(Math.abs(m));
  if (r === 0) return 'точно в точку';
  return `${r} м ${m > 0 ? 'дальше' : 'раньше'}`;
}
