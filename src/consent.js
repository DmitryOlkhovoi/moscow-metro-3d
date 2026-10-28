// Согласие на cookie и аналитику (152-ФЗ): Яндекс Метрика загружается только после «Принять».
// Пока номер счётчика не задан, баннер не показывается и аналитики нет.
import { readSetting, writeSetting } from './storage.js?v=54a59237';

export const METRIKA_ID = 113863096; // номер счётчика Яндекс Метрики

const KEY = 'consent'; // 'granted' | 'denied'

// Подключается отдельным скриптом в index.html (модули выполняются после разбора страницы)
initConsent();

function initConsent() {
  const settingsBtn = document.getElementById('cookie-settings');
  if (!METRIKA_ID) return;
  settingsBtn.parentElement.hidden = false;
  settingsBtn.addEventListener('click', () => showBanner());
  const choice = readSetting(KEY, '');
  if (choice === 'granted') loadMetrika();
  else if (!choice) showBanner();
}

function showBanner() {
  document.getElementById('consent')?.remove();
  const el = document.createElement('div');
  el.id = 'consent';
  el.className = 'consent card';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Согласие на cookie');
  el.innerHTML = `
    <p>Сайт использует cookie и Яндекс Метрику, чтобы понимать, как им пользуются: какие экраны открывают,
      куда кликают, с каких устройств заходят. Нажимая «Принять», вы соглашаетесь на обработку этих данных
      по <a href="privacy.html" target="_blank" rel="noopener">политике конфиденциальности</a>.
      Без согласия сайт работает так же, просто без статистики.</p>
    <div class="consent-actions">
      <button class="btn" data-choice="denied">Отклонить</button>
      <button class="btn primary" data-choice="granted">Принять</button>
    </div>`;
  el.addEventListener('click', (e) => {
    const choice = e.target.closest('[data-choice]')?.dataset.choice;
    if (!choice) return;
    const before = readSetting(KEY, '');
    writeSetting(KEY, choice);
    el.remove();
    if (choice === 'granted') loadMetrika();
    else if (before === 'granted') {
      // отзыв согласия: удаляем cookie Метрики и перезагружаемся, чтобы её скрипт выгрузился
      for (const c of document.cookie.split(';')) {
        const name = c.split('=')[0].trim();
        if (name.startsWith('_ym')) document.cookie = `${name}=; Max-Age=0; path=/`;
      }
      location.reload();
    }
  });
  document.body.append(el);
}

function loadMetrika() {
  if (window.ym) return;
  window.ym = function ym(...args) { (window.ym.a = window.ym.a || []).push(args); };
  window.ym.l = Date.now();
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://mc.yandex.ru/metrika/tag.js?id=${METRIKA_ID}`;
  document.head.append(s);
  // настройки — из кода счётчика в интерфейсе Метрики
  window.ym(METRIKA_ID, 'init', {
    ssr: true, webvisor: true, clickmap: true, ecommerce: 'dataLayer',
    referrer: document.referrer, url: location.href, accurateTrackBounce: true, trackLinks: true,
  });
}
