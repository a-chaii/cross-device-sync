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
 *      按时间窗保留最近 HIST_TTL_MS（7 天），HIST_LIMIT 仅作兜底上限；
 *      对外 API 屏蔽 @ 前缀键。
 *
 * 设备模型（v2）：一台设备一个键，历史天然隔离
 *   watch/battery           手表（兼容旧客户端，键名保留）
 *   dev/<mac 去冒号小写>     其它蓝牙设备（耳机/音箱/手环…）
 */
const COOKIE = 'ws_dash';
const HIST_LIMIT = 2000;
/**
 * 历史保留窗口：产品约束「只存最近一周」。
 * 写入侧 appendHist 会剪掉比它更早的点，读取侧 data() 也按它兜底过滤，
 * 所以无论 KV 里残留多老的数据，对外都不会超过 7 天。
 */
export const HIST_TTL_MS = 7 * 86400000;
// 注意：以前这里有个「值没变也每 30 分钟补一个点」的 GAP_SAMPLE_MS。
// 它让「未连接设备的缓存电量」看起来像在持续上报，已废弃：值不变就不记点。
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
  /** 采集端模块版本（Hook 的 mv 字段），用来分辨某段曲线是哪版模块采的 */
  m?: string | null;
}
function pwdOf(env: DashEnv): string {
  const p = env.DASH_PWD;
  return p && p.length > 0 ? p : '114514';
}
export function histKey(key: string): string {
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
    // 非设备键（如 status/*）不写历史：省一半 KV 写，也避免长出没人看的 @hist: 垃圾键。
    // 历史采样只为「设备电量」服务，见 isDeviceKey()。
    if (!isDeviceKey(key)) return;
    const hk = histKey(key);
    const prev = (await env.SYNC_KV.get(hk, 'json')) as Sample[] | null;
    const arr: Sample[] = Array.isArray(prev) ? prev.slice() : [];
    const l = pickNum(value, 'level');
    const c = pickNum(value, 'charging');
    const s = pickStr(value, 'src');
    const mv = pickStr(value, 'mv');
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
    // 值完全没变时不记点：轮询源（如 DeviceInfo.getBatteryList 的缓存值）会不停
    // 重复同一个数字，按时间补点只会把「缓存值」伪装成「一直在上报」。
    // 真的变化（含充电状态翻转）才落一个采样点。
    if (last && last.l === l && last.c === c) return;
    const one: Sample = { t, l, c, v: version };
    if (s) one.s = s;
    if (mv) one.m = mv;
    // ---- 时间窗裁剪：只保留最近 HIST_TTL_MS ----
    // 数组按 t 单调递增（上面已把 t 夹到 >= last.t），过期点必然集中在头部，
    // 因此用「下标扫描 + 一次 splice」剪枝，比 filter 少一次全量拷贝。
    const ttlFrom = t - HIST_TTL_MS;
    let drop = 0;
    while (drop < arr.length && arr[drop].t < ttlFrom) drop++;
    if (drop > 0) arr.splice(0, drop);
    arr.push(one);
    // 时间窗是主约束；HIST_LIMIT 只是兜底，防止异常高频写入把单 value 撑爆
    while (arr.length > HIST_LIMIT) arr.shift();
    await env.SYNC_KV.put(hk, JSON.stringify(arr), {
      metadata: { updatedAt: new Date().toISOString() },
    });
  } catch {
    // 历史采样失败绝不影响主写入
  }
}

/** 键名是否代表一台设备的电量记录 */
export function isDeviceKey(name: string): boolean {
  if (name === 'watch/battery') return true;
  if (/^dev\/[0-9a-f]{4,32}$/i.test(name)) return true;
  // 兼容未来可能出现的 buds/battery、band/battery 之类
  return /^[a-z][a-z0-9_-]{0,20}\/battery$/.test(name);
}

