import { createClient } from '@supabase/supabase-js';

const $ = id => document.getElementById(id);
const config = globalThis.SHAOYONG_CONFIG || {};
const MODEL = 'deepseek-v4.1-flash-1017-g';
const UPSTREAM = 'https://api.ccode.vip/v1/chat/completions';
let client, session = null, quota = null, configured = false, authBusy = false, ready = false;
let otpEmail = '', widgetId;
const ERROR_TEXT = {
  login_required: '请先登录。', session_expired: '登录已过期，请重新登录。', verified_login_required: '请使用已验证的 GitHub 或邮箱账号。',
  user_limit: '你今天的 5 次已用完，请明天再来。', global_limit: '全站今天的 100 次已用完，请明天再来。',
  cooldown: '发送过快，请至少间隔 10 秒再试。', quota_exhausted: '今日免费次数已用完。',
  service_unavailable: '免费服务未开通或暂时不可用，请稍后再试，也可自带 Key。', quota_unavailable: '配额服务暂不可用，本次未发送给模型。',
  upstream_failed: '模型接口出错，本次已计入次数，请勿反复重试。', upstream_unavailable: '上游连接失败或超时，本次已计入次数。',
  invalid_upstream_reply: '模型没有返回有效正文，本次已计入次数。', invalid_messages: '本局内容过长或附图过大，请开始新一局或移除图片。',
  origin_denied: '此站点未被管理员授权使用免费服务。',
};

function changed() {
  $('auth-actions').hidden = !configured || !!session;
  $('signed-in').hidden = !session;
  if (session) $('auth-status').textContent = '已登录 · ' + (session.user.email || 'GitHub 用户');
  $('quota-status').textContent = quota ? `今日已用 ${quota.used} / 5 次${quota.global_available ? '' : ' · 全站额度已用完'}` : '配额尚未获取（不可发送）';
  window.dispatchEvent(new Event('free-auth-change'));
}

export const freeService = {
  get configured() { return configured; },
  get authenticated() { return !!session; },
  get ready() { return ready; },
  get allowed() { return configured && !!session && !!quota?.allowed && quota.used < 5 && quota.global_available; },
  get endpoint() { return config.FREE_CHAT_URL; },
  model: MODEL,
  upstream: UPSTREAM,
  clear() {
    // Drop the in-memory SDK session on page exit without a server-wide logout.
    session = null; quota = null;
    void client?.auth.stopAutoRefresh();
    void client?.auth.signOut({ scope: 'local' });
    changed();
  },
  async request(action, messages, signal) {
    if (!client || !session) throw new Error('请先登录免费服务。');
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) throw new Error('登录已过期，请重新登录。');
    const response = await fetch(config.FREE_CHAT_URL, {
      method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { 'Content-Type': 'application/json', apikey: config.SUPABASE_ANON_KEY, Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ action, ...(action === 'chat' ? { messages } : {}) }),
    });
    let body;
    try { body = await response.json(); } catch { throw new Error('免费服务返回格式异常。'); }
    if (body.quota) { quota = body.quota; changed(); }
    if (!response.ok) throw new Error(ERROR_TEXT[body.error] || `免费服务请求失败（HTTP ${response.status}）。`);
    return body;
  },
  async refreshQuota() {
    let notice;
    try { await this.request('quota', undefined, AbortSignal.timeout(15000)); }
    catch (error) { quota = null; notice = error instanceof TypeError ? '无法连接免费服务，请检查网络或后端跨域配置。' : error.message; }
    changed();
    if (notice) authNotice(notice);
  },
};

function authNotice(text) { $('auth-status').textContent = text; }

async function captcha() {
  if (!config.TURNSTILE_SITE_KEY) return;
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.onload = () => {
    widgetId = window.turnstile.render($('captcha-widget'), {
      sitekey: config.TURNSTILE_SITE_KEY,
      size: 'flexible',
      callback: token => { $('captcha-token').value = token; },
      'expired-callback': () => { $('captcha-token').value = ''; },
      'error-callback': () => { $('captcha-token').value = ''; },
    });
  };
  script.onerror = () => authNotice('人机验证无法加载，可尝试 GitHub 登录。');
  document.head.append(script);
}

