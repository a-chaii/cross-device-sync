// /dash 页面回归：产物可解析、内联脚本语法合法、关键文案/口径未退化
import { page, loginPage, data, history, HIST_TTL_MS, histKey, isDeviceKey } from './dash.js';

let pass = 0, fail = 0;
const chk = (n, c, e) => (c ? pass++ : (fail++, console.log('FAIL ' + n + (e !== undefined ? ' :: ' + e : ''))));

const res = page();
const html = await res.text();
chk('page 200', res.status === 200, res.status);
chk('html 非空', html.length > 20000, html.length);
chk('no-store / 不缓存', (res.headers.get('cache-control') || '').includes('no-store'), res.headers.get('cache-control'));
chk('HTML 闭合', html.trim().endsWith('</html>'), html.slice(-20));

// 内联脚本语法校验（fmtDur 改动最容易踩到这里）
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
chk('至少有 1 段内联脚本', scripts.length >= 1, scripts.length);
let bad = null;
for (const s of scripts) {
  try { new Function(s); } catch (e) { bad = String(e); }
}
chk('内联脚本语法合法', bad === null, bad);

const js = scripts.join('\n');
chk('含 fmtDur', js.includes('function fmtDur'));
chk('时长空格口径：时/分之间留空格', js.includes("' '+mm+' 分'"), js.includes("mm+' 分") ? '旧口径未改' : '未匹配');
chk('移除列举：不含 6时25分 形式', !js.includes("h+' 时'+mm+' 分'"));
chk('含掉电速率渲染', js.includes('%/h'));
// v11.8.1 回归：canvas 不认 CSS 变量（addColorStop 会抛 SyntaxError，整页渲染中断）
// canvas 的 addColorStop/fillStyle 不解析 CSS 变量，混用会抛 SyntaxError 并中断整页渲染
chk('canvas 里不用 css 变量色', !js.includes('var(--accent') && !/addColorStop\([^)]*var\(--/.test(js));
chk('强调色走 acc() 拼接', js.includes('function acc(a)') && js.includes('acc(.30)'));
chk('莫奈读系统配色而非选图', js.includes("/dash/theme") && !js.includes('FileReader'));
chk('页头标题已个性化', html.includes('柴的设备续航看板'));
chk('不含 emoji', !/[\u{1F300}-\u{1FAFF}]/u.test(html));
chk('不承诺每分钟同步', !/每分钟|实时秒级/.test(html));

const lg = loginPage('密码错了');
const lgText = await lg.text();
chk('loginPage 401（未登录态）', lg.status === 401, lg.status);
chk('loginPage 回显错误', lgText.includes('密码错了'));
chk('loginPage 含 form', lgText.includes('<form'));

chk('HIST_TTL_MS = 7 天', HIST_TTL_MS === 7 * 24 * 3600000, HIST_TTL_MS);
chk('histKey 前缀', histKey('watch/battery') === '@hist:watch/battery', histKey('watch/battery'));
chk('isDeviceKey watch', isDeviceKey('watch/battery') === true);
chk('isDeviceKey dev/abcd', isDeviceKey('dev/abcd') === true);
chk('isDeviceKey 拒绝 @hist', isDeviceKey('@hist:watch/battery') === false);
chk('isDeviceKey 拒绝裸键', isDeviceKey('watch') === false);

// history()/data() 路由形状
const T0 = Date.now(), H = 3600000;
const store = new Map([
  ['watch/battery', JSON.stringify({ value: { level: 62 }, updatedAt: new Date(T0 - 60000).toISOString() })],
  ['@hist:watch/battery', JSON.stringify([{ t: T0 - 5 * H, l: 80 }, { t: T0 - 3 * H, l: 72 }, { t: T0 - 60000, l: 62 }])]
]);
const env = { SYNC_KV: {
  async get(k, t) { const v = store.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); },
  async list() { return { keys: [...store.keys()].filter(k => k[0] !== '@').map(name => ({ name, metadata: null })), list_complete: true, cursor: null }; }
} };
const hr = await history(env, 'watch/battery', 0);
chk('history 200', hr.status === 200, hr.status);
const hb = await hr.json();
chk('history 有点', Array.isArray(hb.hist) && hb.hist.length === 3, JSON.stringify(Object.keys(hb)));
chk('history 带 retentionMs', hb.retentionMs === HIST_TTL_MS, hb.retentionMs);
const dr = await data(env, 'watch/battery', 0);
chk('data 200', dr.status === 200, dr.status);
const db = await dr.json();
chk('data 带 rec 与 hist', !!db.rec && Array.isArray(db.hist) && db.hist.length === 3, JSON.stringify(Object.keys(db)));
chk('data rec 里 level=62', db.rec.value && db.rec.value.level === 62, JSON.stringify(db.rec));
const ar = await data(env, '*', 0);
chk('data 多设备 200', ar.status === 200, ar.status);

console.log('\npass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
