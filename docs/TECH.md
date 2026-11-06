# WatchSync / Cross-Device Sync 技术文档

> 版本：v11.1（commit `3c3021b` + `21674dd`）
> 配套文档：`docs/REQUIREMENTS.md`（需求与硬约束）、`docs/IOS_PROMPT.md`（iOS 端开发提示词）
> 部署形态：Cloudflare Workers（单 Worker）+ Workers KV
> 代码：`src/index.ts`（路由/鉴权/记录 CRUD）、`src/dash.ts`（看板 + 历史采样）、`src/hub.ts`（状态页）、`src/intro.ts`（介绍页）

---

## 1. 系统概述

一个极简的跨端键值同步服务，附带一个「设备续航看板」。

数据流：

```
Android Hook 模块 (WatchBat)
        │  PUT /:key   { "value": {...} }   Header: x-sync-token
        ▼
Cloudflare Worker ──写入──> KV: "<key>"  = { key, value, version, updatedAt }
        │                    KV: "@hist:<key>" = [ {t,l,c,v,s?,m?}, ... ]
        │
        ├── GET /dash/data      (看板 cookie) ──> Web 看板（曲线 + 表格）
        └── GET /dash/hist      (x-sync-token) ──> iOS / 原生客户端
```

设计取向：**极简、零外部依赖、单文件可读**。没有数据库、没有 ORM、没有第三方库，全部逻辑跑在 Worker 里，读 KV 一次拿一条记录。

---

## 2. 数据模型

### 2.1 主记录（一条设备键 = 一个最新状态）

```json
{
  "key": "watch/battery",
  "value": { "level": 65, "charging": 0, "ts": 1793934811390, "name": "OPPO Watch 4 Pro", "src": "watchbat-v10", "mv": "watchbat-v10", "on": 1 },
  "version": 12,
  "updatedAt": "2026-11-06T04:00:11.390Z"
}
```

- `value` 为任意 JSON（服务端不校验结构，只校验大小 ≤ 24 KB）。
- `version` 单调递增，用于乐观并发控制。
- KV 里同时写 `metadata: { updatedAt, version }`，供 `/list` 返回时间戳（不必读 value）。

### 2.2 历史采样（内部键，不对外暴露）

键名：`@hist:<key>`，例如 `@hist:watch/battery`。`/list` 与看板设备列表都会过滤掉 `@` 开头的内部键。

```ts
interface Sample {
  t: number;        // 采样时间（毫秒）。优先取上报 value.ts，否则服务端 Date.now()
  l: number | null; // 电量 0-100，取不到为 null
  c: number | null; // 充电状态 1/0，取不到为 null
  v: number;        // 写入时主记录的 version，用来对齐「这次采样对应哪次上报」
  s?: string | null;// 采集源标识（value.src）
  m?: string | null;// 采集端模块版本（value.mv），看板「模块」列
}
```

### 2.3 保留策略（v11 变更）

| 约束 | 值 | 位置 | 说明 |
|---|---|---|---|
| 时间窗 | **7 天** | `HIST_TTL_MS = 7 * 86400000` | 主约束。写入剪枝 + 读取兜底 |
| 条数上限 | 2000 | `HIST_LIMIT` | 仅兜底，防异常高频写入把单 value 撑大 |
| 单设备下发上限 | 900 | `DEVICE_HIST_CAP` | 仅总览分支生效 |
| 总览设备数 | 12 | `MAX_DEVICES` | 控制 KV 读次数 |
| 前端默认范围 | 7 天 | `S.range = 604800000` | 下拉选项：1h / 3h / 6h / 24h / 3d / 7d / 全部 |

要点：

- **7 天是硬约束，不是可配置项**。读取侧也套用同一个 `from`，所以即使 KV 里残留更老的点（旧版本写入），对外也永远不会超过 7 天。
- `range=0`（前端「全部」）语义是「保留窗口内的全部」，不是「有史以来全部」。
- 裁剪方式：数组按 `t` 单调递增，过期点必然集中在头部，用「下标扫描 + 一次 `splice`」剪枝（比 `filter` 少一次全量拷贝）。

