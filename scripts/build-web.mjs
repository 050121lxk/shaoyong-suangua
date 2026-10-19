import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '_site');
await mkdir(output, { recursive: true });
await cp(path.join(root, 'web'), output, { recursive: true });
await mkdir(path.join(output, 'vendor'), { recursive: true });
await mkdir(path.join(output, 'rules'), { recursive: true });
for (const file of ['SKILL.md', 'REFERENCE.md', 'EXAMPLES.md', 'YAO_CI.md']) {
  await cp(path.join(root, file), path.join(output, 'rules', file));
}
await cp(path.join(root, 'node_modules/lunar-javascript/lunar.js'), path.join(output, 'vendor/lunar.js'));
const license = await readFile(path.join(root, 'node_modules/lunar-javascript/LICENSE'), 'utf8');
await writeFile(path.join(output, 'vendor/LICENSE-lunar-javascript.txt'), license);
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Built _site/ with current repository rules and lunar-javascript 1.7.7 (MIT).');
