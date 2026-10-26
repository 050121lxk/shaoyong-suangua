import { completionChunks, streamDelta } from './sse.mjs';

export const UPSTREAM = 'https://api.ccode.vip/v1/chat/completions';
// Total budget per request; hosted free plan wall clock is 150s.
export const REQUEST_DEADLINE_MS = 140000;
export const USER_DAILY_LIMIT = 5;
export const GUEST_DAILY_LIMIT = 3;

// Client IP as set by the platform edge (Cloudflare). Callers cannot override CF-Connecting-IP
// (Cloudflare rejects it), and a caller-supplied X-Forwarded-For is replaced, so take its first entry only as fallback.
// Stored only as an HMAC so the database never holds raw addresses.
export async function clientIpHash(request, secret) {
  const ip = (request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0]).trim();
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return null;
  // IPv6: one household/phone usually owns a whole /64, so count the /64 as one network.
  const network = ip.includes(':') ? ip.toLowerCase().split(':').slice(0, 4).join(':') + '::/64' : ip;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('guest-ip:' + network));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const MODEL = 'deepseek-v4.1-flash-1017';
export const MAX_BODY = 8 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
// Resource guard, not a display slice; leave room for long ASCII/CJK completions.
export const MAX_REPLY_CHARS = 300000;

export function outputTokenLimit(value) {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 4096 && parsed <= 65536 ? parsed : DEFAULT_MAX_OUTPUT_TOKENS;
}

export async function readLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 9 || messages.length % 2 !== 1) throw new Error('messages');
  return messages.map((message, index) => {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    if (message?.role !== role) throw new Error('role');
    const content = message.content;
    if (typeof content === 'string' && content.trim() && content.length <= (role === 'assistant' ? MAX_REPLY_CHARS : 24000)) return { role, content };
    if (role !== 'user' || !Array.isArray(content) || content.length !== 2) throw new Error('content');
    const [text, image] = content;
    if (text?.type !== 'text' || typeof text.text !== 'string' || !text.text.trim() || text.text.length > 24000) throw new Error('text');
    const data = image?.image_url?.url;
    if (image?.type !== 'image_url' || typeof data !== 'string' || data.length > 1800000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('image');
    return { role, content: [{ type: 'text', text: text.text }, { type: 'image_url', image_url: { url: data } }] };
  });
}

