/**
 * WatchSync · 服务端预测统计（唯一对外实现）
 *
 * 为什么存在这个文件：
 *   预测算法原本只存在于看板页面的浏览器 JS 里，任何原生端想显示「预计续航」
 *   都只能照文档重写一遍。iPad 端已经这么干过，结果是两端数字对不上。
 *   所以把算法整体搬到服务端，`GET /dash/stats` 直接返回算好的数值 **和** 已格式化的
 *   文案，客户端只负责解码 + 显示，一行算法都不用写。
 *
 * 与前端的关系：
 *   下面的函数是 `src/dash.ts` 里浏览器版函数（ptsOf/annotate/olsRate/cyclePts/
 *   sparseOf/statOf/chgStat/fmtDur）的逐字等价移植。改动其中任何一处，必须同步另一处，
 *   并跑 `/tmp/db10/test_stats.mjs` 的交叉一致性断言（同一批 fixtures，两份实现结果必须相等）。
 *
 * 约束（详见 docs/ALGO.md）：
 *   - 同一毫秒只保留先到的点
 *   - 孤立尖点（|b-a|>=8 且 |b-c|>=8 且 |a-c|<=2）不参与统计、不出现在 curve 里
 *   - 放电速率用最小二乘回归，样本 <3 或斜率 >=0 时回退首末差分
 *   - 续航 >720h 不给；稀疏设备不给
 *   - 充电时长只算到最后一条数据，绝不外推到 now
 */
import { HIST_TTL_MS, isDeviceKey, labelOf, loadHist, type DashEnv, type Sample } from './dash';

/** 单次跳变阈值（百分点）。耳机左右耳交替会表现为 ±10 锯齿 */
const JUMP = 8;
/** 总览最多返回多少台设备（控制 KV 读次数） */
const MAX_DEVICES = 12;
/** 单设备 curve 最多下发多少点 */
const CURVE_CAP = 240;
/** 采集链路多久没 PUT 就判「已停」 */
const LINK_DEAD_MS = 2 * 3600000;
/** 电量多久没变就提示「未变」 */
const LEVEL_STILL_MS = 2 * 3600000;

export interface Pt {
  t: number;
  l: number;
  c: number | null;
  v?: number | null;
  m?: string | null;
  s?: string | null;
  /** 设备自称充电中 */
  rep: boolean;
  /** 孤立尖点 */
  jump: boolean;
  /** 相对上一个非尖点上涨 → 推断充电 */
  inf: boolean;
}

export interface Drop {
  t: number;
  from: number;
  to: number;
  d: number;
}

export interface Stat {
  n: number;
  valid: number;
  jumps: number;
  reg: boolean;
  drops: Drop[];
  sum: number;
  charges: number;
  span: number;
  avgGap: number | null;
  maxGap: number | null;
  minGap: number | null;
  rate: number | null;
  life: number | null;
  maxOne: number;
}

export interface Seg {
  t0: number;
  l0: number;
  t: number;
  l: number;
  n: number;
  inf: boolean;
  t1: number;
  open?: boolean;
}

export interface Chg {
  segs: Seg[];
  n: number;
  open: boolean;
  cur: Seg | null;
  elapsed: number;
  gain: number;
  curGain: number;
  rate: number | null;
  eta: number | null;
  avgRate: number | null;
}

export function isCh(s: { c?: unknown }): boolean {
  return s.c === 1 || (s.c as unknown) === true;
}

