// Same bottom-up line convention and calendar boundaries as scripts/qigua.py.
export const GAN = '甲乙丙丁戊己庚辛壬癸';
export const ZHI = '子丑寅卯辰巳午未申酉戌亥';
export const TRIGRAMS = [null,
  ['乾', '天', '金', [1, 1, 1]], ['兑', '泽', '金', [1, 1, 0]],
  ['离', '火', '火', [1, 0, 1]], ['震', '雷', '木', [1, 0, 0]],
  ['巽', '风', '木', [0, 1, 1]], ['坎', '水', '水', [0, 1, 0]],
  ['艮', '山', '土', [0, 0, 1]], ['坤', '地', '土', [0, 0, 0]],
];
const NAMES = [null,
  '乾为天 天泽履 天火同人 天雷无妄 天风姤 天水讼 天山遁 天地否',
  '泽天夬 兑为泽 泽火革 泽雷随 泽风大过 泽水困 泽山咸 泽地萃',
  '火天大有 火泽睽 离为火 火雷噬嗑 火风鼎 火水未济 火山旅 火地晋',
  '雷天大壮 雷泽归妹 雷火丰 震为雷 雷风恒 雷水解 雷山小过 雷地豫',
  '风天小畜 风泽中孚 风火家人 风雷益 巽为风 风水涣 风山渐 风地观',
  '水天需 水泽节 水火既济 水雷屯 水风井 坎为水 水山蹇 水地比',
  '山天大畜 山泽损 山火贲 山雷颐 山风蛊 山水蒙 艮为山 山地剥',
  '地天泰 地泽临 地火明夷 地雷复 地风升 地水师 地山谦 坤为地',
];
const SHENG = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' };
const KE = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' };
const ZHI_WX = { 寅: '木', 卯: '木', 巳: '火', 午: '火', 申: '金', 酉: '金', 亥: '水', 子: '水', 辰: '土', 戌: '土', 丑: '土', 未: '土' };
export const mod = (n, m) => ((n % m) + m) % m || m;
export const hexagram = (up, down) => NAMES[up].split(' ')[down - 1];
const triNumber = lines => TRIGRAMS.findIndex(t => t && t[3].join('') === lines.join(''));
export const triText = n => `${TRIGRAMS[n][0]}（${TRIGRAMS[n][1]}，${TRIGRAMS[n][2]}）`;

export function beijingNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
  return parts.replace(' ', 'T');
}

export function timeInfo(value, Solar) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('请填写完整的北京时间。');
  const [y, m, d, h, minute] = match.slice(1).map(Number);
  if (y < 1901 || y > 2099 || m < 1 || m > 12 || d < 1 || h > 23 || minute > 59 ||
      d > new Date(Date.UTC(y, m, 0)).getUTCDate()) {
    throw new Error('请选择 1901–2099 年间的有效日期和时间。');
  }
  const lunar = Solar.fromYmdHms(y, m, d, h, minute, 0).getLunar();
  const hourIndex = Math.floor((h + 1) / 2) % 12;
  const dayGz = lunar.getDayInGanZhi(); // midnight, not 23:00
  return {
    lunarYearZhi: lunar.getYearZhi(), lunarMonth: Math.abs(lunar.getMonth()),
    leap: lunar.getMonth() < 0, lunarDay: lunar.getDay(), hourNum: hourIndex + 1,
    yearGz: lunar.getYearInGanZhiByLiChun(), monthGz: lunar.getMonthInGanZhiExact(),
    dayGz, hourGz: GAN[(GAN.indexOf(dayGz[0]) % 5 * 2 + hourIndex) % 10] + ZHI[hourIndex],
  };
}

export function timeHexagram(info) {
  const base = ZHI.indexOf(info.lunarYearZhi) + 1 + info.lunarMonth + info.lunarDay;
  return buildHexagram(mod(base, 8), mod(base + info.hourNum, 8), mod(base + info.hourNum, 6));
}

export function buildHexagram(up, down, moving) {
  if (![up, down, moving].every(Number.isInteger) || up < 1 || up > 8 || down < 1 || down > 8 || moving < 1 || moving > 6) {
    throw new Error('上下卦须为 1–8，动爻须为 1–6。');
  }
  const lines = [...TRIGRAMS[down][3], ...TRIGRAMS[up][3]];
  const huDown = triNumber(lines.slice(1, 4));
  const huUp = triNumber(lines.slice(2, 5));
  const changed = [...lines];
  changed[moving - 1] ^= 1;
  const bDown = triNumber(changed.slice(0, 3));
  const bUp = triNumber(changed.slice(3, 6));
  const lowerMoves = moving <= 3;
  return { up, down, moving, lines, changed, huDown, huUp, bDown, bUp,
    ti: lowerMoves ? up : down, yong: lowerMoves ? down : up,
    bianYong: lowerMoves ? bDown : bUp,
    tiHu: lowerMoves ? huUp : huDown, yongHu: lowerMoves ? huDown : huUp };
}