export async function initAuth() {
  try {
    const url = new URL(config.SUPABASE_URL);
    const edge = new URL(config.FREE_CHAT_URL);
    if (url.protocol !== 'https:' || edge.origin !== url.origin || edge.pathname !== '/functions/v1/free-chat' ||
        edge.search || edge.hash || edge.username || !config.SUPABASE_ANON_KEY || config.ALLOWED_ORIGIN !== location.origin) throw new Error('config');
    client = createClient(url.href, config.SUPABASE_ANON_KEY, { auth: {
      persistSession: false, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit',
    } });
    configured = true;
    if (!config.TURNSTILE_SITE_KEY) {
      $('email-login').disabled = true;
      $('email-form').querySelector('.field-help').textContent = '邮箱登录暂未开放（待配置邮件服务和人机验证），请先使用 GitHub 登录。';
    }
    client.auth.onAuthStateChange((_event, value) => {
      session = value; quota = null; changed();
      // Never await auth methods from this callback (SDK lock).
      if (session) setTimeout(() => freeService.refreshQuota(), 0);
    });
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    session = data.session;
    if (!session) authNotice('登录后可免费发送，每日最多 5 次。');
    if (session) await freeService.refreshQuota();
    await captcha();
  } catch {
    configured = false;
    authNotice('免费服务尚未配置。管理员完成 Supabase 部署后开放；当前可选择「自带 API Key」。');
  }
  ready = true;
  if (!configured) $('service-mode').value = 'byok';
  changed();
}

$('github-login').addEventListener('click', async () => {
  if (!client || authBusy) return;
  authBusy = true;
  const redirectTo = location.origin + location.pathname;
  const { error } = await client.auth.signInWithOAuth({ provider: 'github', options: { redirectTo, scopes: 'read:user user:email' } });
  if (error) { authNotice('GitHub 登录失败，请检查管理员的 OAuth 和回调配置。'); authBusy = false; }
});
$('email-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!client || authBusy) return;
  const token = $('captcha-token').value;
  if (!config.TURNSTILE_SITE_KEY || !token) { authNotice('请先完成人机验证，或使用 GitHub 登录。'); return; }
  authBusy = true;
  $('email-login').disabled = true;
  otpEmail = $('login-email').value.trim();
  try {
    const { error } = await client.auth.signInWithOtp({ email: otpEmail, options: { shouldCreateUser: true, captchaToken: token } });
    if (error) throw error;
    $('otp-form').hidden = false;
    authNotice('如果此邮箱可以接收验证码，邮件将很快到达。请检查垃圾箱；60 秒内勿重复发送。');
  } catch { authNotice('验证码发送失败或请求受限。请稍后再试，或使用 GitHub 登录。'); }
  finally {
    authBusy = false;
    $('captcha-token').value = '';
    if (widgetId !== undefined) window.turnstile?.reset(widgetId);
    setTimeout(() => { $('email-login').disabled = false; }, 60000);
  }
});
$('otp-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!client || !otpEmail || authBusy) return;
  authBusy = true;
  try {
    const { error } = await client.auth.verifyOtp({ email: otpEmail, token: $('email-otp').value.trim(), type: 'email' });
    if (error) throw error;
    $('email-otp').value = ''; $('otp-form').hidden = true;
  } catch { authNotice('验证码无效或已过期，请检查后重试。'); }
  finally { authBusy = false; }
});
$('logout').addEventListener('click', async () => {
  if (!client) return;
  await client.auth.signOut({ scope: 'local' });
  session = null; quota = null; authNotice('已退出登录。'); changed();
});
$('refresh-quota').addEventListener('click', () => freeService.refreshQuota());