/** 采样点标注：rep / jump / inf 三标记。纯函数，不删数据 */
export function annotate(p: Sample[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    out.push({
      t: q.t,
      l: q.l as number,
      c: q.c ?? null,
      v: q.v,
      m: q.m ?? null,
      s: q.s ?? null,
      rep: isCh(q),
      jump: false,
      inf: false,
    });
  }
  // 孤立尖点：与前后都拉开 >= JUMP，而前后两点彼此几乎重合（容差 2）
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    if (Math.abs(b.l - a.l) >= JUMP && Math.abs(b.l - c.l) >= JUMP && Math.abs(a.l - c.l) <= 2) {
      b.jump = true;
    }
  }
  let prev: Pt | null = null;
  for (let i = 0; i < out.length; i++) {
    const q = out[i];
    if (q.jump) continue;
    if (prev && !q.rep) {
      // 只要相对上一个有效点上升，就认定是「充电 / 补登电量」段。
      // 不设 JUMP 上限：从 50 直冲 100 的首个充点也是充电，不能混进掉电回归。
      if (q.l - prev.l >= 1) q.inf = true;
    }
    prev = q;
  }
  return out;
}

/** 最小二乘斜率 → 掉电速率(%/h，正数)；样本不足或趋势向上返回 null，调用方回退首末差分 */
export function olsRate(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxy += dx * (ys[i] - my);
    sxx += dx * dx;
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  if (!isFinite(slope) || slope >= 0) return null;
  return -slope;
}

/** 清洗 + 标注：丢 null，同一毫秒只保留先到的点 */
export function ptsOf(hist: Sample[] | null | undefined): Pt[] {
  const a: Sample[] = [];
  if (!hist) return [];
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];
    if (typeof h.l !== 'number') continue;
    /* 同一毫秒写两条：只保留先到的那条。
       模块在同一 tick 里可能连写两次（实测 11:03:29 先 79 后 75），
       两条都留下会让曲线在同一横坐标上「一升一降」，凭空多出一次 4% 掉电，
       还会把正在进行的充电段从中间切断。 */
    if (a.length && a[a.length - 1].t === h.t) continue;
    a.push(h);
  }
  return annotate(a);
}

/** 视窗：从最后一个满电点切起（「充满电后」口径） */
export function cyclePts(p: Pt[]): Pt[] {
  if (!p || !p.length) return [];
  let idx = -1;
  for (let i = p.length - 1; i >= 0; i--) {
    if (p[i].l >= 100) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    for (let i = p.length - 1; i >= 0; i--) {
      if (isCh(p[i])) {
        idx = i;
        break;
      }
    }
  }
  if (idx <= 0) return p;
  const cut = p.slice(idx);
  return cut.length >= 2 ? cut : p;
}

/** 采样空洞占比（0~1）：跨度 ≥2h 才有意义，否则视为不稀疏 */
export function sparseRatio(p: Pt[]): number {
  if (!p || p.length < 2) return 1;
  const span = p[p.length - 1].t - p[0].t;
  if (span < 7200000) return 0;
  let idle = 0;
  for (let i = 1; i < p.length; i++) {
    const g = p[i].t - p[i - 1].t;
    if (g > 5400000) idle += g;
  }
  return idle / span;
}

export function sparseOf(p: Pt[]): boolean {
  return sparseRatio(p) > 0.55;
}

