# WatchSync / Cross-Device Sync 技术文档

> 版本：v11.5
> 配套文档：`docs/REQUIREMENTS.md`（需求与硬约束）、`docs/IOS_PROMPT.md`（iOS 端开发提示词）、`docs/ALGO.md`（预测算法唯一实现）、`docs/DESIGN.md`（视觉/交互/文案规范）
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

## 10. 续航预测降噪与充电推断（v11.3）

### 10.1 为什么需要

线上实测（2026-11-06）暴露两个采集端缺陷：

| 现象 | 证据 | 后果 |
|---|---|---|
| 耳机电量在 90/100 之间反复跳 | `dev/240130b55822` 22 分钟内 ±10 跳变 11 次，间隔 0.5–7 分钟 | 假掉电累计 60% → 旧算法算出 3.47 %/h、满电仅 28.8h |
| 手表充电时 `charging` 恒为 0 | `watch/battery` 电量 47→61 上升，但 `c` 全为 0 | 面板显示「放电」；充电上升段混进时间轴，把速率摊薄 |

采集端 `DINFO#getBatteryList` 只给 level，不给充电标志；左右耳交替取值造成锯齿。服务端不删原始数据，只在**预测**时降噪。

### 10.2 三处标注（`annotate()`，纯函数）

| 字段 | 含义 | 判定 |
|---|---|---|
| `rep` | 设备自己上报充电中 | `charging===1 \|\| charging===true` |
| `jump` | 孤立尖点 | 与前后都相差 ≥ `JUMP`，且前后两点彼此相差 ≤ 2 |
| `inf` | 推断充电 / 补登 | 相对上一个**有效**点上升 ≥ 1%（不设上限） |

`jump` 点不参与任何统计，`prev` 不推进，因此下一段增量仍相对最后一个正常点计算。

### 10.3 预测流程

1. `ptsOf()` 统一做标注，下游卡片/表格/统计拿到的都是带标注的点。
2. 统计时跳过 `jump`；`drops` / `累计掉电` / `单次最大` 都只在有效点之间累计。
3. 回归样本只取「两端都不在充电（`rep` 或 `inf`）」的相邻段 —— 充电上升段必须排除，否则斜率被拉平。
4. `olsRate()` 最小二乘求斜率 → 掉电速率；样本 < 3 或斜率为正时返回 `null`。
5. `null` 时回退首末差分 `sum/span`，UI 在续航数字后加 `~` 提示精度低。
6. `life = 100/rate`，超过 720 小时（30 天）判定为不可信，直接不显示。

### 10.4 阈值

| 参数 | 值 | 说明 |
|---|---|---|
| `JUMP` | 8 | 单次跳变阈值(%)。低于 8 的正常掉电不会被误判 |
| 尖点缝合容差 | 2 | 前后两点差 ≤ 2 才认作「同一个值被尖点打断」 |
| 续航上限 | 720h | 超过即视为外推不可信 |
| 回归最小样本 | 3 | 不足则回退差分 |

### 10.5 实测效果

| 设备 | 旧算法 | 新算法 |
|---|---|---|
| 耳机 `dev/240130b55822` | 3.47 %/h · 满电 28.8h | 1.22 %/h · 满电 81.8h（剔噪 9 点） |
| 手表 `watch/battery` | 充电段摊薄速率 | 2.56 %/h · 满电 39.1h（推断充电段 8 点） |

合成用例：稳定放电 1%/h 时回归输出 1.000 %/h、100.0h（零误差）。

### 10.6 已知局限（不改就是坑）

- **稀疏数据不给预测**：一天只有一两个点时，回归样本不足，宁可不显示也不瞎猜。
- **密集锯齿会连带剔除相邻真点**：耳机 10:05 那次真实的 100→90 掉电，因为夹在锯齿中间也被判成 `jump`，累计掉电少算 10%。
- **`inf` 是推断不是事实**：UI 用青色「推测充电」与绿色「充电中」区分，不要混淆。
- **降噪治标不治本**：根因在采集端（不给充电标志、左右耳交替取值），服务端只能减少误导。

---

## 11. 看板「双时间」与充放电双模式（v11.4–v11.5）

### 11.1 为什么拆两个时间（v11.4）

采集端是 Xposed 模块 `com.chai.watchbat`，hook 在 `com.heytap.mydevices` 里，**全是被动回调**。宿主进程不在 Doze 白名单且 `oom_adj=4`，息屏被冻结后不再有新回调；模块的 30s 心跳只重发 DB 旧值，而 `appendHist` 的 C6 去重会直接丢弃「值没变」的写入。结果是 KV 主键 `updatedAt` 在动、历史没有新点。

所以卡片把两个时间分开显示：

