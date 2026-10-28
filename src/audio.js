// Звуки поездки: настоящие записи московского метро (Freesound, CC0 — см. sounds/CREDITS.md),
// нарезанные на петли «стоянка» и «ход» и разовые «разгон», «торможение», «двери».
// Объявления произносит системный синтез речи браузера (Web Speech API, ru-RU).
import { readSetting, writeSetting } from './storage.js?v=4d6c4aae';

const CLIPS = {
  idle: 'sounds/idle.wav',
  cruise: 'sounds/cruise.wav',
  accel: 'sounds/accel.wav',
  brake: 'sounds/brake.wav',
  doors: 'sounds/doors-close.mp3',
};
const ONESHOT_MAX_SCALE = 3; // при сильном ускорении времени разгон/торможение не совпадут с записью

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class MetroAudio {
  constructor() {
    this.enabled = readSetting('sound', '1') === '1';
    this.ctx = null;
    this.buffers = null;
    this.voices = [];
    this.voiceName = readSetting('voice', 'auto'); // 'auto' или имя голоса
    this.onVoices = null;
    this.lastSpoken = '';
    this.lastSpeed = 0;
    if ('speechSynthesis' in window) {
      const load = () => {
        // лучшие голоса первыми: улучшенные/премиум/онлайн звучат заметно естественнее компактных
        this.voices = speechSynthesis.getVoices().filter((v) => /^ru/i.test(v.lang)).sort((a, b) => voiceRank(b) - voiceRank(a));
        this.onVoices?.(this.voices);
      };
      load();
      speechSynthesis.addEventListener?.('voiceschanged', load);
    }
    // Свернули браузер — поездка на паузе (кадры не идут), значит и звук на паузу
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) {
        this.ctx.suspend();
        if ('speechSynthesis' in window) speechSynthesis.cancel();
      } else {
        this.ctx.resume();
      }
    });
  }

  setVoice(name) {
    this.voiceName = name;
    writeSetting('voice', name);
  }

  setEnabled(on) {
    this.enabled = on;
    writeSetting('sound', on ? '1' : '0');
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05);
    if (!on && 'speechSynthesis' in window) speechSynthesis.cancel();
  }

  // Вызывается из обработчика клика: браузеры разрешают звук только после жеста пользователя
  ensure() {
    if (!this.ctx) this.#build();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  #build() {
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 1 : 0;
    // под землёй звук глуше
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 12000;
    this.tone.connect(this.master).connect(ctx.destination);

    this.loading = Promise.all(Object.entries(CLIPS).map(async ([name, url]) => {
      const data = await (await fetch(url)).arrayBuffer();
      return [name, await ctx.decodeAudioData(data)];
    })).then((list) => {
      this.buffers = Object.fromEntries(list);
      this.idle = this.#loop(this.buffers.idle);
      this.cruise = this.#loop(this.buffers.cruise);
    }).catch((e) => console.warn('Звуки метро не загрузились', e));
  }

  #loop(buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(this.tone);
    src.start(0, Math.random() * buffer.duration);
    return { src, gain };
  }

  #oneShot(name, { offset = 0, level = 1, reverse = false } = {}) {
    let buffer = this.buffers[name];
    if (reverse) {
      buffer = this.ctx.createBuffer(1, buffer.length, buffer.sampleRate);
      const from = this.buffers[name].getChannelData(0), to = buffer.getChannelData(0);
      for (let i = 0; i < from.length; i++) to[i] = from[from.length - 1 - i];
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = level;
    src.connect(gain).connect(this.tone);
    src.start(0, offset);
    const voice = { src, gain, start: this.ctx.currentTime - offset, duration: buffer.duration };
    src.onended = () => { voice.ended = true; };
    return voice;
  }

  #fadeOut(voice, time = 0.4) {
    if (!voice || voice.ended) return;
    const t = this.ctx.currentTime;
    voice.gain.gain.setTargetAtTime(0, t, time / 3);
    voice.src.stop(t + time);
    voice.ended = true;
  }

  // Каждый кадр. speed — км/ч модельной скорости; dt — реальные секунды
  update({ speed, throttle, braking, underground, timeScale = 1 }) {
    if (!this.ctx || !this.buffers) return;
    const t = this.ctx.currentTime;
    const oneShots = timeScale <= ONESHOT_MAX_SCALE;

    // разгон с места — запись разгона
    if (oneShots && throttle && this.lastSpeed < 1 && speed >= 1 && (!this.accel || this.accel.ended)) {
      this.#fadeOut(this.brake);
      this.accel = this.#oneShot('accel', { level: 1 });
    }
    // торможение перед станцией — запись торможения с места, соответствующего скорости
    if (oneShots && braking && speed > 4 && speed < 55 && (!this.brake || this.brake.ended)) {
      const d = this.buffers.brake.duration;
      this.#fadeOut(this.accel);
      this.brake = this.#oneShot('brake', { offset: Math.max(0, (1 - speed / 55) * (d - 4)) });
    }
    if (throttle && this.brake && !this.brake.ended) this.#fadeOut(this.brake);
    if (!oneShots) { this.#fadeOut(this.accel); this.#fadeOut(this.brake); }

    // пока звучит разовая запись, петля хода приглушена и плавно возвращается к её концу
    let duck = 1;
    for (const v of [this.accel, this.brake]) {
      if (!v || v.ended) continue;
      const left = v.start + v.duration - t;
      duck = Math.min(duck, 1 - smoothstep(0, 3, left));
    }

    const run = smoothstep(2, 35, speed);
    this.cruise.src.playbackRate.setTargetAtTime(0.7 + 0.35 * Math.min(speed / 75, 1), t, 0.2);
    this.cruise.gain.gain.setTargetAtTime(run * duck * 0.9, t, 0.15);
    this.idle.gain.gain.setTargetAtTime((1 - run) * 0.6 * (duck < 1 ? 0.4 : 1), t, 0.3);
    this.tone.frequency.setTargetAtTime(underground ? 5000 : 12000, t, 0.5);
    this.lastSpeed = speed;
  }

  // Двери: настоящая запись закрытия; открытие — та же запись задом наперёд, тише
  doors(open) {
    if (!this.ctx || !this.buffers) return;
    this.#oneShot('doors', { level: open ? 0.45 : 0.9, reverse: open });
  }

  // Объявление. Мужской голос — поезд идёт к центру, женский — от центра (как в московском метро)
  say(text, { male = true } = {}) {
    this.lastSpoken = text;
    if (!this.enabled || document.hidden || !('speechSynthesis' in window)) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      const voice = this.#voice(male);
      if (voice) u.voice = voice;
      // высоту не трогаем: сдвиг тона делает голос неестественным
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 1500 + text.length * 110); // страховка, если onend не придёт
      u.onend = u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  // Выбранный голос; в режиме «авто» — лучший мужской/женский, если установлены оба
  #voice(male) {
    if (!this.voices.length) return null;
    if (this.voiceName !== 'auto') {
      const chosen = this.voices.find((v) => v.name === this.voiceName);
      if (chosen) return chosen;
    }
    const pool = this.voices.filter((v) => MALE.test(v.name) === male);
    return (pool.length ? pool : this.voices)[0];
  }

  // Проба голоса из настроек
  preview() {
    const was = this.enabled;
    this.enabled = true;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    const p = this.say('Станция Охотный Ряд. Переход на Замоскворецкую линию.', { male: true });
    this.enabled = was;
    return p;
  }

  // Конец поездки: глушим ход и речь
  stop() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (!this.ctx || !this.buffers) return;
    const t = this.ctx.currentTime;
    for (const l of [this.idle, this.cruise]) l.gain.gain.setTargetAtTime(0, t, 0.2);
    this.#fadeOut(this.accel);
    this.#fadeOut(this.brake);
    this.lastSpeed = 0;
  }
}