/** 放电侧统计 */
export function statOf(p: Pt[]): Stat {
  const drops: Drop[] = [];
  let charges = 0;
  let sum = 0;
  let prev: Pt | null = null;
  let maxOne = 0;
  let jumps = 0;
  let valid = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    if (q.jump) {
      jumps++;
      continue; // 孤立尖点：既不算掉电，也不算采样
    }
    valid++;
    if (prev) {
      if (q.l < prev.l) {
        const dd = prev.l - q.l;
        drops.push({ t: q.t, from: prev.l, to: q.l, d: dd });
        sum += dd;
        if (dd > maxOne) maxOne = dd;
      }
      if ((q.rep || q.inf) && !(prev.rep || prev.inf)) charges++;
    }
    prev = q;
  }
  const span = p.length > 1 ? p[p.length - 1].t - p[0].t : 0;
  let gsum = 0;
  let gmax: number | null = null;
  let gmin: number | null = null;
  let gn = 0;
  for (let i = 1; i < drops.length; i++) {
    const gp = drops[i].t - drops[i - 1].t;
    gsum += gp;
    gn++;
    if (gmax === null || gp > gmax) gmax = gp;
    if (gmin === null || gp < gmin) gmin = gp;
  }
  const avgGap = gn ? gsum / gn : null;
  // 降噪主算法：只用「非跳变、两端都不在充电」的相邻段做最小二乘回归，
  // 因为充电段(上升)混进时间轴会把速率摊薄，尖点会把速率放大。
  const xs: number[] = [];
  const ys: number[] = [];
  const t0 = p.length ? p[0].t : 0;
  let pre: Pt | null = null;
  for (let i = 0; i < p.length; i++) {
    const r = p[i];
    if (r.jump) continue;
    const chg = r.rep || r.inf;
    if (pre && !(pre.rep || pre.inf) && !chg) {
      xs.push((r.t - t0) / 3600000);
      ys.push(r.l);
    }
    pre = r;
  }
  const reg = olsRate(xs, ys);
  // 回归不可用（样本<3 或整体在上升）时回退到首末差分
  const rate = reg !== null ? reg : span > 0 && sum > 0 ? sum / (span / 3600000) : null;
  let life: number | null = rate !== null && rate > 0 ? 100 / rate : null;
  if (life !== null && life > 720) life = null; // 超过 30 天的外推不可信，宁可不显示
  return { n: p.length, valid, jumps, reg: reg !== null, drops, sum, charges, span, avgGap, maxGap: gmax, minGap: gmin, rate, life, maxOne };
}


/** 续航口径的长样本速率：跨充电周期只累加「纯放电间隔」。
 *  刚充满后的两三个小时样本会把续航吹上天（实测 2 小时掉 6% → 外推 49 小时），
 *  所以续航外推必须用长样本：累加所有「相邻两点都不在充电」的掉电间隔。
 *  只统计真正掉电（dd > 0）的间隔，充电上升段与尖点一律跳过。 */
export function wideRate(p: Pt[]): { rate: number | null; spanMs: number; n: number; drop: number } {
  let sum = 0;
  let ms = 0;
  let n = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    if (a.jump || b.jump) continue;
    if (a.rep || a.inf || b.rep || b.inf) continue;
    const dd = a.l - b.l;
    if (dd <= 0) continue;
    sum += dd;
    ms += b.t - a.t;
    n++;
  }
  const rate = ms > 0 && sum > 0 ? sum / (ms / 3600000) : null;
  return { rate, spanMs: ms, n, drop: sum };
}

/** 把长样本速率盖到视窗统计上：样本 >=20 分钟且 >=2 段才采纳，否则原样返回（宁可不猜） */
export function withWide(st: Stat, full: Pt[]): Stat {
  const w = wideRate(full);
  if (w.rate === null || w.spanMs < 20 * 60000 || w.n < 2) return st;
  const life = w.rate > 0 ? 100 / w.rate : null;
  return { ...st, rate: w.rate, life: life !== null && life > 720 ? null : life, reg: true };
}

