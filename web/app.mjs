import { TRIGRAMS, beijingNow, timeInfo, timeHexagram, buildHexagram, hexagram,
  calendarText, boardText, normalizeEndpoint, assembleRules } from './core.mjs';
import { completionChunks, streamDelta } from '../supabase/functions/_shared/sse.mjs';
import { freeService, initAuth } from './auth.mjs';
import { createPet, runGuide, guideSeen } from './pet.mjs';

const $ = id => document.getElementById(id);
const files = ['SKILL.md', 'REFERENCE.md', 'EXAMPLES.md', 'YAO_CI.md'];
// No chunk for this long → treat the connection as stalled.
const IDLE_TIMEOUT_MS = 120000;
// `shown` = what the user typed each round (history's first message also carries the board text).
let rules = '', history = [], shown = [], lockedContext = null, busy = false, attachment = null;
let imageVersion = 0, imageLoading = false, controller = null, approvedDestination = '';
const dialog = $('consent-dialog');
const modeLabels = { time: '时间起卦', manual: '已有卦局', character: '测字', observation: '观物 / 其他' };
const isFree = () => $('service-mode').value === 'free';

for (const id of ['upper', 'lower']) {
  TRIGRAMS.slice(1).forEach((t, index) => {
    const option = document.createElement('option');
    option.value = index + 1;
    option.textContent = `${t[0]} · ${t[1]}`;
    $(id).append(option);
  });
}
$('upper').value = '7';
$('lower').value = '3';
$('casting-time').value = beijingNow();

function status(text, error = false) {
  $('request-status').textContent = text;
  $('request-status').classList.toggle('error', error);
}

function updateControls() {
  $('connection-fields').disabled = busy;
  $('casting-fields').disabled = busy || !!lockedContext;
  $('now').disabled = busy || !!lockedContext;
  $('forget-key').disabled = busy;
  $('send').disabled = busy || !rules || imageLoading || (isFree() && !freeService.allowed);
  $('service-mode').disabled = busy || !!lockedContext;
  $('free-panel').hidden = !isFree();
  $('byok-panel').hidden = isFree();
  ['github-login', 'logout', 'refresh-quota'].forEach(id => { $(id).disabled = busy; });
  $('pick-image').disabled = busy || imageLoading;
  $('remove-image').disabled = busy;
  $('question').disabled = busy;
  $('reset').disabled = busy;
  $('stop').hidden = !busy;
  $('messages').setAttribute('aria-busy', String(busy));
}
window.addEventListener('free-auth-change', updateControls);
$('service-mode').addEventListener('change', () => { approvedDestination = ''; updateControls(); });

