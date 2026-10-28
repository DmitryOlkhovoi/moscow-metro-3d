// Ставит метку версии (?v=хэш содержимого) на стили и модули, чтобы после деплоя браузер
// не брал старые файлы из кэша (GitHub Pages кэширует на 10 минут).
// Запуск перед коммитом: node scripts/stamp.mjs
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STRIP = /\?v=[0-9a-f]+/g;
const modules = (await readdir(join(ROOT, 'src'))).filter((f) => f.endsWith('.js')).map((f) => join('src', f));
const files = ['index.html', 'styles.css', ...modules];

const contents = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(join(ROOT, f), 'utf8')])));
const hash = createHash('sha1');
for (const f of files) hash.update(contents[f].replace(STRIP, ''));
const v = hash.digest('hex').slice(0, 8);

const stamped = {
  'index.html': contents['index.html'].replace(STRIP, '')
    .replace('href="styles.css"', `href="styles.css?v=${v}"`)
    .replace('src="src/main.js"', `src="src/main.js?v=${v}"`),
};
for (const f of modules) {
  stamped[f] = contents[f].replace(STRIP, '').replace(/(from '\.\/[\w-]+\.js)'/g, `$1?v=${v}'`);
}
for (const [f, text] of Object.entries(stamped)) {
  if (text !== contents[f]) await writeFile(join(ROOT, f), text);
}
console.log(`версия ${v}`);
