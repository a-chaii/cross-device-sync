// 交叉一致性：前端 JS（src/dash.ts 抽取，运行在浏览器里的那份）vs 服务端 TS（src/stats.ts 编译产物）
// 目的：防止「Web 端点算 39 小时、小组件算 42 小时」这种双实现漂移。
import fs from 'fs';
import * as S from './stats.js';

const js = fs.readFileSync(new URL('./front.js', import.meta.url), 'utf8');
const F = new Function(js + '\nreturn {isCh,annotate,olsRate,ptsOf,cyclePts,sparseOf,statOf,chgStat,fmtDur,wideRate,withWide};')();

let pass = 0, fail = 0;
// 键序无关的稳定序列化；undefined 归一为 null（服务端为 Swift Codable 显式输出 null，前端省略键）
function stable(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const ks = Object.keys(v).filter(k => k !== 'c' && k !== 'm' && k !== 's').sort();
  return '{' + ks.map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
function eq(name, a, b) {
  const sa = stable(a), sb = stable(b);
  if (sa === sb) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  front =' + sa + '\n  server=' + sb); }
}
function chk(name, cond, extra) {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + extra : '')); }
}

const H = 3600000, M = 60000, T0 = 1700000000000;
const mk = arr => arr.map(([t, l, c]) => ({ t: T0 + t, l, c: c || undefined }));

const fixtures = {
  empty: [],
  single: mk([[0, 80]]),
  flat: mk([[0, 80], [1 * H, 80], [2 * H, 80], [3 * H, 80]]),
  discharge: mk([[0, 100], [1 * H, 96], [2 * H, 92], [3 * H, 88], [4 * H, 85], [5 * H, 81]]),
  charging: mk([[0, 20], [10 * M, 22, 1], [30 * M, 26, 1], [50 * M, 30, 1], [80 * M, 34, 1]]),
  chargeThenIdle: mk([[0, 20], [10 * M, 25, 1], [30 * M, 40, 1], [40 * M, 40], [50 * M, 40]]),
  jump: mk([[0, 90], [H, 50], [2 * H, 90], [3 * H, 88], [4 * H, 86]]),
  dupT: mk([[0, 70], [H, 79], [H, 75], [2 * H, 72], [3 * H, 68]]),
  full: mk([[0, 98, 1], [20 * M, 100, 1], [60 * M, 100], [2 * H, 100], [3 * H, 100]]),
  sparse: mk([[0, 90], [30 * H, 60], [60 * H, 40]]),
  climbNoC: mk([[0, 30], [10 * M, 45], [20 * M, 60], [30 * M, 75]]),
  fast: mk([[0, 100], [10 * M, 98], [20 * M, 96]]),
  longLife: mk([[0, 100], [48 * H, 99], [96 * H, 98], [144 * H, 97]]),
  fullIdle: mk([[0, 100], [H, 100], [2 * H, 100], [3 * H, 100]])
};

// ---------- 1. 九个共享函数逐 fixtures 对比 ----------
for (const [name, hist] of Object.entries(fixtures)) {
  const fp = F.ptsOf(hist), sp = S.ptsOf(hist);
  eq('ptsOf/' + name, fp, sp);
  eq('cyclePts/' + name, F.cyclePts(fp), S.cyclePts(sp));
  eq('sparseOf/' + name, F.sparseOf(fp), S.sparseOf(sp));
  eq('statOf/' + name, F.statOf(fp), S.statOf(sp));
  eq('chgStat/' + name, F.chgStat(fp), S.chgStat(sp));
  eq('annotate/' + name, F.annotate(hist), S.annotate(hist));
}

// ---------- 2. olsRate ----------
eq('olsRate/basic', F.olsRate([0, 1, 2, 3, 4], [100, 96, 92, 88, 85]), S.olsRate([0, 1, 2, 3, 4], [100, 96, 92, 88, 85]));
eq('olsRate/short', F.olsRate([0, 1], [1, 2]), S.olsRate([0, 1], [1, 2]));
eq('olsRate/rise', F.olsRate([0, 1, 2], [1, 2, 3]), S.olsRate([0, 1, 2], [1, 2, 3]));
eq('olsRate/flat', F.olsRate([0, 1, 2], [5, 5, 5]), S.olsRate([0, 1, 2], [5, 5, 5]));