| 显示 | 来源 | 含义 |
|---|---|---|
| `电量 hh:mm` | 历史最后一点 | 电量真的变了 |
| `链路 hh:mm` | KV 主键 `updatedAt` | 采集链路还活着（含心跳） |

`链路` 距今 ≥ 2 小时 → 卡片置灰 +「X 没有任何上报，进程可能被冻结」。**这是让看板诚实，不改变采集行为**（A/D 方案已被否决，刷新策略保持原样）。

### 11.2 充电段统计 `chgStat()`（v11.5）

与 `statOf()` 对称，看的是电量上升那一半：

| 环节 | 规则 |
|---|---|
| 起段 | 设备上报充电（`rep`），或相对上一点上涨 ≥ 1% |
| 续段 | 持平**也算**（采集间隔 1–2 分钟，连续持平是常态，按「上升才算充电」会把一次充电切成几十段） |
| 收段 | 电量真正下降才收段；`jump` 尖点直接跳过 |
| 结束态 | 最后一段没被掉电收掉 → `open=true`，即「现在正在充电」 |

派生值：

| 字段 | 公式 | 备注 |
|---|---|---|
| `elapsed` | `last.t - seg.t0` | **不外推到 `Date.now()`**：冻结时会把「已充 5 小时」吹成 8 小时 |
| `rate` | `curGain / elapsed` | 需 `elapsed > 3min` 且 `curGain > 0`，否则 `null`（不显示 `0.00 %/h` 这种假速率） |
| `eta` | `(100 - last.l) / rate` | 仅 `last.l < 100`；满电不给 |
| `avgRate` | 闭合段均值 | 零/负充入段（耳机 `100→100` 假段）不计入 |

### 11.3 同一毫秒重复写入去重

实测 `11:03:29` 同一毫秒先写 79 再写 75（`v=340/341`）。两条都留会让曲线在同一横坐标「一升一降」，凭空多出一次 4% 掉电，还会把正在进行的充电段从中间切断。`ptsOf()` 只保留先到的那条。

### 11.4 UI 切换

续航统计面板右上角 `.seg` 两个按钮（放电/充电），`S.mode` 切换后纯前端重绘，不重新请求 `/dash/data`。切换同时改：

| 元素 | 放电 | 充电 |
|---|---|---|
| 统计面板标题 | 续航统计 | 充电统计 |
| 分布图标题 | 掉电分布 | 充入分布 |
| 分布图口径 | 每小时掉电**次数**（蓝） | 每小时充入**百分点**（绿） |
| 采样日志第 4 列 | 距上次掉电 | 已充电多久 |
| 卡片状态行 | — | `充电中 · 已充 49 分` |

### 11.5 线上实测（2026-11-06）

| 指标 | 值 |
|---|---|
| 手表充电段 | `10:17 → 11:07`，49→79%（15 点，推断） |
| 已充时长 | 0.82 h（49 分） |
| 充电速率 | 36.63 %/h |
| 预计充满 | 0.57 h（≈11:41 满电） |

去重后手表假掉电从 35 次降到 34 次，累计掉电 57% → 53%。

---

### 11.6 预测统计服务端口径化（v11.6）

**动机**：v11.5 是把算法写成文档让客户端照着抄。结果是两端必然分叉（Web 说 39 小时、客户端说 42 小时），且每次调阈值都要通知两边。v11.6 把整条链路搬到服务端：`src/stats.ts` 是唯一实现，客户端只解码。

**为什么是逐字移植而不是重写**：`src/dash.ts` 的浏览器端 JS（`isCh/annotate/olsRate/ptsOf/cyclePts/sparseOf/statOf/chgStat/fmtDur`）已经在线上跑了几个月，任何「顺便优化」都会让 Web 卡片与 API 数字不一致。所以 `stats.ts` 是这九个函数的逐行等价移植，并用**交叉一致性测试**把两份实现钉在一起：

- `extract_front.py` 从 `src/dash.ts` 按大括号配对抽出浏览器版函数 → `front.js`
- `test_cross.mjs` 用同一批 13 组 fixtures 双跑，逐项断言 `ptsOf / cyclePts / sparseOf / statOf / chgStat / annotate / olsRate / fmtDur / isCh` 结果完全相等（键序无关的稳定序列化，`null` 与省略键归一）
- 另断言七种 `status` 的 `display` 文案形态、`curve` 抽稀（≤240 点、保留首末点、时间严格递增）

当前：`pass=214 fail=0`；HTTP 层 `test_stats.mjs` 35 条；页面回归 `test_page_smoke.mjs` 28 条。

**接口**：`GET /dash/stats?key=&range=&all=1&points=1`，token 鉴权（`x-sync-token`），CORS 合并方式与 `/dash/hist` 一致（复制响应体再叠 `cors`），`cache-control: no-store`。

