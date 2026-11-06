/**
 * WatchSync · 中转数据看板（单文件，零外部依赖）
 *
 * 路由：
 *   GET  /dash          -> 未登录给登录页，已登录给看板
 *   POST /dash          -> 提交密码（form: pwd=xxx），成功后种 cookie 并 303 回 /dash
 *   GET  /dash/data     -> 看板数据（JSON，需 cookie）；key=* 表示多设备总览
 *
 * 密码：环境变量 DASH_PWD，未设置时回退到 114514。
 * Cookie：ws_dash=<sha256(DASH_PWD|SYNC_TOKEN)>，无法被伪造（依赖服务端密钥）。
 *
 * 历史：每次 PUT 成功后由 index.ts 调 appendHist() 采样写入 KV 的 @hist:<key>，
 *      环形保留最近 HIST_LIMIT 条；对外 API 屏蔽 @ 前缀键。
 *
 * 设备模型（v2）：一台设备一个键，历史天然隔离
 *   watch/battery           手表（兼容旧客户端，键名保留）
 *   dev/<mac 去冒号小写>     其它蓝牙设备（耳机/音箱/手环…）
 */
const COOKIE = 'ws_dash';
const HIST_LIMIT = 2000;
const GAP_SAMPLE_MS = 30 * 60 * 1000; // 数值没变化时，最多 30 分钟补一个采样点
const MAX_DEVICES = 12; // 总览最多展开多少台设备（控制 KV 读次数）
const DEVICE_HIST_CAP = 900; // 单设备下发给前端的最大点数

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
  s?: string | null;
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

/** 从上报值里挖原始字段（兼容 {level} / {watch:{level}} / {value:{level}} 等形状） */
function pickRaw(value: unknown, field: string): unknown {
  try {
    const v = value as Record<string, unknown> | null;
    if (!v || typeof v !== 'object') return undefined;
    if (field in v) return v[field];
    const w = v.watch as Record<string, unknown> | undefined;
    if (w && typeof w === 'object' && field in w) return w[field];
    const inner = v.value as Record<string, unknown> | undefined;
    if (inner && typeof inner === 'object' && field in inner) return inner[field];
    return undefined;
  } catch {
    return undefined;
  }
}
function pickNum(value: unknown, field: string): number | null {
  const r = pickRaw(value, field);
  return typeof r === 'number' ? r : null;
}
function pickStr(value: unknown, field: string): string | null {
  const r = pickRaw(value, field);
  return typeof r === 'string' && r.length > 0 ? r : null;
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
    const s = pickStr(value, 'src');
    // 采样时间优先用设备上报的 ts（毫秒），越界则回退到服务端时间
    const now = Date.now();
    const rts = pickNum(value, 'ts');
    let t = now;
    if (rts !== null && rts > 1e12 && rts <= now + 5 * 60 * 1000 && rts > now - 60 * 86400000) {
      t = Math.round(rts);
    }
    const last = arr.length > 0 ? arr[arr.length - 1] : null;
    // 保持时间轴单调，避免补传乱序
    if (last && t < last.t) t = last.t;
    if (last && last.l === l && last.c === c && t - last.t < GAP_SAMPLE_MS) return;
    const one: Sample = { t, l, c, v: version };
    if (s) one.s = s;
    arr.push(one);
    while (arr.length > HIST_LIMIT) arr.shift();
    await env.SYNC_KV.put(hk, JSON.stringify(arr), {
      metadata: { updatedAt: new Date().toISOString() },
    });
  } catch {
    // 历史采样失败绝不影响主写入
  }
}

/** 键名是否代表一台设备的电量记录 */
function isDeviceKey(name: string): boolean {
  if (name === 'watch/battery') return true;
  if (/^dev\/[0-9a-f]{4,32}$/i.test(name)) return true;
  // 兼容未来可能出现的 buds/battery、band/battery 之类
  return /^[a-z][a-z0-9_-]{0,20}\/battery$/.test(name);
}

/** 设备展示名：优先上报里的 name，否则按键名推 */
function labelOf(key: string, value: unknown): string {
  const n = pickStr(value, 'name');
  if (n) return n;
  if (key === 'watch/battery') return '手表';
  const m = /^dev\/([0-9a-f]+)$/i.exec(key);
  if (m) {
    const hex = m[1].toUpperCase();
    return '设备 ' + hex.slice(-6);
  }
  const m2 = /^([a-z][a-z0-9_-]*)\/battery$/i.exec(key);
  if (m2) return m2[1];
  return key;
}

