/**
 * WatchSync · 开发协作台 + 开发文档
 *
 * 解决一个具体问题：服务端 AI 与 iPad 端 AI 各自开发时信息不对齐、重复造轮子。
 * 做法是给两端一个共同的锚点页面：
 *   /dev     协作台（分工表 + 三端实时进度 + 写入方法），需要看板登录
 *   /docs    开发文档（接口契约 + 硬约束 + 常见坑），公开可读（AI 用 curl 就能取）
 *   /status  三端状态聚合 JSON（token 或看板 cookie 均可读）
 *
 * 状态存储刻意「一端一个键」，永不共写，从结构上消灭覆盖冲突：
 *   status/android · status/server · status/ipad
 *
 * 设计约束：纯手写 HTML/CSS/JS，无 CDN、无框架、无图片，CSP 只放行内联。
 */

const HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
};

/** 三端的展示顺序与回退名。键名固定，AI 只写自己那个。 */
export const PEERS: Array<{ id: string; key: string; name: string; role: string }> = [
  { id: 'android', key: 'status/android', name: 'Android 采集端', role: 'Hook 读手表电量 · 上报' },
  { id: 'server', key: 'status/server', name: '服务端 + Web', role: 'Worker · KV · 看板 · 文档' },
  { id: 'ipad', key: 'status/ipad', name: 'iPad 客户端', role: '只读 App + Widget' },
];

const MONO = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace';