**返回结构要点**（完整见 `docs/API_STATS.md`）：
- 单设备 `{ key, label, now, retentionMs, rangeMs, device }`；不带 key/`*` 返回 `{ key:'*', count, devices:[...] }`，按 `link.at` 倒序。
- `device.status` 七值：`discharging / charging / inferredCharging / full / sparse / insufficient / noData`；叠加 `flags.linkStopped` / `flags.levelStale` / `flags.sparse` / `flags.gapRatio`。
- `device.display`：`title` / `subtitle` / `lines[1..5]`，**文案在服务端定死**。
- `?points=1` 才出 `curve: [[t,l]]`，上限 240 点，等距抽稀且保留首末点，尖点不入曲线。

**三条必须在服务端修掉的文案坑（本轮实测发现）**：
1. `l >= 100` 时 `eta` 为 `null`，旧逻辑会拼出「约 —后充满」→ 改为「已到 100%，可以拔电了」。
2. 稀疏文案原本硬编码「约 55%」，与阈值脱钩 → 新增 `sparseRatio()` 输出真实占比（`flags.gapRatio`），文案改为「约 N% 的时间没有数据」。
3. `fmtDur` 在「X 时 Y 分」「X 天 Y 时」之间少了空格（`6时25分`）→ 两端同步改成 `6时25分`，由交叉测试锁死。

**客户端侧影响**：`IOS_PROMPT.md` §6 与 `IPAD_AGENT_PROMPT.md` §5 已从「移植算法 + 跑 13 组用例」改为「调接口 + 原样渲染」；`ALGO.md` 降级为口径解释。小组件自动刷新升级为验收硬条款（`policy: .after` + 每次联网 + `reloadAllTimelines()` + 放置 1 小时仍能自更新）。

### 11.7 回归测试（v11.6 起入库）

四套脚本原本放在 `/tmp`，机器清理一次就全丢（本轮丢过两次），已入库到 `tests/`。`npm test`（等价 `bash tests/run.sh`）会：编译 `src/index.ts` 到 `tests/.build/`、补 ESM 的 `.js` 后缀、从 `src/dash.ts` 里按大括号配对抽出 9 个前端函数生成 `front.js`，再依次跑四套：

| 脚本 | 条数 | 管什么 |
|---|---|---|
| `tests/test_cross.mjs` | 214 | 前端 JS 与服务端 TS 逐字等价（13 组 fixtures，键序无关比较，过滤 Swift Codable 显式输出的 null） |
| `tests/test_stats.mjs` | 35 | `/dash/stats` HTTP 契约：鉴权、参数（`range`/`all`/`points`）、返回形状、CORS、排序 |
| `tests/test_page_smoke.mjs` | 28 | `/dash` 页面回归：HTML 闭合、内联脚本语法合法、关键文案与口径未退化 |
| `tests/check_docs.mjs` | 43 | `/docs` 页面与仓库 md 必须与新契约一致（C9/C10、第 7/9 节、七值 `status`、`gapRatio`） |

合计 288 条。`tsc` 会报 5 条 Cloudflare 环境类型缺失（`KVNamespace` / `ExecutionContext` 等），是预期噪音，脚本里已用 `|| true` 兜住——JS 照常产出，不影响测试。

### 11.8 续航口径修正（v11.7）

**症状**：`/dash/stats` 与 Web 卡片显示「满电约 2 天 1 时」（49 小时），明显高于体感。

**证据**（2026-11-06 14:45 线上实测）：`level=94`、`rate=2.04 %/h`、视窗只有 6 点 / 跨度 2 小时 47 分——速率来自「11:57 充满后 2.8 小时只掉 6%」这一小段，外推 100% 就是 49 小时。同一份 7 天历史里另有：11-05 13:58→17:48（3.8h 掉 11%）、17:48→22:51（5h 掉 15%）、夜间 9.5h 掉 20%，合计 58% / 21h ≈ 2.8 %/h，真实约 1 天 12 时。

**根因**：`life = 100 / rate` 这个口径没错，错在 `rate` 只取自「上一次充满之后」的短视窗（`cyclePts`）——窗口越短，越容易被刚充满后的轻负载段拉低速率。

**改法**：新增 `wideRate()` / `withWide()`：

- 只累加「相邻两点都不在充电、且确实掉电（`dd > 0`）」的间隔，**跨充电周期累加**，天然跳过充电上升段与尖点；
- 样本 **≥20 分钟且 ≥2 段**才采纳，否则保留视窗结果（宁可不猜）；采纳后 `life` 按 `100/rate` 重算，`>720h` 仍置 `null`；
- 图表、`drops/sum/span/points` 等描述字段**仍按原视窗语义**，只有速率与续航走长样本。