function jsonBody(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function loadHist(env: DashEnv, key: string): Promise<Sample[]> {
  const raw = (await env.SYNC_KV.get(histKey(key), 'json')) as Sample[] | null;
  return Array.isArray(raw) ? raw : [];
}

/** 看板数据接口：key='*' 时返回多设备总览 */
export async function data(env: DashEnv, key: string, rangeMs: number): Promise<Response> {
  let allKeys: string[] = [];
  try {
    const listed = await env.SYNC_KV.list({ limit: 1000 });
    allKeys = listed.keys.map((k) => k.name).filter((n) => n.charAt(0) !== '@');
  } catch {
    allKeys = [];
  }
  const devKeys = allKeys.filter(isDeviceKey);
  const now = Date.now();
  const from = rangeMs > 0 ? now - rangeMs : 0;
  const cut = (arr: Sample[]): Sample[] => (from > 0 ? arr.filter((s) => s.t >= from) : arr);

  if (key !== '*' && key !== 'all' && key !== '') {
    const rec = await env.SYNC_KV.get(key, 'json');
    const hist = await loadHist(env, key);
    const view = cut(hist);
    return jsonBody({
      key,
      label: labelOf(key, (rec as { value?: unknown } | null)?.value),
      keys: allKeys,
      devices: devKeys,
      rec,
      hist: view,
      total: hist.length,
      now,
    });
  }

  const use = devKeys.slice(0, MAX_DEVICES);
  const items = await Promise.all(
    use.map(async (k) => {
      const rec = (await env.SYNC_KV.get(k, 'json')) as {
        value?: unknown;
        version?: number;
        updatedAt?: string;
      } | null;
      const hist = await loadHist(env, k);
      const view = cut(hist);
      const cap = view.length > DEVICE_HIST_CAP ? view.slice(view.length - DEVICE_HIST_CAP) : view;
      return {
        key: k,
        label: labelOf(k, rec?.value),
        rec,
        hist: cap,
        total: hist.length,
      };
    }),
  );
  return jsonBody({
    key: '*',
    label: '全部设备',
    keys: allKeys,
    devices: devKeys,
    items,
    rec: null,
    hist: [],
    total: 0,
    now,
  });
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
  .back{position:fixed;left:16px;top:16px;z-index:20;display:inline-flex;align-items:center;gap:6px;
        text-decoration:none;color:var(--muted);font-size:.74rem;border:1px solid var(--line);
        background:rgba(18,24,38,.78);border-radius:999px;padding:5px 11px;
        -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
        transition:color .2s,border-color .2s,transform .2s}
  .back:hover{color:var(--txt);border-color:rgba(120,150,255,.34);transform:translateX(-2px)}
  .back:focus-visible{outline:2px solid var(--blue, #3b82f6);outline-offset:2px}
</style>
</head>
<body>
<a class="back" href="/" title="返回控制台">&larr; 控制台</a>
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
<title>中转看板 · 设备续航</title>
<style>
  :root{--bg:#0b0f19;--card:rgba(18,24,38,.82);--line:rgba(120,150,255,.16);
        --txt:#e6ecf8;--muted:#8b98b3;--blue:#3b82f6;--red:#f87171;--green:#34d399}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(900px 500px at 50% -10%,#16233f 0%,var(--bg) 60%);
       background-attachment:fixed;color:var(--txt);
       font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
       padding:18px 14px 42px}
  .wrap{max-width:1080px;margin:0 auto}
  header{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:12px 0 14px}
  h1{font-size:1.05rem;margin:0;letter-spacing:.02em}
  p.sub{margin:3px 0 0;color:var(--muted);font-size:.72rem;line-height:1.5}
  .spacer{flex:1}
  select{appearance:none;background:rgba(18,24,38,.9);color:var(--txt);font-size:.78rem;
         border:1px solid var(--line);border-radius:9px;padding:7px 10px;outline:none}
  select:focus{border-color:rgba(59,130,246,.6)}
  button.ghost{background:rgba(59,130,246,.16);color:#cfe0ff;font-size:.78rem;cursor:pointer;
               border:1px solid rgba(59,130,246,.35);border-radius:9px;padding:7px 12px}
  button.ghost:hover{background:rgba(59,130,246,.26)}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:16px;
         padding:14px 14px 10px;margin-bottom:14px;
         -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
         box-shadow:0 20px 50px -30px rgba(0,0,0,.9)}
  .panel h2{font-size:.86rem;margin:0 0 10px;display:flex;align-items:baseline;gap:8px;
            font-weight:600;letter-spacing:.01em}
  .panel h2 em{font-style:normal;color:var(--muted);font-weight:400;font-size:.7rem}
  .chartwrap{position:relative}
  canvas{width:100%;display:block;touch-action:pan-y}
  .tip{position:absolute;display:none;pointer-events:none;z-index:9;
       background:rgba(8,12,22,.95);border:1px solid rgba(120,150,255,.3);border-radius:9px;
       padding:6px 9px;font-size:.72rem;line-height:1.5;white-space:nowrap;
       box-shadow:0 10px 26px -10px rgba(0,0,0,.9)}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media (max-width:760px){.grid2{grid-template-columns:1fr}}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:10px;
         margin-bottom:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;
        padding:11px 12px 13px;position:relative;overflow:hidden}
  .card .nm{font-size:.74rem;color:var(--muted);margin-bottom:6px;white-space:nowrap;
            overflow:hidden;text-overflow:ellipsis}
  .card .lv{font-size:1.6rem;font-weight:650;letter-spacing:-.02em;line-height:1.1}
  .card .lv i{font-size:.68rem;font-style:normal;color:var(--muted);margin-left:3px;
              font-weight:400}
  .card .mt{margin-top:6px;font-size:.66rem;color:var(--muted);line-height:1.6}
  .card .bar{position:absolute;left:0;bottom:0;height:3px;opacity:.85}
  .legend{display:flex;flex-wrap:wrap;gap:6px 12px;margin:-2px 0 8px;font-size:.7rem}
  .legend b{display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--muted);
            font-weight:400;user-select:none;-webkit-user-select:none}
  .legend b.off{opacity:.35;text-decoration:line-through}
  .legend .tag{font-size:.6rem;color:var(--muted);border:1px solid var(--line);
               border-radius:6px;padding:0 4px;margin-left:2px}
  .chk{display:inline-flex;align-items:center;gap:6px;font-size:.78rem;color:var(--muted);
       cursor:pointer;user-select:none;-webkit-user-select:none;border:1px solid var(--line);
       border-radius:9px;padding:6px 10px;background:rgba(18,24,38,.9)}
  .chk input{accent-color:#3b82f6;margin:0;width:13px;height:13px}
  .chk:hover{color:var(--txt)}
  .statgrp{grid-column:1/-1;display:flex;align-items:center;gap:6px;font-size:.7rem;
           color:var(--muted);border-bottom:1px solid rgba(120,150,255,.18);
           padding-bottom:4px;margin-top:2px}
  .statgrp i{width:7px;height:7px;border-radius:50%;flex:none}
  .legend i{width:8px;height:8px;border-radius:50%;display:inline-block}
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;font-size:.74rem}
  .stats div{display:flex;justify-content:space-between;gap:8px;
             border-bottom:1px dashed rgba(120,150,255,.12);padding-bottom:5px}
  .stats span{color:var(--muted)}
  .tblwrap{max-height:340px;overflow:auto;-webkit-overflow-scrolling:touch}
  table{width:100%;border-collapse:collapse;font-size:.72rem}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid rgba(120,150,255,.1);
        white-space:nowrap}
  th{color:var(--muted);font-weight:500;position:sticky;top:0;background:#101728;z-index:2}
  td.num{font-variant-numeric:tabular-nums}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;
       vertical-align:middle}
  .drop{color:var(--red)}
  .up{color:var(--green)}
  .empty{color:var(--muted);font-size:.76rem;padding:14px 2px}
  footer{color:var(--muted);font-size:.68rem;text-align:center;margin-top:18px;opacity:.7}
  .back{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--muted);
        font-size:.72rem;border:1px solid var(--line);background:rgba(18,24,38,.78);
        border-radius:999px;padding:5px 11px;transition:color .2s,border-color .2s}
  .back:hover{color:var(--txt);border-color:rgba(120,150,255,.34)}
