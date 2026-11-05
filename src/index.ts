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
 *   GET    /list?prefix=xxx  -> 列出键（最多 100 条）
 *   GET    /:key             -> 读取单条记录
 *   HEAD   /:key             -> 只返回版本信息（响应头 X-Sync-Version / X-Sync-Updated）
 *   PUT    /:key             -> 写入，body: { "value": <any JSON> }
 *                               可选查重头 `x-sync-base-version`，与服务端版本不一致时返回 409
 *   DELETE /:key             -> 删除
 *
 * 记录格式：{ key, value, version, updatedAt }
 */

export interface Env {
  SYNC_KV: KVNamespace;
  SYNC_TOKEN: string;
  ALLOW_ORIGIN?: string;
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

const STATUS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>跨端同步服务</title>
<style>
  body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
       max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem;line-height:1.7;color:#1f2430}
  code{background:#f2f3f7;border-radius:4px;padding:.1rem .35rem;font-size:.9em}
  pre{background:#f2f3f7;border-radius:8px;padding:1rem;overflow-x:auto}
  h1{font-size:1.5rem;margin-bottom:.25rem}
  .tag{display:inline-block;background:#e8f5ec;color:#1a7f45;border-radius:999px;
       padding:.1rem .6rem;font-size:.78rem;vertical-align:middle}
</style>
</head>
<body>
<h1>跨端同步服务 <span class="tag">running</span></h1>
<p>基于 Cloudflare Workers + KV 的最小化跨端键值同步 API。</p>
<pre>GET    /health
GET    /list?prefix=yourapp/
GET    /:key
HEAD   /:key
PUT    /:key    { "value": ... }   # 需头 x-sync-token
DELETE /:key                       # 需头 x-sync-token</pre>
<p>鉴权头：<code>x-sync-token</code>（服务端密钥 <code>SYNC_TOKEN</code>）</p>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (path === '/' && method === 'GET') {
      return new Response(STATUS_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', ...cors },
      });
    }

    if (path === '/health' && method === 'GET') {
      return json({ ok: true, service: 'cross-device-sync', time: new Date().toISOString() }, 200, cors);
    }

    if (!authorized(request, env)) {
      return json({ error: 'unauthorized', hint: '请在请求头携带正确的 x-sync-token' }, 401, cors);
    }

    // /list
    if (path === '/list' && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const listed = await env.SYNC_KV.list({ prefix, limit: MAX_SCAN_KEYS });
      return json(
        {
          prefix,
          cursor: listed.list_complete ? null : listed.cursor,
          keys: listed.keys.map((k) => ({ key: k.name, updatedAt: k.metadata?.updatedAt ?? null })),
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
      return json(record, 200, {
        ...cors,
        'x-sync-version': String(record.version),
        'x-sync-updated': record.updatedAt,
      });
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

      return json(next, 200, {
        ...cors,
        'x-sync-version': String(next.version),
        'x-sync-updated': next.updatedAt,
      });
    }

    if (method === 'DELETE') {
      if (!record) return json({ error: 'not_found', key }, 404, cors);
      await env.SYNC_KV.delete(key);
      return json({ ok: true, key, deletedVersion: record.version }, 200, cors);
    }

    return json({ error: 'method_not_allowed', method }, 405, cors);
  },
} satisfies ExportedHandler<Env>;