---

## 3. 采样算法（`appendHist`）

每次 `PUT /:key` 成功后调用，由 `ctx.waitUntil()` 异步执行，**不拖慢上报、失败不影响主写入**（整体 try/catch 静默）。

步骤：

1. 读 `@hist:<key>`（JSON 数组，缺失视为空）。
2. 归一化时间 `t`：
   - 取 `value.ts`；仅当 `ts > 1e12`（毫秒）、`ts <= now + 5min`、`ts > now - 60d` 时才采用，否则回退 `Date.now()`。
   - 若 `t < last.t`，夹紧为 `last.t`（保持时间轴单调，容忍补传乱序）。
3. **去重**：若 `last.l === l && last.c === c`，直接 return，不落点。
   - 目的：轮询型数据源（`DeviceInfo.getBatteryList` 的缓存值）会反复返回同一个数字，按时间补点会让「缓存值」伪装成「持续上报」。
   - 副作用：装新包后如果电量没变，短期内不会出现新采样点（这是预期行为，不是丢字段）。
4. 时间窗剪枝（7 天）。
5. push 新点，再做 `HIST_LIMIT` 兜底裁剪。
6. 写回整个数组（KV 无 append，只能读改写）。

> 注意：KV 同一 key 写入频率上限约 1 次/秒。当前采集端 `UPLOAD_GAP = 20s`、`HEARTBEAT_GAP = 300s`，且「同值不记点」，实际远低于该限制。

---

## 4. API 契约

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` `/index.html` | 无 | 状态页（hub） |
| GET | `/intro` | 无 | 介绍页 |
| GET | `/health` | 无 | 健康检查，含 `histRetentionMs` / `histRetentionDays` |
| GET | `/list?prefix=` | `x-sync-token` | 列键，最多 100 条，屏蔽 `@` 前缀 |
| GET | `/dash` | 看板 cookie | 未登录返回登录页 |
| POST | `/dash` | 密码 | 表单 `pwd=`，成功 303 + `Set-Cookie: ws_dash=...` |
| GET | `/dash/data?key=&range=` | 看板 cookie | 看板数据 JSON |
| GET | `/dash/hist?key=&range=` | `x-sync-token` | **v11 新增**：单设备历史 JSON（供原生端） |
| GET | `/:key` | `x-sync-token` | 读记录；支持 `If-None-Match` → 304 |
| HEAD | `/:key` | `x-sync-token` | 只返回 `X-Sync-Version` / `X-Sync-Updated` |
| PUT | `/:key` | `x-sync-token` | body `{"value": <any>}`，≤ 24 KB |
| DELETE | `/:key` | `x-sync-token` | 删除主记录 **并清理 `@hist:`** |

### 4.1 鉴权

- `x-sync-token` 必须等于环境密钥 `SYNC_TOKEN`；**定长逐字节比较**（`diff |= a^b`）防时序侧信道，长度不等直接 false。
- 看板：cookie `ws_dash = sha256("ws-dash-v1|" + DASH_PWD + "|" + SYNC_TOKEN)`，`HttpOnly; SameSite=Lax; Max-Age=2592000`。`DASH_PWD` 未设置时回退 `114514`。
- 两个通道互相独立：看板 cookie 不能调 `/list`，token 也不能替代 cookie 读 `/dash/data`。

### 4.2 键名规则

`normalizeKey`：`decodeURIComponent` 后长度 1–256，字符集 `[a-zA-Z0-9._:\-/]`。

设备键（决定是否进看板设备列表）：

| 形式 | 匹配 | 示例 |
|---|---|---|
| 手表兼容键 | 字面量 `watch/battery` | `watch/battery` |
| 蓝牙设备 | `^dev\/[0-9a-f]{4,32}$`（i） | `dev/9cfb77bd3e64` |
| 通用 | `^[a-z][a-z0-9_-]{0,20}\/battery$` | `buds/battery`、`ios/battery` |

展示名 `labelOf` 优先级：上报 `value.name` → `watch/battery` 显示「手表」→ `dev/xxx` 显示「设备 + hex 后 6 位」→ 段名。

### 4.3 `/dash/data` 响应

单设备：

```json
{ "key": "watch/battery", "label": "OPPO Watch 4 Pro", "keys": ["watch/battery", "@..."],
  "devices": ["watch/battery"], "rec": { "key":"...","value":{},"version":9,"updatedAt":"..." },
  "hist": [ { "t": 1793934000000, "l": 65, "c": 0, "v": 9, "s": "watchbat-v10", "m": "watchbat-v10" } ],
  "total": 23, "now": 1793934811390 }
