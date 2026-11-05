# 跨端同步服务 · Cross-Device Sync

基于 **Cloudflare Workers + Workers KV** 的极简跨端键值同步 API。手机、平板、电脑、脚本都能通过一个 HTTP 接口读写同一份数据。

- 单文件 Worker（`src/index.ts`），无框架、无构建步骤
- Token 鉴权 + 定长比较
- 内置版本号，PUT 支持 `x-sync-base-version` 做乐观并发控制
- 全量 CORS，网页端可直接调用
- 记录结构：`{ key, value, version, updatedAt }`

---

## 一、接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 状态页（HTML） |
| GET | `/health` | 健康检查 |
| GET | `/list?prefix=xxx` | 列出键（最多 100 条） |
| GET | `/:key` | 读取单条记录 |
| HEAD | `/:key` | 只返回版本头 `x-sync-version` / `x-sync-updated` |
| PUT | `/:key` | 写入，body 为 `{"value": <任意 JSON>}` |
| DELETE | `/:key` | 删除 |

- 鉴权：请求头 `x-sync-token: <SYNC_TOKEN>`
- 键名允许 `a-z A-Z 0-9 . _ : - /`，长度 1–256；建议用 `app/路径` 形式的命名空间
- 单值上限：本服务限制 24 KB（KV 本身限 25 MB）

示例：

```bash
BASE=https://cross-device-sync.<你的子域>.workers.dev
TOKEN=<你的 SYNC_TOKEN>

# 写入
curl -X PUT "$BASE/notes/clip" \
  -H "x-sync-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"value":{"text":"hello from phone"}}'

# 读取
curl "$BASE/notes/clip" -H "x-sync-token: $TOKEN"

# 带版本写入（版本不符返回 409）
curl -X PUT "$BASE/notes/clip" \
  -H "x-sync-token: $TOKEN" -H 'x-sync-base-version: 1' \
  -d '{"value":{"text":"updated"}}'
```

---

## 二、部署

### 1. 创建 KV 命名空间

```bash
npx wrangler login
npx wrangler kv namespace create SYNC_KV
```

把输出的 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]]`。

### 2. 设置密钥

```bash
npx wrangler secret put SYNC_TOKEN
# 或者用随机串：openssl rand -hex 24
```

### 3. 选择自动部署方式（二选一）

**方式 A：Cloudflare Workers Builds（Git 集成，推荐）**

1. Cloudflare 控制台 → Workers & Pages → Create → Workers → Connect to Git
2. 授权 GitHub，选择本仓库
3. 构建配置：构建命令留空（或 `npm install`），部署命令 `npx wrangler deploy`
4. 之后每次 push 到 `main`，Cloudflare 自动拉取代码并部署

> 本项目已采用方式 A，因此 `.github/workflows/` 下的 Actions 部署文件已移除，避免重复部署。

**方式 B：GitHub Actions**

1. 在 Cloudflare 创建一个 API Token（权限：Workers Scripts:Edit、Workers KV Storage:Edit）
2. 仓库 Settings → Secrets and variables → Actions，添加：
   - `CF_API_TOKEN`
   - `CF_ACCOUNT_ID`
3. push 到 `main` 即触发 `.github/workflows/deploy.yml`

### 4. 本地开发

```bash
npm install
echo 'SYNC_TOKEN=dev-token' > .dev.vars   # 已在 .gitignore 中
npm run dev
```

---

## 三、目录结构

```
.
├── src/index.ts                 # Worker 全部逻辑
├── wrangler.toml                # Worker 配置 / KV 绑定 / 变量
├── tsconfig.json
└── package.json
```

---

## 四、注意事项

- Workers KV 是**最终一致**的（同区域通常毫秒级生效，跨区域可能滞后数十秒），不适合强一致场景；需要强一致请改用 Durable Objects。
- 版本号校验是「先读后写」实现的乐观锁，不是原子事务；高并发写入同一键时仍可能互相覆盖。
- 请不要把 `SYNC_TOKEN` 提交进仓库，用 `wrangler secret` 或平台环境变量管理。

## License

MIT
