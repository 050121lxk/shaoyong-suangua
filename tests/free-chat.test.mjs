import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler, UPSTREAM, MODEL, validateMessages, readLimited } from '../supabase/functions/_shared/handler.mjs';
import { sseData, streamDelta } from '../supabase/functions/_shared/sse.mjs';

const origin = 'https://test.example';
const settings = { ALLOWED_ORIGINS: origin, SUPABASE_URL: 'https://project.example',
  SUPABASE_ANON_KEY: 'public-anon', SUPABASE_SERVICE_ROLE_KEY: 'private-service-key-test',
  UPSTREAM_API_KEY: 'private-upstream-key-test', FREE_SERVICE_ENABLED: 'true' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const req = (body = { action: 'chat', messages: [{ role: 'user', content: '问题' }] }, extra = {}) => new Request('https://project.example/functions/v1/free-chat', {
  method: 'POST', headers: { Origin: origin, Authorization: 'Bearer valid-test-token', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
});
function fixture({ used = 0, global = 0, upstreamStatus = 200, confirmed = true, failQuota = false,
  content = '模型正文', finishReason = 'stop', outputLimit, plainJson = false, upstreamChunks, deadlineMs } = {}) {
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
    if (plainJson) return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }), { headers: { 'content-type': 'application/json' } });
    return sse(upstreamChunks || [...chunk(content, 7).map(t => ({ choices: [{ delta: { content: t } }] })),
      { choices: [{ delta: {}, finish_reason: finishReason }] }], init.signal);
  }, ...(deadlineMs ? { deadlineMs } : {}) });
  return { handler, state, calls };
}
function chunk(text, size) {
  const parts = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}