const CSS = `
*{box-sizing:border-box}
:root{
  --bg:#0b0f19;--card:rgba(18,24,38,.72);--line:rgba(120,150,255,.14);
  --txt:#e6ecf8;--muted:#8b98b3;--blue:#3b82f6;--violet:#8b5cf6;
  --green:#34d399;--amber:#fbbf24;--red:#f87171;--cyan:#22d3ee;--mono:${MONO};
}
html,body{margin:0;padding:0}
body{
  min-height:100vh;background:var(--bg);color:var(--txt);line-height:1.65;
  font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;padding:0 18px 56px;overflow-x:hidden;
}
.bg{position:fixed;inset:0;pointer-events:none;z-index:0}
.bg::before{
  content:"";position:absolute;inset:0;
  background:radial-gradient(760px 420px at 18% -8%,rgba(59,130,246,.20),transparent 70%),
             radial-gradient(640px 380px at 88% 4%,rgba(139,92,246,.16),transparent 72%);
}
.wrap{position:relative;z-index:1;max-width:60rem;margin:0 auto}
.bar{display:flex;align-items:center;gap:10px;padding:22px 2px 0;flex-wrap:wrap}
.mark{width:22px;height:22px;border-radius:7px;flex:none;
  background:linear-gradient(135deg,var(--blue),var(--violet));
  box-shadow:0 3px 12px rgba(59,130,246,.42)}
.brand{font-size:.92rem;font-weight:650}
.nav{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.nav a{
  font-family:var(--mono);font-size:10.5px;color:#8fa6d8;text-decoration:none;
  border:1px solid var(--line);border-radius:999px;padding:4px 10px;background:rgba(18,24,38,.6);
}
.nav a:hover{border-color:rgba(120,150,255,.34);color:#c7d6f5}
h1{margin:30px 0 0;font-size:clamp(1.55rem,4.2vw,2.15rem);letter-spacing:-.02em;
  background:linear-gradient(96deg,#eaf1ff 8%,#9db8ff 48%,#a78bfa 96%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.sub{margin:9px 0 0;color:var(--muted);font-size:.85rem;max-width:36rem}
.banner{
  margin-top:16px;border-radius:14px;padding:13px 16px;font-size:.82rem;
  border:1px solid rgba(251,191,36,.28);background:rgba(251,191,36,.07);color:#e8d9ae;
}
.banner b{color:#fcd34d}
.h2{margin:30px 0 12px;font-size:.78rem;font-weight:600;color:#cdd8ee;letter-spacing:.06em}
.cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(16.5rem,1fr))}
.p{
  border-radius:15px;border:1px solid var(--line);background:var(--card);
  padding:14px 16px 15px;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
}
.p .top{display:flex;align-items:center;gap:8px}
.p .nm{font-size:.9rem;font-weight:620}
.p .st{
  margin-left:auto;font-family:var(--mono);font-size:9.5px;border-radius:999px;
  padding:2px 8px;border:1px solid var(--line);color:var(--muted);white-space:nowrap;
}
.p .st.ok{color:var(--green);border-color:rgba(52,211,153,.34);background:rgba(52,211,153,.08)}
.p .st.warn{color:var(--amber);border-color:rgba(251,191,36,.34);background:rgba(251,191,36,.08)}
.p .st.bad{color:var(--red);border-color:rgba(248,113,113,.34);background:rgba(248,113,113,.08)}
.p .role{margin:3px 0 0;font-family:var(--mono);font-size:10px;color:#5f6e90}
.p .phase{margin:10px 0 0;font-size:.82rem;color:#b9c8e6}
.p .kv{margin:9px 0 0;font-size:.78rem;color:var(--muted)}
.p .kv b{color:#8fa6d8;font-weight:500;font-family:var(--mono);font-size:9.5px;
  letter-spacing:.04em;display:block;margin-bottom:2px}
.p ul{margin:4px 0 0;padding-left:15px;color:var(--muted);font-size:.78rem}
.p li{margin:2px 0}
.p .blk{margin-top:8px;font-size:.76rem;color:#fca5a5}
.p .tm{margin-top:9px;font-family:var(--mono);font-size:9.5px;color:#4f5d7d}
table{width:100%;border-collapse:collapse;margin-top:4px;font-size:.79rem}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:#8fa6d8;font-weight:600;font-size:.74rem;letter-spacing:.04em}
td{color:var(--muted)}
td b{color:#cdd8ee;font-weight:560}
td code,pre code{font-family:var(--mono);font-size:11px;color:#8fa6d8}
.panel{
  margin-top:14px;border-radius:15px;background:var(--card);border:1px solid var(--line);
  padding:14px 16px;
}
pre{margin:0;overflow-x:auto;font-family:var(--mono);font-size:11.5px;line-height:1.85;color:#9fb0d0}
pre b{color:#7dd3fc;font-weight:500}
pre i{color:#5a6a8c;font-style:normal}
.note{margin:11px 0 0;color:#63719a;font-size:.74rem;line-height:1.7}
.note code{font-family:var(--mono);color:#8fa6d8}
ul.doc{margin:6px 0 0;padding-left:17px;color:var(--muted);font-size:.8rem}
ul.doc li{margin:5px 0}
ul.doc b{color:#cdd8ee;font-weight:560}
hr{border:0;border-top:1px solid var(--line);margin:26px 0}
@media (max-width:520px){body{padding:0 14px 44px}}
`;

const NAV = `<div class="nav">
  <a href="/">控制台</a><a href="/dev">协作台</a><a href="/docs">开发文档</a><a href="/dash">看板</a>
</div>`;

/* ------------------------------- 协作台 ------------------------------- */