</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="/">&larr; 控制台</a>
  <header>
    <div>
      <h1>设备续航看板</h1>
      <p class="sub" id="meta">加载中…</p>
    </div>
    <div class="spacer"></div>
    <select id="selKey" title="选择设备"></select>
    <select id="selRange" title="时间范围">
      <option value="3600000">近 1 小时</option>
      <option value="10800000">近 3 小时</option>
      <option value="21600000">近 6 小时</option>
      <option value="86400000" selected>近 24 小时</option>
      <option value="259200000">近 3 天</option>
      <option value="604800000">近 7 天</option>
      <option value="2592000000">近 30 天</option>
      <option value="0">全部</option>
    </select>
    <label class="chk" title="勾选后直接取服务器存储的全部历史，且不做「充满电后」裁剪"><input type="checkbox" id="chkAll">全部历史</label>
    <button class="ghost" id="btnReload" type="button">刷新</button>
  </header>
  <div class="cards" id="cards"></div>
  <div class="panel">
    <h2>电量曲线 <em id="chartMeta"></em></h2>
    <div class="legend" id="legend"></div>
    <div class="chartwrap">
      <canvas id="chart" data-h="240"></canvas>
      <div class="tip" id="tip"></div>
    </div>
  </div>
  <div class="grid2">
    <div class="panel">
      <h2>掉电分布 <em>每小时掉电次数</em></h2>
      <div class="chartwrap">
        <canvas id="bars" data-h="168"></canvas>
        <div class="tip" id="tip2"></div>
      </div>
    </div>
    <div class="panel">
      <h2>续航统计 <em id="statMeta"></em></h2>
      <div class="stats" id="stats"></div>
    </div>
  </div>
  <div class="panel">
    <h2>采样日志 <em id="logMeta"></em></h2>
    <div class="tblwrap">
      <table>
        <thead><tr>
          <th>时间</th><th>电量</th><th>变化</th><th>距上次掉电</th><th>状态</th><th title="该设备这条记录被成功写入的次数，去重跳过的采样也会计入，所以不连续">写入序</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>
  <footer>WatchSync · 只读看板 · 每设备独立键位</footer>
