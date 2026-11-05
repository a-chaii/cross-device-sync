/**
 * WatchSync · 项目介绍页（单文件 Worker）
 *
 * 纯手写 HTML + CSS + 极简 JS，零外部依赖（无 CDN / 无框架 / 无图片）。
 * 链路图完全由 CSS 绘制，并做响应式折行（桌面横向、手机竖向）。
 *
 * 部署：
 *   npx wrangler deploy src/intro.ts --name watchsync --compatibility-date 2025-01-01
 * 或作为现有 Worker 的首页：
 *   import intro from './intro';  →  if (url.pathname === '/') return intro.fetch(request);
 */

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0f19">
<meta name="color-scheme" content="dark">
<meta name="description" content="WatchSync —— 打破生态壁垒，跨越安卓与 iOS 的极客电量同步方案。">
<title>WatchSync · 跨生态电量同步</title>
<style>
  :root{
    --bg:#0b0f19;
    --bg-deep:#070a12;
    --card:rgba(18,24,38,.72);
    --line:rgba(120,150,255,.14);
    --txt:#e6ecf8;
    --muted:#8b98b3;
    --blue:#3b82f6;
    --violet:#8b5cf6;
    --green:#22c55e;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  }

  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{
    margin:0;
    min-height:100%;
    background:var(--bg);
    color:var(--txt);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans SC",sans-serif;
    line-height:1.6;
    -webkit-font-smoothing:antialiased;
    -webkit-tap-highlight-color:transparent;
    overflow-x:hidden;
  }

  /* ---------- 背景：径向光晕 + 网格 + 顶部渐隐 ---------- */
  .bg{
    position:fixed;inset:0;z-index:-1;pointer-events:none;
    background:
      radial-gradient(58rem 34rem at 12% -8%, rgba(59,130,246,.20), transparent 62%),
      radial-gradient(48rem 32rem at 92% 4%, rgba(139,92,246,.18), transparent 64%),
      radial-gradient(38rem 26rem at 50% 112%, rgba(34,197,94,.08), transparent 66%),
      var(--bg-deep);
  }
  .bg::after{
    content:"";position:absolute;inset:0;
    background-image:
      linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
    background-size:48px 48px;
    -webkit-mask-image:radial-gradient(72% 58% at 50% 26%, #000 20%, transparent 82%);
            mask-image:radial-gradient(72% 58% at 50% 26%, #000 20%, transparent 82%);
  }

  .wrap{max-width:1040px;margin:0 auto;padding:clamp(40px,9vh,96px) 20px 56px}

  /* ---------- 入场动画 ---------- */
  .reveal{opacity:0;animation:rise .75s cubic-bezier(.22,.72,.28,1) forwards;animation-delay:var(--d,0s)}
  @keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}

  /* ---------- Hero ---------- */
  .hero{text-align:center;margin-bottom:clamp(38px,7vh,74px)}

  .badge{
    display:inline-flex;align-items:center;gap:8px;
    padding:6px 14px;border-radius:999px;
    font-family:var(--mono);font-size:12px;letter-spacing:.06em;
    color:#9ae7b6;
    background:rgba(34,197,94,.08);
    border:1px solid rgba(34,197,94,.28);
    -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  }
  .badge .dot{
    width:7px;height:7px;border-radius:50%;background:var(--green);
    animation:pulse 2.2s ease-out infinite;
  }
  @keyframes pulse{
    0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}
    70%{box-shadow:0 0 0 9px rgba(34,197,94,0)}
    100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}
  }

  h1{
    margin:22px 0 12px;
    font-size:clamp(2.6rem,9vw,4.5rem);
    line-height:1.04;
    font-weight:800;
    letter-spacing:-.035em;
    background:linear-gradient(102deg,#eef3ff 0%,#a8c1ff 34%,#a78bfa 66%,#7dd3fc 96%);
    -webkit-background-clip:text;background-clip:text;
    color:transparent;
    filter:drop-shadow(0 8px 34px rgba(59,130,246,.28));
  }
  .tagline{
    max-width:33rem;margin:0 auto;
    color:var(--muted);
    font-size:clamp(.95rem,2.3vw,1.08rem);
  }
  .hero-meta{
    margin-top:18px;
    font-family:var(--mono);font-size:11px;letter-spacing:.12em;
    color:#5b6a88;text-transform:uppercase;
  }

  /* ---------- 链路图 ---------- */
  .chain{
    display:flex;flex-wrap:wrap;align-items:center;justify-content:center;
    gap:4px;margin:0 auto clamp(44px,8vh,76px);
  }

  .node{
    position:relative;
    width:clamp(112px,17vw,152px);
    padding:18px 12px 16px;
    border-radius:18px;
    text-align:center;
    background:var(--card);
    border:1px solid var(--line);
    -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
    transition:transform .35s ease,border-color .35s ease,box-shadow .35s ease;
  }
  .node:hover{
    transform:translateY(-5px);
    border-color:rgba(96,140,255,.42);
    box-shadow:0 24px 46px -22px rgba(59,130,246,.7), 0 0 0 1px rgba(59,130,246,.18);
  }
  .node .idx{
    position:absolute;top:8px;right:10px;
    font-family:var(--mono);font-size:10px;color:#3f4d6b;
  }
  .node svg{
    width:30px;height:30px;
    stroke:#93b4ff;fill:none;stroke-width:1.6;
    stroke-linecap:round;stroke-linejoin:round;
  }
  .node .name{margin-top:10px;font-size:14.5px;font-weight:650;letter-spacing:.01em}
  .node .role{
    margin-top:2px;
    font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;
    text-transform:uppercase;color:#6575a0;
  }

  /* 连接器：纯 CSS 虚线 + 箭头 */
  .link{
    position:relative;flex:0 0 auto;
    width:clamp(30px,4.6vw,68px);
    display:flex;align-items:center;justify-content:center;
    min-height:24px;
  }
  .link .rail{
    flex:1;height:2px;
    background-image:repeating-linear-gradient(90deg,#6d8bff 0 6px,transparent 6px 12px);
    background-size:12px 2px;
    animation:flow 1s linear infinite;
  }
  .link .tip{
    width:7px;height:7px;margin-left:-3px;
    border-right:2px solid #a78bfa;border-top:2px solid #a78bfa;
    transform:rotate(45deg);
  }
  .link .proto{
    position:absolute;top:-16px;left:50%;transform:translateX(-50%);
    font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;
    color:#5a6a8d;white-space:nowrap;
  }
  @keyframes flow{to{background-position:12px 0}}

  /* ---------- 特性卡片 ---------- */
  .features{
    display:grid;gap:14px;
    grid-template-columns:repeat(auto-fit,minmax(210px,1fr));
  }
  .card{
    position:relative;overflow:hidden;
    padding:20px 18px;border-radius:16px;
    background:var(--card);
    border:1px solid var(--line);
    -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
    transition:transform .35s ease,border-color .35s ease,box-shadow .35s ease;
  }
  .card::before{
    content:"";position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(120% 90% at 8% 0%, rgba(59,130,246,.17), transparent 56%);
    opacity:0;transition:opacity .35s ease;
  }
  .card:hover{
    transform:translateY(-4px);
    border-color:rgba(120,160,255,.36);
    box-shadow:0 26px 50px -26px rgba(59,130,246,.8);
  }
  .card:hover::before{opacity:1}
  .card h3{
    position:relative;margin:0 0 8px;
    font-size:14.5px;font-weight:650;
    display:flex;align-items:center;gap:8px;
  }
  .card h3 .k{
    font-family:var(--mono);font-size:10px;font-weight:400;
    color:#7c8dbb;letter-spacing:.06em;
  }
  .card p{position:relative;margin:0;color:var(--muted);font-size:13px;line-height:1.65}

  /* ---------- 页脚 ---------- */
  footer{
    margin-top:clamp(42px,8vh,74px);padding-top:22px;
    border-top:1px solid rgba(255,255,255,.06);
    display:flex;flex-wrap:wrap;gap:10px 18px;justify-content:space-between;
    font-family:var(--mono);font-size:11px;color:#4e5c7a;letter-spacing:.04em;
  }
  footer .path{color:#66759b}

  /* ---------- 窄屏：链路图竖排 ---------- */
  @media (max-width:760px){
    .chain{flex-direction:column;align-items:center;gap:2px}
    .node{width:min(300px,88vw)}
    .link{
      width:auto;height:46px;flex-direction:column;
    }
    .link .rail{
      width:2px;height:auto;flex:1;
      background-image:repeating-linear-gradient(180deg,#6d8bff 0 6px,transparent 6px 12px);
      background-size:2px 12px;
      animation-name:flowY;
    }
    .link .tip{transform:rotate(135deg);margin:-3px 0 0 0}
    .link .proto{
      top:50%;left:calc(50% + 14px);transform:translateY(-50%);
    }
  }
  @keyframes flowY{to{background-position:0 12px}}

  /* ---------- 无障碍：尊重系统减弱动效 ---------- */
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important}
    .reveal{opacity:1;transform:none}
  }
</style>
</head>
<body>
<div class="bg" aria-hidden="true"></div>

<main class="wrap">
  <header class="hero">
    <div class="badge reveal" style="--d:.05s"><span class="dot"></span>运行中 · RUNNING</div>
    <h1 class="reveal" style="--d:.12s">WatchSync</h1>
    <p class="tagline reveal" style="--d:.2s">打破生态壁垒，跨越安卓与 iOS 的极客电量同步方案。</p>
    <p class="hero-meta reveal" style="--d:.28s">// Edge Relay · Serverless · Zero Maintenance</p>
  </header>

  <section class="chain reveal" style="--d:.36s" aria-label="数据链路">
    <div class="node">
      <span class="idx">01</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="7" y="6" width="10" height="12" rx="3"/>
        <path d="M9.5 6V3h5v3M9.5 18v3h5v-3"/>
      </svg>
      <div class="name">OPPO Watch</div>
      <div class="role">Source</div>
    </div>

    <div class="link" aria-hidden="true">
      <span class="proto">BLUETOOTH</span>
      <span class="rail"></span><span class="tip"></span>
    </div>

    <div class="node">
      <span class="idx">02</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="7" y="2.5" width="10" height="19" rx="2.6"/>
        <path d="M10.6 5.4h2.8"/>
      </svg>
      <div class="name">一加手机</div>
      <div class="role">Automation</div>
    </div>

    <div class="link" aria-hidden="true">
      <span class="proto">HTTPS POST</span>
      <span class="rail"></span><span class="tip"></span>
    </div>

    <div class="node">
      <span class="idx">03</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.5 18.5h10.2a3.7 3.7 0 0 0 .5-7.36A5 5 0 0 0 7.4 9.4 4 4 0 0 0 6.5 18.5Z"/>
      </svg>
      <div class="name">Cloudflare Worker</div>
      <div class="role">Edge Relay</div>
    </div>

    <div class="link" aria-hidden="true">
      <span class="proto">JSON GET</span>
      <span class="rail"></span><span class="tip"></span>
    </div>

    <div class="node">
      <span class="idx">04</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/>
        <path d="M11 17.6h2"/>
      </svg>
      <div class="name">iPad</div>
      <div class="role">Widget</div>
    </div>
  </section>

  <section class="features reveal" style="--d:.46s" aria-label="核心特性">
    <article class="card">
      <h3><span class="k">01</span>Serverless 架构</h3>
      <p>全部逻辑跑在 Cloudflare 边缘节点，没有服务器要养，也没有进程会挂，零维护成本。</p>
    </article>
    <article class="card">
      <h3><span class="k">02</span>安全鉴权</h3>
      <p>请求需携带自定义 Token 头，服务端定长比较校验；密钥只存于 Worker Secret，不进仓库。</p>
    </article>
    <article class="card">
      <h3><span class="k">03</span>iPad 原生小组件</h3>
      <p>借助 Scripting 在桌面直接读取接口，电量数据以原生小组件形式常驻，一眼可见。</p>
    </article>
    <article class="card">
      <h3><span class="k">04</span>安卓自动化链路</h3>
      <p>手表的蓝牙数据由手机端自动化捕获，触发 POST 上报，全程无需人工干预。</p>
    </article>
  </section>

  <footer>
    <span class="path">OPPO WATCH → ONEPLUS → CF EDGE → IPAD</span>
    <span id="clock">--:--:-- UTC</span>
  </footer>
</main>

<script>
  (function () {
    var el = document.getElementById('clock');
    if (!el) return;
    function tick() {
      el.textContent = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    }
    tick();
    setInterval(tick, 1000);
  })();
</script>
</body>
</html>
`;

export default {
  async fetch(request: Request): Promise<Response> {
    // 只允许 GET / HEAD，其余方法给 405，避免被当成通用接口探测
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response(request.method === 'HEAD' ? null : html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  },
};
