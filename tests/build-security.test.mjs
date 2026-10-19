import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
test('web build ships public config only and excludes backend, tests and source maps', async () => {
  const upstream = 'test-never-publish-UPSTREAM-secret';
  const service = 'test-never-publish-SERVICE-secret';
  execFileSync(process.execPath, ['scripts/build-web.mjs'], { cwd: root, stdio: 'pipe', env: {
    ...process.env, SUPABASE_URL: '', SUPABASE_ANON_KEY: '', FREE_CHAT_URL: '', ALLOWED_ORIGIN: '', TURNSTILE_SITE_KEY: '',
    UPSTREAM_API_KEY: upstream, SUPABASE_SERVICE_ROLE_KEY: service,
  } });
  const files = await readdir(new URL('../_site/', import.meta.url), { recursive: true });
  for (const file of files) {
    assert.ok(!/mock|handler|\.map$|\.test\.|rules\.json|auth\.mjs|config\.example/.test(file), file);
    if (!/\.(mjs|js|json|html|css|md)$/.test(file)) continue;
    const text = await readFile(new URL('../_site/' + file.replaceAll('\\', '/'), import.meta.url), 'utf8');
    assert.ok(!text.includes(upstream), file); assert.ok(!text.includes(service), file);
  }
  const config = await readFile(new URL('../_site/config.js', import.meta.url), 'utf8');
  assert.ok(!config.includes('SERVICE_ROLE') && !config.includes('UPSTREAM_API_KEY'));
  const publicKey = 'sb_publishable_test-browser-key';
  execFileSync(process.execPath, ['scripts/build-web.mjs'], { cwd: root, stdio: 'pipe', env: {
    ...process.env, SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_ANON_KEY: publicKey,
    FREE_CHAT_URL: 'https://test-project.supabase.co/functions/v1/free-chat', ALLOWED_ORIGIN: 'https://example.com',
    TURNSTILE_SITE_KEY: '', UPSTREAM_API_KEY: upstream, SUPABASE_SERVICE_ROLE_KEY: service,
  } });
  const publicConfig = await readFile(new URL('../_site/config.js', import.meta.url), 'utf8');
  assert.ok(publicConfig.includes(publicKey));
  assert.ok(!publicConfig.includes(upstream) && !publicConfig.includes(service));
  for (const key of ['sb_secret_not-public', `head.${Buffer.from('{"role":"service_role"}').toString('base64url')}.sig`]) {
    assert.throws(() => execFileSync(process.execPath, ['scripts/build-web.mjs'], { cwd: root,
      env: { ...process.env, SUPABASE_ANON_KEY: key }, stdio: 'pipe' }));
  }
  // Restore a usable, unconfigured local build after negative tests.
  execFileSync(process.execPath, ['scripts/build-web.mjs'], { cwd: root, stdio: 'pipe', env: {
    ...process.env, SUPABASE_URL: '', SUPABASE_ANON_KEY: '', FREE_CHAT_URL: '', ALLOWED_ORIGIN: '', TURNSTILE_SITE_KEY: '',
  } });
});
