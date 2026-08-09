import {access, copyFile, mkdir, readdir, rm} from 'node:fs/promises';
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

const rootFiles = await readdir(output);
const sourceFiles = await readdir(join(output, 'src'));
if (rootFiles.join(',') !== 'index.html,src' || sourceFiles.sort().join(',') !== 'collision.js,model.js,wires-format.js') {
  throw new Error(`unexpected static output: ${rootFiles.join(',')} / ${sourceFiles.join(',')}`);
}
console.log(`Built ${assets.length} static assets in ${output}`);
