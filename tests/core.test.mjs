import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import lunar from 'lunar-javascript';
import { TRIGRAMS, timeInfo, timeHexagram, buildHexagram, hexagram, normalizeEndpoint,
  boardText, beijingNow, assembleRules, extractReply, mod, relation, wangshuai } from '../web/core.mjs';

test('calendar matches Python 1.4.8 fixtures at spring festival, lichun, leap month and midnight', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./calendar-fixtures.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) {
    const info = timeInfo(fixture.date, lunar.Solar);
    assert.deepEqual(info, fixture.info, fixture.date);
    const board = timeHexagram(info);
    assert.deepEqual([board.up, board.down, board.moving], fixture.board, fixture.date);
  }
});

test('all 384 boards keep the stationary trigram and change exactly the moving line', () => {
  for (let up = 1; up <= 8; up++) for (let down = 1; down <= 8; down++) for (let moving = 1; moving <= 6; moving++) {
    const b = buildHexagram(up, down, moving);
    assert.equal(b.changed.filter((n, index) => n !== b.lines[index]).length, 1);
    assert.notEqual(b.changed[moving - 1], b.lines[moving - 1]);
    assert.equal(moving <= 3 ? b.bUp : b.bDown, b.ti);
    assert.deepEqual(TRIGRAMS[b.huDown][3], b.lines.slice(1, 4));
    assert.deepEqual(TRIGRAMS[b.huUp][3], b.lines.slice(2, 5));
    assert.ok(hexagram(up, down));
  }
});

test('known board and human-readable output', () => {
  const info = timeInfo('2026-10-16T19:37', lunar.Solar);
  const b = timeHexagram(info);
  assert.equal(hexagram(b.up, b.down), '山泽损');
  assert.equal(hexagram(b.huUp, b.huDown), '地雷复');
  assert.equal(hexagram(b.bUp, b.bDown), '火泽睽');
  assert.match(boardText(b, info), /癸亥日 壬戌时/);
  const manual = buildHexagram(7, 3, 1);
  assert.equal(hexagram(manual.up, manual.down), '山火贲');
  assert.equal(hexagram(manual.bUp, manual.bDown), '艮为山');
});

test('Beijing time is explicit and independent of local timezone', () => {
  assert.equal(beijingNow(new Date('2026-10-16T16:30:00Z')), '2026-10-17T00:30');
  assert.equal(beijingNow(new Date('2026-10-16T16:00:00Z')), '2026-10-17T00:00');
});

test('invalid inputs are rejected', () => {
  for (const value of ['', '2025-02-30T12:00', '2026-00-01T12:00', '2026-01-00T12:00', '2026-01-01T24:00', '1900-01-01T12:00']) {
    assert.throws(() => timeInfo(value, lunar.Solar));
  }
  for (const args of [[0, 1, 1], [1, 9, 1], [1, 1, 7], [1, 1, 1.5]]) assert.throws(() => buildHexagram(...args));
});

