// 文档一致性：/docs 页面 + 仓库 md 必须与新契约一致
import fs from 'fs';
import { docsPage, devPage } from './dev.js';

let pass = 0, fail = 0;
const chk = (n, c, e) => (c ? pass++ : (fail++, console.log('FAIL ' + n + (e !== undefined ? ' :: ' + String(e).slice(0, 120) : ''))));
const read = p => fs.readFileSync(process.cwd() + '/docs/' + p, 'utf8');

const docs = await (await docsPage()).text();
const dev = await (await devPage()).text();

// ---- /docs ----
chk('/docs 有预测统计接口一节', docs.includes('预测统计接口 /dash/stats'));
chk('/docs 不再是「预测算法（v11.5」', !docs.includes('7 · 预测算法（v11.5'));
chk('/docs 硬约束改成十条', docs.includes('十条硬约束'));
chk('/docs 有 C9', docs.includes('C9 预测只许调接口'));
chk('/docs 有 C10', docs.includes('C10 小组件必须自动刷新'));
chk('/docs 有小组件刷新节', docs.includes('9 · 小组件自动刷新'));
chk('/docs 写到 policy: .after', docs.includes('policy: .after'));
chk('/docs 写到 reloadAllTimelines', docs.includes('reloadAllTimelines'));
chk('/docs 有 gapRatio', docs.includes('gapRatio'));
chk('/docs 有七值 status noData', docs.includes('noData'));
chk('/docs 版本表有 v11.6', docs.includes('<b>v11.6</b>'));
chk('/docs 版本节改为 11', docs.includes('11 · 版本'));
chk('/docs 接口表有 /dash/stats', docs.includes('/dash/stats?key=&amp;range='));
chk('/docs 提到 API_STATS', docs.includes('API_STATS.md'));
chk('/docs 无 emoji', !/[\u{1F300}-\u{1FAFF}]/u.test(docs));
chk('/docs 不承诺每分钟同步', !/每分钟同步/.test(docs.replace(/不[许能可]承诺[^<]*|不承诺[^<]*/g, '')));
chk('/docs 是完整 HTML', docs.trim().endsWith('</html>'));
chk('/dev 也能打开', dev.length > 1000 && dev.includes('各端状态'));

// ---- 仓库 md ----
const ios = read('IOS_PROMPT.md'), ipad = read('IPAD_AGENT_PROMPT.md');
const api = read('API_STATS.md'), req = read('REQUIREMENTS.md'), tech = read('TECH.md');

for (const [n, t] of [['iOS', ios], ['iPad', ipad]]) {
  chk(n + ' 含 /dash/stats', t.includes('/dash/stats'));
  chk(n + ' 含 reloadAllTimelines', t.includes('reloadAllTimelines'));
  chk(n + ' 含 policy: .after', t.includes('.after'));
  chk(n + ' 要求放置 1 小时自动刷新', /1 小时以上/.test(t));
  chk(n + ' 明确禁止自研算法', /禁止自研|不许自己算|不写算法|只调接口/.test(t));
  chk(n + ' 不再要求跑 13 组用例', !/移植完必须逐条跑过这 13 组用例/.test(t));
  chk(n + ' 不再要求 DurationEstimator 单测', !/DurationEstimator` 的单元测试/.test(t));
}
chk('iOS 有 §5.5 自动刷新硬条款', ios.includes('5.5 自动刷新'));
chk('iPad 不再有 AlgorithmTests', !ipad.includes('AlgorithmTests'));
chk('iPad 有 StatsModels', ipad.includes('StatsModels'));

chk('API_STATS 存在且含七值', ['noData','inferredCharging','insufficient','gapRatio'].every(k => api.includes(k)));
chk('API_STATS 写清 curve 上限 240', api.includes('240'));
chk('API_STATS 写清 lines 1–5 行', api.includes('1–5 行'));
chk('REQUIREMENTS FR-7.1 是自动刷新', req.includes('FR-7.1 **必须自动刷新'));
chk('REQUIREMENTS FR-7.4 是服务端口径化', req.includes('FR-7.4 **预测口径已服务端化'));
chk('TECH 有 11.6 节', tech.includes('### 11.6 预测统计服务端口径化'));
chk('TECH 写了交叉一致性测试', tech.includes('test_cross.mjs'));
chk('TECH 写了三条文案坑', tech.includes('约 —后充满'));

console.log('\npass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
