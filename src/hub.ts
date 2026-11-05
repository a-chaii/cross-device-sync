/**
 * WatchSync · 控制台首页（单文件，零外部依赖）
 *
 * 站点总入口：把原来散落的 /dash、/intro、/health 收拢成一张导航页，
 * 并在前端探一次 /health 显示实时状态。
 *
 * 设计约束：
 *   - 纯手写 HTML + CSS + 极简 JS，无 CDN / 无框架 / 无图片（图标为内联 SVG）
 *   - 与 intro.ts / dash.ts 共用同一套色板（--bg:#0b0f19），切页视觉不跳
 *   - CSP 只放行内联样式/脚本，禁掉一切外部加载
 *
 * 路由：由 index.ts 的 `/` 直接调用 page()。
 */

const HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
};

/* 内联图标：24x24 视图，stroke 跟随 currentColor */
const ICON_CHART =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l3-4 3 3 4-6"/></svg>';
const ICON_INFO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>';
const ICON_PULSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2-5 4 10 2-5h8"/></svg>';
const ICON_CODE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l-5-6 5-6"/><path d="M15 6l5 6-5 6"/></svg>';

const CSS_A = `
  *{box-sizing:border-box}
  :root{
    --bg:#0b0f19; --bg-deep:#070a12; --card:rgba(18,24,38,.72);
    --line:rgba(120,150,255,.14); --txt:#e6ecf8; --muted:#8b98b3;
    --blue:#3b82f6; --violet:#8b5cf6; --green:#34d399; --red:#f87171; --cyan:#22d3ee;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  }
  html,body{margin:0;padding:0}
  body{
    min-height:100vh;background:var(--bg);color:var(--txt);line-height:1.6;
    font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased;
    padding:0 18px 56px;position:relative;overflow-x:hidden;
  }
  /* 背景层：双层径向光晕 + 网格，网格顶部径向渐隐 */
  .bg{position:fixed;inset:0;pointer-events:none;z-index:0}
  .bg::before{
    content:"";position:absolute;inset:0;
    background:
      radial-gradient(760px 420px at 18% -8%,rgba(59,130,246,.20),transparent 70%),
      radial-gradient(640px 380px at 88% 4%,rgba(139,92,246,.16),transparent 72%),
      radial-gradient(900px 500px at 50% 108%,rgba(34,211,238,.08),transparent 70%);
  }
  .bg::after{
    content:"";position:absolute;inset:0;
    background-image:linear-gradient(rgba(120,150,255,.055) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(120,150,255,.055) 1px,transparent 1px);
    background-size:48px 48px;
    -webkit-mask-image:radial-gradient(circle at 50% 0%,#000 0%,transparent 72%);
    mask-image:radial-gradient(circle at 50% 0%,#000 0%,transparent 72%);
  }
  .wrap{position:relative;z-index:1;max-width:60rem;margin:0 auto}

  /* 顶栏 */
  .bar{display:flex;align-items:center;gap:10px;padding:22px 2px 0;flex-wrap:wrap}
  .mark{
    width:22px;height:22px;border-radius:7px;flex:none;
    background:linear-gradient(135deg,var(--blue),var(--violet));
    box-shadow:0 3px 12px rgba(59,130,246,.42);
  }
  .brand{font-size:.92rem;font-weight:650;letter-spacing:.01em}
  .ver{font-family:var(--mono);font-size:9.5px;color:#4f5d7d;border:1px solid var(--line);
       border-radius:5px;padding:1px 5px}
  .pill{
    margin-left:auto;display:inline-flex;align-items:center;gap:6px;
    font-family:var(--mono);font-size:10.5px;border-radius:999px;padding:4px 10px;
    border:1px solid var(--line);background:rgba(18,24,38,.6);color:var(--muted);
    transition:color .2s,border-color .2s;
  }
  .pill .dot{width:6px;height:6px;border-radius:50%;background:var(--muted);flex:none}
  .pill.ok{color:var(--green);border-color:rgba(52,211,153,.34)}
  .pill.ok .dot{background:var(--green);box-shadow:0 0 7px rgba(52,211,153,.8)}
  .pill.bad{color:var(--red);border-color:rgba(248,113,113,.34)}
  .pill.bad .dot{background:var(--red);box-shadow:0 0 7px rgba(248,113,113,.8)}
  .pill.wait .dot{animation:blink 1.1s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:.28}50%{opacity:1}}

  /* 标题区 */
  h1{
    margin:34px 0 0;font-size:clamp(1.65rem,4.6vw,2.4rem);line-height:1.2;letter-spacing:-.02em;
    background:linear-gradient(96deg,#eaf1ff 8%,#9db8ff 48%,#a78bfa 96%);
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  }
  .sub{margin:10px 0 0;color:var(--muted);font-size:.87rem;max-width:34rem}
  .chain{
    margin:16px 0 0;font-family:var(--mono);font-size:11px;color:#5f6e90;
    display:flex;align-items:center;gap:7px;flex-wrap:wrap;
  }
  .chain span{color:#7f8db0}
  .chain i{color:#3f4d6b;font-style:normal}
`;const CSS_B = `
  /* 入口卡片 */
  .grid{display:grid;gap:12px;margin-top:26px;grid-template-columns:repeat(auto-fit,minmax(15.5rem,1fr))}
  a.card{
    display:block;text-decoration:none;color:inherit;position:relative;
    border-radius:15px;border:1px solid var(--line);background:var(--card);
    padding:16px 17px 15px;
    -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
    transition:transform .2s,border-color .2s,box-shadow .2s;
  }
  a.card:hover{
    transform:translateY(-3px);border-color:rgba(120,150,255,.32);
    box-shadow:0 12px 30px -12px rgba(59,130,246,.42);
  }
  a.card:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
  .ic{
    width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(140deg,rgba(59,130,246,.20),rgba(139,92,246,.16));
    border:1px solid rgba(120,150,255,.20);color:#a9c2ff;margin-bottom:11px;
  }
  .ic svg{width:17px;height:17px}
  a.card.g1 .ic{color:#93b4ff}
  a.card.g2 .ic{color:#c4b5fd}
  a.card.g3 .ic{color:#6ee7b7}
  a.card.g4 .ic{color:#7dd3fc}
  .t{font-size:.92rem;font-weight:620;display:flex;align-items:center;gap:8px}
  .d{margin:6px 0 0;color:var(--muted);font-size:.79rem;line-height:1.65}
  .tag{
    display:inline-block;margin-top:11px;font-family:var(--mono);font-size:9.5px;
    color:#6b81ad;background:rgba(120,150,255,.07);border:1px solid var(--line);
    border-radius:5px;padding:1.5px 6px;
  }
  .arrow{
    position:absolute;right:16px;top:17px;color:#3f4d6b;font-size:14px;
    transition:transform .18s,color .18s;
  }
  a.card:hover .arrow{transform:translateX(3px);color:#8fa6d8}

  /* 面板 */
  .panel{
    margin-top:16px;border-radius:16px;background:var(--card);border:1px solid var(--line);
    padding:15px 18px 16px;
    -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
    scroll-margin-top:12px;
  }
  .panel h2{
    font-size:.8rem;margin:0 0 11px;font-weight:600;color:#cdd8ee;letter-spacing:.03em;
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  }
  .panel h2 em{font-style:normal;font-family:var(--mono);font-size:9.5px;color:var(--muted);font-weight:400}
  pre{margin:0;overflow-x:auto;font-family:var(--mono);font-size:11.5px;line-height:1.9;color:#9fb0d0}
  pre b{color:#7dd3fc;font-weight:500}
  pre i{color:#5a6a8c;font-style:normal}
  .note{margin:13px 0 0;color:#63719a;font-size:.74rem;line-height:1.7}
  .note code{font-family:var(--mono);color:#8fa6d8}
  @media (max-width:520px){
    body{padding:0 14px 44px}
    h1{margin-top:26px}
  }
`;const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex,nofollow">
<title>WatchSync · 控制台</title>
<style>${CSS_A}${CSS_B}</style>
</head>
<body>
<div class="bg"></div>
<div class="wrap">

  <div class="bar">
    <span class="mark"></span>
    <span class="brand">WatchSync</span>
    <span class="ver">v1</span>
    <span class="pill wait" id="pill"><span class="dot"></span><span id="pilltxt">检测中</span></span>
  </div>

  <h1>跨端同步 · 控制台</h1>
  <p class="sub">手表电量经手机中转，写进 Cloudflare KV，任意设备可读。所有页面与接口由同一个 Worker 提供。</p>

  <div class="chain">
    <span>Watch 4 Pro</span><i>&rarr;</i>
    <span>蓝牙</span><i>&rarr;</i>
    <span>PJX110 · LSPosed</span><i>&rarr;</i>
    <span>Worker + KV</span><i>&rarr;</i>
    <span>iPad</span>
  </div>

  <div class="grid">
    <a class="card g1" href="/dash">
      <span class="arrow">&rarr;</span>
      <span class="ic">${ICON_CHART}</span>
      <span class="t">中转看板</span>
      <p class="d">电量曲线、版本递增、上传间隔与最近采样，需要密码登录。</p>
      <span class="tag">/dash</span>
    </a>
    <a class="card g2" href="/intro">
      <span class="arrow">&rarr;</span>
      <span class="ic">${ICON_INFO}</span>
      <span class="t">项目介绍</span>
      <p class="d">整条链路的原理、模块职责边界，以及为什么这么设计。</p>
      <span class="tag">/intro</span>
    </a>
    <a class="card g3" href="/health">
      <span class="arrow">&rarr;</span>
      <span class="ic">${ICON_PULSE}</span>
      <span class="t">健康检查</span>
      <p class="d">返回 service、time 的 JSON 探针，可直接用于监控。</p>
      <span class="tag">/health</span>
    </a>
    <a class="card g4" href="#api">
      <span class="arrow">&rarr;</span>
      <span class="ic">${ICON_CODE}</span>
      <span class="t">接口速查</span>
      <p class="d">键值读写删的完整路由表，附鉴权方式，就在本页下方。</p>
      <span class="tag">API</span>
    </a>
  </div>

  <div class="panel" id="api">
    <h2>接口速查 <em>x-sync-token 鉴权</em></h2>
