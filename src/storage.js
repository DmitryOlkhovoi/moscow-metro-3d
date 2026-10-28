// Настройки пользователя в localStorage (тема, звук, голос, решение о cookie).
// В приватном режиме хранилище может быть недоступно — тогда просто работаем со значениями по умолчанию.

export function readSetting(key, fallback) {
  try { return localStorage.getItem(`metro3d:${key}`) ?? fallback; } catch { return fallback; }
}

export function writeSetting(key, value) {
  try { localStorage.setItem(`metro3d:${key}`, value); } catch { /* хранилище недоступно — не страшно */ }
}
