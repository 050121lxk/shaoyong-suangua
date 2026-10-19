import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { env } from 'node:process';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '_site');
// _site is exclusively generated; do not publish old test fixtures or stale files.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'style.css']) await cp(path.join(root, 'web', file), path.join(output, file));
// Public Supabase browser settings only; service-role/upstream secrets are never read here.
const browserConfig = {
  SUPABASE_URL: env.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY || '',
  FREE_CHAT_URL: env.FREE_CHAT_URL || '',
  ALLOWED_ORIGIN: env.ALLOWED_ORIGIN || '',
  TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY || '',
};
if (/^sb_secret_/.test(browserConfig.SUPABASE_ANON_KEY)) throw new Error('Refusing to publish a Supabase secret key. Use anon/publishable key only.');
try {
  const claims = JSON.parse(Buffer.from(browserConfig.SUPABASE_ANON_KEY.split('.')[1] || '', 'base64url').toString());
  if (claims.role && claims.role !== 'anon') throw new Error('nonpublic_key');
} catch (error) {
  if (error.message === 'nonpublic_key') throw new Error('Refusing to publish a non-anon JWT.');
}
await writeFile(path.join(output, 'config.js'), `window.SHAOYONG_CONFIG = Object.freeze(${JSON.stringify(browserConfig)});\n`);
// Minification is distribution hygiene, NOT a secret-protection boundary.
await build({ entryPoints: [path.join(root, 'web/app.mjs')], outfile: path.join(output, 'app.mjs'),
  bundle: true, minify: true, sourcemap: false, platform: 'browser', format: 'esm', target: ['es2022'], legalComments: 'eof' });
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
