import {createHash} from 'node:crypto';
import {access, copyFile, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'dist');
const assets = [
  'index.html',
  'src/model.js',
  'src/wires-format.js',
  'src/collision.js'
];

await rm(output, {recursive: true, force: true});
for (const asset of assets) {
  const source = join(root, asset);
  const target = join(output, asset);
  await access(source);
  await mkdir(dirname(target), {recursive: true});
  await copyFile(source, target);
}

// Модули подключаются с хэшем содержимого, чтобы браузер после деплоя не смешал новый index.html со старыми модулями из кэша.
let page = await readFile(join(output, 'index.html'), 'utf8');
for (const asset of assets.filter(path => path.startsWith('src/'))) {
  const hash = createHash('sha256').update(await readFile(join(output, asset))).digest('hex').slice(0, 10);
  const reference = `'./${asset}'`;
  if (!page.includes(reference)) throw new Error(`index.html does not import ${asset}`);
  page = page.replaceAll(reference, `'./${asset}?v=${hash}'`);
}
await writeFile(join(output, 'index.html'), page);

const rootFiles = await readdir(output);
const sourceFiles = await readdir(join(output, 'src'));
if (rootFiles.join(',') !== 'index.html,src' || sourceFiles.sort().join(',') !== 'collision.js,model.js,wires-format.js') {
  throw new Error(`unexpected static output: ${rootFiles.join(',')} / ${sourceFiles.join(',')}`);
}
console.log(`Built ${assets.length} static assets in ${output}`);