const DEV_HTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="robots" content="noindex,nofollow">
<title>WatchSync · 开发协作台</title>
<style>${CSS}</style></head><body>
<div class="bg"></div>
<div class="wrap">
  <div class="bar"><span class="mark"></span><span class="brand">WatchSync</span>${NAV}</div>
  <h1>开发协作台</h1>
  <p class="sub">三端 AI 的公共锚点：分工边界、各自进度、在线状态。所有状态来自 KV 的 <code>status/*</code> 键。</p>

  <div class="banner">
    <b>开工前先对齐。</b>任何 AI 在写第一行代码前，先读本页分工表 + <a href="/docs" style="color:#fcd34d">开发文档</a>，
    确认接口契约与职责边界。要改接口、改字段、改语义，<b>先改文档并在这里登记</b>，否则另一端会照着旧契约写出不兼容的东西。
  </div>

  <div class="h2">三端状态 <span id="ts" style="color:#4f5d7d;font-weight:400"></span></div>
  <div class="cards" id="cards"><div class="p"><div class="kv">加载中…</div></div></div>

  <div class="h2">分工与边界</div>
  <div class="panel">
    <table>
      <tr><th>端</th><th>负责</th><th>不碰 / 红线</th><th>产出</th></tr>
      <tr><td><b>Android 采集端</b></td><td>Hook 读手表电量、按变化上报、状态文件自检</td>
          <td>不改 Worker 路由与 KV 结构</td><td><code>watch/battery</code> 数据</td></tr>
      <tr><td><b>服务端 + Web</b></td><td>Worker 路由、KV 模型、7 天窗口、看板、文档</td>
          <td>不改 Hook 侧字段语义；不擅自改 <code>/dash/hist</code> 契约</td><td>本仓库 <code>src/</code>、<code>docs/</code></td></tr>
      <tr><td><b>iPad 客户端</b></td><td>只读 App + Widget（小=电量 / 中=续航 / 大=曲线）</td>
          <td><b>任何写操作</b>（PUT/DELETE）、内置看板密码、客户端二次裁剪 7 天</td><td>Xcode 工程 + <code>Secrets.swift</code></td></tr>
    </table>
    <p class="note">跨端唯一契约是 <a href="/docs" style="color:#8fa6d8">开发文档</a> 里的接口表与字段语义。改动先改文档，再改代码。</p>
  </div>

  <div class="h2">怎么登记自己的状态</div>
  <div class="panel">
<pre><i># 只能写自己那一个键，写完页面 20 秒内自动刷新</i>
<b>PUT</b> /status/server   <i># 或 status/android · status/ipad</i>
x-sync-token: &lt;SYNC_TOKEN&gt;
{"value":{
  "id":"server",
  "name":"服务端 + Web",
  "role":"Worker · KV · 看板 · 文档",
  "phase":"v11.1 已上线",
  "doing":"正在做什么（一句话）",
  "next":["下一步 A","下一步 B"],
  "blockers":[],
  "owner":"CH_AI",
  "updatedAt":1793900000000
}}</pre>
    <p class="note">
      约束：<b>一端一键，永不共写</b>（共写必然互相覆盖）；value 控制在 500 字节内，<b>不要放代码、日志、diff</b>；
      写完记得更新 <code>updatedAt</code>（毫秒），页面用它算在线状态。
      非设备键不会写入历史采样，不会污染 <code>@hist:</code>。
    </p>
  </div>
</div>
<script>
(function(){
  var ORDER=[
    {id:'android',name:'Android 采集端',role:'Hook 读手表电量 · 上报'},
    {id:'server',name:'服务端 + Web',role:'Worker · KV · 看板 · 文档'},
    {id:'ipad',name:'iPad 客户端',role:'只读 App + Widget'}
  ];
  function esc(s){
    return String(s==null?'':s).replace(/[&<>"']/g,function(c){
      if(c==='&') return '&amp;';
      if(c==='<') return '&lt;';
      if(c==='>') return '&gt;';
      if(c===String.fromCharCode(34)) return '&'+'quot;';
      return '&#39;';
    });
  }
  function ago(ms){
    if(!ms||!isFinite(ms)) return '从未';
    var d=Date.now()-ms;
    if(d<0) return '刚刚';
    var m=Math.floor(d/60000);
    if(m<1) return '刚刚';
    if(m<60) return m+' 分钟前';
    var h=Math.floor(m/60);
    if(h<24) return h+' 小时前';
    return Math.floor(h/24)+' 天前';
  }
  function state(p){
    if(!p||p.missing) return ['bad','未接入'];
    var t=p.updatedAt||0;
    var d=Date.now()-t;
    if(!t) return ['bad','无时间戳'];
    if(d<15*60000) return ['ok','在线'];
    if(d<2*3600000) return ['warn','刚活跃'];
    return ['bad','离线'];
  }
  function render(peers){
    var box=document.getElementById('cards');
    var byId={}; (peers||[]).forEach(function(p){byId[p.id]=p;});
    var html='';
    ORDER.forEach(function(o){
      var p=byId[o.id]||{id:o.id,missing:true};
      var s=state(p);
      html+='<div class="p"><div class="top"><span class="nm">'+esc(p.name||o.name)+'</span>'+
        '<span class="st '+s[0]+'">'+s[1]+'</span></div>'+
        '<p class="role">'+esc(p.role||o.role)+'</p>';
      if(p.missing){
        html+='<p class="phase">这一端还没登记状态。</p>'+
          '<p class="kv"><b>它需要做的</b>PUT <code>status/'+esc(o.id)+'</code></p>';
      }else{
        html+='<p class="phase">'+esc(p.phase||'—')+'</p>';
        html+='<p class="kv"><b>正在做</b>'+esc(p.doing||'—')+'</p>';
        if(p.next&&p.next.length){
          html+='<p class="kv"><b>下一步</b></p><ul>';
          p.next.slice(0,4).forEach(function(x){html+='<li>'+esc(x)+'</li>';});
          html+='</ul>';
        }
        if(p.blockers&&p.blockers.length){
          html+='<p class="blk">阻塞：'+esc(p.blockers.join('；'))+'</p>';
        }
      }
      html+='<p class="tm">'+(p.owner?esc(p.owner)+' · ':'')+ago(p.updatedAt)+'</p></div>';
    });
    box.innerHTML=html;
  }
  function load(){
    fetch('/status',{cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function(j){
      render(j.peers);
      document.getElementById('ts').textContent='· 更新于 '+new Date().toLocaleTimeString('zh-CN');
    }).catch(function(){
      document.getElementById('cards').innerHTML='<div class="p"><div class="kv">读取状态失败（可能未登录或网络异常）</div></div>';
    });
  }
  load();
  setInterval(load,20000);
})();
</script>
</body></html>`;

/* ------------------------------ 开发文档 ------------------------------ */