/** 设备展示名：优先上报里的 name，否则按键名推 */
export function labelOf(key: string, value: unknown): string {
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

export async function loadHist(env: DashEnv, key: string): Promise<Sample[]> {
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
  // 下限取「range 起点」与「保留窗口起点」中更晚的那个：
  // range=0（全部）时等价于只看最近 HIST_TTL_MS。
  const ttlFrom = now - HIST_TTL_MS;
  const from = rangeMs > 0 ? Math.max(now - rangeMs, ttlFrom) : ttlFrom;
  const cut = (arr: Sample[]): Sample[] => arr.filter((s) => s.t >= from);

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

/**
 * 只读历史接口（x-sync-token 鉴权），供 iOS / 原生客户端使用。
 *
 * 为什么要单独开这个口子：/dash/data 走的是看板 cookie（要 DASH_PWD 换 cookie），
 * 原生端不该内置看板密码，也不适合维护 cookie 流程；而 GET /:key 只返回最新记录、
 * 不返回历史数组。所以这里给「持 SYNC_TOKEN 的客户端」一个纯 JSON 的历史读取端点。
 *
 * 返回：{ key, label, hist:[{t,l,c,v,s,m}], total, now, retentionMs }
 *   - hist 已按 range 与保留窗口裁剪，时间升序
 *   - total 是裁剪前的条数（便于客户端判断是否被截断）
 */
export async function history(env: DashEnv, key: string, rangeMs: number): Promise<Response> {
  const now = Date.now();
  const ttlFrom = now - HIST_TTL_MS;
  const from = rangeMs > 0 ? Math.max(now - rangeMs, ttlFrom) : ttlFrom;
  const rec = (await env.SYNC_KV.get(key, 'json')) as { value?: unknown } | null;
  const hist = (await loadHist(env, key)).filter((s) => s.t >= from);
  return jsonBody({
    key,
    label: labelOf(key, rec?.value),
    hist,
    total: hist.length,
    now,
    retentionMs: HIST_TTL_MS,
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
  select:disabled{opacity:.42;cursor:not-allowed}
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
  .card.stale{border-color:rgba(251,191,36,.32)}
  .card.stale .lv{opacity:.42}
  .card.stale .bar{opacity:.25}
  .warn{color:#fbbf24}
  .hint{color:#94a3b8}
  .seg{margin-left:auto;display:inline-flex;border:1px solid var(--line);border-radius:9px;
       overflow:hidden;align-self:center}
  .seg button{font:inherit;font-size:.66rem;line-height:1.6;background:transparent;border:0;
              color:var(--muted);padding:2px 9px;cursor:pointer}
  .seg button.on{background:rgba(59,130,246,.22);color:#dbeafe}
  .mod{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#94a3b8;
    background:rgba(148,163,184,.14);border-radius:4px;padding:1px 5px;white-space:nowrap}
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
      <option value="86400000">近 24 小时</option>
      <option value="259200000">近 3 天</option>
      <option value="604800000" selected>近 7 天</option>
      <option value="0">全部</option>
    </select>
    <label class="chk" title="勾选后直接取服务器保留的全部历史（最近 7 天），且不做「充满电后」裁剪"><input type="checkbox" id="chkAll">全部历史</label>
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
      <h2><span id="distTitle">掉电分布</span> <em id="distMeta">每小时掉电次数</em></h2>
      <div class="chartwrap">
        <canvas id="bars" data-h="168"></canvas>
        <div class="tip" id="tip2"></div>
      </div>
    </div>
    <div class="panel">
      <h2><span id="statTitle">续航统计</span> <em id="statMeta"></em>
        <span class="seg" id="segMode">
          <button type="button" data-m="dis" class="on">放电</button>
          <button type="button" data-m="chg">充电</button>
        </span>
      </h2>
      <div class="stats" id="stats"></div>
    </div>
  </div>
  <div class="panel">
    <h2>采样日志 <em id="logMeta"></em></h2>
    <div class="tblwrap">
      <table>
        <thead><tr>
          <th>时间</th><th>电量</th><th>变化</th><th id="thSince">距上次掉电</th><th>状态</th><th title="采集端模块版本（Hook 的 mv 字段）。同一段曲线若跨版本，可据此判断数据来源">模块</th><th title="该设备这条记录被成功写入的次数，去重跳过的采样也会计入，所以不连续">写入序</th>
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
var S={key:'*',range:604800000,data:null,hidden:{},touched:{},all:false,mode:'dis'};
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
  if(h<48)return h+' 时'+(mm?' '+mm+' 分':'');
  var dd=Math.floor(h/24);
  return dd+' 天'+(h%24?' '+(h%24)+' 时':'');
}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':'&'+'quot;';});}
function isCh(s){return s.c===1||s.c===true;}
// 降噪参数：单次跳变阈值(%)。耳机左右耳取值交替会在此处表现为 ±10 的锯齿。
var JUMP=8;
/**
 * 采样点标注（纯函数，不删数据）：
 *   rep  = 设备自己上报「充电中」
 *   jump = 孤立尖点（前后都相距 >= JUMP，而前后两点彼此接近）→ 判为噪声，不参与预测
 *   inf  = 与上一个有效点相比小幅上升 → 推断为充电（设备不上报 charging 时的兜底）
 */
function annotate(p){
  var out=[],i,q;
  for(i=0;i<p.length;i++){
    q=p[i];
    out.push({t:q.t,l:q.l,c:q.c,v:q.v,m:q.m,s:q.s,rep:isCh(q),jump:false,inf:false});
  }
  for(i=1;i<out.length-1;i++){
    var a=out[i-1],b=out[i],c=out[i+1];
    // 孤立尖点：该点与前后都拉开 ≥ JUMP，而前后两点彼此几乎重合（容差 2）
    if(Math.abs(b.l-a.l)>=JUMP&&Math.abs(b.l-c.l)>=JUMP&&Math.abs(a.l-c.l)<=2)b.jump=true;
  }
  var prev=null;
  for(i=0;i<out.length;i++){
    q=out[i];
    if(q.jump)continue;
    if(prev&&!q.rep){
      // 只要相对上一个有效点上升，就认定是「充电 / 补登电量」段。
      // 不设 JUMP 上限：从 50 直冲 100 的首个充点也是充电，不能混进掉电回归。
      if(q.l-prev.l>=1)q.inf=true;
    }
    prev=q;
  }
  return out;
}
/** 最小二乘斜率 → 掉电速率(%/h，正数)；样本不足或趋势向上时返回 null，调用方回退到首末差分 */
function olsRate(xs,ys){
  var n=xs.length,i,mx=0,my=0;
  if(n<3)return null;
  for(i=0;i<n;i++){mx+=xs[i];my+=ys[i];}
  mx/=n;my/=n;
  var sxy=0,sxx=0;
  for(i=0;i<n;i++){var dx=xs[i]-mx;sxy+=dx*(ys[i]-my);sxx+=dx*dx;}
  if(!(sxx>0))return null;
  var slope=sxy/sxx;
  if(!isFinite(slope)||slope>=0)return null;
  return -slope;
}
function cyclePts(p){
  if(!p||!p.length)return [];
  var idx=-1,i;
  for(i=p.length-1;i>=0;i--){if(p[i].l>=100){idx=i;break;}}
  if(idx<0){for(i=p.length-1;i>=0;i--){if(isCh(p[i])){idx=i;break;}}}
  if(idx<=0)return p;
  var cut=p.slice(idx);
  return cut.length>=2?cut:p;
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
  for(var i=0;i<hist.length;i++){
    var h=hist[i];
    if(typeof h.l!=='number')continue;
    /* 同一毫秒写两条：只保留先到的那条。
       模块在同一 tick 里可能连写两次（实测 11:03:29 先 79 后 75），
       两条都留下会让曲线在同一横坐标上「一升一降」，凭空多出一次 4% 掉电，
       还会把正在进行的充电段从中间切断。 */
    if(a.length&&a[a.length-1].t===h.t)continue;
    a.push(h);
  }
  return annotate(a);   // 统一在这里做标注，下游（卡片/表格/统计）拿到的都是带 rep/inf/jump 的点
}
function items(){
  var d=S.data;
  if(!d)return [];
  if(d.items)return d.items;
  return [{key:d.key,label:d.label,hist:d.hist||[],rec:d.rec,total:d.total||0}];
}
function statOf(p){
  var drops=[],charges=0,sum=0,prev=null,maxOne=0,i,jumps=0,valid=0;
  for(i=0;i<p.length;i++){
    var q=p[i];
    if(q.jump){jumps++;continue;}   // 孤立尖点：既不算掉电，也不算采样
    valid++;
    if(prev){
      if(q.l<prev.l){
        var dd=prev.l-q.l;
        drops.push({t:q.t,from:prev.l,to:q.l,d:dd});
        sum+=dd;
        if(dd>maxOne)maxOne=dd;
      }
      if((q.rep||q.inf)&&!(prev.rep||prev.inf))charges++;
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
  // 降噪主算法：只用「非跳变、两端都不在充电」的相邻段做最小二乘回归，
  // 因为充电段(上升)混进时间轴会把速率摊薄，尖点会把速率放大。
  var xs=[],ys=[],t0=p.length?p[0].t:0,pre=null;
  for(i=0;i<p.length;i++){
    var r=p[i];
    if(r.jump){continue;}
    var chg=(r.rep||r.inf);
    if(pre&&!(pre.rep||pre.inf)&&!chg){
      xs.push((r.t-t0)/3600000);ys.push(r.l);
    }
    pre=r;
  }
  var reg=olsRate(xs,ys);
  // 回归不可用（样本<3 或整体在上升）时回退到首末差分
  var rate=reg!==null?reg:((span>0&&sum>0)?sum/(span/3600000):null);
  var life=rate>0?100/rate:null;
  if(life!==null&&life>720)life=null;   // 超过 30 天的外推不可信，宁可不显示
  return {n:p.length,valid:valid,jumps:jumps,reg:reg!==null,drops:drops,sum:sum,
          charges:charges,span:span,avgGap:avgGap,maxGap:gmax,minGap:gmin,
          rate:rate,life:life,maxOne:maxOne};
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
    // 画线跳过孤立尖点：否则耳机的 ±10 交替会画成心电图。
    // 注意这只是视觉降噪，原始点仍完整保留在下方表格里（标 *），不隐藏数据。
    var fp=[];
    for(j=0;j<p.length;j++){ if(!p[j].jump) fp.push(p[j]); }
    if(fp.length<2) fp=p;
    g.beginPath();
    for(j=0;j<fp.length;j++){
      var px=X(fp[j].t),py=Y(fp[j].l);
      if(j===0)g.moveTo(px,py);else g.lineTo(px,py);
    }
    g.stroke();
    for(j=0;j<p.length;j++){
      var q=p[j];
      if(q.jump) continue;   // 尖点不画点，值仍在表格里
      var qx=X(q.t),qy=Y(q.l);
      var chq=isCh(q);
      var rc=chq?r+0.8:r;
      g.beginPath();
      g.arc(qx,qy,rc,0,6.2832);
      g.fillStyle=chq?'#34d399':(q.inf?'#5eead4':se.color);
      g.globalAlpha=chq?0.98:(q.inf?0.85:0.9);
      g.fill();
      g.globalAlpha=1;
      if(series.length<4){
        hp.push({x:qx,y:qy,html:'<b style="color:'+se.color+'">'+esc(se.label)+'</b><br>'+
          fmtT(q.t)+'<br>电量 '+q.l+'%'+(chq?' · 充电中':(q.inf?' · 推测充电':''))+'<br>第 '+q.v+' 次写入'});
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
  var chgMode=S.mode==='chg';
  var cnt=[],sam=[],i;
  for(i=0;i<24;i++){cnt.push(0);sam.push(0);}
  for(i=0;i<its.length;i++){
    if(!shownIt(its[i]))continue;
    var p=ptsOf(its[i].hist);
    for(var b=0;b<p.length;b++){
      if(p[b].jump)continue;   // 尖点不参与分布统计
      var idx=23-Math.floor((now-p[b].t)/3600000);
      if(idx>=0&&idx<24)sam[idx]++;
      if(b>0&&!p[b-1].jump){
        var dl=p[b].l-p[b-1].l;
        var idx2=23-Math.floor((now-p[b].t)/3600000);
        if(idx2>=0&&idx2<24){
          if(chgMode){ if(dl>0)cnt[idx2]+=dl; }   // 充电：累加充入百分点
          else{ if(dl<0)cnt[idx2]++; }            // 放电：累加掉电次数
        }
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
      if(chgMode){
        grd.addColorStop(0,'rgba(52,211,153,.95)');
        grd.addColorStop(1,'rgba(16,185,129,.30)');
      }else{
        grd.addColorStop(0,'rgba(96,165,250,.95)');
        grd.addColorStop(1,'rgba(59,130,246,.30)');
      }
      g.fillStyle=grd;
      g.beginPath();
      if(g.roundRect)g.roundRect(x,y,w2,hgt,3);else g.rect(x,y,w2,hgt);
      g.fill();
    }
    var hh=((nowH-23+d)%24+24)%24;
    hp.push({x:x+w2/2,y:y+Math.min(hgt/2,12),
      html:'<b>'+pad(hh)+':00 – '+pad((hh+1)%24)+':00</b><br>'+
        (chgMode?('充入 '+cnt[d]+'%'):('掉电 '+cnt[d]+' 次'))+' · 采样 '+
        sam[d]+' 条'});
  }
  if(!any){
    g.fillStyle='#8b98b3';
    g.textAlign='center';
    g.textBaseline='middle';
    g.fillText(chgMode?'近 24 小时没有充入记录':'近 24 小时没有掉电记录',W/2,T+yh/2);
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
    var since=cur?cur.t:0,stillH=0;
    if(cur){
      since=cur.t;
      for(var q=p.length-1;q>0;q--){
        if(p[q-1].l!==p[q].l){since=p[q].t;break;}
        since=p[0].t;
      }
      stillH=(Date.now()-since)/3600000;
    }
    /* 「已充电多久」直接取 chgStat 的当前充电段，和统计面板同源；
       只算到最后一条数据，避免采集冻结时把时长吹大 */
    var cs=chgStat(p);
    var chgOn=cs.open?cs.cur:null;
    var chgMs=chgOn?(chgOn.t-chgOn.t0):null;
    /* 链路时间与电量时间是两回事，必须分开看：
       linkTs  = KV 主键的 updatedAt，只要模块发起过 PUT 就会刷新（含心跳），代表「采集链路活着」
       since   = 历史里最后一次电量变化，代表「电量真的变了」
       两者都冻住 = 进程被冻结/模块停了；只有 since 冻住 = 链路正常，电量本来就没变。 */
    var linkTs=0;
    if(it.rec&&it.rec.updatedAt){
      var lm=Date.parse(it.rec.updatedAt);
      if(!isNaN(lm)&&lm>0)linkTs=lm;
    }
    var linkH=linkTs?(Date.now()-linkTs)/3600000:null;
    var linkDead=linkH!==null&&linkH>=2;   // 2 小时没有 PUT → 采集大概率已停
    h+='<div class="card'+(linkDead?' stale':'')+'">'+
       '<div class="nm" title="'+esc(it.key)+'">'+esc(it.label)+'</div>'+
       '<div class="lv">'+(lv===null?'--':lv)+'<i>%</i></div>'+
       '<div class="mt">'+
       (cur?('电量 '+fmtT(cur.t)
             +(chgOn?(chgOn.inf
                 ?' · <span style="color:#5eead4" title="设备未上报充电标志，电量不再下降且此前在上涨，按趋势推断">推测充电</span>'
                 :' · <span style="color:#34d399">充电中</span>'):'')
             +(chgMs!==null?' · 已充 '+fmtDur(chgMs):''))
           :'无数据')+
       (linkTs?('<br>链路 '+fmtT(linkTs)+(linkDead?'<span class="warn"> · 已停</span>':'')):'<br>链路 —')+
       (linkDead
          ?'<br><span class="warn">'+fmtDur((linkH||0)*3600000)+' 没有任何上报，进程可能被冻结</span>'
          :(stillH>=2?'<br><span class="hint">链路正常 · 电量 '+fmtDur(stillH*3600000)+' 未变</span>':''))+
       '<br>24h 变化 '+delta+' · 采样 '+st.valid+' 条'
         +(st.jumps?'<span title="前后都相差 ≥'+JUMP+'% 而前后两点彼此接近，判为孤立尖点：不参与续航预测，曲线里也不画点，原始值仍在上方表格中（标 *）"> <span class="warn">剔噪 '+st.jumps+'</span></span>':'')+
       '<br>掉电 '+(st.rate!==null?st.rate.toFixed(2)+' %/h':'—')+
       (st.life!==null?(' · 满电约 '+fmtDur(st.life*3600000)+(st.reg?'':' <span class="warn" title="有效样本不足，退回首末差分">~</span>')):'')+
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
/**
 * 充电段统计：与 statOf 对称，但看的是「电量上升」那一半。
 * 起段：设备上报了充电标志(q.rep)，或电量相对上一点开始上涨；
 * 续段：电量持平或上涨都算（采集间隔 1~2 分钟，中间必然会有点持平）；
 * 收段：电量真正下降（掉电）才收段，孤立尖点直接跳过。
 * 最后一段没有被掉电收掉 → open=true，表示「现在正在充电」。
 */
function chgStat(p){
  var segs=[],cur=null,i,prev=null;
  for(i=0;i<p.length;i++){
    var q=p[i];
    if(q.jump)continue;                       // 尖点不参与分段
    var rise=prev?(q.l-prev.l>=1):false;      // 相对上一点在涨 → 起段
    var drop=prev?(q.l<prev.l):false;         // 真正掉电 → 收段
    if(cur){
      if(drop){cur.t1=q.t;segs.push(cur);cur=null;}
      else{
        /* 持平必须留在段内：采集端每 1~2 分钟报一次，电量经常连续几点不变，
           按「上升才算充电」切段会把一次完整充电切成几十个碎片。 */
        cur.t=q.t;cur.l=q.l;cur.n++;
        if(q.rep)cur.inf=false;
      }
    }else if(q.rep||rise){
      cur={t0:q.t,l0:q.l,t:q.t,l:q.l,n:1,inf:!q.rep};
    }
    prev=q;
  }
  if(cur){cur.open=true;cur.t1=cur.t;segs.push(cur);}
  var gain=0;
  for(i=0;i<segs.length;i++)gain+=(segs[i].l-segs[i].l0);
  var last=segs.length?segs[segs.length-1]:null;
  var elapsed=0,curGain=0,rate=null,eta=null;
  if(last&&last.open){
    /* 时长只算到「最后一条数据」，不外推到 Date.now()：
       采集端息屏会被冻结，如果按现在外推，一个已经停了 5 小时的充电段
       会被写成「已充 8 小时」，越冻越离谱。宁可显示得保守。 */
    elapsed=last.t-last.t0;
    curGain=last.l-last.l0;
    if(elapsed>180000&&curGain>0){rate=curGain/(elapsed/3600000);}
    if(rate!==null&&rate>0&&last.l<100)eta=(100-last.l)/rate*3600000;
  }
  var closed=0,cg=0;
  for(i=0;i<segs.length;i++){
    var g=segs[i];
    if(g.open)continue;
    var dur=g.t-g.t0;
    if(dur<=0)continue;
    var gg=g.l-g.l0;
    if(gg<=0)continue;   // 零/负充入的段（例如耳机 100→100 的假段）不参与平均速率
    closed++;cg+=gg/(dur/3600000);
  }
  return {segs:segs,n:segs.length,open:last?!!last.open:false,cur:last,
          elapsed:elapsed,gain:gain,curGain:curGain,rate:rate,eta:eta,
          avgRate:closed?cg/closed:null};
}
function renderStats(its){
  var h='',i,shown=0;
  function row(k,v){return '<div><span>'+k+'</span><b>'+v+'</b></div>';}
  var chgMode=S.mode==='chg';
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
    if(chgMode){
      var cs=chgStat(p);
      h+=row('采样点',st.n+(st.jumps?'（剔噪 '+st.jumps+'）':''));
      h+=row('覆盖时长',fmtDur(st.span));
      if(cs.open&&cs.cur){
        h+=row('状态','<span style="color:#34d399">充电中</span>'+
          (cs.cur.inf?'<span class="mod" title="设备未上报充电标志，这一整段是按电量上升趋势推断的">推断</span>':''));
        h+=row('已充时长',fmtDur(cs.elapsed));
        h+=row('已充入',(cs.curGain>=0?'+':'')+cs.curGain+'%'+
          '<span class="mod">'+cs.cur.l0+'→'+cs.cur.l+'</span>');
        h+=row('充电速率',cs.rate!==null?cs.rate.toFixed(2)+' %/h':'—');
        h+=row('预计充满',cs.cur.l>=100?'已充满':
          (cs.eta!==null?'约 '+fmtDur(cs.eta):'—'));
      }else{
        h+=row('状态','未在充电');
        h+=row('已充时长','—');
        if(cs.n){
          var last=cs.segs[cs.n-1];
          h+=row('最近一段',fmtT(last.t0)+' → '+fmtT(last.t1));
          h+=row('充入电量',(last.l-last.l0)+'%<span class="mod">'+last.l0+'→'+last.l+'</span>');
          if(last.t1>last.t0){
            h+=row('该段速率',((last.l-last.l0)/((last.t1-last.t0)/3600000)).toFixed(2)+' %/h');
          }
        }else{
          h+=row('最近一段','没有充电记录');
        }
        h+=row('预计充满','—');
      }
      h+=row('充电段数',cs.n);
      h+=row('累计充入',cs.gain>0?'+'+cs.gain+'%':'—');
      h+=row('平均充电速率',cs.avgRate!==null?cs.avgRate.toFixed(2)+' %/h':'—');
    }else{
      h+=row('采样点',st.n+(st.jumps?'（剔噪 '+st.jumps+'）':''));
      h+=row('覆盖时长',fmtDur(st.span));
      h+=row('掉电次数',st.drops.length);
      h+=row('累计掉电',st.sum+'%');
      h+=row('单次最大',st.maxOne?st.maxOne+'%':'—');
      h+=row('平均掉电间隔',st.avgGap!==null?fmtDur(st.avgGap):'—');
      h+=row('最长不掉电',st.maxGap!==null?fmtDur(st.maxGap):'—');
      h+=row('掉电速率',st.rate!==null?st.rate.toFixed(2)+' %/h'+(st.reg?'<span class="mod">回归</span>':''):'—');
      h+=row('满电续航',st.life!==null?'约 '+fmtDur(st.life*3600000):'—');
      h+=row('充电次数',st.charges+'<span class="mod">含推断</span>');
    }
  }
  $('stats').innerHTML=h||'<div style="grid-column:1/-1;color:var(--muted)">没有可统计的设备（稀疏设备已默认排除，点图例可强制显示）</div>';
  $('statMeta').textContent=shown>1?('按设备分别统计 · '+shown+' 台'):(shown===1?'单设备':'无设备');
}
function buildRows(hist){
  var p=ptsOf(hist),out=[],prev=null,lastDrop=null,chgFrom=null;
  for(var i=0;i<p.length;i++){
    var q=p[i],jump=!!q.jump;
    var d=null,sd=null,isDrop=false;
    if(!jump&&prev){
      d=q.l-prev.l;
      sd=lastDrop!==null?(q.t-lastDrop):null;
      isDrop=q.l<prev.l;
    }
    /* 充电段判定与 chgStat 用同一套状态机（起段=上报充电或开始上涨，收段=真掉电），
       保证表格里的「已充电多久」和统计面板的「已充时长」是同一个数 */
    if(!jump&&prev){
      if(chgFrom!==null){
        if(q.l<prev.l)chgFrom=null;
      }else if(q.rep||q.l-prev.l>=1){
        chgFrom=q.t;
      }
    }
    var chg=chgFrom!==null;
    var ct=chg?(q.t-chgFrom):null;
    out.push({t:q.t,l:q.l,d:d,sd:sd,ct:ct,chg:chg,c:!!q.rep,inf:!!q.inf,jump:jump,v:q.v,drop:isDrop,m:q.m});
    if(isDrop)lastDrop=q.t;
    if(!jump)prev=q;   // 跳变点不更新基准，下一段的增量仍相对最后一个正常点算
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
  var chgMode=S.mode==='chg';
  var h='';
  for(i=0;i<view.length;i++){
    var r=view[i];
    var dtxt='—',cls='';
    if(r.d!==null){
      if(r.d>0){dtxt='+'+r.d;cls='up';}
      else if(r.d<0){dtxt=String(r.d);cls='drop';}
      else{dtxt='0';}
    }
    /* 第四列随模式切换：放电看「距上次掉电」，充电看「这一充电段已经充了多久」 */
    var sdtxt,scell;
    if(chgMode){
      sdtxt=r.ct===null?'—':fmtDur(r.ct);
      scell=r.ct!==null?('<b class="up">'+sdtxt+'</b>'):sdtxt;
    }else{
      sdtxt=r.sd===null?'—':fmtDur(r.sd);
      scell=r.drop?('<b class="drop">'+sdtxt+'</b>'):sdtxt;
    }
    var dotc=r.c?'#34d399':(r.drop?'#f87171':'#60a5fa');
    h+='<tr>'+
       '<td class="num" title="'+esc(r.label)+'">'+
       '<span class="dot" style="background:'+dotc+'"></span>'+fmtT(r.t)+'</td>'+
       '<td class="num">'+r.l+'%'+(r.jump?'<span class="warn" title="孤立尖点：前后都相差 ≥'+JUMP+'%，已排除在续航预测之外">*</span>':'')+'</td>'+
       '<td class="num '+cls+'">'+dtxt+'</td>'+
       '<td class="num">'+scell+'</td>'+
       '<td>'+(r.chg
         ?(r.c?'充电':'<span style="color:#5eead4" title="设备未上报充电标志，电量未再下降且此前在上涨，按趋势推断">推测充电</span>')
         :'放电')+'</td>'+
       '<td class="num">'+(r.m?'<span class="mod">'+esc(String(r.m).replace(/^watchbat-/,''))+'</span>':'—')+'</td>'+
       '<td class="num" title="该记录第 '+r.v+' 次成功写入；不连续是因为去重跳过的采样也计入了计数">#'+r.v+'</td>'+
       '</tr>';
  }
  $('rows').innerHTML=h||
    '<tr><td colspan="8" class="empty">暂无采样，等下一次上报。</td></tr>';
  $('logMeta').textContent='共 '+all.length+' 条 · 显示 '+view.length;
}
/* 放电 / 充电两种视角共用一个面板，切模式只改文案和按钮态，数据不重新拉取 */
function applyMode(){
  var chg=S.mode==='chg';
  var sb=$('segMode');
  if(sb){
    var bs=sb.getElementsByTagName('button');
    for(var i=0;i<bs.length;i++){
      bs[i].className=bs[i].getAttribute('data-m')===S.mode?'on':'';
    }
  }
  var st=$('statTitle'),dt=$('distTitle'),dm=$('distMeta'),th=$('thSince');
  if(st)st.textContent=chg?'充电统计':'续航统计';
  if(dt)dt.textContent=chg?'充入分布':'掉电分布';
  if(dm)dm.textContent=chg?'每小时充入电量（%）':'每小时掉电次数';
  if(th)th.textContent=chg?'已充电多久':'距上次掉电';
}
function renderAll(){
  var d=S.data;
  if(!d)return;
  var its=items(),series=[],i,tot=0;
  applyMode();
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
  $('selRange').disabled=!!S.all;
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
$('chkAll').onchange=function(){S.all=this.checked;$('selRange').disabled=S.all;load();};
/* 右上角的 放电 / 充电 切换：纯前端重绘，不重新请求 /dash/data */
(function(){
  var sb=$('segMode');
  if(!sb)return;
  var bs=sb.getElementsByTagName('button');
  for(var i=0;i<bs.length;i++){
    bs[i].onclick=function(){
      var m=this.getAttribute('data-m');
      if(!m||m===S.mode)return;
      S.mode=m;
      if(S.data)renderAll();else applyMode();
    };
  }
})();
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
