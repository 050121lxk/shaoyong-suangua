import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler, UPSTREAM, MODEL, validateMessages, readLimited } from '../supabase/functions/_shared/handler.mjs';

const origin = 'https://test.example';
const settings = { ALLOWED_ORIGINS: origin, SUPABASE_URL: 'https://project.example',
  SUPABASE_ANON_KEY: 'public-anon', SUPABASE_SERVICE_ROLE_KEY: 'private-service-key-test',
  UPSTREAM_API_KEY: 'private-upstream-key-test', FREE_SERVICE_ENABLED: 'true' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const req = (body = { action: 'chat', messages: [{ role: 'user', content: '问题' }] }, extra = {}) => new Request('https://project.example/functions/v1/free-chat', {
  method: 'POST', headers: { Origin: origin, Authorization: 'Bearer valid-test-token', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
});
function fixture({ used = 0, global = 0, upstreamStatus = 200, confirmed = true, failQuota = false,
  content = '模型正文', finishReason = 'stop', outputLimit } = {}) {
  const calls = [];
  const state = { used, global };
  const handler = createHandler({ env: k => k === 'FREE_MAX_OUTPUT_TOKENS' ? outputLimit : settings[k], rules: 'SERVER FULL RULES', fetcher: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/v1/user')) return json({ id: 'server-user-id', email_confirmed_at: confirmed ? '2026-01-01' : null, app_metadata: { providers: ['email'] } });
    if (url.endsWith('/rpc/free_quota')) {
      if (failQuota) return json({}, 500);
      const body = JSON.parse(init.body);
      assert.equal(body.p_user, 'server-user-id');
      const allowed = state.used < 5 && state.global < 100;
      if (allowed && body.p_consume) { state.used++; state.global++; }
      return json({ allowed, used: state.used, limit: 5, global_available: state.global < 100, global_remaining: 100 - state.global,
        ...(!allowed ? { reason: state.used >= 5 ? 'user_limit' : 'global_limit' } : {}) });
    }
    assert.equal(url, UPSTREAM);
    if (upstreamStatus !== 200) return json({ secret: settings.UPSTREAM_API_KEY }, upstreamStatus);
    return json({ choices: [{ message: { content }, finish_reason: finishReason }] });
  } });
  return { handler, state, calls };
}

test('no login or invalid origin cannot consume or reach upstream', async () => {
  const { handler, calls } = fixture();
  assert.equal((await handler(req(undefined, { Authorization: '' }))).status, 401);
  assert.equal((await handler(req(undefined, { Origin: 'https://evil.example' }))).status, 403);
  assert.equal(calls.length, 0);
});
test('server id, fixed model, fixed URL, full rules and output cap override caller', async () => {
  const { handler, calls, state } = fixture();
  const response = await handler(req({ action: 'chat', user_id: 'attacker', model: 'expensive', url: 'https://evil.example', max_tokens: 999999,
    messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(response.status, 200);
  assert.equal(state.used, 1);
  const paid = calls.at(-1);
  assert.equal(paid.url, UPSTREAM);
  const body = JSON.parse(paid.init.body);
  assert.equal(body.model, MODEL); assert.equal(body.max_tokens, 32768);
  assert.ok(body.messages[0].content.startsWith('SERVER FULL RULES'));
  assert.equal(paid.init.redirect, 'error');
  const text = await response.text();
  assert.ok(!text.includes(settings.UPSTREAM_API_KEY));
  assert.ok(!text.includes(settings.SUPABASE_SERVICE_ROLE_KEY));
});
test('long free replies are returned intact and can be included in a follow-up', async () => {
  // Includes multibyte text and JSON escaping; exceeds the old 24K character check.
  const content = '卦象依据\n"阴阳"\\'.repeat(15000);
  const f = fixture({ content });
  const response = await f.handler(req());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.content, content);
  assert.equal(body.truncated, false);
  const messages = [{ role: 'user', content: '问题' }, { role: 'assistant', content }, { role: 'user', content: '继续' }];
  assert.deepEqual(validateMessages(messages), messages);
  assert.equal((await f.handler(req({ action: 'chat', messages }))).status, 200);
  assert.throws(() => validateMessages([{ role: 'user', content: '字'.repeat(24001) }]));
});
test('only server configuration can adjust output budget; invalid settings use safe default', async () => {
  for (const [outputLimit, expected] of [['16384', 16384], ['65536', 65536], ['', 32768], ['bad', 32768], ['0', 32768], ['999999', 32768], ['1.5', 32768]]) {
    const f = fixture({ outputLimit });
    assert.equal((await f.handler(req())).status, 200);
    assert.equal(JSON.parse(f.calls.at(-1).init.body).max_tokens, expected);
  }
});
test('provider length finish is reported without slicing content or automatic paid retries', async () => {
  const f = fixture({ content: '尚未结束的正文', finishReason: 'length' });
  const body = await (await f.handler(req())).json();
  assert.equal(body.content, '尚未结束的正文');
  assert.equal(body.truncated, true);
  assert.equal(body.max_output_tokens, 32768);
  assert.equal(f.calls.filter(c => c.url === UPSTREAM).length, 1);
});
test('larger output budget retains response resource limits and secret-reflection protection', async () => {
  for (const content of ['字'.repeat(300001), settings.UPSTREAM_API_KEY, settings.SUPABASE_SERVICE_ROLE_KEY]) {
    const f = fixture({ content });
    const response = await f.handler(req());
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'invalid_upstream_reply');
    assert.equal(body.content, undefined);
    assert.equal(f.state.used, 1);
  }
});
test('sixth request blocked; separate global daily cap blocks paid call', async () => {
  const f = fixture({ used: 4 });
  assert.equal((await f.handler(req())).status, 200);
  assert.equal((await f.handler(req())).status, 429);
  assert.equal(f.calls.filter(c => c.url === UPSTREAM).length, 1);
  const g = fixture({ global: 100 });
  assert.equal((await g.handler(req())).status, 429);
  assert.equal(g.calls.filter(c => c.url === UPSTREAM).length, 0);
});
test('upstream failure counts, raw provider error is never returned', async () => {
  const f = fixture({ upstreamStatus: 500 });
  const response = await f.handler(req());
  assert.equal(response.status, 502);
  assert.equal(f.state.used, 1);
  assert.ok(!(await response.text()).includes(settings.UPSTREAM_API_KEY));
});
test('quota display does not consume; verified login and database fail closed', async () => {
  const f = fixture({ global: 37 });
  const quotaReply = await f.handler(req({ action: 'quota' }));
  assert.equal(quotaReply.status, 200);
  assert.equal((await quotaReply.json()).quota.global_remaining, 63);
  assert.equal(f.state.used, 0);
  assert.equal((await fixture({ confirmed: false }).handler(req())).status, 403);
  const broken = fixture({ failQuota: true });
  assert.equal((await broken.handler(req())).status, 503);
  assert.equal(broken.calls.filter(c => c.url === UPSTREAM).length, 0);
});
test('reject client system roles, arbitrary images, oversized history; sanitize accepted input', () => {
  for (const input of [[], [{ role: 'system', content: 'bypass' }], [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
    [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'https://internal.example/' } }] }]]) {
    assert.throws(() => validateMessages(input));
  }
  assert.deepEqual(validateMessages([{ role: 'user', content: 'x', tool_calls: ['bad'] }]), [{ role: 'user', content: 'x' }]);
});
test('request/response bounded reader rejects chunked oversize', async () => {
  await assert.rejects(readLimited(new Response('123456'), 5), /too_large/);
});
test('disabled service fails closed and never contacts auth/provider', async () => {
  const handler = createHandler({ env: k => k === 'FREE_SERVICE_ENABLED' ? 'false' : settings[k], rules: 'rules', fetcher: () => { throw new Error('must not call'); } });
  assert.equal((await handler(req())).status, 503);
});
test('concurrent handler requests preserve a shared quota reservation result before upstream', async () => {
  // The fixture serializes updates. Real cross-connection lock testing remains a deployment check.
  const f = fixture({ used: 4 });
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.handler(req())));
  assert.equal(replies.filter(r => r.status === 200).length, 1);
  assert.equal(replies.filter(r => r.status === 429).length, 11);
  assert.equal(f.calls.filter(c => c.url === UPSTREAM).length, 1);
  assert.equal(f.state.used, 5);
});
test('SQL hard caps serialize in global→user order and revoke browser execution', () => {
  const sql = readFileSync(new URL('../supabase/migrations/202610170001_free_quota.sql', import.meta.url), 'utf8');
  assert.match(sql, /used between 0 and 100/); assert.match(sql, /used between 0 and 5/);
  assert.match(sql, /Asia\/Shanghai/);
  assert.ok(sql.indexOf('v_global from public.free_daily_global where day = v_day for update') < sql.indexOf('v_used, v_last from public.free_daily_users'));
  assert.match(sql, /revoke all on function public.free_quota\(uuid, boolean\) from public, anon, authenticated/);
});