// ---------- 3. fmtDur 文案（中文单位，客户端不得自己拼） ----------
for (const d of [null, 0, 89999, 90000, 60000, 5400000, 5399999, 3600000, 3660000, 172800000, 172799999, 259200000, 2592900000, 720 * H, 3600000 * 24 * 41])
  eq('fmtDur/' + d, F.fmtDur(d), S.fmtDur(d));

// ---------- 4. isCh ----------
eq('isCh/1', F.isCh({ c: 1 }), S.isCh({ c: 1 }));
eq('isCh/true', F.isCh({ c: true }), S.isCh({ c: true }));
eq('isCh/0', F.isCh({ c: 0 }), S.isCh({ c: 0 }));

// ---------- 5. 口径断言（以真实算法为准，不臆造期望值） ----------
const dp = S.ptsOf(fixtures.discharge);
const sd = S.statOf(dp);
chk('掉电 6 点全有效', sd.n === 6, sd.n);
chk('掉电速率 > 0', typeof sd.rate === 'number' && sd.rate > 0, sd.rate);
chk('掉电速率 ~3.9%/h', Math.abs(sd.rate - 3.86) < 0.3, sd.rate);

const hp = S.ptsOf(fixtures.charging);
const hc = S.chgStat(hp);
const hl = hp[hp.length - 1];
chk('充电段 open', hc.open === true);
chk('充电段数 1', hc.n === 1, hc.n);
chk('elapsed = last.t - cur.t0（不外推到 now）', hc.elapsed === hl.t - hc.cur.t0, hc.elapsed);
chk('gain = last.l - cur.l0', hc.gain === hl.l - hc.cur.l0, hc.gain);

const fl = S.chgStat(S.ptsOf(fixtures.full));
chk('l>=100 不给 eta', fl.eta === null || fl.eta === undefined, fl.eta);

const jp = S.ptsOf(fixtures.jump);
chk('孤立尖点标 1 个', jp.filter(p => p.jump).length === 1, jp.filter(p => p.jump).length);

const dug = S.ptsOf(fixtures.dupT);
chk('同毫秒去重', dug.length === 4, dug.length);
chk('同毫秒保留先到 79', dug[1].l === 79, dug[1].l);
// ---------- 5b. 长样本速率 wideRate / withWide（v11.7 续航口径） ----------
for (const name of Object.keys(fixtures)) {
  const p1 = F.ptsOf(fixtures[name]), p2 = S.ptsOf(fixtures[name]);
  eq('wideRate/' + name, F.wideRate(p1), S.wideRate(p2));
  eq('withWide/' + name, F.withWide(F.statOf(p1), p1), S.withWide(S.statOf(p2), p2));
}
// 短窗口不吹牛：刚充满 2.8 小时掉 6% → 短窗外推约 47 小时；长历史里真实 2.8%/h
const short = [{ t: 0, l: 100 }, { t: 0.6 * H, l: 99 }, { t: H, l: 98 }, { t: 2.8 * H, l: 94 }];
const longHist = [{ t: -21 * H, l: 100 }, { t: -18 * H, l: 91 }, { t: -12 * H, l: 74 }, { t: -6 * H, l: 57 }, { t: -1.5 * H, l: 52 }].concat(short);
const tiny = [{ t: 0, l: 100 }, { t: 60000, l: 99 }];
const wr = S.wideRate(S.ptsOf(longHist));
chk('wideRate 跨周期累加', wr.n >= 4 && wr.spanMs >= 6 * H, wr.n + ' 段 / ' + wr.spanMs + 'ms');
chk('宽窗速率比短窗更保守', wr.rate > S.statOf(S.ptsOf(short)).rate, wr.rate + ' vs ' + S.statOf(S.ptsOf(short)).rate);
chk('withWide 采纳长样本后续航变短', S.withWide(S.statOf(S.ptsOf(short)), S.ptsOf(longHist)).life < S.statOf(S.ptsOf(short)).life);
chk('样本不足原样返回', (() => { const s = S.statOf(S.ptsOf(tiny)); return S.withWide(s, S.ptsOf(tiny)) === s; })());