/** 充电侧状态机 */
export function chgStat(p: Pt[]): Chg {
  const segs: Seg[] = [];
  let cur: Seg | null = null;
  let prev: Pt | null = null;
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    if (q.jump) continue; // 尖点不参与分段
    const rise = prev ? q.l - prev.l >= 1 : false; // 相对上一点在涨 → 起段
    const drop = prev ? q.l < prev.l : false; // 真正掉电 → 收段
    if (cur) {
      if (drop) {
        cur.t1 = q.t;
        segs.push(cur);
        cur = null;
      } else {
        /* 持平必须留在段内：采集端每 1~2 分钟报一次，电量经常连续几点不变，
           按「上升才算充电」切段会把一次完整充电切成几十个碎片。 */
        cur.t = q.t;
        cur.l = q.l;
        cur.n++;
        if (q.rep) cur.inf = false;
      }
    } else if (q.rep || rise) {
      cur = { t0: q.t, l0: q.l, t: q.t, l: q.l, n: 1, inf: !q.rep, t1: q.t };
    }
    prev = q;
  }
  if (cur) {
    cur.open = true;
    cur.t1 = cur.t;
    segs.push(cur);
  }
  let gain = 0;
  for (let i = 0; i < segs.length; i++) gain += segs[i].l - segs[i].l0;
  const last = segs.length ? segs[segs.length - 1] : null;
  let elapsed = 0;
  let curGain = 0;
  let rate: number | null = null;
  let eta: number | null = null;
  if (last && last.open) {
    /* 时长只算到「最后一条数据」，不外推到 Date.now()：
       采集端息屏会被冻结，如果按现在外推，一个已经停了 5 小时的充电段
       会被写成「已充 8 小时」，越冻越离谱。宁可显示得保守。 */
    elapsed = last.t - last.t0;
    curGain = last.l - last.l0;
    if (elapsed > 180000 && curGain > 0) rate = curGain / (elapsed / 3600000);
    if (rate !== null && rate > 0 && last.l < 100) eta = ((100 - last.l) / rate) * 3600000;
  }
  let closed = 0;
  let cg = 0;
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    if (g.open) continue;
    const dur = g.t - g.t0;
    if (dur <= 0) continue;
    const gg = g.l - g.l0;
    if (gg <= 0) continue; // 零/负充入的段（例如耳机 100→100 的假段）不参与平均速率
    closed++;
    cg += gg / (dur / 3600000);
  }
  return { segs, n: segs.length, open: last ? !!last.open : false, cur: last, elapsed, gain, curGain, rate, eta, avgRate: closed ? cg / closed : null };
}

/** 时长格式化（与前端 fmtDur 逐字等价） */
export function fmtDur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return s + ' 秒';
  const m = Math.round(s / 60);
  if (m < 90) return m + ' 分';
  const h = Math.floor(s / 3600);
  const mm = Math.round((s % 3600) / 60);
  if (h < 24) return h + ' 时' + (mm ? ' ' + mm + ' 分' : '');
  const dd = Math.floor(h / 24);
  return dd + ' 天' + (h % 24 ? ' ' + (h % 24) + ' 时' : '');
}

const rateText = (v: number | null): string => (v === null ? '—' : v.toFixed(2) + ' %/h');

/** 主状态：七值。另有 linkStopped / levelStale 两个可叠加 flag（见 docs/DESIGN.md 九状态矩阵） */
export type StatsStatus =
  | 'noData'
  | 'charging'
  | 'inferredCharging'
  | 'full'
  | 'sparse'
  | 'insufficient'
  | 'discharging';

export interface DeviceStats {
  key: string;
  label: string;
  now: number;
  view: 'cycle' | 'all';
  retentionMs: number;
  rangeMs: number;
  /** 当前电量（历史最后一点），null = 没数据 */
  level: number | null;
  levelAt: number | null;
  link: { at: number | null; ageMs: number | null; state: 'ok' | 'stopped' };
  status: StatsStatus;
  flags: { linkStopped: boolean; levelStale: boolean; sparse: boolean; gapRatio: number; insufficient: boolean };
  charging: {
    on: boolean;
    inferred: boolean;
    elapsedMs: number;
    elapsedText: string;
    gain: number;
    from: number | null;
    to: number | null;
    rate: number | null;
    rateText: string;
    etaMs: number | null;
    etaText: string;
    full: boolean;
  };
  discharge: {
    rate: number | null;
    rateText: string;
    regression: boolean;
    lifeHours: number | null;
    lifeText: string;
    lifeApprox: boolean;
    remainHours: number | null;
    remainText: string;
    delta24h: number | null;
    delta24hText: string;
    drops: number;
    sum: number;
    maxOne: number;
    charges: number;
    spanMs: number;
    spanText: string;
    avgGapMs: number | null;
    avgGapText: string;
    maxGapMs: number | null;
    maxGapText: string;
    points: number;
    validPoints: number;
    jumps: number;
  };
  charge: {
    segments: number;
    gain: number;
    gainText: string;
    avgRate: number | null;
    avgRateText: string;
    lastSegment: { from: number; to: number; gain: number; rate: number | null; rateText: string; at: number } | null;
  };
  /** 客户端直接显示这两行就够；lines 是 Web 卡片的五行说明文字 */
  display: { title: string; subtitle: string; lines: string[] };
  /** points=1 时才有：已剔尖点的曲线点，[t, l] */
  curve?: Array<[number, number]>;
}