const DOCS_HTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>WatchSync · 开发文档</title>
<style>${CSS}</style></head><body>
<div class="bg"></div>
<div class="wrap">
  <div class="bar"><span class="mark"></span><span class="brand">WatchSync</span>${NAV}</div>
  <h1>开发文档</h1>
  <p class="sub">跨端对接的唯一契约。改动接口先改这里，再改代码 —— 两端 AI 都按这页写。</p>

  <div class="h2">1 · 链路与职责</div>
  <div class="panel">
<pre>Watch 4 Pro  <i>蓝牙</i>  PJX110(LSPosed)
     <i>└─ Hook 读电量 →</i> <b>PUT /watch/battery</b>
                              <i>↓</i>
                          <b>Worker + KV</b>  <i>（主记录 + @hist: 历史，保留 7 天）</i>
                              <i>↓</i>
      <b>GET /dash/hist</b> ← 只读消费者：Web 看板 · iPad App · Widget</pre>
    <table>
      <tr><th>端</th><th>权限</th><th>说明</th></tr>
      <tr><td><b>Android</b></td><td>读写</td><td>唯一的生产者，负责 <code>PUT</code> 电量</td></tr>
      <tr><td><b>Web 看板</b></td><td>只读</td><td>cookie 登录（<code>DASH_PWD</code>），不持有 token</td></tr>
      <tr><td><b>iPad App / Widget</b></td><td><b>只读</b></td><td>只用 <code>GET</code>；禁止任何写操作</td></tr>
    </table>
  </div>

  <div class="h2">2 · 接口表</div>
  <div class="panel">