// Dependency injection enables tests without secrets, live auth, or paid API requests.
export function createHandler({ env, rules, fetcher = fetch, deadlineMs = REQUEST_DEADLINE_MS }) {
  const origins = (env('ALLOWED_ORIGINS') || '').split(',').map(v => v.trim()).filter(Boolean);
  const maxOutputTokens = outputTokenLimit(env('FREE_MAX_OUTPUT_TOKENS'));
  return async request => {
    const started = Date.now();
    const origin = request.headers.get('origin');
    const cors = { 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (origin && origins.includes(origin)) Object.assign(cors, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    });
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
    if (!origin || !origins.includes(origin)) return reply(403, { error: 'origin_denied' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    const supabase = env('SUPABASE_URL');
    const publicKey = env('SUPABASE_ANON_KEY');
    const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
    const upstreamKey = env('UPSTREAM_API_KEY');
    if (!supabase || !publicKey || !serviceKey || !upstreamKey || env('FREE_SERVICE_ENABLED') !== 'true') return reply(503, { error: 'service_unavailable' });
    const bearer = request.headers.get('authorization') || '';
    if (!/^Bearer [A-Za-z0-9._-]+$/.test(bearer) || bearer.length > 12000) return reply(401, { error: 'login_required' });
    if (!(request.headers.get('content-type') || '').startsWith('application/json')) return reply(415, { error: 'json_required' });
    try {
      const auth = await fetcher(`${supabase}/auth/v1/user`, {
        headers: { apikey: publicKey, Authorization: bearer }, redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!auth.ok) return reply(401, { error: 'session_expired' });
      const user = JSON.parse(await readLimited(auth, 128000));
      const providers = Array.isArray(user.app_metadata?.providers) ? user.app_metadata.providers : [];
      // Guests (Supabase anonymous sign-in) get their own, smaller pool; everyone else needs a verified login.
      const guest = user.is_anonymous === true;
      const verified = !guest && user.email_confirmed_at && providers.some(p => p === 'github' || p === 'email') && !user.user_metadata?.is_anonymous;
      if (!user.id || !(guest || verified) || (user.banned_until && Date.parse(user.banned_until) > Date.now())) return reply(403, { error: 'verified_login_required' });
      let ipHash;
      if (guest) {
        ipHash = await clientIpHash(request, serviceKey);
        if (!ipHash) return reply(403, { error: 'guest_unavailable' });
      }
      if (Number(request.headers.get('content-length')) > MAX_BODY) return reply(413, { error: 'request_too_large' });
      let body;
      try { body = JSON.parse(await readLimited(request, MAX_BODY)); }
      catch { return reply(400, { error: 'invalid_or_oversized_json' }); }
      if (!['quota', 'chat'].includes(body?.action)) return reply(400, { error: 'invalid_action' });
      let messages;
      if (body.action === 'chat') {
        try { messages = validateMessages(body.messages); }
        catch { return reply(400, { error: 'invalid_messages' }); }
      }
      // The authenticated user id is NEVER read from the request body.
      const limit = guest ? GUEST_DAILY_LIMIT : USER_DAILY_LIMIT;
      const quotaResponse = await fetcher(`${supabase}/rest/v1/rpc/${guest ? 'guest_quota' : 'free_quota'}`, {
        method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_user: user.id, ...(guest ? { p_ip_hash: ipHash } : {}), p_consume: body.action === 'chat' }),
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!quotaResponse.ok) return reply(503, { error: 'quota_unavailable' });
      const quota = { ...JSON.parse(await readLimited(quotaResponse, 16000)), guest };
      if (!Number.isInteger(quota.used) || quota.used < 0 || quota.used > limit || quota.limit !== limit ||
          typeof quota.allowed !== 'boolean' || typeof quota.global_available !== 'boolean' ||
          !Number.isInteger(quota.global_remaining) || quota.global_remaining < 0 || quota.global_remaining > 100) return reply(503, { error: 'quota_unavailable' });
      if (body.action === 'quota') return reply(200, { quota, model: MODEL, upstream: UPSTREAM });
      if (!quota.allowed) return reply(429, { error: quota.reason || 'quota_exhausted', quota });

      // Consumption is committed BEFORE the paid call. Network failures still cost one slot.
      const upstreamAbort = new AbortController();
      // The hosted free plan stops a worker after 150s wall clock; finish the stream before that.
      const deadline = setTimeout(() => upstreamAbort.abort('deadline'), Math.max(1, deadlineMs - (Date.now() - started)));
      request.signal?.addEventListener('abort', () => upstreamAbort.abort('client'), { once: true });
      let upstream;
      try {
        upstream = await fetcher(UPSTREAM, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${upstreamKey}` },
          body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: rules + '\n网页免费版发送次数有限（登录用户每天五次、游客每天三次）。每一轮都直接给出完整断语与可核对卦象，不向用户提问；用户之后主动反馈再在原卦局上拟合。' }, ...messages], max_tokens: maxOutputTokens, stream: true }),
          redirect: 'error', signal: upstreamAbort.signal,
        });
      } catch { clearTimeout(deadline); return reply(502, { error: 'upstream_unavailable', quota }); }
      if (!upstream.ok) {
        clearTimeout(deadline);
        await upstream.body?.cancel();
        return reply(502, { error: 'upstream_failed', quota });
      }
      return new Response(relay(upstream, { quota, maxOutputTokens, secrets: [upstreamKey, serviceKey], upstreamAbort, deadline }), {
        status: 200, headers: { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' },
      });
    } catch { return reply(503, { error: 'service_unavailable' }); }
  };
}

// Re-emits only visible text as our own SSE events; raw upstream JSON never reaches the browser.
function relay(upstream, { quota, maxOutputTokens, secrets, upstreamAbort, deadline }) {
  const encoder = new TextEncoder();
  // Hold back enough characters that no prefix of a secret is ever flushed before the full check.
  const holdBack = Math.max(...secrets.map(s => s.length)) - 1;
  let iterator;
  return new ReadableStream({
    async start(stream) {
      const send = event => stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      send({ type: 'start', quota, max_output_tokens: maxOutputTokens });
      let content = '', flushed = 0, checked = 0, finish = null, lastPing = 0, lastFlush = 0, failed = null;
      const flush = final => {
        // A new occurrence must end in the unchecked tail, so scan only that window (keeps CPU linear).
        const window = content.slice(Math.max(0, checked - holdBack));
        checked = content.length;
        if (secrets.some(secret => window.includes(secret))) throw new Error('reflected_secret');
        const end = final ? content.length : Math.max(flushed, content.length - holdBack);
        if (end > flushed) { send({ type: 'delta', text: content.slice(flushed, end) }); flushed = end; }
      };
      try {
        iterator = completionChunks(upstream, 8 * 1024 * 1024);
        for await (const chunk of iterator) {
          const part = streamDelta(chunk);
          finish = part.finish || finish;
          if (part.text) {
            content += part.text;
            if (content.length > MAX_REPLY_CHARS) { content = content.slice(0, MAX_REPLY_CHARS); finish = 'length'; break; }
            // Coalesce token-sized chunks: fewer writes keeps Edge CPU time well under its 2s limit.
            if (Date.now() - lastFlush >= 50) { lastFlush = Date.now(); flush(false); }
          } else if (part.reasoning && Date.now() - lastPing > 1500) {
            lastPing = Date.now();
            send({ type: 'thinking' });
          }
        }
      } catch (error) {
        failed = error?.message === 'reflected_secret' ? 'invalid_upstream_reply'
          : upstreamAbort.signal.reason === 'deadline' ? 'time_limit' : 'upstream_unavailable';
      } finally {
        clearTimeout(deadline);
      }
      try {
        if (failed === 'invalid_upstream_reply') send({ type: 'error', error: failed });
        else if (!content.trim()) send({ type: 'error', error: failed === 'time_limit' ? 'time_limit' : failed || 'invalid_upstream_reply' });
        else {
          flush(true);
          send({ type: 'done', truncated: finish === 'length' || failed === 'time_limit', interrupted: failed === 'upstream_unavailable', reason: failed || finish });
        }
      } catch { send({ type: 'error', error: 'invalid_upstream_reply' }); }
      stream.close();
    },
    cancel() {
      clearTimeout(deadline);
      upstreamAbort.abort('client');
      void iterator?.return?.();
    },
  });
}
