/**
 * WatchSync · 中转数据看板（单文件，零外部依赖）
 *
 * 路由：
 *   GET  /dash          -> 未登录给登录页，已登录给看板
 *   POST /dash          -> 提交密码（form: pwd=xxx），成功后种 cookie 并 303 回 /dash
 *   GET  /dash/data     -> 看板数据（JSON，需 cookie）
 *
 * 密码：环境变量 DASH_PWD，未设置时回退到 114514。
 * Cookie：ws_dash=<sha256(DASH_PWD|SYNC_TOKEN)>，无法被伪造（依赖服务端密钥）。
 *
 * 历史：每次 PUT 成功后由 index.ts 调 appendHist() 采样写入 KV 的 @hist:<key>，
 *      环形保留最近 HIST_LIMIT 条；对外 API 屏蔽 @ 前缀键。
 */

const COOKIE = 'ws_dash';
const HIST_LIMIT = 2000;
const GAP_SAMPLE_MS = 30 * 60 * 1000; // 数值没变化时，最多 30 分钟补一个采样点

export interface DashEnv {
  SYNC_KV: KVNamespace;
  SYNC_TOKEN: string;
  DASH_PWD?: string;
}

export interface Sample {
  t: number;
  l: number | null;
  c: number | null;
  v: number;
}

function pwdOf(env: DashEnv): string {
  const p = env.DASH_PWD;
  return p && p.length > 0 ? p : '114514';
}

function histKey(key: string): string {
  return '@hist:' + key;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

async function tokenOf(env: DashEnv): Promise<string> {
  return sha256Hex('ws-dash-v1|' + pwdOf(env) + '|' + (env.SYNC_TOKEN || ''));
}

function equalConst(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie') || '';
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.indexOf(name + '=') === 0) return p.slice(name.length + 1);
  }
  return null;
}

/** 是否已通过看板鉴权 */
export async function check(req: Request, env: DashEnv): Promise<boolean> {
  const got = readCookie(req, COOKIE);
  if (!got) return false;
  return equalConst(got, await tokenOf(env));
}

/** 从上报值里挖数字字段（兼容 {level} / {watch:{level}} / {value} 等形状） */
function pickNum(value: unknown, field: string): number | null {
  try {
    const v = value as Record<string, unknown> | null;
    if (!v || typeof v !== 'object') return null;
    const direct = v[field];
    if (typeof direct === 'number') return direct;
    const w = v.watch as Record<string, unknown> | undefined;
    if (w && typeof w === 'object' && typeof w[field] === 'number') return w[field] as number;
    const inner = v.value as Record<string, unknown> | undefined;
    if (inner && typeof inner === 'object' && typeof inner[field] === 'number') return inner[field] as number;
    return null;
  } catch {
    return null;
  }
}

/** 记录一次采样（在 PUT 成功后调用，建议塞进 waitUntil） */
export async function appendHist(
  env: DashEnv,
  key: string,
  value: unknown,
  version: number,
): Promise<void> {
  try {
    const hk = histKey(key);
    const prev = (await env.SYNC_KV.get(hk, 'json')) as Sample[] | null;
    const arr: Sample[] = Array.isArray(prev) ? prev.slice() : [];
    const l = pickNum(value, 'level');
    const c = pickNum(value, 'charging');
    const t = Date.now();
    const last = arr.length > 0 ? arr[arr.length - 1] : null;
    if (last && last.l === l && last.c === c && t - last.t < GAP_SAMPLE_MS) return;
    arr.push({ t, l, c, v: version });
    while (arr.length > HIST_LIMIT) arr.shift();
    await env.SYNC_KV.put(hk, JSON.stringify(arr), {
      metadata: { updatedAt: new Date().toISOString() },
    });
  } catch {
    // 历史采样失败绝不影响主写入
  }
}

/** 看板数据接口 */
export async function data(env: DashEnv, key: string, rangeMs: number): Promise<Response> {
  const rec = await env.SYNC_KV.get(key, 'json');
  const histRaw = (await env.SYNC_KV.get(histKey(key), 'json')) as Sample[] | null;
  const hist = Array.isArray(histRaw) ? histRaw : [];

  let keys: string[] = [];
  try {
    const listed = await env.SYNC_KV.list({ limit: 1000 });
    keys = listed.keys.map((k) => k.name).filter((n) => n.charAt(0) !== '@');
  } catch {
    keys = [];
  }

  const from = rangeMs > 0 ? Date.now() - rangeMs : 0;
  const view = hist.filter((s) => s.t >= from);

  return new Response(
    JSON.stringify({ key, keys, rec, hist: view, total: hist.length, now: Date.now() }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    },
  );
}

const PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** 登录页 */
export function loginPage(err?: string): Response {
  return new Response(loginHtml(err), { status: err ? 401 : 200, headers: PAGE_HEADERS });
}

/** 处理登录提交 */
export async function handleLogin(req: Request, env: DashEnv): Promise<Response> {
  const body = await req.text();
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  let pwd = '';
  if (ct.indexOf('application/json') >= 0) {
    try {
      pwd = String((JSON.parse(body) || {}).pwd || '');
    } catch {
      pwd = '';
    }
  } else {
    try {
      pwd = new URLSearchParams(body).get('pwd') || '';
    } catch {
      pwd = '';
    }
  }

  const want = pwdOf(env);
  if (want.length === pwd.length && equalConst(pwd, want)) {
    const token = await tokenOf(env);
    return new Response(null, {
      status: 303,
      headers: {
        location: '/dash',
        'set-cookie': COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000',
        'cache-control': 'no-store',
      },
    });
  }
  return loginPage('密码不对，再想想');
}

/** 看板页 */
export function page(): Response {
  return new Response(dashHtml(), { status: 200, headers: PAGE_HEADERS });
}

function loginHtml(err?: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex,nofollow">
<title>中转看板 · 登录</title>
<style>
  :root{--bg:#0b0f19;--card:rgba(18,24,38,.82);--line:rgba(120,150,255,.16);
        --txt:#e6ecf8;--muted:#8b98b3;--blue:#3b82f6;--red:#f87171}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;display:flex;align-items:center;justify-content:center;
       background:radial-gradient(900px 500px at 50% -10%,#16233f 0%,var(--bg) 60%);
       color:var(--txt);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
       padding:24px}
  .box{width:100%;max-width:22rem;background:var(--card);border:1px solid var(--line);
       border-radius:18px;padding:26px 22px;backdrop-filter:blur(12px);
       box-shadow:0 24px 60px -20px rgba(0,0,0,.8)}
  h1{font-size:1.05rem;margin:0 0 4px;letter-spacing:.02em}
  p.sub{margin:0 0 18px;color:var(--muted);font-size:.8rem;line-height:1.6}
  label{display:block;font-size:.75rem;color:var(--muted);margin-bottom:6px}
  input{width:100%;padding:11px 13px;border-radius:11px;border:1px solid var(--line);
        background:rgba(8,12,22,.7);color:var(--txt);font-size:1rem;letter-spacing:.14em;
        outline:none;transition:border-color .15s}
  input:focus{border-color:rgba(59,130,246,.65)}
  button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:11px;cursor:pointer;
         background:linear-gradient(180deg,#3b82f6,#2563eb);color:#fff;font-size:.95rem;
         font-weight:600;transition:filter .15s}
  button:hover{filter:brightness(1.08)}
  .err{margin-top:12px;color:var(--red);font-size:.8rem}
</style>
</head>
<body>
<form class="box" method="POST" action="/dash" autocomplete="off">
  <h1>中转看板</h1>
  <p class="sub">仅用于查看跨端同步服务经过的数据统计。</p>
  <label for="pwd">访问密码</label>
  <input id="pwd" name="pwd" type="password" inputmode="numeric" autofocus
         placeholder="pwd" required>
  <button type="submit">进入</button>
  ${err ? '<div class="err">' + err + '</div>' : ''}
</form>
</body>
</html>`;
}

function dashHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex,nofollow">
<title>中转看板 · WatchSync</title>
<style>
  :root{--bg:#0b0f19;--card:rgba(18,24,38,.72);--line:rgba(120,150,255,.14);
        --txt:#e6ecf8;--muted:#8b98b3;--blue:#3b82f6;--green:#34d399;--amber:#fbbf24;
        --red:#f87171;--cyan:#22d3ee}
  *{box-sizing:border-box}
  body{margin:0;background:
        radial-gradient(1000px 520px at 12% -8%,#16233f 0%,transparent 62%),
        radial-gradient(900px 480px at 100% 0%,#1a1533 0%,transparent 58%),
        var(--bg);
       color:var(--txt);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
       min-height:100vh;padding:18px 16px 40px}
  .wrap{max-width:64rem;margin:0 auto}
  header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;
         margin-bottom:16px}
  .brand{font-size:1.02rem;font-weight:650;letter-spacing:.01em}
  .brand span{color:var(--muted);font-weight:400;font-size:.78rem;margin-left:8px}
  .actions{display:flex;gap:8px;flex-wrap:wrap}
  select,button{font:inherit;font-size:.8rem;color:var(--txt);background:rgba(8,12,22,.7);
       border:1px solid var(--line);border-radius:10px;padding:7px 10px;cursor:pointer;
       outline:none}
  select:focus{border-color:rgba(59,130,246,.6)}
  button.primary{background:linear-gradient(180deg,#3b82f6,#2563eb);border:0;font-weight:600}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:10px;
         margin-bottom:12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 14px;
        backdrop-filter:blur(10px)}
  .card .k{font-size:.7rem;color:var(--muted);letter-spacing:.04em;margin-bottom:6px}
  .card .v{font-size:1.45rem;font-weight:650;line-height:1.1;font-variant-numeric:tabular-nums}
  .card .v small{font-size:.72rem;font-weight:400;color:var(--muted);margin-left:3px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px 14px 10px;
         backdrop-filter:blur(10px);margin-bottom:12px}
  .panel h2{font-size:.82rem;margin:0 0 10px;font-weight:600;color:#cdd8ee;letter-spacing:.02em}
  .panel h2 em{font-style:normal;color:var(--muted);font-weight:400;font-size:.72rem;margin-left:8px}
  canvas{width:100%;display:block}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media (max-width:760px){.grid2{grid-template-columns:1fr}}
  table{width:100%;border-collapse:collapse;font-size:.78rem;font-variant-numeric:tabular-nums}
  th,td{text-align:left;padding:6px 4px;border-bottom:1px solid rgba(120,150,255,.09)}
  th{color:var(--muted);font-weight:500;font-size:.72rem}
  tbody tr:last-child td{border-bottom:0}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;
       vertical-align:middle}
  .empty{color:var(--muted);font-size:.8rem;padding:16px 4px}
  footer{color:var(--muted);font-size:.72rem;text-align:center;margin-top:16px;line-height:1.7}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">中转数据看板<span id="hint">加载中…</span></div>
    <div class="actions">
      <select id="key" title="数据键"></select>
      <select id="range" title="时间范围">
        <option value="10800000">3 小时</option>
        <option value="21600000" selected>6 小时</option>
        <option value="86400000">24 小时</option>
        <option value="604800000">7 天</option>
        <option value="0">全部</option>
      </select>
      <button class="primary" id="refresh">刷新</button>
    </div>
  </header>

  <section class="cards" id="cards"></section>

  <section class="panel">
    <h2>电量曲线<em id="chartHint"></em></h2>
    <canvas id="chart" height="260"></canvas>
  </section>

  <div class="grid2">
    <section class="panel">
      <h2>上报频次<em>24 小时内每小时样本数</em></h2>
      <canvas id="bars" height="170"></canvas>
    </section>
    <section class="panel">
      <h2>最近记录</h2>
      <div id="table"></div>
    </section>
  </div>

  <footer>
    数据来自 Workers KV · 每 60 秒自动刷新<br>
    <span id="stamp"></span>
  </footer>
</div>
<script>
var DATA = null;
var KEY = 'watch/battery';

function $(id){ return document.getElementById(id); }

function pad(n){ return (n < 10 ? '0' : '') + n; }

function hhmm(t){
  var d = new Date(t);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function dt(t){
  var d = new Date(t);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hhmm(t);
}

function ago(t){
  var s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}

function num(x, d){
  return (x === null || x === undefined || isNaN(x)) ? '—' : Number(x).toFixed(d === undefined ? 0 : d);
}

function card(k, v, sub){
  return '<div class="card"><div class="k">' + k + '</div><div class="v">' + v +
         (sub ? '<small>' + sub + '</small>' : '') + '</div></div>';
}

function levelOf(sample){
  return sample.l === null || sample.l === undefined ? null : sample.l;
}

function renderCards(){
  var rec = DATA ? DATA.rec : null;
  var hist = (DATA && DATA.hist) ? DATA.hist : [];
  var v = (rec && rec.value) ? rec.value : {};
  var lv = null;
  if (v.level !== undefined && v.level !== null) lv = v.level;
  else if (v.watch && v.watch.level !== undefined && v.watch.level !== null) lv = v.watch.level;
  var ch = 0;
  if (v.charging !== undefined && v.charging !== null) ch = v.charging;
  else if (v.watch && v.watch.charging !== undefined && v.watch.charging !== null) ch = v.watch.charging;

  var out = '';
  out += card('当前电量', num(lv) + '%', ch === 1 ? '充电中' : '');
  out += card('写入版本', rec ? rec.version : '—', '');
  out += card('最后上报', rec ? ago(Date.parse(rec.updatedAt)) : '—', '');
  out += card('样本数', hist.length, '共 ' + (DATA ? DATA.total : 0) + ' 条');

  // 间隔与断档
  var pts = hist.filter(function(s){ return levelOf(s) !== null; });
  var gaps = [];
  for (var i = 1; i < pts.length; i++) {
    var g = pts[i].t - pts[i - 1].t;
    if (g > 0) gaps.push(g);
  }
  var avgGap = null, maxGap = null;
  if (gaps.length) {
    var sum = 0;
    for (var j = 0; j < gaps.length; j++) sum += gaps[j];
    avgGap = sum / gaps.length;
    maxGap = Math.max.apply(null, gaps);
  }
  out += card('平均间隔', avgGap === null ? '—' : Math.round(avgGap / 60000),
              avgGap === null ? '' : '分钟');
  out += card('最长断档', maxGap === null ? '—' : Math.round(maxGap / 60000),
              maxGap === null ? '' : '分钟');

  // 耗电速率与续航：用首尾两点算
  var rate = null, hours = null, left = null;
  if (pts.length >= 2) {
    var a = pts[0], b = pts[pts.length - 1];
    hours = (b.t - a.t) / 3600000;
    if (hours > 0.5) {
      var dl = levelOf(a) - levelOf(b);
      if (dl > 0) {
        rate = dl / hours;
        left = levelOf(b) / rate;
      }
    }
  }
  out += card('耗电速率', rate === null ? '—' : num(rate, 2), rate === null ? '' : '%/时');
  out += card('预计续航', left === null ? '—' : num(left, 1), left === null ? '' : '小时');

  $('cards').innerHTML = out;
}

function drawLine(){
  var c = $('chart');
  var dpr = window.devicePixelRatio || 1;
  var w = c.clientWidth || 600;
  var h = 260;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  var g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  var hist = (DATA && DATA.hist) ? DATA.hist : [];
  var pts = hist.filter(function(s){ return levelOf(s) !== null && levelOf(s) >= 0; });

  var pl = 34, pr = 10, pt = 8, pb = 22;
  var iw = w - pl - pr, ih = h - pt - pb;

  g.font = '10px ui-sans-serif,system-ui';
  g.strokeStyle = 'rgba(120,150,255,.12)';
  g.fillStyle = '#8b98b3';
  g.lineWidth = 1;
  for (var i = 0; i <= 4; i++) {
    var y = pt + ih * (i / 4);
    g.beginPath();
    g.moveTo(pl, y);
    g.lineTo(w - pr, y);
    g.stroke();
    g.fillText(String(100 - i * 25), 8, y + 3);
  }

  if (pts.length === 0) {
    g.fillStyle = '#8b98b3';
    g.fillText('这个范围内还没有样本', pl, pt + ih / 2);
    $('chartHint').textContent = '';
    return;
  }

  var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  if (t1 - t0 < 60000) { t1 = t0 + 60000; }

  function X(t){ return pl + (t - t0) / (t1 - t0) * iw; }
  function Y(v){ return pt + (1 - v / 100) * ih; }

  var grad = g.createLinearGradient(0, pt, 0, pt + ih);
  grad.addColorStop(0, 'rgba(59,130,246,.35)');
  grad.addColorStop(1, 'rgba(59,130,246,0)');

  g.beginPath();
  g.moveTo(X(pts[0].t), Y(levelOf(pts[0])));
  for (var k = 1; k < pts.length; k++) g.lineTo(X(pts[k].t), Y(levelOf(pts[k])));
  g.lineTo(X(pts[pts.length - 1].t), pt + ih);
  g.lineTo(X(pts[0].t), pt + ih);
  g.closePath();
  g.fillStyle = grad;
  g.fill();

  g.beginPath();
  g.moveTo(X(pts[0].t), Y(levelOf(pts[0])));
  for (var m = 1; m < pts.length; m++) g.lineTo(X(pts[m].t), Y(levelOf(pts[m])));
  g.strokeStyle = '#60a5fa';
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.stroke();

  var lastP = pts[pts.length - 1];
  g.beginPath();
  g.arc(X(lastP.t), Y(levelOf(lastP)), 3.2, 0, Math.PI * 2);
  g.fillStyle = '#60a5fa';
  g.fill();

  g.fillStyle = '#8b98b3';
  g.fillText(dt(t0), pl, h - 6);
  var endLabel = dt(t1);
  g.fillText(endLabel, w - pr - g.measureText(endLabel).width, h - 6);

  $('chartHint').textContent = pts.length + ' 个点 / ' + (DATA && DATA.key ? DATA.key : '');
}

function drawBars(){
  var c = $('bars');
  var dpr = window.devicePixelRatio || 1;
  var w = c.clientWidth || 420;
  var h = 170;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  var g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  var hist = (DATA && DATA.hist) ? DATA.hist : [];
  var now = Date.now();
  var BUCKETS = 24;
  var span = 3600000;
  var counts = [];
  for (var i = 0; i < BUCKETS; i++) counts.push(0);
  for (var j = 0; j < hist.length; j++) {
    var idx = BUCKETS - 1 - Math.floor((now - hist[j].t) / span);
    if (idx >= 0 && idx < BUCKETS) counts[idx]++;
  }

  var max = 1;
  for (var k = 0; k < counts.length; k++) if (counts[k] > max) max = counts[k];

  var pl = 18, pr = 6, pt = 8, pb = 18;
  var iw = w - pl - pr, ih = h - pt - pb;
  var bw = iw / BUCKETS;

  g.font = '9px ui-sans-serif,system-ui';
  for (var b = 0; b < BUCKETS; b++) {
    var bh = counts[b] / max * ih;
    var x = pl + b * bw;
    g.fillStyle = counts[b] > 0 ? 'rgba(59,130,246,.85)' : 'rgba(120,150,255,.10)';
    g.fillRect(x + 1, pt + ih - Math.max(bh, counts[b] > 0 ? 2 : 1), bw - 2, Math.max(bh, counts[b] > 0 ? 2 : 1));
  }

  g.strokeStyle = 'rgba(120,150,255,.16)';
  g.beginPath();
  g.moveTo(pl, pt + ih + .5);
  g.lineTo(w - pr, pt + ih + .5);
  g.stroke();

  g.fillStyle = '#8b98b3';
  g.fillText('24h 前', pl, h - 5);
  var t2 = '现在';
  g.fillText(t2, w - pr - g.measureText(t2).width, h - 5);
  g.fillText('峰值 ' + max, pl + 2, pl + 4);
}

function renderTable(){
  var hist = (DATA && DATA.hist) ? DATA.hist : [];
  var rows = hist.slice(-14).reverse();
  if (rows.length === 0) {
    $('table').innerHTML = '<div class="empty">还没有采样记录</div>';
    return;
  }
  var html = '<table><thead><tr><th>时间</th><th>电量</th><th>状态</th><th>版本</th></tr></thead><tbody>';
  for (var i = 0; i < rows.length; i++) {
    var s = rows[i];
    var dot = s.c === 1 ? '#34d399' : '#8b98b3';
    var st = s.c === 1 ? '充电' : '放电';
    html += '<tr><td>' + dt(s.t) + '</td><td>' + num(levelOf(s)) + '%</td>' +
            '<td><span class="dot" style="background:' + dot + '"></span>' + st + '</td>' +
            '<td>' + s.v + '</td></tr>';
  }
  html += '</tbody></table>';
  $('table').innerHTML = html;
}

function renderAll(){
  renderCards();
  drawLine();
  drawBars();
  renderTable();
  if (DATA && DATA.rec) {
    $('hint').textContent = DATA.key + ' · ' + ago(Date.parse(DATA.rec.updatedAt)) + '更新';
  }
  $('stamp').textContent = '最近刷新 ' + dt(Date.now());
}

function loadKeys(){
  if (!DATA || !DATA.keys) return;
  var sel = $('key');
  var cur = KEY;
  var html = '';
  for (var i = 0; i < DATA.keys.length; i++) {
    var k = DATA.keys[i];
    html += '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + k + '</option>';
  }
  sel.innerHTML = html;
}

function load(){
  var range = Number($('range').value);
  fetch('/dash/data?key=' + encodeURIComponent(KEY) + '&range=' + range, { credentials: 'same-origin' })
    .then(function(r){
      if (r.status === 401) { location.href = '/dash'; throw new Error('unauthorized'); }
      return r.json();
    })
    .then(function(d){
      DATA = d;
      loadKeys();
      renderAll();
    })
    .catch(function(){ $('hint').textContent = '加载失败'; });
}

$('refresh').addEventListener('click', load);
$('range').addEventListener('change', load);
$('key').addEventListener('change', function(){ KEY = $('key').value; load(); });

load();
setInterval(load, 60000);
</script>
</body>
</html>`;
}
