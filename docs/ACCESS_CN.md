# 大陆访问方案（workers.dev 打不开怎么办）

## 1. 现象与根因

- 服务默认域：`cross-device-sync.beluga233.workers.dev`。
- `*.workers.dev` **整个域名**在中国大陆被 DNS 污染（解析回 0.0.0.0 / 127.x / 内网地址）+ SNI 阻断。这与本仓库代码无关：同一个 Worker 换自己的域名就能连。
- **当前已绑自定义域**：`https://a-chai.de5.net`（子域 `a-chai` 的 NS 已委派给 Cloudflare：`greg.ns.cloudflare.com` / `jen.ns.cloudflare.com`）。workers.dev 保留作备份入口。
- 实测本机当前走的是 fake-ip 代理（`getent hosts` 返回 fc00::4、`remote_ip=198.18.0.9`），所以必须带 `--resolve` 才通——**这不是大陆直连可用的证据**。

## 2. 方案对比

| 方案 | 成本 | 改动量 | 大陆可用性 | 结论 |
|---|---|---|---|---|
| **A · 自有域名绑 Custom Domain** | 域名 ¥10–60/年 | 只改一行配置 + 客户端 baseURL | 多数地区可直连（速度一般、偶发超时） | **推荐** |
| B · 迁国内云（阿里云 FC / 腾讯云 SCF + 表存储·Redis） | 免费额度 + 备案域名 | 存储层重写（KV → 表存储），代码大改 | 最好（境内速度） | A 实在不行再考虑 |
| C · 继续挂代理 | 代理费 | 无 | 能用，但「让 iPad 直接看 /docs」这个场景不成立 | 临时 |
| D · 客户端 IP 直连 + 自定义 SNI | 0 | 客户端要写 NWConnection，IP 会漂移 | 脆弱，随时断 | 不推荐 |

## 3. A 方案步骤（约 10 分钟）

1. 买个域名（.top / .xyz / .cc 首年几块到十几块），别买已被墙的。
2. 注册商面板把 NS 改成 Cloudflare 给的两个（形如 xxx.ns.cloudflare.com）。
3. 二选一：
   - Dashboard → Workers & Pages → cross-device-sync → Settings → Domains & Routes → Add → **Custom Domain**，填 a-chai.de5.net；
   - 或改 `wrangler.toml` 里的 `routes`，把域名换成你的，push 到 main 由 GitHub 自动构建上线。
   - **坑**：`routes` 必须是**顶层键**，要写在所有 `[table]`（如 `[vars]`、`[observability]`）之前。写在文件末尾会被 TOML 解析成 `observability.routes`，部署时静默失效。
4. 等证书状态变 Active（1–5 分钟）。
5. 验证：`curl -s https://a-chai.de5.net/health`，再带 token 调 `/dash/stats`。
6. 客户端只改一处：`Config.xcconfig` 的 `API_BASE_URL`；文档里的 base URL 由服务端统一替换。

## 4. 注意

- **不要把 workers.dev 当对外/设备用域名**：Android 采集端、iOS、小组件在大陆会被一起挡住。
- 自定义域与 workers.dev 同时生效，回滚只需改客户端配置。
- Cloudflare 免费版在大陆属「境外边缘」，速度就是境外速度，偶发 5xx/超时；所以客户端必须保留「失败用缓存兜底」，小组件断网静默（见 `/docs` 第 9 节）。
- 自用不需要 ICP 备案；只有做境内合规站点才需要，那时才应该走 B 方案。

## 5. 换域后要同步的地方

| 位置 | 改什么 |
|---|---|
| `wrangler.toml` | 顶层 `routes` 的 `pattern` 换成新域名（勿写在 `[table]` 之后） |
| `docs/*.md` 与 `src/dev.ts` 里的示例 | base URL 统一替换（含 `/docs` 页面示例） |
| `IOS_PROMPT.md` / `IPAD_AGENT_PROMPT.md` | `/docs` 地址与 curl 示例 |
| iOS 工程 | `Config.xcconfig` 的 `API_BASE_URL` |
| `/status/server` | `doing` 里注明新入口，避免两边用旧域 |