export function relation(a, b) {
  const wa = TRIGRAMS[a][2], wb = TRIGRAMS[b][2];
  if (wa === wb) return '比和';
  if (SHENG[wa] === wb) return '生';
  if (KE[wa] === wb) return '克';
  if (SHENG[wb] === wa) return '被生于';
  return '被克于';
}

export function wangshuai(wx, zhi) {
  const ling = ZHI_WX[zhi];
  if (wx === ling) return '旺';
  if (SHENG[ling] === wx) return '相';
  if (SHENG[wx] === ling) return '休';
  if (KE[wx] === ling) return '囚';
  return '死';
}

export function calendarText(info) {
  return `干支：${info.yearGz}年 ${info.monthGz}月 ${info.dayGz}日 ${info.hourGz}时\n农历：${info.lunarYearZhi}年 ${info.leap ? '闰' : ''}${info.lunarMonth}月 ${info.lunarDay}日 ${ZHI[info.hourNum - 1]}时（起卦年数按春节，旺衰按节气，子时0点换日）`;
}

export function boardText(b, info) {
  const text = [calendarText(info),
    `主卦：${hexagram(b.up, b.down)}（上${triText(b.up)} 下${triText(b.down)}），第${b.moving}爻动`,
    `互卦：${hexagram(b.huUp, b.huDown)}（上互${triText(b.huUp)} 下互${triText(b.huDown)}）`,
    `变卦：${hexagram(b.bUp, b.bDown)}（上${triText(b.bUp)} 下${triText(b.bDown)}）`,
    `体卦：${triText(b.ti)}；用卦：${triText(b.yong)}；变用：${triText(b.bianYong)}`,
    `体互：${triText(b.tiHu)}；用互：${triText(b.yongHu)}`,
    '生克（以体为主语）：' + [['用卦', b.yong], ['变用', b.bianYong], ['体互', b.tiHu], ['用互', b.yongHu]].map(([label, n]) => `体${TRIGRAMS[b.ti][0]}${relation(b.ti, n)}${label}${TRIGRAMS[n][0]}`).join('；'),
    `用卦之间：${TRIGRAMS[b.yong][0]}${relation(b.yong, b.bianYong)}${TRIGRAMS[b.bianYong][0]}；体互${relation(b.tiHu, b.yongHu)}用互`,
  ];
  for (const [label, zhi] of [['月令', info.monthGz[1]], ['日辰', info.dayGz[1]]]) {
    text.push(`旺衰（${label}${zhi}）：` + [...new Set([b.ti, b.yong, b.bianYong, b.tiHu, b.yongHu])].map(n => TRIGRAMS[n][0] + wangshuai(TRIGRAMS[n][2], zhi)).join('、'));
  }
  return text.join('\n');
}

export function normalizeEndpoint(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('请填写完整接口地址，例如 https://api.openai.com/v1'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('接口必须使用 HTTPS；仅本机 localhost 允许 HTTP。');
  if (url.username || url.password || url.search || url.hash) throw new Error('接口地址不能包含账号、密码、查询参数或片段；Key 请填入专用输入框。');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path || '/v1'}/chat/completions`;
  return url.href;
}

export const WEB_ADAPTER = `你正在 shaoyong-suangua 的纯前端网页体验版中。随后是仓库真实规则全文，请遵循规则，但注意以下网页环境边界：
1. 没有文件、终端、联网、脚本执行或感知周围环境的工具；下列文件已加载，不要声称调用了工具或要求用户在页面里执行脚本。前端提供的历法和卦局是确定性计算，不要重起、擅改。追问时保留当前卦局；只有用户明确要求另起一事才更换。
2. 用户选择测字或观物时，前端只提供历法，不自动起时间卦。按规则提问和取卦；手写图像需模型确实具有视觉能力，辨不清就说明，不能编造笔画。用户消息中自带卦局优先于默认时间卦。
3. 未提供真实外应则不得冒充观察到外应。本网页默认不生成模拟外应，需用户明确请求才生成，并显著标注模拟，且不能当独立证据。
4. 这是传统文化学习与提示词演示，不是科学预测或专业建议。规则所述把握分档不是统计概率，不保证准确。健康问题提醒以医生意见为准；不把卦象作为诊断或重大决策依据。
5. 用简体中文和现代白话，先给简明判断或必要追问，再给可核对依据。展示关键卦象、阴阳结构和生克，但不倾倒冗长的内部思考。射覆直接作答，不讨提示。文档案例只是参考，不能把其中人物或结论套成当前用户的事实。`;

export function assembleRules(docs) {
  return WEB_ADAPTER + '\n\n' + docs.map(([name, text]) => `===== ${name} =====\n${text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')}`).join('\n\n');
}

export function extractReply(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
    if (text.trim()) return text;
  }
  throw new Error('接口未返回可显示的正文。请检查模型是否支持 Chat Completions，或增加输出上限（推理模型也会消耗输出预算）。');
}