```

总览（`key=*`）：`items[]`，每项 `{key,label,rec,hist,total}`，`hist` 已按 `DEVICE_HIST_CAP=900` 从尾部截断。

`range` 单位毫秒，`0`/缺省=保留窗口内全部；服务端 `Math.min(range, HIST_TTL_MS)` 夹到 7 天，内部再以 7 天窗口兜底。

### 4.4 `/dash/hist` 响应（v11 新增）

给 iOS / 原生端用的**只读、纯 JSON、token 鉴权**历史端点。为什么需要它：`/dash/data` 依赖看板 cookie（要拿 `DASH_PWD` 换），原生 App 不该内置看板密码；而 `GET /:key` 只返回最新记录、不含历史。

```json
{ "key": "watch/battery", "label": "OPPO Watch 4 Pro",
  "hist": [ { "t": 1793934060000, "l": 64, "c": 0, "v": 10, "m": "watchbat-v10" } ],
  "total": 2, "now": 1793934811390, "retentionMs": 604800000 }
```

- `hist` 升序，已按 `range` 与 7 天窗口裁剪。
- `retentionMs` 让客户端自证契约版本，不必硬编码 7 天。
- 错误：`400 invalid_key`（缺 key / key 以 `@` 开头）、`401 unauthorized`。
- **CORS**：v11.1 起该端点（含 400/401 错误响应）都会合并 `cors` 头，Web 端跨域可直接调；未加之前只有原生端能用。
- **客户端形态**：iOS App + 桌面 Widget 均为**只读消费者**（只用 `GET`），规格见 `docs/IOS_PROMPT.md`。

### 4.5 状态码

| 码 | error | 触发 |
|---|---|---|
| 400 | `invalid_key` / `bad_request` | 键名非法；PUT body 不是 `{"value":...}` |
| 401 | `unauthorized` | token 缺失/错误；或看板 cookie 无效 |
| 404 | `not_found` | 主记录不存在 |
| 405 | `method_not_allowed` | 方法不支持 |
| 409 | `version_conflict` | 带 `x-sync-base-version` 且与服务端版本不一致，返回 `current` 记录 |
| 413 | `payload_too_large` | 请求体 > 24 KB（`limit` 字段给上限） |

---

## 5. 容量与配额

### 5.1 KV 硬限制

| 项目 | 免费版 | Paid（$5/月） |
|---|---|---|
| 总容量 | 1 GB | 10 GB |
| 读 | 10 万/天 | 1000 万/月 |
| 写 | **1000/天** | 100 万/月 |
| list | **1000/天** | 100 万/月 |
| 单 value | 25 MiB | 同 |
| 单 key 名 | 512 B | 同 |
| 同 key 写频率 | ≈1 次/秒 | 同 |
| 一致性 | 最终一致（≤60s） | 同 |

### 5.2 实测/估算

- 单点体积：手表 ≈ 58 B、耳机 ≈ 68 B（含 `s`/`m`）。
- 7 天窗口下：稳态 10–25 点/天 → 70–175 点/设备 → **约 5–12 KB/设备**。
- 2000 点满额 ≈ 114 KB/设备；1 GB 理论可装 ~9000 台满额设备（旧模型）。
- **真正的瓶颈是每日配额，不是容量**：
  - 写入 = 心跳驱动。单设备在线 12 次/时 ≈ 288 写/天 → 3 台就接近 1000/天。
  - 看板 60s 自动刷新 × 24h = 1440 次 `list`/天 → 免费版直接超。
- 应对：看板刷新改 5 分钟；多设备全上线后升 Paid；要长档改 R2/D1，别把 KV 数组继续撑大。

---

## 6. 部署与运维

```bash
cd /root/cross-device-sync
npx tsc --noEmit          # 类型检查（tsconfig 已开 strict + workers-types）
npx wrangler deploy       # 需要已登录 / CLOUDFLARE_API_TOKEN
```

机密（不要写进 `wrangler.toml`）：

```bash
npx wrangler secret put SYNC_TOKEN    # 必须
npx wrangler secret put DASH_PWD      # 可选，未设置回退 114514（务必设置）
```

已知限制：

- **当前环境 `wrangler whoami` 未认证**，无法部署，只能改代码 + 等有凭证的环境执行 `deploy`。
- **本地 `wrangler dev` 在 proot 下会崩**（`MmapAligned(1GB)`），不要用；本地验证请用「tsc 编译单文件 + mock KV」（见 §7）。

上线后验证清单：

1. `GET /health` → 含 `"histRetentionDays": 7`。
2. `GET /dash` → 登录后页面 `size ≈ 26 KB`，下拉默认「近 7 天」，无「近 30 天」。
3. `curl -H "x-sync-token: $T" "$HOST/dash/hist?key=watch/battery"` → 200 且 `hist` 数组升序、`retentionMs=604800000`。
4. 触发一次电量变化 → 新点 `t` 为当前时间，旧点若超 7 天已消失。
5. `DELETE /:key` → `@hist:` 同键也被清（用 `/list?prefix=@hist:` 看不到，需 KV 控制台或临时脚本确认）。

---

## 7. 本地验证方法（无 wrangler dev）

```bash
# 1. 单文件编译（绕过 tsconfig 的 noEmit）
npx tsc src/dash.ts --outDir /tmp/db3 --target ES2022 --module ESNext \
  --moduleResolution Bundler --types @cloudflare/workers-types --skipLibCheck

