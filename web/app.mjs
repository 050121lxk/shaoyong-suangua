import { TRIGRAMS, beijingNow, timeInfo, timeHexagram, buildHexagram, hexagram,
  calendarText, boardText, normalizeEndpoint, assembleRules, extractReply } from './core.mjs';
import { freeService, initAuth } from './auth.mjs';

const $ = id => document.getElementById(id);
const files = ['SKILL.md', 'REFERENCE.md', 'EXAMPLES.md', 'YAO_CI.md'];
let rules = '', history = [], lockedContext = null, busy = false, attachment = null;
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
  document.querySelectorAll('[data-example]').forEach(b => { b.disabled = busy || !!lockedContext; });
}
window.addEventListener('free-auth-change', updateControls);
$('service-mode').addEventListener('change', () => { approvedDestination = ''; updateControls(); });

async function loadRules() {
  rules = '';
  $('retry-rules').hidden = true;
  $('rule-status').textContent = '正在加载仓库规则…';
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
    $('rule-status').textContent = `完整规则已就绪 · 4 份文档 · 约 ${(rules.length / 10000).toFixed(1)} 万字符（非 token 数）`;
    $('rule-dot').className = 'status-dot ready';
  } catch {
    $('rule-status').textContent = '规则加载失败，暂不可发送。请检查网络后重试。';
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
    title.textContent = `${modeLabels[ctx.mode]} · ${lockedContext ? '本局已固定' : '本地预览'}`;
    target.append(title);
    if (ctx.board) {
      const b = ctx.board;
      const triples = document.createElement('div');
      triples.className = 'board-triples';
      triples.append(drawHex(b.up, b.down, `主 · ${b.moving}爻动`, b.moving),
        drawHex(b.huUp, b.huDown, '互 · 过程'), drawHex(b.bUp, b.bDown, '变 · 结果'));
      const meta = document.createElement('p');
      meta.className = 'board-meta';
      meta.textContent = `体${TRIGRAMS[b.ti][0]} · 用${TRIGRAMS[b.yong][0]} / ${ctx.info.yearGz} ${ctx.info.monthGz} ${ctx.info.dayGz} ${ctx.info.hourGz}`;
      target.append(triples, meta);
    } else {
      const text = document.createElement('div');
      text.className = 'calendar-only';
      text.textContent = calendarText(ctx.info) + '\n仅提供历法，不擅起时间卦。请在右侧描述字形或征兆。';
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

function addMessage(role, text, image) {
  $('welcome').hidden = true;
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = role === 'user' ? '你 · 求问' : role === 'error' ? '未完成 · 本次未加入模型历史' : '观象 · 模型推演';
  const content = document.createElement('div');
  content.className = 'message-content';
  // Never interpret user/model text as HTML, links, or Markdown.
  content.textContent = text;
  article.append(label, content);
  if (image) {
    const img = document.createElement('img');
    img.className = 'message-image'; img.alt = '本次提交的图片'; img.src = image;
    article.append(img);
  }
  $('messages').append(article);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function confirmDestination(endpoint, model) {
  const key = `${endpoint}\n${model}`;
  if (approvedDestination === key) return Promise.resolve(true);
  $('consent-endpoint').textContent = endpoint;
  $('consent-model').textContent = model;
  $('consent-description').textContent = isFree()
    ? '免费服务：登录凭据发给 Supabase 后端；后端使用管理员的服务端密钥，转发问题、规则、对话和附图到 api.ccode.vip。每次转发占用今日 1 次，失败也计次。'
    : '你的 API Key 将直接发给下列接口，问题、完整规则、对话和附图将由该服务商处理。';
  if (isFree()) $('consent-endpoint').textContent = `${endpoint} → ${freeService.upstream}`;
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
  400: '请求格式、上下文长度或输出参数不被支持。请检查模型和接口配置，必要时新开一局。',
  401: '认证失败，请检查 API Key。', 403: '接口拒绝访问，请检查密钥和模型权限。',
  404: '未找到接口或模型，请检查 Base URL 和模型 ID。',
  413: '请求过大，请减少附图或新开一局。', 429: '额度或速率受限，请检查余额与配额，稍后手动重试。',
};

$('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !rules || imageLoading) return;
  const question = $('question').value.trim();
  if (!question) return;
  let endpoint, ctx;
  const apiKey = $('api-key').value.trim();
  const model = $('model').value.trim();
  try {
    if (isFree()) {
      if (!freeService.allowed) throw new Error('请先登录并确认今日仍有免费次数。');
      endpoint = freeService.endpoint;
    } else {
      endpoint = normalizeEndpoint($('base-url').value);
      if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('请填写有效的 API Key（不能含换行）。');
      if (!model || /[\r\n]/.test(model)) throw new Error('请填写有效的模型 ID。');
    }
    if (history.length >= 40) throw new Error('本局已达 20 轮，请新开一局以控制上下文和费用。');
    if (isFree() && history.length >= 10) throw new Error('免费模式每局最多 5 轮，请开始新一局。每日次数仍由服务器统一计算。');
    ctx = lockedContext || getContext();
  } catch (error) { status(error.message, true); return; }

  busy = true;
  controller = new AbortController();
  updateControls();
  let timer;
  try {
    if (!await confirmDestination(endpoint, isFree() ? freeService.model : model)) { status('已取消，未发出 API 请求。'); return; }
    if (controller.signal.aborted) { status('已停止，未发出 API 请求。'); return; }
    const image = attachment?.dataUrl;
    const text = history.length ? question : contextText(ctx) + '\n\n用户求问：\n' + question;
    const userMessage = { role: 'user', content: image ? [
      { type: 'text', text }, { type: 'image_url', image_url: { url: image } },
    ] : text };
    addMessage('user', question, image);
    status('模型正在推演… 本页等待完整回复，最长 180 秒。');
    let timedOut = false;
    timer = setTimeout(() => { timedOut = true; controller?.abort(); }, 180000);
    try {
      if (isFree()) {
        const data = await freeService.request('chat', [...history, userMessage], controller.signal);
        if (typeof data.content !== 'string' || !data.content.trim()) throw new Error('免费服务返回正文为空。');
        history.push(userMessage, { role: 'assistant', content: data.content });
        lockedContext = ctx;
        addMessage('assistant', data.content);
        $('question').value = '';
        clearImage(); renderBoard();
        status(data.truncated ? `上游报告输出长度已达限制（本站请求预算 ${data.max_output_tokens || '以服务端配置为准'} token，推理内容也可能占用）；可在剩余次数内请模型继续。` : '本轮完成 · 每日最多 5 次发送，以服务端计数为准。');
        return;
      }
      const response = await fetch(endpoint, {
        method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({ model, messages: [{ role: 'system', content: rules }, ...history, userMessage],
          max_tokens: Number($('max-tokens').value), stream: false }),
      });
      if (!response.ok) {
        // Do not display provider bodies: they can contain reflected secrets or untrusted HTML.
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}：${HTTP_ERRORS[response.status] || '服务商返回错误，请检查服务状态或接口兼容性。'}`);
      }
      const raw = await response.text();
      if (raw.length > 4000000) throw new Error('接口回复过大，已停止显示。');
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('接口未返回有效 JSON，请确认这是 Chat Completions 接口。'); }
      const reply = extractReply(data);
      history.push(userMessage, { role: 'assistant', content: reply });
      lockedContext = ctx;
      addMessage('assistant', reply);
      $('question').value = '';
      clearImage();
      renderBoard();
      status(data.choices?.[0]?.finish_reason === 'length' ? '回复因输出上限被截断，可提高输出上限并请模型继续。' : '本轮完成 · 追问将保留本局，页面刷新后对话不保留。');
    } catch (error) {
      let message;
      if (controller.signal.aborted) message = timedOut ? '等待超时（180 秒），本次未加入对话历史。服务商可能仍在处理或计费。' : '已停止等待，本次未加入对话历史。服务商可能仍在处理或计费。';
      else if (error instanceof TypeError) message = '无法连接接口：可能是 CORS 跨域限制、网络或 TLS 问题。请使用允许浏览器直连的可信接口；不要关闭浏览器安全机制。';
      else message = error.message;
      // Never print raw request objects, keys, or response bodies.
      message = apiKey ? message.split(apiKey).join('[密钥已隐藏]') : message;
      addMessage('error', message);
      status('发送未完成，输入及附图仍保留，可检查配置后手动重试。', true);
    }
  } finally {
    clearTimeout(timer);
    controller = null;
    busy = false;
    // If the browser stopped waiting, the server may already have consumed a slot.
    if (isFree() && freeService.authenticated) void freeService.refreshQuota();
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
    $('attachment-name').textContent = `${canvas.width} × ${canvas.height} · 本地重编码（仅本次附图）`;
    $('attachment').hidden = false;
    status('图片已在本地缩放；发送时会交给所选模型服务商，请确认模型支持视觉。');
  } catch (error) {
    if (version === imageVersion) { clearImage(); status(error.message || '无法读取图片，请更换文件。', true); }
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (version === imageVersion) imageLoading = false;
    updateControls();
  }
});

function reset() {
  if (busy) return false;
  if ((history.length || $('question').value.trim() || attachment) && !window.confirm('清空本局对话、输入和附图？连接配置与密钥会保留在当前页面内存。')) return false;
  history = [];
  lockedContext = null;
  clearImage();
  $('messages').querySelectorAll('.message').forEach(node => node.remove());
  $('welcome').hidden = false;
  $('question').value = '';
  $('casting-time').value = beijingNow();
  status('已开始新一局。API Key 仍仅在本页，离开前可点击「清除密钥」。');
  renderBoard();
  updateControls();
  return true;
}
$('reset').addEventListener('click', reset);
document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => {
  if (busy || lockedContext) return;
  const example = button.dataset.example;
  if (example === 'job') {
    $('casting-mode').value = 'time';
    $('question').value = '请按时间卦看看我这次求职的进展。信息不足时，请先问我，再展开分析。';
  } else if (example === 'character') {
    $('casting-mode').value = 'character';
    $('question').value = '我想以「安」字测最近一件事的进展。请先问清事项，按测字规则分析，不要凭空补造字形异常或外应。';
  } else {
    $('casting-mode').value = 'manual';
    $('upper').value = '7'; $('lower').value = '3'; $('moving').value = '1';
    $('question').value = '射覆：我心里想了一件物品。卦局为上艮下离、初爻动，请沿用原卦，按阴阳爻结构直接猜，不追问提示。';
  }
  renderBoard();
  $('question').focus();
}));

// Clear credentials on navigation / bfcache; never persist secrets or chat.
window.addEventListener('pagehide', () => { $('api-key').value = ''; approvedDestination = ''; controller?.abort(); freeService.clear(); });
renderBoard();
loadRules();
initAuth();