export interface StatsOpts {
  all?: boolean;
  points?: boolean;
}

/** 单设备：算法 → 可直接显示的完整对象 */
export function deviceStats(key: string, label: string, hist: Sample[], rec: { updatedAt?: string } | null, now: number, rangeMs: number, opts: StatsOpts = {}): DeviceStats {
  const full = ptsOf(hist);
  const view = opts.all ? full : cyclePts(full);
  const st = withWide(statOf(view), full);
  const cs = chgStat(full);
  const gapRatio = sparseRatio(full);
  const sparse = gapRatio > 0.55;

  const cur = full.length ? full[full.length - 1] : null;
  const level = cur ? cur.l : null;
  const levelAt = cur ? cur.t : null;

  // 24h 变化：用全量点（不是视窗），否则切窗后就没有 24h 前的位置了
  let c24: number | null = null;
  if (cur) {
    for (let j = full.length - 1; j >= 0; j--) {
      if (cur.t - full[j].t >= 86400000) {
        c24 = full[j].l;
        break;
      }
    }
  }
  const delta = cur && c24 !== null ? cur.l - c24 : null;

  // 电量多久没变（与「链路时间」是两回事）
  let since = cur ? cur.t : 0;
  let stillMs = 0;
  if (cur) {
    since = cur.t;
    for (let q = full.length - 1; q > 0; q--) {
      if (full[q - 1].l !== full[q].l) {
        since = full[q].t;
        break;
      }
      since = full[0].t;
    }
    stillMs = now - since;
  }

  // 链路时间 = KV 主键 updatedAt（心跳也会刷新）
  let linkAt: number | null = null;
  if (rec && rec.updatedAt) {
    const lm = Date.parse(rec.updatedAt);
    if (!isNaN(lm) && lm > 0) linkAt = lm;
  }
  const linkAge = linkAt !== null ? now - linkAt : null;
  const linkStopped = linkAge !== null && linkAge >= LINK_DEAD_MS;
  const levelStale = !!cur && stillMs >= LEVEL_STILL_MS;

  const chgOn = cs.open ? cs.cur : null;
  const chgElapsed = chgOn ? chgOn.t - chgOn.t0 : 0;
  const inferred = !!(chgOn && chgOn.inf);

  let status: StatsStatus;
  if (!cur) status = 'noData';
  else if (chgOn) status = inferred ? 'inferredCharging' : 'charging';
  else if (cur.l >= 100) status = 'full';
  else if (sparse) status = 'sparse';
  else if (st.rate === null || st.life === null) status = 'insufficient';
  else status = 'discharging';

  // ---- 文案：全部在这里定死，客户端不要自己拼 ----
  const title =
    status === 'noData'
      ? '无数据'
      : status === 'charging'
        ? '充电中' + (chgElapsed > 0 ? ' · 已充 ' + fmtDur(chgElapsed) : '')
        : status === 'inferredCharging'
          ? '推测充电' + (chgElapsed > 0 ? ' · 已充 ' + fmtDur(chgElapsed) : '')
          : status === 'full'
            ? '已充满'
            : status === 'sparse'
              ? '数据不足'
              : status === 'insufficient'
                ? '数据不足'
                : '掉电 ' + rateText(st.rate);

  // 充电中但已经到了 100%：eta 必然为 null（算法规定 l>=100 不外推），
  // 这时绝不能拼出「约 —后充满」，否则小组件上会出现一根破折号。
  const chgFull = !!(chgOn && chgOn.l >= 100);
  const etaText = cs.rate !== null && cs.eta !== null ? '约 ' + fmtDur(cs.eta) + '后充满' : '速率样本不足';
  const remain = level !== null && st.rate !== null && st.rate > 0 ? level / st.rate : null;

  const subtitle =
    status === 'charging'
      ? chgFull
        ? '已到 100%，可以拔电了'
        : etaText
      : status === 'inferredCharging'
        ? chgFull
          ? '已到 100%，可以拔电了'
          : etaText
        : status === 'full'
          ? st.life !== null
            ? '还剩 ' + fmtDur(remain * 3600000)
            : '续航待估'
          : status === 'discharging'
            ? st.life !== null
              ? '还剩 ' + fmtDur(remain * 3600000)
              : '续航待估'
            : status === 'sparse'
              ? '采样太稀疏，约 ' + Math.round(gapRatio * 100) + '% 的时间没有数据'
              : status === 'insufficient'
                ? '有效样本不足，暂不外推'
                : '等等客户端上报';

  const lines: string[] = [];
  if (cur) {
    lines.push('电量 ' + fmtDur(now - cur.t) + '前');
    lines.push(linkAt !== null ? '链路 ' + fmtDur(now - linkAt) + '前' + (linkStopped ? ' · 已停' : '') : '链路 —');
    if (linkStopped) lines.push(fmtDur(linkAge) + ' 没有任何上报，进程可能被冻结');
    else if (levelStale) lines.push('链路正常 · 电量 ' + fmtDur(stillMs) + ' 未变');
    lines.push('24h 变化 ' + (delta === null ? '—' : (delta > 0 ? '+' : '') + delta + '%') + ' · 采样 ' + st.valid + ' 条' + (st.jumps ? ' · 剔噪 ' + st.jumps : ''));
    lines.push('掉电 ' + rateText(st.rate) + (st.life !== null ? ' · 还剩 ' + fmtDur(remain * 3600000) + (st.reg ? '' : ' ~') : ''));
  } else {
    lines.push('无数据');
  }

  const out: DeviceStats = {
    key,
    label,
    now,
    view: opts.all ? 'all' : 'cycle',
    retentionMs: HIST_TTL_MS,
    rangeMs,
    level,
    levelAt,
    link: { at: linkAt, ageMs: linkAge, state: linkStopped ? 'stopped' : 'ok' },
    status,
    flags: { linkStopped, levelStale, sparse, gapRatio: Math.round(gapRatio * 100) / 100, insufficient: status === 'insufficient' || status === 'sparse' },
    charging: {
      on: !!chgOn,
      inferred,
      elapsedMs: chgElapsed,
      elapsedText: fmtDur(chgElapsed),
      gain: cs.curGain,
      from: chgOn ? chgOn.l0 : null,
      to: chgOn ? chgOn.l : null,
      rate: cs.rate,
      rateText: rateText(cs.rate),
      etaMs: cs.eta,
      etaText: cs.eta === null ? '—' : fmtDur(cs.eta),
      full: !!chgOn && chgOn.l >= 100,
    },
    discharge: {
      rate: st.rate,
      rateText: rateText(st.rate),
      regression: st.reg,
      lifeHours: st.life,
      lifeText: fmtDur(st.life !== null ? st.life * 3600000 : null),
      lifeApprox: st.rate !== null && !st.reg,
      delta24h: delta,
      remainHours: remain,
      remainText: fmtDur(remain !== null ? remain * 3600000 : null),
      delta24hText: delta === null ? '—' : (delta > 0 ? '+' : '') + delta + '%',
      drops: st.drops.length,
      sum: st.sum,
      maxOne: st.maxOne,
      charges: st.charges,
      spanMs: st.span,
      spanText: fmtDur(st.span),
      avgGapMs: st.avgGap,
      avgGapText: fmtDur(st.avgGap),
      maxGapMs: st.maxGap,
      maxGapText: fmtDur(st.maxGap),
      points: st.n,
      validPoints: st.valid,
      jumps: st.jumps,
    },
    charge: {
      segments: cs.n,
      gain: cs.gain,
      gainText: cs.gain > 0 ? '+' + cs.gain + '%' : '—',
      avgRate: cs.avgRate,
      avgRateText: rateText(cs.avgRate),
      lastSegment:
        cs.n > 0
          ? {
              from: cs.segs[cs.n - 1].l0,
              to: cs.segs[cs.n - 1].l,
              gain: cs.segs[cs.n - 1].l - cs.segs[cs.n - 1].l0,
              rate: cs.segs[cs.n - 1].t1 > cs.segs[cs.n - 1].t0 ? (cs.segs[cs.n - 1].l - cs.segs[cs.n - 1].l0) / ((cs.segs[cs.n - 1].t1 - cs.segs[cs.n - 1].t0) / 3600000) : null,
              rateText: rateText(cs.segs[cs.n - 1].t1 > cs.segs[cs.n - 1].t0 ? (cs.segs[cs.n - 1].l - cs.segs[cs.n - 1].l0) / ((cs.segs[cs.n - 1].t1 - cs.segs[cs.n - 1].t0) / 3600000) : null),
              at: cs.segs[cs.n - 1].t1,
            }
          : null,
    },
    display: { title, subtitle, lines },
  };

  if (opts.points) {
    // 曲线只画非尖点；点太多时等距抽稀（保留首末点）
    const drawable = view.filter((q) => !q.jump);
    let use = drawable;
    if (drawable.length > CURVE_CAP) {
      use = [];
      const step = (drawable.length - 1) / (CURVE_CAP - 1);
      for (let i = 0; i < CURVE_CAP; i++) use.push(drawable[Math.round(i * step)]);
    }
    out.curve = use.map((q) => [q.t, q.l] as [number, number]);
  }
  return out;
}