<pre><b>GET</b>    /health   <i>&rarr; {ok, service, time}</i>
<b>GET</b>    /list     <i>&rarr; {keys:[{name,size,version}]}</i>
<b>GET</b>    /:key     <i>&rarr; 原样返回值 · ETag 缓存</i>
<b>HEAD</b>   /:key     <i>&rarr; 只取 version / 大小</i>
<b>PUT</b>    /:key     <i>&rarr; 写入 · 值不变则版本不涨</i>
<b>DELETE</b> /:key     <i>&rarr; 删除 · 返回 {deleted}</i></pre>
    <p class="note">写与删需带 <code>x-sync-token</code> 请求头，读公开。以 <code>@</code> 开头的内部键不会出现在 /list 里。</p>
  </div>

</div>
<script>
(function(){
  var pill=document.getElementById('pill'), txt=document.getElementById('pilltxt');
  function set(cls,label){ pill.className='pill '+cls; txt.textContent=label; }
  try{
    var t0=Date.now();
    fetch('/health',{cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(function(j){
      if(j&&j.ok){ set('ok','在线 · '+(Date.now()-t0)+'ms'); }
      else { set('bad','异常响应'); }
    }).catch(function(){ set('bad','不可达'); });
    setTimeout(function(){ if(pill.className.indexOf('wait')>-1) set('bad','超时'); },8000);
  }catch(e){ set('bad','不可达'); }
})();
</script>
</body>
</html>`;

export function page(): Response {
  return new Response(HTML, { status: 200, headers: HEADERS });
}

export default page;