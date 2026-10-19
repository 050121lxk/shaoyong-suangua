export const UPSTREAM = 'https://api.ccode.vip/v1/chat/completions';
export const MODEL = 'deepseek-v4.1-flash-1017-g';
export const MAX_BODY = 8 * 1024 * 1024;

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
    if (typeof content === 'string' && content.trim() && content.length <= 24000) return { role, content };
    if (role !== 'user' || !Array.isArray(content) || content.length !== 2) throw new Error('content');
    const [text, image] = content;
    if (text?.type !== 'text' || typeof text.text !== 'string' || !text.text.trim() || text.text.length > 24000) throw new Error('text');
    const data = image?.image_url?.url;
    if (image?.type !== 'image_url' || typeof data !== 'string' || data.length > 1800000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('image');
    return { role, content: [{ type: 'text', text: text.text }, { type: 'image_url', image_url: { url: data } }] };
  });
}

// Dependency injection enables tests without secrets, live auth, or paid API requests.
export function createHandler({ env, rules, fetcher = fetch }) {
  const origins = (env('ALLOWED_ORIGINS') || '').split(',').map(v => v.trim()).filter(Boolean);
  return async request => {
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
      const eligible = user.email_confirmed_at && providers.some(p => p === 'github' || p === 'email') && !user.user_metadata?.is_anonymous;
      if (!user.id || !eligible || user.is_anonymous || (user.banned_until && Date.parse(user.banned_until) > Date.now())) return reply(403, { error: 'verified_login_required' });
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
      const quotaResponse = await fetcher(`${supabase}/rest/v1/rpc/free_quota`, {
        method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_user: user.id, p_consume: body.action === 'chat' }),
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!quotaResponse.ok) return reply(503, { error: 'quota_unavailable' });
      const quota = JSON.parse(await readLimited(quotaResponse, 16000));
      if (!Number.isInteger(quota.used) || quota.used < 0 || quota.used > 5 || quota.limit !== 5 ||
          typeof quota.allowed !== 'boolean' || typeof quota.global_available !== 'boolean') return reply(503, { error: 'quota_unavailable' });
      if (body.action === 'quota') return reply(200, { quota, model: MODEL, upstream: UPSTREAM });
      if (!quota.allowed) return reply(429, { error: quota.reason || 'quota_exhausted', quota });

      // Consumption is committed BEFORE the paid call. Network failures still cost one slot.
      try {
        const upstream = await fetcher(UPSTREAM, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstreamKey}` },
          body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: rules + '\n网页免费版每用户每天仅五次发送。请将必要追问集中在一轮内（不要为凑次数省略依据），信息足够则及时给结论与可核对卦象；不要保证五轮内一定能断清。' }, ...messages], max_tokens: 4096, stream: false }),
          // Leave headroom for auth/RPC and the hosted free plan's 150s idle limit.
          redirect: 'error', signal: AbortSignal.timeout(115000),
        });
        if (!upstream.ok) {
          await upstream.body?.cancel();
          return reply(502, { error: 'upstream_failed', quota });
        }
        const data = JSON.parse(await readLimited(upstream, 600000));
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim() || content.length > 24000) return reply(502, { error: 'invalid_upstream_reply', quota });
        // Do not return raw upstream JSON/errors; they may reflect credentials.
        if (content.includes(upstreamKey) || content.includes(serviceKey)) return reply(502, { error: 'invalid_upstream_reply', quota });
        return reply(200, { content, truncated: data.choices?.[0]?.finish_reason === 'length', quota });
      } catch { return reply(502, { error: 'upstream_unavailable', quota }); }
    } catch { return reply(503, { error: 'service_unavailable' }); }
  };
}