/** 入口：key 为空/'*' 时返回所有设备 */
export async function statsOf(env: DashEnv, key: string, rangeMs: number, opts: StatsOpts = {}): Promise<Response> {
  const now = Date.now();
  const ttlFrom = now - HIST_TTL_MS;
  const from = rangeMs > 0 ? Math.max(now - rangeMs, ttlFrom) : ttlFrom;
  const cut = (arr: Sample[]): Sample[] => arr.filter((s) => s.t >= from);

  const json = (obj: unknown): Response =>
    new Response(JSON.stringify(obj), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

  if (key && key !== '*' && key !== 'all') {
    const rec = (await env.SYNC_KV.get(key, 'json')) as { value?: unknown; updatedAt?: string } | null;
    const hist = cut(await loadHist(env, key));
    const d = deviceStats(key, labelOf(key, rec?.value), hist, rec, now, rangeMs, opts);
    return json({ key, label: d.label, now, retentionMs: HIST_TTL_MS, rangeMs, device: d });
  }

  let allKeys: string[] = [];
  try {
    const listed = await env.SYNC_KV.list({ limit: 1000 });
    allKeys = listed.keys.map((k) => k.name).filter((n) => n.charAt(0) !== '@');
  } catch {
    allKeys = [];
  }
  const use = allKeys.filter(isDeviceKey).slice(0, MAX_DEVICES);
  const devices = await Promise.all(
    use.map(async (k) => {
      const rec = (await env.SYNC_KV.get(k, 'json')) as { value?: unknown; updatedAt?: string } | null;
      const hist = cut(await loadHist(env, k));
      return deviceStats(k, labelOf(k, rec?.value), hist, rec, now, rangeMs, opts);
    }),
  );
  // 与桌面小组件一致：按链路时间倒序，最近有上报的排前面
  devices.sort((a, b) => (b.link.at || 0) - (a.link.at || 0));
  return json({ key: '*', now, retentionMs: HIST_TTL_MS, rangeMs, count: devices.length, devices });
}
