// Панель (маршрут, вид, линии), автодополнение станций, карточка станции, HUD поездки и тосты
import { fmtDepth, fmtDist, fmtMinutes } from './scene.js?v=54a59237';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const normalize = (s) => s.toLowerCase().replace(/ё/g, 'е');
const RING_LINES = new Set(['5', '11', '14']);

const DEPTH_SOURCES = {
  wikidata: 'глубина заложения · Wikidata',
  ruwiki: 'глубина заложения · Википедия',
  estimate: 'оценка: данных нет, по соседним станциям',
};

const ICON_WALK = '<svg viewBox="0 0 24 24"><circle cx="13" cy="4.5" r="2" fill="currentColor"/><path d="M10 21l2-6 3 3v4M9 12l1-4 4 1 2 4 3 1M10 8l-3 2-1 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const ICON_DRIVE = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 14v6.5M10 12H3.5M14 12h6.5" stroke="currentColor" stroke-width="2"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

export function lineBadge(line, size = '') {
  const cls = ['lb', size, RING_LINES.has(line.id) ? 'ring' : '', line.label.length > 1 ? 'wide' : ''].filter(Boolean).join(' ');
  return `<span class="${cls}" style="--c:${line.color}" title="${esc(line.name)}">${esc(line.label)}</span>`;
}