test('API URL normalization preserves custom paths and rejects credentials or unsafe schemes', () => {
  assert.equal(normalizeEndpoint('https://api.openai.com'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(normalizeEndpoint('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
  assert.equal(normalizeEndpoint('https://api.example.com/custom/chat/completions'), 'https://api.example.com/custom/chat/completions');
  assert.equal(normalizeEndpoint('http://localhost:8080/v1'), 'http://localhost:8080/v1/chat/completions');
  for (const input of ['javascript:alert(1)', 'http://example.com/v1', 'https://user:pass@api.example.com', 'https://api.example.com/v1?key=secret', 'https://api.example.com/#x', '//api.example.com']) assert.throws(() => normalizeEndpoint(input));
});

test('rule adapter contains complete documents and does not invent tool access', () => {
  const docs = ['SKILL.md', 'REFERENCE.md', 'EXAMPLES.md', 'YAO_CI.md'].map(name => [name, readFileSync(new URL('../' + name, import.meta.url), 'utf8')]);
  const prompt = assembleRules(docs);
  for (const [name, text] of docs) {
    assert.ok(prompt.includes(`===== ${name} =====`));
    assert.ok(prompt.includes(text.trim().split('\n').at(-1)));
  }
  assert.match(prompt, /没有文件、终端、联网/);
  assert.match(prompt, /以医生意见为准/);
  assert.ok(!prompt.includes('name: shaoyong-suangua'));
});

test('rules answer directly without asking, then refit only on user feedback', () => {
  const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  const examples = readFileSync(new URL('../EXAMPLES.md', import.meta.url), 'utf8');
  const prompt = assembleRules([['SKILL.md', skill]]);
  assert.match(skill, /先断后验：不向卦主提问/);
  assert.match(skill, /卦主不给反馈就到此为止/);
  assert.match(skill, /反馈拟合/);
  // The old ask-first workflow must not survive anywhere the model reads.
  for (const text of [skill, examples, prompt]) {
    assert.doesNotMatch(text, /先问后断|多轮提问|针对候选象提问|不限轮数|编成问题问卦主|必要追问|缺信息先问/);
  }
  assert.match(prompt, /不向用户提问、结尾不追问/);
});

test('API reply extraction handles strings and text blocks; no reasoning-only false success', () => {
  assert.equal(extractReply({ choices: [{ message: { content: '正文' } }] }), '正文');
  assert.equal(extractReply({ choices: [{ message: { content: [{ type: 'text', text: '正文' }] } }] }), '正文');
  assert.throws(() => extractReply({ choices: [{ message: { reasoning_content: 'hidden' } }] }));
});

test('relations and remainder zero follow skill conventions', () => {
  assert.equal(mod(8, 8), 8); assert.equal(mod(12, 6), 6);
  assert.equal(relation(3, 7), '生'); assert.equal(relation(7, 3), '被生于');
  assert.equal(relation(6, 3), '克'); assert.equal(relation(3, 6), '被克于');
  assert.equal(wangshuai('水', '亥'), '旺'); assert.equal(wangshuai('木', '亥'), '相');
});

test('web uses text-only output, bounded 24h sign-in storage and only an explicitly configured CAPTCHA script', () => {
  const app = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
  const auth = readFileSync(new URL('../web/auth.mjs', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /\.innerHTML|\.outerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(auth, /\.innerHTML|\.outerHTML|insertAdjacentHTML|sessionStorage|indexedDB|document\.cookie/);
  // Sign-in persists through a wrapper that enforces the 24h window; nothing else in auth.mjs touches storage.
  assert.match(auth, /persistSession: true, storage: loginStorage/);
  assert.match(auth, /LOGIN_TTL_MS = 24 \* 60 \* 60 \* 1000/);
  // Storage keys: the 24h sign-in (AUTH_KEY + its stamp) and a parked guest refresh token (GUEST_KEY, 7 days).
  assert.deepEqual([...auth.matchAll(/localStorage\.(\w+)\(([^,)]+)/g)].map(m => `${m[1]} ${m[2]}`).sort(), [
    'getItem GUEST_KEY', 'getItem key', 'getItem key', 'getItem this.stampKey(key',
    'removeItem GUEST_KEY', 'removeItem key', 'removeItem this.stampKey(key',
    'setItem GUEST_KEY', 'setItem key', 'setItem this.stampKey(key']);
  assert.match(auth, /GUEST_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  // Saved readings are text only (images replaced by a marker) and the API key never leaves page memory.
  assert.match(app, /\[附图未保存\]/);
  assert.doesNotMatch(app, /saveLast\([^)]*api-key/);
  // The desk pet may only remember that the onboarding guide was seen.
  const pet = readFileSync(new URL('../web/pet.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(pet, /\.innerHTML|\.outerHTML|insertAdjacentHTML|sessionStorage|indexedDB|document\.cookie/);
  assert.deepEqual([...pet.matchAll(/localStorage\.(\w+)\(([^,)]+)/g)].map(m => m[1] + ' ' + m[2]), ['getItem GUIDE_KEY', 'setItem GUIDE_KEY']);
  assert.doesNotMatch(html, /deepseek|ccode\.vip/, 'free service model/upstream are not shown to users');
  assert.match(auth, /if \(!config\.TURNSTILE_SITE_KEY\) return/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
  assert.match(app, /redirect: 'error'/);
  assert.match(app, /credentials: 'omit'/);
});