</div>
<script>
(function(){
'use strict';
var COLOR=['#60a5fa','#34d399','#fbbf24','#f472b6','#22d3ee','#a78bfa','#fb923c','#4ade80'];
var S={key:'*',range:86400000,data:null,hidden:{},touched:{},all:false};
function $(id){return document.getElementById(id);}
function pad(n){return n<10?'0'+n:''+n;}
function fmtT(t){var d=new Date(t);
  return pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());}
function fmtHm(t){var d=new Date(t);return pad(d.getHours())+':'+pad(d.getMinutes());}
function fmtDur(ms){
  if(ms==null||!isFinite(ms)||ms<0)return '—';
  var s=Math.round(ms/1000);
  if(s<90)return s+' 秒';
  var m=Math.round(s/60);
  if(m<90)return m+' 分';
  var h=Math.floor(s/3600),mm=Math.round((s%3600)/60);
  if(h<48)return h+' 时'+(mm?mm+' 分':'');
  var dd=Math.floor(h/24);
  return dd+' 天'+(h%24?h%24+' 时':'');
}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':'"';});}
function isCh(s){return s.c===1||s.c===true;}
function cyclePts(p){
  if(!p||!p.length)return [];
  var idx=-1,i;
  for(i=p.length-1;i>=0;i--){if(p[i].l>=100){idx=i;break;}}
  if(idx<0){for(i=p.length-1;i>=0;i--){if(isCh(p[i])){idx=i;break;}}}
  if(idx<=0)return p;
  return p.slice(idx);
}
function viewPts(hist){var p=ptsOf(hist);return S.all?p:cyclePts(p);}
function sparseOf(p){
  if(!p||p.length<2)return true;
  var span=p[p.length-1].t-p[0].t;
  if(span<7200000)return false;
  var idle=0,i,g;
  for(i=1;i<p.length;i++){g=p[i].t-p[i-1].t;if(g>5400000)idle+=g;}
  return idle/span>0.55;
}
function sparseIt(it){return sparseOf(ptsOf(it.hist));}
function shownIt(it){
  if(S.hidden[it.key])return false;
  if(sparseIt(it)&&!S.touched[it.key])return false;
  return true;
}
function keyItem(k){var a=items();for(var i=0;i<a.length;i++){if(a[i].key===k)return a[i];}return null;}
function ptsOf(hist){
  var a=[];
  if(!hist)return a;
  for(var i=0;i<hist.length;i++){if(typeof hist[i].l==='number')a.push(hist[i]);}
  return a;
}
function items(){
  var d=S.data;
  if(!d)return [];
  if(d.items)return d.items;
  return [{key:d.key,label:d.label,hist:d.hist||[],rec:d.rec,total:d.total||0}];
}
function statOf(p){
  var drops=[],charges=0,sum=0,prev=null,maxOne=0,i;
  for(i=0;i<p.length;i++){
    var q=p[i];
    if(prev){
      if(q.l<prev.l){
        var dd=prev.l-q.l;
        drops.push({t:q.t,from:prev.l,to:q.l,d:dd});
        sum+=dd;
        if(dd>maxOne)maxOne=dd;
      }
      if(isCh(q)&&!isCh(prev))charges++;
    }
    prev=q;
  }
  var span=p.length>1?p[p.length-1].t-p[0].t:0;
  var gaps=[],gsum=0,gmax=null,gmin=null;
  for(i=1;i<drops.length;i++){
    var gp=drops[i].t-drops[i-1].t;
    gaps.push(gp);gsum+=gp;
    if(gmax===null||gp>gmax)gmax=gp;
    if(gmin===null||gp<gmin)gmin=gp;
  }
  var avgGap=gaps.length?gsum/gaps.length:null;
  var rate=(span>0&&sum>0)?sum/(span/3600000):null;
  var life=rate>0?100/rate:null;
  return {n:p.length,drops:drops,sum:sum,charges:charges,span:span,
          avgGap:avgGap,maxGap:gmax,minGap:gmin,rate:rate,life:life,maxOne:maxOne};
}
function adapt(cv,h){
  var dpr=window.devicePixelRatio||1;
  if(h)cv.setAttribute('data-h',h);
  var w=cv.clientWidth||(cv.parentNode?cv.parentNode.clientWidth:600)||600;
  var H=+cv.getAttribute('data-h')||220;
  cv.width=Math.round(w*dpr);
  cv.height=Math.round(H*dpr);
  cv.style.height=H+'px';
  var g=cv.getContext('2d');
  g.setTransform(dpr,0,0,dpr,0,0);
  g.clearRect(0,0,w,H);
  return {g:g,w:w,h:H};
}
function bindTip(cv,tip){
  if(!cv||!tip)return;
  function move(ev){
    var hp=cv._hp||[];
    if(!hp.length){tip.style.display='none';return;}
    var r=cv.getBoundingClientRect();
    var cx=ev.touches?ev.touches[0].clientX:ev.clientX;
    var cy=ev.touches?ev.touches[0].clientY:ev.clientY;
    var x=cx-r.left,y=cy-r.top,best=null,bd=1e9;
    for(var i=0;i<hp.length;i++){
      var dx=hp[i].x-x,dy=hp[i].y-y,dd=dx*dx+dy*dy;
      if(dd<bd){bd=dd;best=hp[i];}
    }
    if(!best||bd>900){tip.style.display='none';return;}
    tip.innerHTML=best.html;
    tip.style.display='block';
    var tw=tip.offsetWidth,th=tip.offsetHeight;
    var left=x+12,top=y-th-10;
    if(left+tw>cv.clientWidth-2)left=Math.max(2,x-tw-12);
    if(top<2)top=y+14;
    tip.style.left=Math.round(left)+'px';
    tip.style.top=Math.round(top)+'px';
  }
  cv.addEventListener('mousemove',move);
  cv.addEventListener('mouseleave',function(){tip.style.display='none';});
  cv.addEventListener('touchstart',function(e){move(e);},{passive:true});
  cv.addEventListener('touchmove',function(e){move(e);},{passive:true});
  cv.addEventListener('touchend',function(){
    setTimeout(function(){tip.style.display='none';},2200);
  });
}
function drawChart(series){
  var cv=$('chart');
  if(!cv)return;
  var box=adapt(cv,0),g=box.g,W=box.w,H=box.h;
  var L=34,R=10,T=10,B=20;
  var hp=[];
  cv._hp=hp;
  var tmin=null,tmax=null,n=0,i,j;
  for(i=0;i<series.length;i++){
    var ps=series[i].pts;
    n+=ps.length;
    for(j=0;j<ps.length;j++){
      var tt=ps[j].t;
      if(tmin===null||tt<tmin)tmin=tt;
      if(tmax===null||tt>tmax)tmax=tt;
    }
  }
  g.font='11px ui-sans-serif,system-ui,sans-serif';
  if(!n){
    g.fillStyle='#8b98b3';g.textAlign='center';g.textBaseline='middle';
    g.fillText('没有可绘制的设备（稀疏设备默认隐藏，点上方图例可强制显示）',W/2,H/2);
    return;
  }
  if(tmax-tmin<60000)tmax=tmin+60000;
  var xw=W-L-R,yh=H-T-B;
  function X(t){return L+(t-tmin)/(tmax-tmin)*xw;}
  function Y(l){
    var v=Math.max(0,Math.min(100,l));
    return T+(1-v/100)*yh;
  }
  g.strokeStyle='rgba(120,150,255,.10)';
  g.lineWidth=1;
  g.fillStyle='#8b98b3';
  g.textAlign='right';
  g.textBaseline='middle';
  for(var l=0;l<=100;l+=25){
    var gy=Math.round(Y(l))+.5;
    g.beginPath();g.moveTo(L,gy);g.lineTo(W-R,gy);g.stroke();
    g.fillText(l+'%',L-7,gy);
  }
  var ticks=W<520?3:5;
  g.textAlign='center';
  g.textBaseline='top';
  for(var k=0;k<=ticks;k++){
    var tx=L+xw*k/ticks;
    var tk=tmin+(tmax-tmin)*k/ticks;
    g.strokeStyle='rgba(120,150,255,.07)';
    g.beginPath();
    g.moveTo(Math.round(tx)+.5,T);
    g.lineTo(Math.round(tx)+.5,H-B);
    g.stroke();
    g.fillStyle='#8b98b3';
    g.fillText(fmtHm(tk),Math.min(W-R-14,Math.max(L+14,tx)),H-B+4);
  }
  for(var si=0;si<series.length;si++){
    var se=series[si],p=se.pts;
    if(!p.length)continue;
    var r=p.length>260?1.2:(p.length>140?1.6:(p.length>60?2.0:(p.length>20?2.4:3.0)));
    g.strokeStyle=se.color;
    g.lineWidth=1.7;
    g.lineJoin='round';
    g.lineCap='round';
    g.beginPath();
    for(j=0;j<p.length;j++){
      var px=X(p[j].t),py=Y(p[j].l);
      if(j===0)g.moveTo(px,py);else g.lineTo(px,py);
    }
    g.stroke();
    for(j=0;j<p.length;j++){
      var q=p[j],qx=X(q.t),qy=Y(q.l);
      var rc=isCh(q)?r+0.8:r;
      g.beginPath();
      g.arc(qx,qy,rc,0,6.2832);
      g.fillStyle=isCh(q)?'#34d399':se.color;
      g.globalAlpha=isCh(q)?0.98:0.9;
      g.fill();
      g.globalAlpha=1;
      if(series.length<4){
        hp.push({x:qx,y:qy,html:'<b style="color:'+se.color+'">'+esc(se.label)+'</b><br>'+
          fmtT(q.t)+'<br>电量 '+q.l+'%'+(isCh(q)?' · 充电中':'')+'<br>第 '+q.v+' 次写入'});
      }
    }
    var lp=p[p.length-1];
    g.beginPath();
    g.arc(X(lp.t),Y(lp.l),r+2.2,0,6.2832);
    g.strokeStyle=se.color;
    g.lineWidth=1.2;
    g.globalAlpha=.55;
    g.stroke();
    g.globalAlpha=1;
  }
}
function drawBars(its){
  var cv=$('bars');
  if(!cv)return;
  var box=adapt(cv,0),g=box.g,W=box.w,H=box.h;
  var L=26,R=8,T=8,B=20;
  var hp=[];
  cv._hp=hp;
  var now=Date.now();
  var cnt=[],sam=[],i;
  for(i=0;i<24;i++){cnt.push(0);sam.push(0);}
  for(i=0;i<its.length;i++){
    if(!shownIt(its[i]))continue;
    var p=ptsOf(its[i].hist);
    for(var b=0;b<p.length;b++){
      var idx=23-Math.floor((now-p[b].t)/3600000);
      if(idx>=0&&idx<24)sam[idx]++;
      if(b>0&&p[b].l<p[b-1].l){
        var idx2=23-Math.floor((now-p[b].t)/3600000);
        if(idx2>=0&&idx2<24)cnt[idx2]++;
      }
    }
  }
  var maxv=1;
  for(i=0;i<24;i++)if(cnt[i]>maxv)maxv=cnt[i];
  var xw=W-L-R,yh=H-T-B,bw=xw/24;
  g.font='11px ui-sans-serif,system-ui,sans-serif';
  g.strokeStyle='rgba(120,150,255,.10)';
  g.lineWidth=1;
  g.beginPath();
  g.moveTo(L,H-B+.5);
  g.lineTo(W-R,H-B+.5);
  g.stroke();
  g.fillStyle='#8b98b3';
  g.textAlign='right';
  g.textBaseline='middle';
  g.fillText(String(maxv),L-6,T+4);
  g.fillText('0',L-6,H-B-4);
  var nowH=new Date(now).getHours();
  var any=false;
  for(var d=0;d<24;d++){
    if(cnt[d])any=true;
    var hgt=cnt[d]>0?Math.max(2,cnt[d]/maxv*yh):0;
    var x=L+d*bw+bw*0.15,w2=Math.max(2,bw*0.7);
    var y=H-B-hgt;
    if(hgt>0){
      var grd=g.createLinearGradient(0,y,0,H-B);
      grd.addColorStop(0,'rgba(96,165,250,.95)');
      grd.addColorStop(1,'rgba(59,130,246,.30)');
      g.fillStyle=grd;
      g.beginPath();
      if(g.roundRect)g.roundRect(x,y,w2,hgt,3);else g.rect(x,y,w2,hgt);
      g.fill();
    }
    var hh=((nowH-23+d)%24+24)%24;
    hp.push({x:x+w2/2,y:y+Math.min(hgt/2,12),
      html:'<b>'+pad(hh)+':00 – '+pad((hh+1)%24)+':00</b><br>掉电 '+cnt[d]+' 次 · 采样 '+
        sam[d]+' 条'});
  }
  if(!any){
    g.fillStyle='#8b98b3';
    g.textAlign='center';
    g.textBaseline='middle';
    g.fillText('近 24 小时没有掉电记录',W/2,T+yh/2);
  }
  g.fillStyle='#8b98b3';
  g.textAlign='center';
  g.textBaseline='top';
  for(var e=0;e<24;e+=6){
    var h2=((nowH-23+e)%24+24)%24;
    g.fillText(pad(h2)+':00',L+e*bw+bw/2,H-B+4);
  }
}
function renderCards(its){
  var box=$('cards');
  if(!its.length){
    box.innerHTML='<div class="empty">还没有任何设备键，等客户端上报后自动出现。</div>';
    return;
  }
  var h='',i;
  for(i=0;i<its.length;i++){
    var it=its[i],p=ptsOf(it.hist),st=statOf(viewPts(it.hist));
    var cur=p.length?p[p.length-1]:null;
    var c24=null;
    if(cur){
      for(var j=p.length-1;j>=0;j--){
        if(cur.t-p[j].t>=86400000){c24=p[j].l;break;}
      }
    }
    var col=COLOR[i%COLOR.length];
    var delta='—';
    if(cur&&c24!==null){
      var dv=cur.l-c24;
      delta=(dv>0?'+':'')+dv+'%';
    }
    var lv=cur?cur.l:null;
    h+='<div class="card">'+
       '<div class="nm" title="'+esc(it.key)+'">'+esc(it.label)+'</div>'+
       '<div class="lv">'+(lv===null?'--':lv)+'<i>%</i></div>'+
       '<div class="mt">'+
       (cur?('更新 '+fmtT(cur.t)+(isCh(cur)?' · <span style="color:#34d399">充电中</span>':''))
           :'无数据')+
       '<br>24h 变化 '+delta+' · 采样 '+p.length+' 条'+
       '<br>掉电 '+(st.rate!==null?st.rate.toFixed(2)+' %/h':'—')+
       (st.life!==null?(' · 满电约 '+fmtDur(st.life*3600000)):'')+
       '</div>'+
       '<div class="bar" style="width:'+Math.max(0,Math.min(100,lv===null?0:lv))+'%;'+
       'background:'+col+'"></div>'+
       '</div>';
  }
  box.innerHTML=h;
}
function renderLegend(its){
  var box=$('legend');
  var h='',i;
  for(i=0;i<its.length;i++){
    var it=its[i];
    var sp=sparseIt(it);
    var off=shownIt(it)?'':' off';
    h+='<b class="lg'+off+'" data-k="'+esc(it.key)+'">'+
       '<i style="background:'+COLOR[i%COLOR.length]+'"></i>'+esc(it.label)+(sp?'<span class="tag" title="采样间隔过大、在线频率低，默认不画进总曲线也不计入统计">稀疏</span>':'')+'</b>';
  }
  box.innerHTML=h||'<b style="opacity:.5">无设备</b>';
  var bs=box.getElementsByTagName('b');
  for(i=0;i<bs.length;i++){
    bs[i].onclick=function(){
      var k=this.getAttribute('data-k');
      if(!k)return;
      var kit=keyItem(k);
      S.touched[k]=1;
      if(kit&&shownIt(kit))S.hidden[k]=1;else delete S.hidden[k];
      renderAll();
    };
  }
}
function renderStats(its){
  var h='',i,shown=0;
  function row(k,v){return '<div><span>'+k+'</span><b>'+v+'</b></div>';}
  for(i=0;i<its.length;i++){
    var it=its[i];
    if(!shownIt(it))continue;
    shown++;
    var p=viewPts(it.hist);
    var st=statOf(p);
    if(its.length>1){
      h+='<div class="statgrp"><i style="background:'+COLOR[i%COLOR.length]+'"></i>'+
         esc(it.label)+'<span style="opacity:.75;margin-left:auto">'+
         (S.all?'全部采样':'充满电后')+' '+p.length+' 点</span></div>';
    }
    h+=row('采样点',st.n);
    h+=row('覆盖时长',fmtDur(st.span));
    h+=row('掉电次数',st.drops.length);
    h+=row('累计掉电',st.sum+'%');
    h+=row('单次最大',st.maxOne?st.maxOne+'%':'—');
    h+=row('平均掉电间隔',st.avgGap!==null?fmtDur(st.avgGap):'—');
    h+=row('最长不掉电',st.maxGap!==null?fmtDur(st.maxGap):'—');
    h+=row('掉电速率',st.rate!==null?st.rate.toFixed(2)+' %/h':'—');
    h+=row('满电续航',st.life!==null?'约 '+fmtDur(st.life*3600000):'—');
    h+=row('充电次数',st.charges);
  }
  $('stats').innerHTML=h||'<div style="grid-column:1/-1;color:var(--muted)">没有可统计的设备（稀疏设备已默认排除，点图例可强制显示）</div>';
  $('statMeta').textContent=shown>1?('按设备分别统计 · '+shown+' 台'):(shown===1?'单设备':'无设备');
}
function buildRows(hist){
  var p=ptsOf(hist),out=[],prev=null,lastDrop=null;
  for(var i=0;i<p.length;i++){
    var q=p[i];
    var d=prev?(q.l-prev.l):null;
    var sd=lastDrop!==null?(q.t-lastDrop):null;
    var isDrop=prev?(q.l<prev.l):false;
    out.push({t:q.t,l:q.l,d:d,sd:sd,c:isCh(q),v:q.v,drop:isDrop});
    if(isDrop)lastDrop=q.t;
    prev=q;
  }
  return out;
}
function renderTable(its){
  var all=[],i,j;
  for(i=0;i<its.length;i++){
    var rs=buildRows(its[i].hist);
    for(j=0;j<rs.length;j++){
      rs[j].label=its[i].label;
      rs[j].key=its[i].key;
      all.push(rs[j]);
    }
  }
  all.sort(function(a,b){return b.t-a.t;});
  var cap=S.key==='*'?160:600;
  var view=all.length>cap?all.slice(0,cap):all;
  var h='';
  for(i=0;i<view.length;i++){
    var r=view[i];
    var dtxt='—',cls='';
    if(r.d!==null){
      if(r.d>0){dtxt='+'+r.d;cls='up';}
      else if(r.d<0){dtxt=String(r.d);cls='drop';}
      else{dtxt='0';}
    }
    var sdtxt=r.sd===null?'—':fmtDur(r.sd);
    var dotc=r.c?'#34d399':(r.drop?'#f87171':'#60a5fa');
    h+='<tr>'+
       '<td class="num" title="'+esc(r.label)+'">'+
       '<span class="dot" style="background:'+dotc+'"></span>'+fmtT(r.t)+'</td>'+
       '<td class="num">'+r.l+'%</td>'+
       '<td class="num '+cls+'">'+dtxt+'</td>'+
       '<td class="num">'+(r.drop?'<b class="drop">'+sdtxt+'</b>':sdtxt)+'</td>'+
       '<td>'+(r.c?'充电':'放电')+'</td>'+
       '<td class="num" title="该记录第 '+r.v+' 次成功写入；不连续是因为去重跳过的采样也计入了计数">#'+r.v+'</td>'+
       '</tr>';
  }
  $('rows').innerHTML=h||
    '<tr><td colspan="7" class="empty">暂无采样，等下一次上报。</td></tr>';
  $('logMeta').textContent='共 '+all.length+' 条 · 显示 '+view.length;
}
function renderAll(){
  var d=S.data;
  if(!d)return;
  var its=items(),series=[],i,tot=0;
  renderCards(its);
  for(i=0;i<its.length;i++){
    var it=its[i];
    tot+=ptsOf(it.hist).length;
    if(!shownIt(it))continue;
    series.push({key:it.key,label:it.label,color:COLOR[i%COLOR.length],pts:viewPts(it.hist)});
  }
  renderLegend(its);
  drawChart(series);
  drawBars(its);
  renderStats(its);
  renderTable(its);
  var totShown=0;
  for(i=0;i<series.length;i++)totShown+=series[i].pts.length;
  $('chkAll').checked=S.all;
  $('chartMeta').textContent=(S.key==='*'?'全部设备':(d.label||S.key))+' · '+
    (S.all?'全部历史':'充满电后')+' '+totShown+' 个采样点'+
    (tot>totShown?'（已隐藏 '+ (tot-totShown) +' 点）':'');
  var nw=new Date();
  $('meta').textContent='更新于 '+pad(nw.getHours())+':'+pad(nw.getMinutes())+':'+
    pad(nw.getSeconds())+' · '+(d.devices?d.devices.length:0)+' 个设备键 · '+
    (d.keys?d.keys.length:0)+' 个总键';
}
function fillKeySelect(){
  var d=S.data;
  var keys=(d&&d.devices)||[];
  var h='<option value="*">全部设备（总览）</option>';
  for(var i=0;i<keys.length;i++){
    h+='<option value="'+esc(keys[i])+'">'+esc(keys[i])+'</option>';
  }
  if(S.key!=='*'&&keys.indexOf(S.key)<0){
    h+='<option value="'+esc(S.key)+'">'+esc(S.key)+'</option>';
  }
  var sel=$('selKey');
  sel.innerHTML=h;
  sel.value=S.key;
}
function load(){
  var url='/dash/data?key='+encodeURIComponent(S.key)+'&range='+(S.all?0:S.range);
  fetch(url,{credentials:'same-origin',cache:'no-store'}).then(function(r){
    if(r.status===401){location.href='/dash';return null;}
    return r.json();
  }).then(function(j){
    if(!j)return;
    S.data=j;
    fillKeySelect();
    renderAll();
  }).catch(function(e){
    $('meta').textContent='加载失败：'+e;
  });
}
$('btnReload').onclick=function(){load();};
$('selKey').onchange=function(){S.key=this.value;S.hidden={};load();};
$('selRange').onchange=function(){S.range=+this.value;load();};
$('chkAll').onchange=function(){S.all=this.checked;load();};
var rt=null;
window.addEventListener('resize',function(){
  clearTimeout(rt);
  rt=setTimeout(function(){if(S.data)renderAll();},180);
});
bindTip($('chart'),$('tip'));
bindTip($('bars'),$('tip2'));
load();
setInterval(load,60000);
})();
</script>
</body>
</html>`;
}