const MALE = /yuri|юрий|pavel|павел|maxim|максим|dmitr|дмитр|male|мужск/i;

function voiceRank(v) {
  let r = 0;
  if (/premium|enhanced|улучш|natural|neural|google|online/i.test(v.name)) r += 2;
  if (!v.localService) r += 1; // облачные голоса обычно качественнее
  return r;
}

// ---------- тексты объявлений ----------

// «Кольцевая линия» → «Кольцевую линию»
function accusative(phrase) {
  return phrase.split(' ').map((w) => w.replace(/ая$/, 'ую').replace(/яя$/, 'юю').replace(/^линия$/, 'линию')).join(' ');
}

export function transferPhrase(lines) {
  if (!lines.length) return '';
  const regular = lines.filter((l) => / линия$/.test(l.name)).map((l) => l.name.replace(/ линия$/, ''));
  const other = lines.filter((l) => !/ линия$/.test(l.name)).map((l) => l.name);
  const parts = [];
  if (regular.length === 1) parts.push(`${accusative(regular[0])} линию`);
  if (regular.length > 1) {
    const adj = regular.map(accusative);
    parts.push(`${adj.slice(0, -1).join(', ')} и ${adj[adj.length - 1]} линии`);
  }
  parts.push(...other);
  return `Переход на ${parts.join(' и ')}.`;
}

export function arrivalText(station, transferLines, terminal) {
  let text = `Станция ${station.name}.`;
  const tr = transferPhrase(transferLines);
  if (tr) text += ` ${tr}`;
  if (terminal) text += ' Конечная. Поезд дальше не идёт, просьба выйти из вагонов.';
  return text;
}

export function departureText(next) {
  return `Осторожно, двери закрываются. Следующая станция — ${next.name}.`;
}