<pre><b>GET</b>    /health                        <i>免鉴权 · {ok,service,time,histRetentionMs,histRetentionDays}</i>
<b>GET</b>    /list?prefix=                  <i>token · {prefix,cursor,keys:[{key,updatedAt}]} 上限 100</i>
<b>GET</b>    /:key                          <i>token · {key,value,version,updatedAt}</i>
<b>HEAD</b>   /:key                          <i>token · 只取 x-sync-version / x-sync-updated</i>
<b>PUT</b>    /:key                          <i>token · body {"value":&lt;任意 JSON&gt;} 上限 24KB</i>
<b>DELETE</b> /:key                          <i>token · 同时清理 @hist:&lt;key&gt;</i>
<b>GET</b>    /dash/hist?key=&amp;range=         <i>token · 只读历史（原生端专用，已带 CORS）</i>
<b>GET</b>    /status                        <i>token 或看板 cookie · 三端状态聚合</i>
<b>GET</b>    /dev · /docs                   <i>协作台（需登录）· 本文档（公开）</i></pre>
    <p class="note">鉴权二选一：请求头 <code>x-sync-token</code>；或先 <code>POST /dash</code> 用 <code>DASH_PWD</code> 换 <code>ws_dash</code> cookie。原生端<b>不要</b>内置看板密码。</p>
  </div>

  <div class="h2">3 · 历史与采样</div>
  <div class="panel">
<pre><b>GET</b> /dash/hist?key=watch/battery&amp;range=86400000
<i>→</i> {"key":"watch/battery","label":"OPPO Watch 4 Pro",
     "hist":[{"t":1793887119729,"l":100,"c":0,"v":22,"s":"DINFO#getBatteryList"}],
     "total":123,"now":1793900000000,"retentionMs":604800000}</pre>
    <table>
      <tr><th>字段</th><th>语义</th><th>坑</th></tr>
      <tr><td><code>t</code></td><td>毫秒 epoch</td><td><b>不是秒</b>；用 Int64 再 /1000</td></tr>
      <tr><td><code>l</code></td><td>电量 0–100</td><td>可能为 <code>null</code> → 用可选类型</td></tr>
      <tr><td><code>c</code></td><td>1 充电 / 0 未充</td><td>可能为 <code>null</code>，nil 按「未知」</td></tr>
      <tr><td><code>v</code> <code>s</code> <code>m</code></td><td>版本 / 来源 / 模块版本</td><td>调试用，不展示给用户；<code>s</code> 取值不固定</td></tr>
    </table>
    <p class="note">
      <b>range</b>：3600000 · 10800000 · 21600000 · 86400000 · 259200000 · 604800000 · 0（窗口内全部）。
      超过 7 天自动夹紧。
    </p>
  </div>

  <div class="h2">4 · 六条硬约束（改之前先问）</div>
  <div class="panel">
    <ul class="doc">
      <li><b>C1 保留 7 天</b>：604800000 ms，写侧剪枝 + 读侧过滤 + range 夹紧三处同源。</li>
      <li><b>C2 不做开关</b>：7 天是产品定义，不是环境变量。</li>
      <li><b>C3 token 不进仓库</b>：它能写能删，泄露=全量失控。</li>
      <li><b>C4 原生端不内置看板密码</b>：用 <code>/dash/hist</code>，别碰 cookie 流程。</li>
      <li><b>C5 采样时间单调递增</b>：裁剪与绘图都依赖这条不变量。</li>
      <li><b>C6 同值不落点</b>：<code>level</code> 与 <code>charging</code> 都没变就不记点。</li>
    </ul>
  </div>

  <div class="h2">5 · 五个必踩的坑</div>
  <div class="panel">
    <ul class="doc">
      <li><b>曲线有长平台</b>：因为 C6，不是丢数据。闲置 &gt; 2 小时灰显「数据未更新」。</li>
      <li><b><code>range=0</code></b>：「保留窗口内全部」（≤7 天），不是「有史以来」。</li>
      <li><b>键不存在</b>：<code>/dash/hist</code> 返回 <b>200 + 空数组</b>，不是 404。</li>
      <li><b>客户端二次裁剪 7 天</b>：服务端已裁，重复裁会在时钟偏移时误删。</li>
      <li><b>非设备键写历史</b>：<code>status/*</code> 不参与采样，别指望它有曲线。</li>
    </ul>
  </div>

  <div class="h2">6 · 键名与设备识别</div>
  <div class="panel">
<pre>允许字符  a-z A-Z 0-9 . _ : - /     长度 1–256
设备键    watch/battery
          dev/&lt;4–32 位 hex&gt;
          &lt;小写字母开头 1–21 位&gt;/battery
状态键    status/android · status/server · status/ipad
内部键    @hist:&lt;key&gt;   <i>（不对外暴露，不会出现在 /list）</i></pre>
    <p class="note">只有「设备键」会进看板设备列表、才会写历史采样。</p>
  </div>

  <div class="h2">7 · 版本</div>
  <div class="panel">
    <table>
      <tr><th>版本</th><th>内容</th></tr>
      <tr><td><b>v11.1</b></td><td>7 天时间窗 · <code>/dash/hist</code> · DELETE 清历史 · <code>/health</code> 暴露保留窗口 · CORS</td></tr>
      <tr><td><b>v11.2</b></td><td><code>/dev</code> 协作台 · <code>/docs</code> 文档 · <code>/status</code> 聚合 · 非设备键不再写历史</td></tr>
    </table>
  </div>

  <hr>
  <p class="note">完整实现细节见仓库 <code>docs/TECH.md</code>、<code>docs/REQUIREMENTS.md</code>、<code>docs/IOS_PROMPT.md</code>。本页只保证「对接所需的最小真相」。</p>
</div>
</body></html>`;

/* ------------------------------- 导出 ------------------------------- */

