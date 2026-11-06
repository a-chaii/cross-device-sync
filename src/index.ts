/**
 * Cross-Device Sync Service (Cloudflare Worker)
 *
 * 一套极简的跨端键值同步 API，数据存放在 Workers KV。
 *
 * 鉴权：请求头 `x-sync-token` 必须等于环境密钥 SYNC_TOKEN。
 *
 * 路由：
 *   GET    /                 -> 服务状态页
 *   GET    /health           -> 健康检查
 *   GET    /list?prefix=xxx  -> 列出键（最多 100 条，屏蔽 @ 前缀的内部键）
 *   GET    /dash             -> 中转数据看板（密码登录，独立 cookie 鉴权）
 *   POST   /dash             -> 提交看板密码
 *   GET    /dash/data        -> 看板数据 JSON（需看板 cookie）
 *   GET    /dash/hist?key=   -> 单设备历史 JSON（需 x-sync-token，供 iOS/原生端）
 *   GET    /:key             -> 读取单条记录
 *   HEAD   /:key             -> 只返回版本信息（响应头 X-Sync-Version / X-Sync-Updated）
 *   PUT    /:key             -> 写入，body: { "value": <any JSON> }
 *                               可选查重头 `x-sync-base-version`，与服务端版本不一致时返回 409
 *   DELETE /:key             -> 删除
 *
 * 记录格式：{ key, value, version, updatedAt }
 */

import intro from './intro';
import hub from './hub';
import {
  appendHist,
  check,
  data as dashData,
  handleLogin,
  histKey,
  history as dashHistory,
  loginPage,
  page as dashPage,
  HIST_TTL_MS,
} from './dash';

export interface Env {
  SYNC_KV: KVNamespace;
  SYNC_TOKEN: string;
  ALLOW_ORIGIN?: string;
  DASH_PWD?: string;
}

interface SyncRecord {
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
}