chk('稀疏命中', S.sparseOf(S.ptsOf(fixtures.sparse)) === true, S.sparseOf(S.ptsOf(fixtures.sparse)));
chk('不稀疏不误报', S.sparseOf(S.ptsOf(fixtures.discharge)) === false, S.sparseOf(S.ptsOf(fixtures.discharge)));
chk('sparseRatio = sparseOf 阈值一致', S.sparseOf(S.ptsOf(fixtures.sparse)) === (S.sparseRatio(S.ptsOf(fixtures.sparse)) > 0.55));

// ---------- 6. deviceStats 的 status / display（服务端定死文案） ----------
function dev(name, hist, opts) {
  const rec = { updatedAt: new Date(T0 + 3 * H).toISOString(), level: 0 };
  return S.deviceStats('dev_' + name, '设备 ' + name, hist, rec, T0 + 3 * H + 60000, 7 * 24 * H, opts || {});
}
const cases = [
  ['charging', fixtures.charging, 'charging'],
  ['inferred', fixtures.climbNoC, 'inferredCharging'],
  ['full', fixtures.fullIdle, 'full'],
  ['fullChg', fixtures.full, 'charging'],
  ['sparse', fixtures.sparse, 'sparse'],
  ['flat', fixtures.flat, 'insufficient'],
  ['discharge', fixtures.discharge, 'discharging'],
  ['empty', fixtures.empty, 'noData']
];
for (const [n, hist, want] of cases) {
  const d = dev(n, hist);
  chk('status/' + n + ' = ' + want, d.status === want, d.status);
  chk('display/' + n + ' 有 title', typeof d.display.title === 'string' && d.display.title.length > 0, d.display.title);
  chk('display/' + n + ' 有 subtitle', typeof d.display.subtitle === 'string' && d.display.subtitle.length > 0, d.display.subtitle);
  chk('display/' + n + ' lines 1~5 行', Array.isArray(d.display.lines) && d.display.lines.length >= 1 && d.display.lines.length <= 5, d.display && d.display.lines && d.display.lines.length);
  chk('display/' + n + ' 无破折号凑数', !/约\s*—/.test(d.display.subtitle), d.display.subtitle);
  chk('display/' + n + ' 无 undefined', !JSON.stringify(d.display).includes('undefined'), JSON.stringify(d.display));
  chk('display/' + n + ' 不含 emoji', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(d.display.title + d.display.subtitle), d.display.title);
  console.log('  [' + n + '] ' + d.status + ' | ' + d.display.title + ' | ' + d.display.subtitle);
}

// ---------- 7. points=1 的曲线抽稀 ----------
const many = [];
for (let i = 0; i < 2000; i++) many.push({ t: T0 + i * 60000, l: 100 - Math.floor(i / 40) });
const dv = dev('curve', many, { points: true });
chk('curve 存在', Array.isArray(dv.curve), typeof dv.curve);
chk('curve <= 240 点', dv.curve.length <= 240, dv.curve.length);
const view = S.cyclePts(S.ptsOf(many));
chk('curve 保留首点（视窗首点）', dv.curve[0][0] === view[0].t, dv.curve[0][0] + ' vs ' + view[0].t);
chk('curve 时间递增', dv.curve.every((p, i) => i === 0 || p[0] > dv.curve[i - 1][0]));
chk('curve 保留末点', dv.curve[dv.curve.length - 1][0] === many[many.length - 1].t);
chk('curve 每项 [t,l]', dv.curve.every(p => Array.isArray(p) && p.length === 2 && typeof p[1] === 'number'));

console.log('\npass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