export function devPage(): Response {
  return new Response(DEV_HTML, { status: 200, headers: HEADERS });
}

export function docsPage(): Response {
  return new Response(DOCS_HTML, { status: 200, headers: HEADERS });
}

interface PeerState {
  id: string;
  missing?: boolean;
  name?: string;
  role?: string;
  phase?: string;
  doing?: string;
  next?: string[];
  blockers?: string[];
  owner?: string;
  updatedAt?: number;
}

/** 读三端状态；缺失的端以 {id, missing:true} 占位，不让页面出现空洞 */
export async function statusData(env: { SYNC_KV: KVNamespace }): Promise<{ now: number; peers: PeerState[] }> {
  const peers = await Promise.all(
    PEERS.map(async (p) => {
      // KV 里存的是外层记录 {key,value,version,updatedAt}，状态在 value 里面
      const rec = (await env.SYNC_KV.get(p.key, 'json')) as
        | { value?: unknown; updatedAt?: string }
        | null;
      const inner = rec && typeof rec.value === 'object' && rec.value !== null ? (rec.value as Record<string, unknown>) : null;
      if (!inner) return { id: p.id, missing: true } as PeerState;
      const raw = inner;
      const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 6) : []);
      // updatedAt 优先用 AI 自己写的毫秒；没写则退回 KV 记录的 ISO 时间
      let updatedAt: number | undefined;
      if (typeof raw.updatedAt === 'number') updatedAt = raw.updatedAt;
      else if (typeof rec?.updatedAt === 'string') {
        const t = Date.parse(rec.updatedAt);
        if (Number.isFinite(t)) updatedAt = t;
      }
      return {
        id: p.id,
        name: typeof raw.name === 'string' ? raw.name : p.name,
        role: typeof raw.role === 'string' ? raw.role : p.role,
        phase: typeof raw.phase === 'string' ? raw.phase : undefined,
        doing: typeof raw.doing === 'string' ? raw.doing : undefined,
        next: arr(raw.next),
        blockers: arr(raw.blockers),
        owner: typeof raw.owner === 'string' ? raw.owner : undefined,
        updatedAt,
      } as PeerState;
    }),
  );
  return { now: Date.now(), peers };
}