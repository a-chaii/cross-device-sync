// HTTP 层：/dash/stats 路由契约（鉴权、参数、返回形状、CORS、排序）
import mod from './index.js';
const handler = mod.fetch ? mod.fetch.bind(mod) : mod;

let pass = 0, fail = 0;
const chk = (n, c, e) => (c ? pass++ : (fail++, console.log('FAIL ' + n + (e !== undefined ? ' :: ' + e : ''))));

const T0 = Date.now();
const H = 3600000;
const TOKEN = 'tok_test_123';

function mkEnv() {
  const store = new Map();
  const put = (k, v) => store.set(k, { v, updatedAt: new Date(v && v.updatedAtMs ? v.updatedAtMs : T0).toISOString() });
  put('watch/battery', { updatedAtMs: T0 - 60000, value: { level: 62 } });
  put('@hist:watch/battery', [
    { t: T0 - 6 * H, l: 80 }, { t: T0 - 5 * H, l: 76 }, { t: T0 - 4 * H, l: 72 },
    { t: T0 - 3 * H, l: 68 }, { t: T0 - 2 * H, l: 64 }, { t: T0 - 60000, l: 62 }
  ]);
  put('phone/battery', { updatedAtMs: T0 - 2 * H, value: { level: 91 } });
  put('@hist:phone/battery', [{ t: T0 - 5 * H, l: 95 }, { t: T0 - 2 * H, l: 91 }]);
  put('@meta', { updatedAtMs: T0, value: {} });

  return {
    SYNC_TOKEN: TOKEN,
    ALLOW_ORIGIN: 'https://example.com',
    SYNC_KV: {
      async get(k, type) {
        const e = store.get(k);
        if (!e) return null;
        return type === 'json' ? JSON.parse(JSON.stringify(e.v)) : JSON.stringify(e.v);
      },
      async put(k, v) { store.set(k, { v: JSON.parse(v), updatedAt: new Date().toISOString() }); },
      async delete(k) { store.delete(k); },
      async list({ prefix, limit } = {}) {
        const keys = [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).slice(0, limit || 1000)
          .map(k => ({ name: k, metadata: { updatedAt: store.get(k).updatedAt } }));
        return { keys, list_complete: true, cursor: null };
      }
    }
  };
}

const B = 'https://a-chai.de5.net';
const call = async (path, token = TOKEN) => {
  const headers = {};
  if (token) headers['x-sync-token'] = token;
  const res = await handler(new Request(B + path, { headers }), mkEnv(), {});
  let body = null;
  try { body = await res.clone().json(); } catch { body = null; }
  return { res, body };
};

// 1. 鉴权
let r = await call('/dash/stats?key=watch/battery', null);
chk('无 token 401', r.res.status === 401, r.res.status);
chk('401 带 CORS', r.res.headers.get('access-control-allow-origin') === 'https://example.com', r.res.headers.get('access-control-allow-origin'));
r = await call('/dash/stats?key=watch/battery', 'wrong');
chk('错 token 401', r.res.status === 401, r.res.status);

// 2. 单设备
r = await call('/dash/stats?key=watch/battery');
chk('单设备 200', r.res.status === 200, r.res.status);
chk('content-type json', (r.res.headers.get('content-type') || '').includes('application/json'), r.res.headers.get('content-type'));
chk('no-store', r.res.headers.get('cache-control') === 'no-store', r.res.headers.get('cache-control'));
chk('返回 key', r.body.key === 'watch/battery', r.body.key);
chk('有 device', !!r.body.device, Object.keys(r.body));
chk('retentionMs = 7 天', r.body.retentionMs === 7 * 24 * H, r.body.retentionMs);
chk('level = 62', r.body.device.level === 62, r.body.device.level);
chk('status = discharging', r.body.device.status === 'discharging', r.body.device.status);
chk('display.title 是掉电', /^掉电 /.test(r.body.device.display.title), r.body.device.display.title);
chk('display.subtitle 还剩', /^还剩 |^续航待估/.test(r.body.device.display.subtitle), r.body.device.display.subtitle);
chk('display.lines 1~5 行', r.body.device.display.lines.length >= 1 && r.body.device.display.lines.length <= 5, r.body.device.display.lines.length);
chk('discharge.rate 正数', r.body.device.discharge.rate > 0, r.body.device.discharge.rate);
chk('无 curve（未传 points）', r.body.device.curve === undefined, typeof r.body.device.curve);
chk('charging.on=false', r.body.device.charging.on === false);

// 3. points=1
r = await call('/dash/stats?key=watch/battery&points=1');
chk('points=1 出 curve', Array.isArray(r.body.device.curve), typeof r.body.device.curve);
chk('curve 6 点', r.body.device.curve.length === 6, r.body.device.curve.length);
chk('curve 项为 [t,l]', r.body.device.curve.every(p => p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number'));

// 4. 全部设备
r = await call('/dash/stats');
chk('多设备 key=*', r.body.key === '*', r.body.key);
chk('多设备 count=2', r.body.count === 2, r.body.count);
chk('多设备按链路时间倒序', r.body.devices[0].key === 'watch/battery' && r.body.devices[1].key === 'phone/battery', r.body.devices.map(d => d.key).join(','));
chk('内部键被过滤', !r.body.devices.some(d => d.key.charAt(0) === '@'));

// 5. 非法 key
r = await call('/dash/stats?key=' + encodeURIComponent('bad key!'));
chk('非法字符 400', r.res.status === 400 && r.body.error === 'invalid_key', r.res.status + '/' + JSON.stringify(r.body));
r = await call('/dash/stats?key=' + encodeURIComponent('@hist:watch/battery'));
chk('内部键拒绝 400', r.res.status === 400 && r.body.error === 'invalid_key', r.res.status);
r = await call('/dash/stats?key=' + 'a'.repeat(300));
chk('超长 key 400', r.res.status === 400, r.res.status);

// 6. range / all
r = await call('/dash/stats?key=watch/battery&range=' + 2 * H);
chk('range 生效', r.body.rangeMs === 2 * H, r.body.rangeMs);
chk('range 后点数变少', r.body.device.discharge.points < 6, r.body.device.discharge.points);
r = await call('/dash/stats?key=watch/battery&range=99999999999');
chk('range 上限截断', r.body.rangeMs === 7 * 24 * H, r.body.rangeMs);
r = await call('/dash/stats?key=watch/battery&all=1');
chk('all=1 视窗 all', r.body.device.view === 'all', r.body.device.view);
r = await call('/dash/stats?key=watch/battery');
chk('默认视窗 cycle', r.body.device.view === 'cycle', r.body.device.view);

// 7. 不存在的设备
r = await call('/dash/stats?key=dev/abcd');
chk('不存设备 200', r.res.status === 200, r.res.status);
chk('不存设备 status=noData', r.body.device.status === 'noData', r.body.device.status);
chk('不存设备 display 无数据', r.body.device.display.title === '无数据', r.body.device.display.title);

console.log('\npass=' + pass + ' fail=' + fail);
if (fail) process.exit(1);