async function loadRules() {
  rules = '';
  $('retry-rules').hidden = true;
  $('rule-status').textContent = '正在加载规则…';
  $('rule-dot').className = 'status-dot';
  updateControls();
  try {
    const docs = await Promise.all(files.map(async name => {
      const response = await fetch(`./rules/${name}`, { signal: AbortSignal.timeout(20000), credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error('规则加载失败');
      const text = await response.text();
      if (text.length < 100 || text.trimStart().startsWith('<!')) throw new Error('规则文件无效');
      return [name, text];
    }));
    rules = assembleRules(docs);
    $('rule-status').textContent = `规则已就绪 · 约 ${(rules.length / 10000).toFixed(1)} 万字符`;
    $('rule-dot').className = 'status-dot ready';
  } catch {
    $('rule-status').textContent = '规则加载失败，暂不可发送。';
    $('rule-dot').className = 'status-dot error';
    $('retry-rules').hidden = false;
  }
  updateControls();
}
$('retry-rules').addEventListener('click', loadRules);

function getContext() {
  if (!globalThis.Solar) throw new Error('本地历法库未加载，请刷新页面后重试。');
  const mode = $('casting-mode').value;
  const value = $('casting-time').value;
  const info = timeInfo(value, globalThis.Solar);
  let board = null;
  if (mode === 'time') board = timeHexagram(info);
  if (mode === 'manual') board = buildHexagram(Number($('upper').value), Number($('lower').value), Number($('moving').value));
  return { mode, value, info, board };
}

function drawHex(up, down, label, moving) {
  const wrapper = document.createElement('div');
  wrapper.className = 'hex-column';
  const heading = document.createElement('small');
  heading.textContent = label;
  const graphic = document.createElement('div');
  graphic.className = 'hex-lines';
  graphic.setAttribute('aria-hidden', 'true');
  const lines = [...TRIGRAMS[down][3], ...TRIGRAMS[up][3]];
  for (let i = 5; i >= 0; i--) {
    const line = document.createElement('div');
    line.className = `yao${moving === i + 1 ? ' moving' : ''}`;
    line.append(document.createElement('span'));
    if (!lines[i]) line.append(document.createElement('span'));
    graphic.append(line);
  }
  const name = document.createElement('div');
  name.textContent = hexagram(up, down);
  wrapper.append(heading, graphic, name);
  return wrapper;
}

function renderBoard() {
  $('manual-fields').hidden = $('casting-mode').value !== 'manual';
  const target = $('board');
  target.replaceChildren();
  try {
    const ctx = lockedContext || getContext();
    const title = document.createElement('p');
    title.className = 'board-title';
    title.textContent = `${modeLabels[ctx.mode]} · ${lockedContext ? '本局已固定' : '预览'}`;
    target.append(title);
    $('casting-chip').textContent = ctx.board
      ? `${hexagram(ctx.board.up, ctx.board.down)} · ${lockedContext ? '已固定' : '预览'}`
      : `${modeLabels[ctx.mode]} · ${lockedContext ? '已固定' : '预览'}`;
    $('casting-chip').classList.toggle('locked', !!lockedContext);
    if (ctx.board) {
      const b = ctx.board;
      const triples = document.createElement('div');
      triples.className = 'board-triples';
      triples.append(drawHex(b.up, b.down, `主 · ${b.moving}爻动`, b.moving),
        drawHex(b.huUp, b.huDown, '互'), drawHex(b.bUp, b.bDown, '变'));
      const meta = document.createElement('p');
      meta.className = 'board-meta';
      meta.textContent = `体${TRIGRAMS[b.ti][0]} · 用${TRIGRAMS[b.yong][0]} / ${ctx.info.yearGz} ${ctx.info.monthGz} ${ctx.info.dayGz} ${ctx.info.hourGz}`;
      target.append(triples, meta);
    } else {
      const text = document.createElement('div');
      text.className = 'calendar-only';
      text.textContent = calendarText(ctx.info) + '\n此方式不自动起卦，请在提问中描述字形或征兆。';
      target.append(text);
    }
  } catch (error) {
    target.textContent = error.message;
  }
}
['casting-mode', 'casting-time', 'upper', 'lower', 'moving'].forEach(id => $(id).addEventListener('change', renderBoard));
$('now').addEventListener('click', () => { $('casting-time').value = beijingNow(); renderBoard(); });

function contextText(ctx) {
  return `[本网页确定性历法 / 卦局，求问时刻 ${ctx.value.replace('T', ' ')} 北京时间；方式：${modeLabels[ctx.mode]}]\n` +
    (ctx.board ? boardText(ctx.board, ctx.info) : calendarText(ctx.info)) + '\n' +
    (ctx.mode === 'manual' ? '这是用户指定的卦局，必须沿用，不能重新起卦。若是后天卦，请用户说明路径。' :
      ctx.mode === 'time' ? '此为默认时间卦；若用户正文已给不同卦局，以用户给定为准，不重起。' :
        '本页没有自动起时间卦；请按用户给的字、征兆或已有信息依技能取卦，缺信息先问。');
}

const nearBottom = () => {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
};
const scrollToEnd = () => { $('messages').scrollTop = $('messages').scrollHeight; };

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers/contexts without the async Clipboard API.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

const LABELS = { user: '你', assistant: '观象', error: '未完成' };

function addMessage(role, text = '', image) {
  $('welcome').hidden = true;
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const label = document.createElement('div');
  label.className = 'message-label';
  const name = document.createElement('span');
  name.textContent = LABELS[role];
  label.append(name);
  const content = document.createElement('div');
  content.className = 'message-content';
  // Never interpret user/model text as HTML, links, or Markdown.
  content.textContent = text;
  let copy;
  if (role === 'assistant') {
    copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'text-button copy-button';
    copy.textContent = '复制';
    copy.setAttribute('aria-label', '复制这条回答');
    copy.addEventListener('click', async () => {
      const value = content.textContent;
      if (!value) return;
      const ok = await copyText(value);
      copy.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { copy.textContent = '复制'; }, 1500);
    });
    label.append(copy);
  }
  const body = document.createElement('div');
  body.className = 'message-body';
  body.append(label, content);
  if (image) {
    const img = document.createElement('img');
    img.className = 'message-image'; img.alt = '本次提交的图片'; img.src = image;
    body.append(img);
  }
  if (role !== 'user') {
    const avatar = document.createElement('img');
    avatar.className = 'avatar'; avatar.src = './assets/avatar.webp'; avatar.alt = ''; avatar.width = 40; avatar.height = 40;
    article.append(avatar);
  }
  article.append(body);
  $('messages').append(article);
  scrollToEnd();
  return { article, content, name, copy };
}

// Incremental renderer for one assistant reply; repaints at most once per frame.
function replyView() {
  const view = addMessage('assistant');
  view.article.classList.add('streaming', 'waiting');
  view.content.textContent = '正在连接…';
  view.copy.hidden = true;
  let text = '', frame = 0;
  const paint = () => {
    frame = 0;
    const follow = nearBottom();
    view.content.textContent = text;
    if (follow) scrollToEnd();
  };
  return {
    get text() { return text; },
    waiting(note) { if (!text) view.content.textContent = note; },
    append(piece) {
      if (!piece) return;
      if (!text) { view.article.classList.remove('waiting'); view.copy.hidden = false; }
      text += piece;
      if (!frame) frame = requestAnimationFrame(paint);
    },
    finish(note) {
      if (frame) cancelAnimationFrame(frame);
      paint();
      view.article.classList.remove('streaming', 'waiting');
      if (note) view.name.textContent = `观象 · ${note}`;
    },
    remove() {
      if (frame) cancelAnimationFrame(frame);
      view.article.remove();
    },
  };
}

function confirmDestination(endpoint, model) {
  const key = `${endpoint}\n${model}`;
  if (approvedDestination === key) return Promise.resolve(true);
  $('consent-endpoint').textContent = endpoint;
  $('consent-model').textContent = model;
  $('consent-details').hidden = isFree();
  $('consent-warning').hidden = isFree();
  $('consent-description').textContent = isFree()
    ? '免费体验由本站后端代为请求模型，你的问题、对话和附图会交给模型服务商处理。每次发送占用今日 1 次，失败也计次。本页只确认这一次。'
    : '你的 API Key 将直接发给下列接口，问题、完整规则、对话和附图将由该服务商处理。';
  return new Promise(resolve => {
    const onClose = () => {
      if (dialog.returnValue === 'confirm') approvedDestination = key;
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', onClose, { once: true });
    dialog.returnValue = '';
    dialog.showModal();
    $('consent-cancel').focus();
  });
}
$('consent-cancel').addEventListener('click', () => dialog.close('cancel'));
$('consent-confirm').addEventListener('click', () => dialog.close('confirm'));
$('forget-key').addEventListener('click', () => { $('api-key').value = ''; approvedDestination = ''; status('API Key 已从本页清除。'); });

const HTTP_ERRORS = {
  400: '请求格式、上下文长度或参数不被支持（部分接口不支持流式输出）。请检查模型和接口配置，必要时新开一局。',
  401: '认证失败，请检查 API Key。', 403: '接口拒绝访问，请检查密钥和模型权限。',
  404: '未找到接口或模型，请检查 Base URL 和模型 ID。',
  413: '请求过大，请减少附图或新开一局。', 429: '额度或速率受限，请检查余额与配额，稍后手动重试。',
};

// Free service: server events start → thinking / delta… → done (auth.mjs throws on error events).
async function streamFree(messages, view, signal, onActivity) {
  const stream = await freeService.request('chat', messages, signal);
  if (typeof stream?.[Symbol.asyncIterator] !== 'function') throw new Error('免费服务返回格式异常。');
  let result = { truncated: false, interrupted: false, budget: null };
  for await (const event of stream) {
    onActivity();
    if (event.type === 'start') { result.budget = event.max_output_tokens; view.waiting('模型正在推演…'); }
    else if (event.type === 'thinking') view.waiting('模型正在思考…');
    else if (event.type === 'delta' && typeof event.text === 'string') view.append(event.text);
    else if (event.type === 'done') result = { ...result, truncated: !!event.truncated, interrupted: !!event.interrupted };
  }
  return result;
}

// Bring-your-own-key: OpenAI-compatible SSE, or a plain JSON reply if the provider ignores stream.
async function streamByok(endpoint, apiKey, model, messages, view, signal, onActivity) {
  const response = await fetch(endpoint, {
    method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', Authorization: `Bearer ${apiKey}` },
    signal,
    body: JSON.stringify({ model, messages: [{ role: 'system', content: rules }, ...messages],
      max_tokens: Number($('max-tokens').value), stream: true }),
  });
  if (!response.ok) {
    // Do not display provider bodies: they can contain reflected secrets or untrusted HTML.
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}：${HTTP_ERRORS[response.status] || '服务商返回错误，请检查服务状态或接口兼容性。'}`);
  }
  view.waiting('模型正在推演…');
  let finish = null;
  try {
    for await (const chunk of completionChunks(response, 16 * 1024 * 1024)) {
      onActivity();
      if (chunk?.error) throw new Error('服务商在输出中途报错，请稍后重试。');
      const delta = streamDelta(chunk);
      if (delta.reasoning) view.waiting('模型正在思考…');
      view.append(delta.text);
      if (delta.finish) finish = delta.finish;
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('接口未返回有效数据，请确认这是 Chat Completions 接口。');
    if (error.message === 'too_large') throw new Error('接口回复过大，已停止接收。');
    throw error;
  }
  return { truncated: finish === 'length', interrupted: false, budget: null };
}

$('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !rules || imageLoading) return;
  const question = $('question').value.trim();
  if (!question) return;
  let endpoint, ctx;
  const free = isFree();
  const apiKey = $('api-key').value.trim();
  const model = $('model').value.trim();
  try {
    if (free) {
      if (!freeService.allowed) throw new Error('请先登录并确认今日仍有免费次数。');
      endpoint = freeService.endpoint;
    } else {
      endpoint = normalizeEndpoint($('base-url').value);
      if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('请填写有效的 API Key（不能含换行）。');
      if (!model || /[\r\n]/.test(model)) throw new Error('请填写有效的模型 ID。');
    }
    if (history.length >= 40) throw new Error('本局已达 20 轮，请新开一局以控制上下文和费用。');
    if (free && history.length >= 10) throw new Error('免费模式每局最多 5 轮，请开始新一局。');
    ctx = lockedContext || getContext();
  } catch (error) { status(error.message, true); return; }

  busy = true;
  controller = new AbortController();
  updateControls();
  let idleTimer, timedOut = false, view;
  const onActivity = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = true; controller?.abort(); }, IDLE_TIMEOUT_MS);
  };
  try {
    if (!await confirmDestination(endpoint, free ? 'free' : model)) { status('已取消，未发出请求。'); return; }
    pet.activity('casting');
    if (controller.signal.aborted) { status('已停止，未发出请求。'); return; }
    const image = attachment?.dataUrl;
    const text = history.length ? question : contextText(ctx) + '\n\n用户求问：\n' + question;
    const userMessage = { role: 'user', content: image ? [
      { type: 'text', text }, { type: 'image_url', image_url: { url: image } },
    ] : text };
    const userView = addMessage('user', question, image);
    view = replyView();
    status('');
    onActivity();
    let result, failure = null;
    try {
      result = free
        ? await streamFree([...history, userMessage], view, controller.signal, onActivity)
        : await streamByok(endpoint, apiKey, model, [...history, userMessage], view, controller.signal, onActivity);
    } catch (error) {
      failure = error;
    }
    if (!failure && !view.text.trim()) failure = new Error('模型没有返回正文（推理模型可能把输出预算用在了思考上），可提高输出上限后重试。');

    // Keep whatever already streamed (unless the server rejected the reply as a whole),
    // so the user can copy it or ask the model to continue.
    const partial = !failure?.discard && view.text.trim() ? view.text : '';
    if (failure && !partial) {
      view.remove();
      let message;
      if (controller.signal.aborted) message = timedOut ? `连续 ${IDLE_TIMEOUT_MS / 1000} 秒没有收到数据，已停止等待。` : '已停止，模型尚未输出正文。';
      else if (failure instanceof TypeError) message = '无法连接接口：可能是跨域（CORS）、网络或 TLS 问题。请使用允许浏览器直连的可信接口。';
      else message = failure.message;
      // Never print raw request objects, keys, or response bodies.
      if (apiKey) message = message.split(apiKey).join('[密钥已隐藏]');
      if (failure.discard) userView.article.remove();
      addMessage('error', message + (!free && controller.signal.aborted ? ' 服务商可能仍在处理或计费。' : ''));
      status('本次未加入对话，输入和附图已保留，可检查后手动重试。', true);
      pet.activity(controller.signal.aborted && !timedOut ? null : 'error', 2500);
      return;
    }

    history.push(userMessage, { role: 'assistant', content: view.text });
    shown.push(question);
    lockedContext = ctx;
    void saveLast();
    $('question').value = '';
    clearImage();
    renderBoard();
    if (failure) {
      view.finish(controller.signal.aborted && !timedOut ? '已停止' : '已中断');
      status('回答未完整，已保留输出部分并计入本局；可发送「继续」让模型接着写。', true);
    } else if (result.interrupted) {
      view.finish('已中断');
      status('上游连接中断，已保留输出部分；可发送「继续」让模型接着写。', true);
    } else if (result.truncated) {
      view.finish('已截断');
      status(free
        ? `已达输出上限（本站预算 ${result.budget || '以服务端为准'} token，推理也会占用）或 140 秒时限；可发送「继续」。`
        : '已达输出上限，可提高最大输出 token 后发送「继续」。', true);
    } else {
      view.finish();
      status('');
    }
    pet.activity(failure || result.interrupted ? null : 'success', 2000);
  } finally {
    if (pet.state === 'casting') pet.activity(null);
    clearTimeout(idleTimer);
    controller = null;
    busy = false;
    // If the browser stopped waiting, the server may already have consumed a slot.
    if (free && freeService.authenticated) void freeService.refreshQuota();
    updateControls();
  }
});

$('stop').addEventListener('click', () => {
  if (dialog.open) dialog.close('cancel');
  controller?.abort();
});
$('question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    if (!$('send').disabled) $('chat-form').requestSubmit();
  }
});

function clearImage() {
  imageVersion++;
  attachment = null;
  imageLoading = false;
  $('image-file').value = '';
  $('attachment-preview').removeAttribute('src');
  $('attachment-name').textContent = '';
  $('attachment').hidden = true;
}
$('pick-image').addEventListener('click', () => $('image-file').click());
$('remove-image').addEventListener('click', () => { clearImage(); updateControls(); });
$('image-file').addEventListener('change', async () => {
  const file = $('image-file').files[0];
  if (!file || busy) return;
  const version = ++imageVersion;
  imageLoading = true;
  updateControls();
  let objectUrl;
  try {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('仅支持 JPG、PNG 或 WebP 图片。');
    if (file.size > 10 * 1024 * 1024) throw new Error('图片请小于 10 MB。');
    objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    if (version !== imageVersion) return;
    const ratio = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    attachment = { dataUrl: canvas.toDataURL('image/jpeg', 0.88) };
    $('attachment-preview').src = attachment.dataUrl;
    $('attachment-name').textContent = `${canvas.width} × ${canvas.height} · 需视觉模型`;
    $('attachment').hidden = false;
  } catch (error) {
    if (version === imageVersion) { clearImage(); status(error.message || '无法读取图片，请更换文件。', true); }
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (version === imageVersion) imageLoading = false;
    updateControls();
  }
});

// ---- Saved "上一局" (signed-in users only; text only, one per user, server-side RLS) ----
const textOnly = content => typeof content === 'string' ? content
  : content.filter(p => p.type === 'text').map(p => p.text).join('\n') + '\n[附图未保存]';

async function saveLast() {
  if (!freeService.authenticated || !lockedContext) return;
  const ctx = lockedContext;
  const saved = await freeService.saveLast({
    mode: isFree() ? 'free' : 'byok',
    context: { mode: ctx.mode, value: ctx.value, board: ctx.board && { up: ctx.board.up, down: ctx.board.down, moving: ctx.board.moving }, shown },
    messages: history.map(m => ({ role: m.role, content: textOnly(m.content) })),
  });
  if (!saved) status('本局未能保存到账号（可能过长），不影响继续对话。');
}

let restoring = false;
async function restoreLast() {
  if (restoring || busy || history.length) return;
  restoring = true;
  try { await applyLast(await freeService.loadLast()); } finally { restoring = false; }
}
async function applyLast(record) {
  if (!record || busy || history.length || !globalThis.Solar) return;
  try {
    const c = record.context;
    const info = timeInfo(c.value, globalThis.Solar);
    const board = c.mode === 'time' ? timeHexagram(info) : c.mode === 'manual' ? buildHexagram(c.board.up, c.board.down, c.board.moving) : null;
    history = record.messages;
    shown = Array.isArray(c.shown) ? c.shown : [];
    lockedContext = { mode: c.mode, value: c.value, info, board };
    $('casting-mode').value = c.mode;
    $('casting-time').value = c.value;
    $('service-mode').value = record.mode === 'byok' || !freeService.configured ? 'byok' : 'free';
    let round = 0;
    for (const message of history) {
      if (message.role === 'user') addMessage('user', shown[round++] ?? message.content);
      else addMessage('assistant', message.content);
    }
    renderBoard();
    updateControls();
    const when = new Date(record.updated_at).toLocaleString('zh-CN', { hour12: false });
    status(`已恢复上一局（${when}），可以接着问；点「新一局」会删除这条记录。`);
  } catch {
    history = []; shown = []; lockedContext = null;
  }
}
window.addEventListener('auth-signed-in', () => {
  // Chatting before signing in (bring-your-own-key): keep that as the saved reading instead.
  if (history.length) void saveLast(); else void restoreLast();
});

function reset() {
  if (busy) return false;
  if ((history.length || $('question').value.trim() || attachment) && !window.confirm('清空本局对话、输入和附图？已保存到账号的上一局也会删除。连接配置与密钥会保留在当前页面内存。')) return false;
  if (history.length) void freeService.deleteLast();
  history = [];
  shown = [];
  lockedContext = null;
  clearImage();
  $('messages').querySelectorAll('.message').forEach(node => node.remove());
  $('welcome').hidden = false;
  $('question').value = '';
  $('casting-time').value = beijingNow();
  status('已开始新一局。');
  renderBoard();
  updateControls();
  return true;
}
$('reset').addEventListener('click', reset);

// Small panel dialogs opened from the pet menu, the header chip and the account button.
let returnFocus = null;
function openPanel(id) {
  const panel = $(id);
  if (!panel || panel.open) return;
  if (busy && id !== 'help-dialog') { status('正在回答中，完成或停止后再修改设置。'); return; }
  document.querySelectorAll('dialog.panel-dialog[open]').forEach(d => d.close());
  returnFocus = document.activeElement;
  panel.showModal();
}
document.querySelectorAll('dialog.panel-dialog').forEach(panel => {
  panel.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => panel.close()));
  // Click on the backdrop closes the panel.
  panel.addEventListener('click', event => { if (event.target === panel) panel.close(); });
  panel.addEventListener('close', () => {
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  });
});
$('account-button').addEventListener('click', () => openPanel('login-dialog'));
$('casting-chip').addEventListener('click', () => openPanel('casting-dialog'));
$('open-login').addEventListener('click', () => { $('config-dialog').close(); openPanel('login-dialog'); });

const pet = createPet({ avoid: $('chat-form'), onSelect: target => (target === 'reset' ? reset() : openPanel(target)) });

function startGuide() {
  runGuide([
    { target: () => pet.element, title: '我是观象小龙', text: '点我打开菜单：起卦、配置、说明和新一局都在这里。也可以把我拖到任何地方。' },
    { target: () => $('account-button'), title: '先登录', text: '用 GitHub 登录后，每天可免费问 5 次，不需要任何密钥。' },
    { target: () => pet.element, title: '或者自带 Key', text: '已有自己的模型接口？点我选「配置」，切换到「自带 API Key」填写即可。' },
    { target: () => $('question'), title: '一事一问', text: '在这里写下想问的事。默认按求问时刻起卦，可在「起卦」里换成测字或已有卦局。' },
  ], { onDone: () => $('question').focus({ preventScroll: true }) });
}
$('guide-replay').addEventListener('click', () => { $('help-dialog').close(); startGuide(); });

// Clear credentials on navigation / bfcache; never persist secrets or chat.
// The API key never persists; sign-in persists for at most 24h (see auth.mjs).
window.addEventListener('pagehide', () => { $('api-key').value = ''; approvedDestination = ''; controller?.abort(); });
renderBoard();
loadRules();
initAuth();
if (!guideSeen.get()) requestAnimationFrame(startGuide);