**附带三处**：`fmtDur` 的「天」阈值从 48h 下调到 24h（`36 时 10 分` → `1 天 12 时`）；新增 `discharge.remainHours/remainText`（`level / rate`，按当前电量还剩多久）——`lifeHours` 是满电口径，两者并列给出；**display 文案与副标题统一改用「还剩 X」**（`level / rate`）。

**验证**：同一份线上历史 49h → **36 时 10 分**（`rate=2.76 %/h`，38 段 / 21h）；交叉测试 182 → **214** 条（新增 `wideRate/withWide` 逐字等价 + 「短窗口不吹牛」4 条断言）。

## 12. 版本记录

| 版本 | 变更 |
|---|---|
| v11.7 | 续航口径修正：新增 `wideRate()` / `withWide()`长样本速率（跨充电周期只累加纯放电间隔，≥20 分钟且 ≥2 段才采纳），修复「刚充满 2 小时就外推 49 小时」；`fmtDur` 天数阈值 48h → 24h；新增 `discharge.remainHours/remainText`（按当前电量还剩多久），display 文案改「还剩 X」；交叉测试 182 → 214 |
| v11.6 | 预测统一收到服务端：新增 `src/stats.ts`（九个算法从 `dash.ts` 逐字移植）+ `GET /dash/stats`（token 鉴权，七值 `status`、`display{title,subtitle,lines}` 成品文案、`curve` 等距抽稀）；修三处文案坑（`l>=100` 不再拼「约 —后充满」、`sparse` 用真实 `gapRatio`、`fmtDur` 补空格）；`/docs` 补第 7 节接口与第 9 节小组件自动刷新，硬约束增至 C10；四套回归测试入库 `tests/` 共 288 条 |
| v11.5 | 充放电双模式：`chgStat()` 充电段统计（已充时长/充入电量/充电速率/预计充满/平均充电速率），`.seg` 右上角切换按钮，掉电分布同步「充入电量」面板，采样日志第 4 列随模式切「距上次掉电 / 已充电多久」，卡片显示「已充 X」；`ptsOf()` 对同一毫秒重复写入去重；充电段允许持平续段 |
| docs v11.5 | 新增 `docs/ALGO.md`（预测算法唯一实现：输入契约/管线/参数/`chgStat` 伪码/13 组校验用例）与 `docs/DESIGN.md`（视觉 token 表/组件清单/九状态矩阵/文案正反例/Web→SwiftUI 映射）；`IOS_PROMPT.md` §6 换为新算法、§5.3 取消电量阈值分色、§11 新增两条禁止；`IPAD_AGENT_PROMPT.md` §5 整节重写（原 `slope<=0.2`/240h/分钟圆 5 的旧口径废弃）；`/docs` 补 §7 算法与 §8 视觉规范、硬约束增至 C8 |
| v11.4 | 卡片拆「电量时间 / 链路时间」双时间：`链路` 取 KV 主键 `updatedAt`（≥2h 置灰提示进程被冻结），`电量` 取历史最后一点；曲线与散点跳过 `jump` 尖点 |
| v11.3 | 续航预测降噪：新增 `annotate()` 标注 `rep`/`jump`/`inf`，剔除孤立尖点、排除充电上升段、以最小二乘回归代替首末差分，续航超 720h 不显示；`charging` 缺失时用上升趋势推断「推测充电」；修复 `dash.ts` 中 `esc()` 将 `"` 映射为自身的转义漏洞 |
| v11.2 | 新增 `/docs`（公开开发文档）、`/dev`（协作台，cookie）、`/status`（三端状态聚合，token 或 cookie）；`status/<端>` 一端一键永不共写；`appendHist` 对非设备键短路（`status/*` 不再产生 `@hist:` 垃圾键，写入 2 次降 1 次）；主页扩至 6 张卡片 |
| docs | iOS 端定位改为**纯只读接收端**（不上报），新增 Widget 规格（小=电量 / 中=预计续航 / 大=+24h 曲线）；需求文档同步裁定 D1–D4 不再调整。**本次无代码改动** |
| v11.1 `21674dd` | `/dash/hist` 响应合并 CORS 头（含错误响应），Web 端跨域可直接调；补路由级测试 23 条 |
| v11 `3c3021b` | 历史改为 7 天时间窗（`HIST_TTL_MS`）；新增 `/dash/hist`；DELETE 清理 `@hist:`；`/health` 暴露保留窗口；前端默认近 7 天、移除 30 天选项 |
| v10 `67a30fc` | 采样日志显示采集端模块版本（`mv`/`m`），表格新增「模块」列，`colspan` 8 |
| v9 `65686b9` | 值不变不再补采样点；卡片对超 2 小时未变化的值灰显 |
| 更早 | 多设备模型（`dev/<mac>`）、`range` 选择器、看板 cookie 鉴权 |