# 2. 让 node 按 ESM 解析
echo '{"type":"module"}' > /tmp/db3/package.json

# 3. mock KV 跑断言：get/put/delete/list 四个方法即可
node /tmp/db3/test_ttl.mjs
```

当前回归结果（v11）：

- `TTL_TEST ALL_PASS pass=12 fail=0`（剪枝 / 全过期 / 2000 兜底 / 读取侧兜底 / range 生效 / range 夹紧 / 键前缀）
- `PAGE_CHECK`：默认 7 天、下拉选中、无 30 天项、`colspan="8"`、`class="mod"` 全部保留
- `node --check new_live.js` → 通过（页面内嵌脚本 17846 B）

---

## 8. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 看板「模块」列全是 `—` | 装新包后电量未变，被「同值不记点」跳过 | 等电量变化（降 1% 或插拔充电）后自动出现 |
| 看板某设备曲线是直线 | 数据源是缓存值，`l`/`c` 都不变 | 预期行为，不是丢数据 |
| `PUT` 返回 413 | body > 24 KB | 客户端裁剪字段 |
| `PUT` 返回 409 | 带了 `x-sync-base-version` 且已过期 | 重新 GET 拿 version 再写 |
| `GET /:key` 404 但看板有数据 | 看板读的是 `@hist:`，主记录可能被 DELETE | 检查是否误删 |
| 设备不出现在看板 | 键名不匹配 `isDeviceKey` | 用 `watch/battery`、`dev/<hex>`、`xxx/battery` |
| 设备端状态文件找不到 | 在外部私有目录 | `/sdcard/Android/data/com.heytap.mydevices/files/`（不是 `/data/data`） |

---

## 9. 开发协作台与状态协议（v11.2）

两端 AI 并行开发容易信息漂移、重复造轮子，因此提供三个入口作为**公共锚点**：

| 路由 | 鉴权 | 用途 |
|---|---|---|
| `GET /docs` | 公开 | 开发文档：接口契约、字段语义、六条硬约束、必踩的坑。AI 用 `curl` 即可取 |
| `GET /dev` | 看板 cookie | 协作台：分工边界表 + 三端实时进度 + 在线状态 |
| `GET /status` | token 或 cookie | 三端状态聚合 JSON，供页面轮询 |

### 9.1 状态存储：一端一键，永不共写

```
status/android    Android 采集端
status/server     服务端 + Web
status/ipad       iPad 客户端
```

**为什么不用一个 `status` 键**：`PUT` 是整条覆盖、没有字段级合并，两端共写必然互相吞掉，最后「看起来有内容，其实是半个真相」。

### 9.2 value 结构

```json
{
  "id": "server",
  "name": "服务端 + Web",
  "role": "Worker · KV · 看板 · 文档",
  "phase": "v11.2 已上线",
  "doing": "写协作台与开发文档",
  "next": ["等 iPad 端接入状态", "观察 KV 写入量"],
  "blockers": [],
  "owner": "CH_AI",
  "updatedAt": 1793900000000
}
```

- `updatedAt` 用**毫秒**；页面据此判在线：< 15 分钟「在线」，< 2 小时「刚活跃」，否则「离线」。
- 缺 `updatedAt` 时回退用 KV 记录的 ISO 时间。
- value 控制在 500 B 内，**不放代码、日志、diff**。

### 9.3 非设备键不再写历史采样

`appendHist` 现在有前置判断：`if (!isDeviceKey(key)) return;`

- 影响：`status/*` 这类键不会再生成 `@hist:status/*` 垃圾键。
- 效果：状态写入从 **2 次 KV 写降为 1 次**，且历史数组不会被无意义数据撑大。
- 设备键（`watch/battery`、`dev/<hex>`、`xxx/battery`）行为不变。

### 9.4 配额影响

| 项 | 数值 |
|---|---|
| KV 免费额度 | 1,000 写/天 · 100,000 读/天 |
| 现有采样压力 | 手表约 11 分钟一点 → 约 200–400 写/天（每次 PUT 写主键 + `@hist:`） |
| 状态写入 | 里程碑级，约 20–50 写/天 → **+5%~10%** |
| `/status` 渲染 | 每次 3 读，浏览器 20 秒轮询一次 → 读配额无压力 |

结论：**协作台不会成为配额瓶颈**；真正的风险是共写覆盖与历史污染，已分别用「分键」和「设备键判断」消除。

---

## 10. 版本记录

| 版本 | 变更 |
|---|---|
| v11.2 | 新增 `/docs`（公开开发文档）、`/dev`（协作台，cookie）、`/status`（三端状态聚合，token 或 cookie）；`status/<端>` 一端一键永不共写；`appendHist` 对非设备键短路（`status/*` 不再产生 `@hist:` 垃圾键，写入 2 次降 1 次）；主页扩至 6 张卡片 |
| docs | iOS 端定位改为**纯只读接收端**（不上报），新增 Widget 规格（小=电量 / 中=预计续航 / 大=+24h 曲线）；需求文档同步裁定 D1–D4 不再调整。**本次无代码改动** |
| v11.1 `21674dd` | `/dash/hist` 响应合并 CORS 头（含错误响应），Web 端跨域可直接调；补路由级测试 23 条 |
| v11 `3c3021b` | 历史改为 7 天时间窗（`HIST_TTL_MS`）；新增 `/dash/hist`；DELETE 清理 `@hist:`；`/health` 暴露保留窗口；前端默认近 7 天、移除 30 天选项 |
| v10 `67a30fc` | 采样日志显示采集端模块版本（`mv`/`m`），表格新增「模块」列，`colspan` 8 |
| v9 `65686b9` | 值不变不再补采样点；卡片对超 2 小时未变化的值灰显 |
| 更早 | 多设备模型（`dev/<mac>`）、`range` 选择器、看板 cookie 鉴权 |