// Upstream SSE with CRLF lines, split across arbitrary network chunk boundaries. `hang` simulates a stalled provider.
function sse(chunks, signal) {
  const encoded = new TextEncoder().encode(chunks.map(c => c === 'hang' ? '' : `data: ${JSON.stringify(c)}\r\n\r\n`).join('') + (chunks.includes('hang') ? '' : 'data: [DONE]\r\n\r\n'));
  return new Response(new ReadableStream({
    async start(controller) {
      const step = encoded.length > 20000 ? 4093 : 13;
      for (let i = 0; i < encoded.length; i += step) controller.enqueue(encoded.slice(i, i + step));
      if (!chunks.includes('hang')) return controller.close();
      signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
async function events(response) {
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const list = [];
  for await (const data of sseData(response.body)) list.push(JSON.parse(data));
  return list;
}
const textOf = list => list.filter(e => e.type === 'delta').map(e => e.text).join('');

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
  assert.equal(body.model, MODEL); assert.equal(body.max_tokens, 32768); assert.equal(body.stream, true);
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
  const list = await events(response);
  assert.equal(list[0].type, 'start'); assert.equal(list[0].quota.used, 1);
  assert.equal(textOf(list), content);
  assert.deepEqual(list.at(-1), { type: 'done', truncated: false, interrupted: false, reason: 'stop' });
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
  const list = await events(await f.handler(req()));
  assert.equal(textOf(list), '尚未结束的正文');
  assert.equal(list.at(-1).truncated, true);
  assert.equal(list[0].max_output_tokens, 32768);
  assert.equal(f.calls.filter(c => c.url === UPSTREAM).length, 1);
});
test('secret reflections are never streamed, not even as a prefix split across chunks', async () => {
  for (const secret of [settings.UPSTREAM_API_KEY, settings.SUPABASE_SERVICE_ROLE_KEY]) {
    const f = fixture({ content: '前文'.repeat(30) + secret + '后文' });
    const list = await events(await f.handler(req()));
    const streamed = textOf(list);
    for (let n = 4; n <= secret.length; n++) assert.ok(!streamed.includes(secret.slice(0, n)), `prefix ${n} leaked`);
    assert.deepEqual(list.at(-1), { type: 'error', error: 'invalid_upstream_reply' });
    assert.equal(f.state.used, 1);
  }
});
test('oversized replies stop at the resource limit and are flagged truncated', async () => {
  const f = fixture({ content: '字'.repeat(300050) });
  const list = await events(await f.handler(req()));
  assert.equal(textOf(list).length, 300000);
  assert.equal(list.at(-1).truncated, true);
});
test('reasoning-only chunks become throttled keepalives, never visible text', async () => {
  const f = fixture({ upstreamChunks: [{ choices: [{ delta: { reasoning_content: '内部思考' } }] }, { choices: [{ delta: { reasoning_content: '更多' } }] },
    { choices: [{ delta: { content: '答案' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] });
  const list = await events(await f.handler(req()));
  assert.deepEqual(list.filter(e => e.type === 'thinking').length, 1);
  assert.equal(textOf(list), '答案');
  assert.ok(!JSON.stringify(list).includes('内部思考'));
});
test('providers that ignore stream:true and return plain JSON still work', async () => {
  const list = await events(await fixture({ plainJson: true, content: '整段正文' }).handler(req()));
  assert.equal(textOf(list), '整段正文');
  assert.equal(list.at(-1).type, 'done');
});
test('stalled upstream is cut at the deadline; partial text is kept and flagged, empty text is an error', async () => {
  const partial = fixture({ deadlineMs: 50, upstreamChunks: [{ choices: [{ delta: { content: '已输出部分' } }] }, 'hang'] });
  const list = await events(await partial.handler(req()));
  assert.equal(textOf(list), '已输出部分');
  assert.deepEqual(list.at(-1), { type: 'done', truncated: true, interrupted: false, reason: 'time_limit' });
  const empty = fixture({ deadlineMs: 50, upstreamChunks: ['hang'] });
  assert.deepEqual((await events(await empty.handler(req()))).at(-1), { type: 'error', error: 'time_limit' });
});
test('text is relayed while the upstream is still generating', async () => {
  const encoder = new TextEncoder();
  const settingsEnv = k => settings[k];
  const first = '第一段推演内容'.repeat(10);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = createHandler({ env: settingsEnv, rules: 'r', fetcher: async url => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'u', email_confirmed_at: 'x', app_metadata: { providers: ['github'] } });
    if (url.endsWith('/rpc/free_quota')) return json({ allowed: true, used: 1, limit: 5, global_available: true, global_remaining: 99 });
    return new Response(new ReadableStream({ async start(c) {
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: first } }] })}\n\n`));
      await gate;
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '第二段' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
      c.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const iterator = sseData((await handler(req())).body)[Symbol.asyncIterator]();
  assert.equal(JSON.parse((await iterator.next()).value).type, 'start');
  // Upstream is blocked here, yet the first text (minus the secret-check hold-back) already reached the client.
  const early = JSON.parse((await iterator.next()).value);
  assert.equal(early.type, 'delta');
  assert.ok(early.text.length > 0 && first.startsWith(early.text));
  release();
  const rest = [early];
  for (let r; !(r = await iterator.next()).done;) rest.push(JSON.parse(r.value));
  assert.equal(textOf(rest), first + '第二段');
  assert.equal(rest.at(-1).type, 'done');
});
test('client disconnect aborts the upstream request', async () => {
  const f = fixture({ upstreamChunks: [{ choices: [{ delta: { content: '开头' } }] }, 'hang'] });
  const response = await f.handler(req());
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(f.calls.at(-1).init.signal.aborted, true);
});
test('SSE parser handles CRLF, split chunks, multi-line data and array content', async () => {
  const bytes = new TextEncoder().encode('event: x\r\ndata: a\r\ndata: b\r\n\r\n: comment\n\ndata:c\n\n');
  const body = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
  const out = [];
  for await (const d of sseData(body)) out.push(d);
  assert.deepEqual(out, ['a\nb', 'c']);
  assert.equal(streamDelta({ choices: [{ delta: { content: [{ type: 'text', text: '甲' }, { type: 'image', x: 1 }] } }] }).text, '甲');
});
test('sixth request blocked; separate global daily cap blocks paid call', async () => {
  const f = fixture({ used: 4 });
  await events(await f.handler(req()));
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

test('guests use their own quota RPC keyed by a hashed client IP; raw IPs never leave the function', async () => {
  const calls = [];
  const state = { used: 0 };
  const handler = createHandler({ env: k => settings[k], rules: 'r', fetcher: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/v1/user')) return json({ id: 'guest-id', is_anonymous: true, app_metadata: { providers: ['anonymous'] } });
    if (url.endsWith('/rpc/guest_quota')) {
      const body = JSON.parse(init.body);
      assert.equal(body.p_user, 'guest-id');
      assert.match(body.p_ip_hash, /^[0-9a-f]{64}$/);
      if (body.p_consume) state.used++;
      return json({ allowed: state.used <= 3, used: state.used, limit: 3, global_available: true, global_remaining: 100 - state.used });
    }
    assert.notEqual(true, url.endsWith('/rpc/free_quota'), 'guests must not touch the signed-in pool');
    return sse([{ choices: [{ delta: { content: '游客回答' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
  } });
  const ipHeaders = { 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' };
  const quota = await (await handler(req({ action: 'quota' }, ipHeaders))).json();
  assert.equal(quota.quota.limit, 3); assert.equal(quota.quota.guest, true);
  const list = await events(await handler(req(undefined, ipHeaders)));
  assert.equal(textOf(list), '游客回答');
  const rpc = calls.filter(c => c.url.endsWith('/rpc/guest_quota')).map(c => c.init.body).join('');
  assert.ok(!rpc.includes('203.0.113.9'), 'raw IP is not sent to the database');
  // Same /64 IPv6 network → same hash; different IPv4 → different hash.
  const hashes = [];
  for (const ip of ['2001:db8:1:2::a', '2001:db8:1:2::b', '198.51.100.1']) {
    await handler(req({ action: 'quota' }, { 'CF-Connecting-IP': ip }));
    hashes.push(JSON.parse(calls.filter(c => c.url.endsWith('/rpc/guest_quota')).at(-1).init.body).p_ip_hash);
  }
  assert.equal(hashes[0], hashes[1]); assert.notEqual(hashes[0], hashes[2]);
  // No usable client IP → guests are refused before any quota or paid call.
  const before = calls.length;
  const denied = await handler(req(undefined, { 'CF-Connecting-IP': 'not-an-ip' }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'guest_unavailable');
  assert.ok(calls.slice(before).every(c => c.url.endsWith('/auth/v1/user')));
});
test('a signed-in quota claiming the guest limit (or vice versa) is rejected as malformed', async () => {
  const handler = createHandler({ env: k => settings[k], rules: 'r', fetcher: async url => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'u', email_confirmed_at: 'x', app_metadata: { providers: ['github'] } });
    return json({ allowed: true, used: 0, limit: 3, global_available: true, global_remaining: 100 });
  } });
  assert.equal((await handler(req({ action: 'quota' }))).status, 503);
});