export function initUI({
  data, metro, onSelect, onRoute, onRide, onExaggeration, onBasemap, onOpacity, onView, onRuler,
  onTheme, onSound, soundEnabled, theme, audio,
}) {
  const lineById = metro.lineById;
  const badge = (s, size) => lineBadge(lineById.get(s.line), size);
  const stationById = metro.stationById;
  const depthText = (s) => (s.depth > 0 ? `−${fmtDepth(s.depth)} м` : s.depth < 0 ? 'эстакада' : 'наземная');

  // ---------- панель и вкладки ----------
  const panel = $('#panel');
  $('#panel-toggle').addEventListener('click', () => panel.classList.toggle('collapsed'));
  const tabs = document.querySelectorAll('.tabs button');
  const showTab = (name) => {
    for (const t of tabs) t.classList.toggle('active', t.dataset.tab === name);
    for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
  };
  for (const t of tabs) t.addEventListener('click', () => showTab(t.dataset.tab));

  // ---------- вид ----------
  const ex = $('#exaggeration');
  const setExaggeration = (value) => {
    ex.value = value;
    $('#exaggeration-value').textContent = `×${value}`;
    onExaggeration(Number(value));
  };
  ex.addEventListener('input', () => setExaggeration(ex.value));
  $('#basemap').addEventListener('change', (e) => onBasemap(e.target.value));
  const themeSelect = $('#theme');
  themeSelect.value = theme;
  themeSelect.addEventListener('change', () => onTheme(themeSelect.value));

  // звук: чекбокс во вкладке «Вид» и кнопка в HUD
  const soundBox = $('#opt-sound');
  const soundBtn = $('#hud .hud-sound');
  const setSound = (on) => {
    soundBox.checked = on;
    soundBtn.classList.toggle('off', !on);
    soundBtn.title = on ? 'Выключить звук (M)' : 'Включить звук (M)';
    onSound(on);
  };
  soundBox.checked = soundEnabled;
  soundBtn.classList.toggle('off', !soundEnabled);
  soundBox.addEventListener('change', () => setSound(soundBox.checked));

  // голос объявлений
  const voiceSelect = $('#voice');
  const voiceHint = $('#voice-hint');
  const renderVoices = (voices) => {
    voiceSelect.innerHTML = '<option value="auto">Автоматически</option>'
      + voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}${v.localService ? '' : ' · онлайн'}</option>`).join('');
    voiceSelect.value = voices.some((v) => v.name === audio.voiceName) ? audio.voiceName : 'auto';
    const good = voices.some((v) => /premium|enhanced|улучш|google|natural|neural/i.test(v.name) || !v.localService);
    voiceHint.hidden = good;
    voiceHint.innerHTML = !voices.length
      ? 'Русских голосов в системе нет — объявления будут прочитаны голосом по умолчанию.'
      : /Mac/.test(navigator.platform)
        ? 'Установлен только базовый голос. Естественнее звучат улучшенные: Системные настройки → Универсальный доступ → '
          + 'Устный контент → Системный голос → Управлять голосами → Русский: «Милена (улучшенный)» и «Юрий (улучшенный)». '
          + 'После установки перезапустите браузер — тогда будет и мужской голос к центру, и женский от центра.'
        : 'Установлен только базовый голос. Естественнее звучат улучшенные голоса системы или «Google русский» в Chrome.';
  };
  renderVoices(audio.voices);
  audio.onVoices = renderVoices;
  voiceSelect.addEventListener('change', () => audio.setVoice(voiceSelect.value));
  $('#voice-test').addEventListener('click', () => audio.preview());
  soundBtn.addEventListener('click', () => setSound(!soundBox.checked));
  $('#opacity').addEventListener('input', (e) => onOpacity(Number(e.target.value)));
  for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => onView(b.dataset.view));

  const rulerBtn = $('#ruler');
  const setRuler = (on) => {
    rulerBtn.classList.toggle('active', on);
    onRuler(on);
  };
  rulerBtn.addEventListener('click', () => setRuler(!rulerBtn.classList.contains('active')));

  $('#opt-labels').addEventListener('change', (e) => { metro.showLabels = e.target.checked; });
  $('#opt-shafts').addEventListener('change', (e) => metro.setShafts(e.target.checked));
  $('#opt-transfers').addEventListener('change', (e) => metro.setTransfers(e.target.checked));

  // ---------- линии ----------
  const linesEl = $('#lines');
  for (const line of data.lines) {
    const li = document.createElement('li');
    li.innerHTML = `<label><input type="checkbox" checked data-line="${esc(line.id)}">${lineBadge(line)}<span>${esc(line.name)}</span></label>`;
    linesEl.append(li);
  }
  linesEl.addEventListener('change', (e) => metro.setLineVisible(e.target.dataset.line, e.target.checked));
  const setAll = (on) => {
    for (const cb of linesEl.querySelectorAll('input')) {
      cb.checked = on;
      metro.setLineVisible(cb.dataset.line, on);
    }
  };
  $('#lines-all').addEventListener('click', () => setAll(true));
  $('#lines-none').addEventListener('click', () => setAll(false));

  // ---------- автодополнение ----------
  const ac = $('#ac');
  function attachAutocomplete(input, onChoose) {
    let found = [];
    let active = 0;
    const render = () => {
      if (!found.length || document.activeElement !== input) { ac.hidden = true; return; }
      const r = input.closest('.field, .search')?.getBoundingClientRect() ?? input.getBoundingClientRect();
      Object.assign(ac.style, { left: `${r.left}px`, top: `${r.bottom + 6}px`, width: `${Math.max(r.width, 260)}px` });
      ac.innerHTML = found.map((s, i) => `<li data-i="${i}" class="${i === active ? 'active' : ''}">
        ${badge(s, 'sm')}<span>${esc(s.name)}</span><small>${depthText(s)}</small></li>`).join('');
      ac.hidden = false;
      ac.onpointerdown = (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        e.preventDefault();
        choose(found[Number(li.dataset.i)]);
      };
    };
    const choose = (s) => { found = []; render(); onChoose(s); };
    input.addEventListener('input', () => {
      const q = normalize(input.value.trim());
      found = q ? data.stations.filter((s) => normalize(s.name).includes(q))
        .sort((a, b) => normalize(a.name).indexOf(q) - normalize(b.name).indexOf(q) || a.name.localeCompare(b.name))
        .slice(0, 10) : [];
      active = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { active = Math.min(active + 1, found.length - 1); render(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
      if (e.key === 'Enter' && found[active]) choose(found[active]);
      if (e.key === 'Escape') { found = []; render(); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(render, 100));
    input.addEventListener('focus', () => input.select());
  }

  // ---------- маршрут ----------
  const ends = { from: null, to: null };
  const inputs = { from: $('#from'), to: $('#to') };
  const setEnd = (which, s) => {
    ends[which] = s;
    inputs[which].value = s ? s.name : '';
    const field = inputs[which].closest('.field');
    field.querySelector('.lb')?.remove();
    if (s) inputs[which].insertAdjacentHTML('beforebegin', badge(s, 'sm'));
    showTab('route');
    if (ends.from && ends.to && ends.from !== ends.to) onRoute(ends.from, ends.to);
    else { onRoute(null); renderEmpty(); }
  };
  attachAutocomplete(inputs.from, (s) => { setEnd('from', s); if (!ends.to) inputs.to.focus(); else inputs.from.blur(); });
  attachAutocomplete(inputs.to, (s) => { setEnd('to', s); inputs.to.blur(); });
  for (const which of ['from', 'to']) {
    inputs[which].addEventListener('change', () => { if (!inputs[which].value.trim() && ends[which]) setEnd(which, null); });
  }
  $('#swap').addEventListener('click', () => {
    const { from, to } = ends;
    ends.from = null; ends.to = null;
    setEnd('from', to);
    setEnd('to', from);
  });

  const result = $('#route-result');
  function renderEmpty() {
    result.innerHTML = `<p class="empty">Введите станции или кликните по станции на схеме и выберите <b>«Отсюда»</b> / <b>«Сюда»</b>.
      Маршрут можно проехать на поезде или самому повести состав в мини-игре <b>«Машинист»</b>.</p>
      <p class="empty"><button class="btn" id="random-route">Случайный маршрут</button></p>`;
    $('#random-route').addEventListener('click', () => {
      const pool = data.stations.filter((s) => metro.isVisible(s));
      const a = pool[Math.floor(Math.random() * pool.length)];
      let b;
      do b = pool[Math.floor(Math.random() * pool.length)]; while (b === a || Math.hypot(a.x - b.x, a.z - b.z) < 4000);
      ends.from = null;
      setEnd('from', a);
      setEnd('to', b);
    });
  }
  renderEmpty();

  function showRoute(route) {
    if (!route) {
      result.innerHTML = '<p class="empty">Маршрут не найден — возможно, нужные линии скрыты.</p>';
      return;
    }
    const usedLines = [...new Set(route.legs.map((l) => l.line))].map((id) => lineBadge(lineById.get(id), 'sm')).join('');
    const nTr = route.transfers.length;
    const trWord = nTr === 0 ? 'без пересадок' : `${nTr} ${plural(nTr, 'пересадка', 'пересадки', 'пересадок')}`;
    const nSt = route.stations.length - route.legs.length;
    let html = `
      <div class="summary">
        <div class="time">≈ ${fmtMinutes(route.time).replace(' мин', '<small>мин</small>')}</div>
        <div class="lines-used">${usedLines}</div>
      </div>
      <div class="facts">
        <span>${trWord}</span><span>${fmtDist(route.length)} по путям</span>
        <span>${nSt} ${plural(nSt, 'перегон', 'перегона', 'перегонов')}</span>
        <span>глубже всего −${fmtDepth(route.maxDepth)} м</span>
      </div>
      <div class="actions">
        <button class="btn primary" data-ride="auto">${ICON_PLAY}Поездка</button>
        <button class="btn game" data-ride="manual">${ICON_DRIVE}Машинист<span class="tag">игра</span></button>
      </div>
      <ol class="steps">`;
    route.legs.forEach((leg, i) => {
      const line = lineById.get(leg.line);
      const mid = leg.stations.slice(1, -1);
      const stRow = (s, end) => `<div class="st${end ? ' end' : ''}" data-station="${esc(s.id)}">${esc(s.name)}<small>${depthText(s)}</small></div>`;
      html += `<li class="leg" style="--c:${line.color}">
        <div class="leg-head">${lineBadge(line)}<span>${esc(line.name)}</span><small>${fmtMinutes(leg.time)}</small></div>
        ${stRow(leg.stations[0], true)}
        ${mid.length > 3
          ? `<div class="mid" hidden>${mid.map((s) => stRow(s)).join('')}</div><button class="more">${mid.length} ${plural(mid.length, 'остановка', 'остановки', 'остановок')} ▾</button>`
          : mid.map((s) => stRow(s)).join('')}
        ${stRow(leg.stations[leg.stations.length - 1], true)}
      </li>`;
      const tr = route.transfers[i];
      if (tr && i < route.legs.length - 1) {
        html += `<li class="transfer">${ICON_WALK}<span>Переход на «${esc(tr.to.name)}» · ${fmtDist(tr.length)}</span><b>${fmtMinutes(tr.time)}</b></li>`;
      }
    });
    html += '</ol>';
    result.innerHTML = html;
  }

  result.addEventListener('click', (e) => {
    const ride = e.target.closest('[data-ride]');
    if (ride) return onRide(ride.dataset.ride);
    const more = e.target.closest('.more');
    if (more) { more.previousElementSibling.hidden = false; more.remove(); return; }
    const st = e.target.closest('[data-station]');
    if (st) onSelect(stationById.get(st.dataset.station), { focus: true });
  });

  // ---------- карточка станции ----------
  const info = $('#info');
  info.addEventListener('click', (e) => {
    if (e.target.closest('.close')) {
      if (rulerBtn.classList.contains('active')) setRuler(false);
      if (info.dataset.kind === 'result') onRide(null);
      onSelect(null);
      return;
    }
    const end = e.target.closest('[data-end]');
    if (end) { setEnd(end.dataset.end, stationById.get(end.dataset.id)); return; }
    const again = e.target.closest('[data-again]');
    if (again) { onRide(again.dataset.again); return; }
    const link = e.target.closest('[data-station]');
    if (link) onSelect(stationById.get(link.dataset.station), { focus: true });
  });

  const stLink = (s) => `<button class="st-link" data-station="${esc(s.id)}">${badge(s, 'sm')}${esc(s.name)}</button>`;
  const closeBtn = `<button class="icon-btn close" aria-label="Закрыть">${ICON_CLOSE}</button>`;

  function showStation(s) {
    if (!s) { info.hidden = true; return; }
    info.dataset.kind = 'station';
    const line = lineById.get(s.line);
    const src = s.depth > 0 ? DEPTH_SOURCES[s.depthSource]
      : s.depth < 0 ? `путь на мосту/эстакаде, ~${-s.depth} м над землёй` : 'наземная станция';
    const neighbors = metro.neighbors(s);
    const transfers = metro.transfersOf(s);
    const depthBig = s.depth > 0 ? `−${fmtDepth(s.depth)}<small>м</small>` : s.depth < 0 ? `+${-s.depth}<small>м</small>` : '0<small>м</small>';
    info.innerHTML = `${closeBtn}
      <h2>${esc(s.name)}</h2>
      <div class="line-name">${lineBadge(line)}${esc(line.name)}</div>
      <div class="depth-big">${depthBig}</div>
      <div class="src">${esc(src)}${s.wikidata ? ` · <a href="https://www.wikidata.org/wiki/${esc(s.wikidata)}" target="_blank" rel="noopener">${esc(s.wikidata)}</a>` : ''}</div>
      <div class="actions">
        <button class="btn" data-end="from" data-id="${esc(s.id)}"><span class="pin from"></span>Отсюда</button>
        <button class="btn primary" data-end="to" data-id="${esc(s.id)}"><span class="pin to" style="border-color:#fff"></span>Сюда</button>
      </div>
      ${neighbors.length ? `<h3>Перегоны</h3><table>${neighbors.map(({ station, seg }) => `
        <tr><td>${stLink(station)}</td>
        <td class="num">${fmtDist(seg.length)}<span class="sub">по прямой ${fmtDist(seg.direct)}</span></td></tr>`).join('')}</table>` : ''}
      ${transfers.length ? `<h3>Пересадки</h3><table>${transfers.map(({ station, length }) => `
        <tr><td>${stLink(station)}<span class="sub">${depthText(station)}</span></td>
        <td class="num">${fmtDist(length)}<span class="sub">между центрами</span></td></tr>`).join('')}</table>` : ''}
    `;
    info.hidden = false;
  }

  // Возвращает текст для подписи на линии линейки
  function showRuler(picks) {
    info.dataset.kind = 'ruler';
    const [a, b] = picks;
    let body = '<p class="hint">Кликните по первой станции на схеме.</p>';
    let label = null;
    if (a && !b) body = `<p>${stLink(a)}</p><p class="hint">Теперь кликните по второй станции.</p>`;
    if (a && b) {
      const horiz = Math.hypot(b.x - a.x, b.z - a.z);
      const dy = b.depth - a.depth;
      const d3 = Math.hypot(horiz, dy);
      label = fmtDist(d3);
      body = `
        <p>${stLink(a)}<br>${stLink(b)}</p>
        <div class="big-num">${fmtDist(d3)}</div><div class="src">по прямой в 3D</div>
        <table style="margin-top:10px">
          <tr><td>По горизонтали</td><td class="num">${fmtDist(horiz)}</td></tr>
          <tr><td>Разница глубин</td><td class="num">${fmtDepth(Math.round(Math.abs(dy) * 10) / 10)} м</td></tr>
        </table>
        <p class="hint">Следующий клик начнёт новое измерение.</p>`;
    }
    info.innerHTML = `${closeBtn}<h2>Линейка</h2>${body}`;
    info.hidden = false;
    return label;
  }

  function showResult(r) {
    info.dataset.kind = 'result';
    const fmtT = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
    const manual = r.mode === 'manual';
    const perfect = r.stops.filter((s) => s.grade === 'Идеально').length;
    const title = !manual ? 'Поездка завершена'
      : r.score >= r.stops.length * 80 ? 'Машинист первого класса'
        : r.score >= r.stops.length * 40 ? 'Уверенный машинист' : 'Стажёр';
    info.innerHTML = `${closeBtn}
      <h2>${title}</h2>
      <div class="line-name">${stLink(r.route.from)} → ${stLink(r.route.to)}</div>
      ${manual ? `<div class="depth-big">${r.score}<small>очков</small></div>
        <div class="result-grade">${perfect} из ${r.stops.length} остановок — идеально</div>` : ''}
      <table>
        <tr><td>Время в пути (модельное)</td><td class="num">${fmtT(r.time)}</td></tr>
        <tr><td>По расписанию</td><td class="num">≈ ${fmtMinutes(r.planned)}</td></tr>
        <tr><td>Расстояние</td><td class="num">${fmtDist(r.route.length)}</td></tr>
      </table>
      ${manual ? `<h3>Остановки</h3><table>${r.stops.map((s) => `<tr><td>${stLink(s.station)}</td>
        <td class="num">${esc(s.grade)}<span class="sub">${s.offset == null ? '—' : `${Math.round(Math.abs(s.offset))} м`}</span></td></tr>`).join('')}</table>` : ''}
      <div class="actions">
        <button class="btn" data-again="auto">${ICON_PLAY}Ещё раз</button>
        <button class="btn game" data-again="manual">${ICON_DRIVE}Машинист</button>
      </div>`;
    info.hidden = false;
  }

  // ---------- HUD ----------
  const hud = $('#hud');
  const speedo = $('.speedo', hud);
  const valueArc = $('.speedo .value', hud);
  const els = {
    speed: $('.speed', hud), name: $('.hud-next .name', hud), dist: $('.hud-next .dist', hud),
    lbl: $('.hud-next .lbl', hud), depth: $('.depth', hud), score: $('.score', hud), time: $('.time', hud),
    line: $('.hud-line', hud), progress: $('.hud-progress i', hud), platform: $('.platform', hud), mark: $('.platform .mark', hud),
  };
  let lastLine = null;
  let lastNext = null;
  const hudApi = {
    show(mode, { onScale, onExit, onControl, onCab }) {
      hud.hidden = false;
      hud.classList.toggle('auto', mode === 'auto');
      document.body.classList.add('riding');
      lastLine = lastNext = null;
      for (const b of hud.querySelectorAll('[data-scale]')) b.onclick = () => onScale(Number(b.dataset.scale));
      $('.hud-exit', hud).onclick = onExit;
      $('.hud-cab', hud).onclick = onCab;
      for (const b of hud.querySelectorAll('[data-ctl]')) {
        const set = (on) => { b.classList.toggle('on', on); onControl(b.dataset.ctl, on); };
        b.onpointerdown = (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); set(true); };
        b.onpointerup = b.onpointercancel = () => set(false);
      }
    },
    hide() {
      hud.hidden = true;
      document.body.classList.remove('riding');
    },
    update(st) {
      const kmh = Math.round(st.speed);
      els.speed.textContent = kmh;
      valueArc.style.strokeDasharray = `${Math.min(st.speed / 90, 1) * 100} 100`;
      speedo.classList.toggle('over', st.overspeed);
      if (st.line !== lastLine) {
        lastLine = st.line;
        els.line.innerHTML = `${lineBadge(st.line)}<span>${esc(st.line.name)}</span>`;
      }
      if (st.next !== lastNext) {
        lastNext = st.next;
        els.name.innerHTML = esc(st.next.name);
      }
      els.lbl.textContent = st.phase === 'run' ? 'Следующая' : st.phase === 'transfer' ? 'Пересадка' : st.phase === 'done' ? 'Конечная' : 'Стоянка';
      els.dist.textContent = st.phase === 'run'
        ? (st.distance >= 0 ? `до остановки ${fmtDist(st.distance)}` : `проехали на ${fmtDist(-st.distance)}`)
        : st.phase === 'dwell' ? 'двери открыты' : '';
      els.depth.textContent = st.depth > 0.5 ? `−${Math.round(st.depth)} м` : st.depth < -0.5 ? `+${Math.round(-st.depth)} м` : '0 м';
      els.score.textContent = st.score;
      els.time.textContent = `${Math.floor(st.time / 60)}:${String(Math.floor(st.time % 60)).padStart(2, '0')}`;
      els.progress.style.width = `${Math.min(100, st.progress * 100)}%`;
      const showPlatform = st.mode === 'manual' && st.phase === 'run' && Math.abs(st.distance) < 400;
      els.platform.hidden = !showPlatform;
      if (showPlatform) {
        // шкала ±100 м вокруг точки остановки
        const x = 50 - (st.distance / 100) * 50;
        els.mark.style.left = `${Math.max(0, Math.min(100, x))}%`;
      }
      for (const b of hud.querySelectorAll('[data-scale]')) b.classList.toggle('active', Number(b.dataset.scale) === st.timeScale);
      $('.hud-cab', hud).classList.toggle('active', st.cab);
    },
  };

  // ---------- тосты ----------
  const toasts = $('#toasts');
  function toast(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    toasts.append(el);
    while (toasts.children.length > 3) toasts.firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2200);
  }

  return { showStation, showRuler, showRoute, showResult, setEnd, hud: hudApi, toast, setRuler, setExaggeration, setSound };
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