const MAX_VALUE_BYTES = 24 * 1024; // KV 单值上限 25MB，这里保守限制，防止误用
const MAX_SCAN_KEYS = 100;

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-sync-token, x-sync-base-version',
    'Access-Control-Expose-Headers': 'x-sync-version, x-sync-updated',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function authorized(request: Request, env: Env): boolean {
  const token = request.headers.get('x-sync-token');
  if (!env.SYNC_TOKEN) return false;
  if (!token || token.length !== env.SYNC_TOKEN.length) return false;
  // 定长比较，避免时序侧信道
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ env.SYNC_TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

function normalizeKey(raw: string): string | null {
  const key = decodeURIComponent(raw);
  if (!key || key.length > 256) return null;
  if (!/^[a-zA-Z0-9._:\-\/]+$/.test(key)) return null;
  return key;
}



export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(env);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if ((path === '/' || path === '/index.html') && (method === 'GET' || method === 'HEAD')) {
      return hub();
    }
    // 项目介绍页（WatchSync 落地页，纯前端静态，无需鉴权）
    if ((path === '/intro' || path === '/intro/') && (method === 'GET' || method === 'HEAD')) {
      return intro.fetch(request);
    }

    if (path === '/health' && method === 'GET') {
      return json(
        {
          ok: true,
          service: 'cross-device-sync',
          time: new Date().toISOString(),
          histRetentionMs: HIST_TTL_MS,
          histRetentionDays: Math.round(HIST_TTL_MS / 86400000),
        },
        200,
        cors,
      );
    }

    // ---- 中转数据看板（独立 cookie 鉴权，不走 x-sync-token）----
    if (path === '/dash' || path === '/dash/') {
      if (method === 'GET' || method === 'HEAD') {
        return (await check(request, env)) ? dashPage() : loginPage();
      }
      if (method === 'POST') {
        return handleLogin(request, env);
      }
      return new Response('method_not_allowed', { status: 405 });
    }

    if (path === '/dash/data' && method === 'GET') {
      if (!(await check(request, env))) {
        return json({ error: 'unauthorized', hint: '请先访问 /dash 登录' }, 401);
      }
      // key=* 或省略 -> 多设备总览；range 单位毫秒，0/缺省 = 全部
      const raw = url.searchParams.get('key');
      const k = raw && raw.length > 0 ? raw : '*';
      if (k !== '*' && k.charAt(0) === '@') return json({ error: 'invalid_key' }, 400);
      const r = Number(url.searchParams.get('range') || '0');
      const range = Number.isFinite(r) && r > 0 ? Math.min(r, 90 * 86400000) : 0;
      return dashData(env, k, range);
    }

    if (!authorized(request, env)) {
      return json({ error: 'unauthorized', hint: '请在请求头携带正确的 x-sync-token' }, 401, cors);
    }

    // /dash/hist：只读历史（token 鉴权，给 iOS / 原生端）
    if (path === '/dash/hist' && method === 'GET') {
      const hk = normalizeKey(url.searchParams.get('key') || '');
      if (!hk || hk.charAt(0) === '@') {
        return json({ error: 'invalid_key', hint: '请传 ?key=<设备键>，如 watch/battery' }, 400, cors);
      }
      const hr = Number(url.searchParams.get('range') || '0');
      const hrange = Number.isFinite(hr) && hr > 0 ? Math.min(hr, HIST_TTL_MS) : 0;
      // dashHistory() 返回的 JSON 没带 CORS 头：原生客户端无所谓，
      // 但 Web 端跨域调用 /dash/hist 会被浏览器拦。这里复制响应再合并 cors，
      // 避免把 HTTP 层的事塞进 dash.ts。
      const histRes = await dashHistory(env, hk, hrange);
      const histHeaders: Record<string, string> = {};
      histRes.headers.forEach((v, k) => { histHeaders[k] = v; });
      return new Response(histRes.body, { status: histRes.status, headers: { ...histHeaders, ...cors } });
    }
    // /list
    if (path === '/list' && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const listed = await env.SYNC_KV.list({ prefix, limit: MAX_SCAN_KEYS });
      return json(
        {
          prefix,
          cursor: listed.list_complete ? null : listed.cursor,
          keys: listed.keys
            .filter((k) => k.name.charAt(0) !== '@') // 内部键（如 @hist:*）不对外暴露
            .map((k) => ({ key: k.name, updatedAt: (k.metadata as { updatedAt?: string } | null)?.updatedAt ?? null })),
        },
        200,
        cors,
      );
    }

    // /:key
    if (path.length <= 1) {
      return json({ error: 'not_found' }, 404, cors);
    }

    const key = normalizeKey(path.slice(1));
    if (!key) {
      return json({ error: 'invalid_key', hint: '键仅允许字母、数字、. _ : - /，长度 1-256' }, 400, cors);
    }

    const record = (await env.SYNC_KV.get(key, 'json')) as SyncRecord | null;

    if (method === 'GET') {
      if (!record) return json({ error: 'not_found', key }, 404, cors);
      const etag = '"' + record.version + '-' + record.updatedAt + '"';
      const vh = {
        ...cors,
        etag,
        'x-sync-version': String(record.version),
        'x-sync-updated': record.updatedAt,
      };
      if (request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: vh });
      }
      return json(record, 200, vh);
    }

    if (method === 'HEAD') {
      if (!record) return new Response(null, { status: 404, headers: cors });
      return new Response(null, {
        status: 200,
        headers: {
          ...cors,
          'x-sync-version': String(record.version),
          'x-sync-updated': record.updatedAt,
        },
      });
    }

    if (method === 'PUT') {
      const raw = await request.text();
      if (raw.length > MAX_VALUE_BYTES) {
        return json({ error: 'payload_too_large', limit: MAX_VALUE_BYTES }, 413, cors);
      }

      let value: unknown;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !('value' in parsed)) {
          throw new Error('missing value field');
        }
        value = (parsed as { value: unknown }).value;
      } catch {
        return json({ error: 'bad_request', hint: '请求体需为 {"value": <任意 JSON>}' }, 400, cors);
      }

      // 乐观并发控制：客户端可带上读取到的版本号
      const baseVersionHeader = request.headers.get('x-sync-base-version');
      if (baseVersionHeader !== null) {
        const base = Number(baseVersionHeader);
        const current = record?.version ?? 0;
        if (!Number.isNaN(base) && base !== current) {
          return json(
            { error: 'version_conflict', baseVersion: base, currentVersion: current, current: record },
            409,
            cors,
          );
        }
      }

      const next: SyncRecord = {
        key,
        value,
        version: (record?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };

      await env.SYNC_KV.put(key, JSON.stringify(next), {
        metadata: { updatedAt: next.updatedAt, version: next.version },
      });

      // 顺便记一个历史采样点（异步，不拖慢上报）
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(appendHist(env, key, value, next.version));
      }

      return json(next, 200, {
        ...cors,
        'x-sync-version': String(next.version),
        'x-sync-updated': next.updatedAt,
      });
    }

    if (method === 'DELETE') {
      if (!record) return json({ error: 'not_found', key }, 404, cors);
      await env.SYNC_KV.delete(key);
      // 顺带删掉历史键，避免「删了设备还留一堆 @hist: 孤儿键」
      const cleanup = env.SYNC_KV.delete(histKey(key));
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cleanup);
      else await cleanup;
      return json({ ok: true, key, deletedVersion: record.version }, 200, cors);
    }

    return json({ error: 'method_not_allowed', method }, 405, cors);
  },
} satisfies ExportedHandler<Env>;
