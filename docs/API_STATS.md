# `GET /dash/stats` 契约（预测统计接口，v11.6）

> 这是**预测数据的唯一真源**。客户端（iOS / iPad / Widget / 未来任何端）**不许再实现算法**，只解码本接口并按 `display.*` 原样渲染。
> 服务端实现：`src/stats.ts`（`deviceStats()` 单设备、`statsOf()` 入口）。算法口径解释见 [`ALGO.md`](./ALGO.md)，但它不是让你实现的。

---

## 1. 请求

```
GET /dash/stats?key=<设备键>                     # 单设备
GET /dash/stats                                  # 全部设备（等价 ?key=*）
GET /dash/stats?key=<设备键>&range=<毫秒>        # 时间窗
GET /dash/stats?key=<设备键>&all=1               # 视窗改为「全部采样」
GET /dash/stats?key=<设备键>&points=1            # 附带曲线点
```

鉴权（**所有**请求）：

```
x-sync-token: <SYNC_TOKEN>
```

| 参数 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `key` | 否 | 设备键 | 缺省或 `*` → 返回全部设备。非法字符 → `400 invalid_key`；`@` 开头（内部键）→ `400 invalid_key` |
| `range` | 否 | 毫秒 | 上限 `604800000`（`HIST_TTL_MS`，7 天），超出被夹断；`0`/缺省 = 保留窗口内全部 |
| `all` | 否 | `1` / `true` | 视窗改用全部采样。默认视窗是 `cyclePts()`：**从最后一个满电点切起**（与 Web 看板一致） |
| `points` | 否 | `1` / `true` | 额外返回 `device.curve` |

响应头：`content-type: application/json; charset=utf-8`、`cache-control: no-store`；配置了 `ALLOW_ORIGIN` 时带 CORS 头（与 `/dash/hist` 一致）。

---

## 2. 响应：单设备

```json
{
  "key": "watch/battery",
  "label": "手表",
  "now": 1762408800000,
  "retentionMs": 604800000,
  "rangeMs": 0,
  "device": { "…见 §4…" }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | 设备键 |
| `label` | string | 展示名（`value.name` → key 推导），直接用，不要自己拼 |
| `now` | number | 服务端当前毫秒时间戳（所有 `ageMs` 都相对它） |
| `retentionMs` | number | 历史保留窗口，恒 `604800000` |
| `rangeMs` | number | 实际生效的时间窗（被夹断后的值），`0` = 全部 |

## 3. 响应：全部设备

```json
{ "key": "*", "now": 1762408800000, "retentionMs": 604800000, "rangeMs": 0,
  "count": 2, "devices": [ { "…§4…" }, { "…§4…" } ] }
```

- `devices` 按 `device.link.at`（KV `updatedAt`，心跳也会刷新）**倒序**：最近有上报的排前面。
- 只包含设备键（`watch/battery`、`dev/<hex>`、`<name>/battery`），**内部键 `@hist:*` 不会出现**。
- 最多 `MAX_DEVICES` 台。

---

## 4. `device` 对象

### 4.1 顶层

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` / `label` | string | 与父级一致（方便单个 `device` 直接传递） |
| `now` | number | 同上 |
| `view` | `"cycle"` \| `"all"` | 实际使用的视窗 |
| `retentionMs` / `rangeMs` | number | 同上 |
| `level` | number \| null | 最新电量 0–100；无采样 → `null` |
| `levelAt` | number \| null | 最新采样时间戳 |
| `link` | object | `{ at: number\|null, ageMs: number\|null, state: "ok"\|"stopped" }`。`at` = KV `updatedAt`；`ageMs ≥ LINK_DEAD_MS` 时 `state="stopped"` |
| `status` | string | 七值，见 §5 |
| `flags` | object | 见 §4.2 |
| `charging` | object | 见 §4.3 |
| `discharge` | object | 见 §4.4 |
| `charge` | object | 见 §4.5 |
| `display` | object | 见 §6，**成品文案** |
| `curve` | `[[t,l], …]` \| 缺省 | 仅 `points=1` 时存在，见 §7 |

### 4.2 `flags`

| 字段 | 类型 | 说明 |
|---|---|---|
| `linkStopped` | bool | `link.ageMs` 超阈值：进程可能被冻结，链路已停 |
| `levelStale` | bool | 链路正常，但电量已长时间未变（`stillMs` 超阈值） |
| `sparse` | bool | 采样空洞占比 > 0.55（且跨度 ≥ 2h） |
| `gapRatio` | number | 真实空洞占比，0–1，两位小数。`sparse` 等价于 `> 0.55` |
| `insufficient` | bool | `status` 是 `sparse` 或 `insufficient` 时为 `true` |

### 4.3 `charging`（当前充电段）

| 字段 | 类型 | 说明 |
|---|---|---|
| `on` | bool | 是否处于**未闭合**充电段 |
| `inferred` | bool | `true` = 设备没报 `c=1`，靠电量上涨推断（手表恒不报 `c`） |
| `elapsedMs` / `elapsedText` | number / string | **`last.t - last.t0`，绝不外推到 `now`**（息屏冻结会把「已充 5 小时」吹成 8 小时） |
| `gain` | number | 本段充入百分点（`last.l - last.l0`） |
| `from` / `to` | number \| null | 段首/段末电量 |
| `rate` | number \| null | `%/h`。需 `elapsedMs > 180000` **且** `gain > 0`，否则 `null`（不许显示 `0.00 %/h`） |
| `rateText` | string | 已格式化，`null` → `—` |
| `etaMs` / `etaText` | number \| null / string | `(100 - to) / rate`；`to ≥ 100` 或 `rate === null` → `null` / `—` |
| `full` | bool | 段末已达 100% |

### 4.4 `discharge`（放电侧统计）

| 字段 | 类型 | 说明 |
|---|---|---|
| `rate` | number \| null | `%/h`。**v11.7 起改长样本**：跨充电周期只累加「两端都不在充电」的纯放电间隔，样本 ≥6h 且 ≥4 段才采纳（否则回退视窗回归）。刚充满 2 小时掉 6% 不会再被外推成 49 小时 |
| `rateText` | string | 格式化，`null` → `—` |
| `regression` | bool | `true` = 用的回归；`false` = 回退首末差分（UI 加 `~`） |
| `lifeHours` | number \| null | **满电口径** `100 / rate`；`> 720h` 置 `null`（不显示「剩余 3000 小时」） |
| `lifeText` | string | 已格式化（如 `1 天 12 时`），`null` → `—`。**≥24h 用天，不再写「36 时」** |
| `lifeApprox` | bool | 是否属「近似值」（回退差分或 `rate` 缺失时为 `true`） |
| `remainHours` | number \| null | **按当前电量** 还能用多久：`level / rate`；v11.7 新增。与 `lifeHours`（满电口径）一起给，客户端按需显示 |
| `remainText` | string | 已格式化（如 `1 天 9 时`），`null` → `—` |
| `delta24h` / `delta24hText` | number \| null / string | 相对 24h 前的变化；无 24h 前样本 → `null` / `—` |
| `drops` | number | 掉电事件数 |
| `sum` | number | 累计掉电百分点 |
| `maxOne` | number | 单次最大掉电 |
| `charges` | number | 上升事件数 |
| `spanMs` / `spanText` | number / string | 视窗跨度 |
| `avgGapMs` / `avgGapText` | number / string | 平均采样间隔 |
| `maxGapMs` / `maxGapText` | number / string | 最大采样间隔 |
| `points` | number | 视窗内点数 |
| `validPoints` | number | 参与统计的有效点数（去尖点、去重后） |
| `jumps` | number | 被剔除的孤立尖点数 |

### 4.5 `charge`（历史充电段汇总）

| 字段 | 类型 | 说明 |
|---|---|---|
| `segments` | number | 充电段个数 |
| `gain` | number | 总充入百分点 |
| `gainText` | string | `+30%`；为 0 时 `—` |
| `avgRate` / `avgRateText` | number \| null / string | 已闭合段的平均速率（零充入段不计入） |
| `lastSegment` | object \| null | `{ from, to, gain, rate, rateText, at }`，最近一段 |

---

## 5. `status` 七值（唯一状态枚举）

判定顺序固定（先命中先返回）：

| # | status | 条件 | 含义 |
|---|---|---|---|
| 1 | `noData` | 没有任何采样点 | 从没上报过 |
| 2 | `charging` | 存在未闭合充电段，且设备自报 `c=1` | 正在充电 |
| 3 | `inferredCharging` | 存在未闭合充电段，靠上涨推断 | 推测充电（手表类不报 `c`） |
| 4 | `full` | `level ≥ 100` 且不在充电 | 已充满 |
| 5 | `sparse` | 空洞占比 > 0.55 且跨度 ≥ 2h | 采样太稀疏 |
| 6 | `insufficient` | `rate === null` 或 `life === null` | 有效样本不足 |
| 7 | `discharging` | 其余 | 正常放电 |

**叠加标记**（不改 `status`，由客户端附加显示）：`flags.linkStopped`、`flags.levelStale`。

> 客户端**禁止**自创状态词（如「电量稳定」「异常」），也禁止按电量阈值分色。

---

## 6. `display`：文案在服务端定死

```json
"display": {
  "title": "掉电 2.56 %/h",
  "subtitle": "满电约 1 天 15 时",
  "lines": ["电量 1 分前", "链路 1 分前", "24h 变化 -18% · 采样 42 条", "掉电 2.56 %/h · 满电约 1 天 15 时"]
}
```

| status | `title` | `subtitle` |
|---|---|---|
| `discharging` | `掉电 2.56 %/h` | `满电约 1 天 15 时`（无续航 → `满电续航待估`） |
| `charging` | `充电中 · 已充 49 分` | `约 34 分后充满` / 速率不足 → `速率样本不足` / 已到 100% → `已到 100%，可以拔电了` |
| `inferredCharging` | `推测充电 · 已充 20 分` | 同上 |
| `full` | `已充满` | `满电约 1 天 15 时` / `满电续航待估` |
| `sparse` | `数据不足` | `采样太稀疏，约 62% 的时间没有数据`（百分比取自 `flags.gapRatio`） |
| `insufficient` | `数据不足` | `有效样本不足，暂不外推` |
| `noData` | `无数据` | `等等客户端上报` |

`lines` 是 Web 卡片那几行说明文字，**1–5 行、行数随状态变化**（不是固定 5 行）：

| 行 | 内容 | 出现条件 |
|---|---|---|
| 1 | `电量 N 分前` | 有采样点 |
| 2 | `链路 N 分前` / `链路 —`（停 → 追加 ` · 已停`） | 有采样点 |
| 3 | `N 时 没有任何上报，进程可能被冻结` / `链路正常 · 电量 N 时 未变` | 仅 `linkStopped` 或 `levelStale` 时出现 |
| 4 | `24h 变化 -18% · 采样 42 条 · 剔噪 3` | 有采样点 |
| 5 | `掉电 2.56 %/h · 满电约 1 天 15 时`（近似时追加 ` ~`） | 有采样点 |
| — | `无数据` | 无采样点（此时只有 1 行） |

**渲染规则**
- 三个字段**逐字上屏**，不许改写、不许拼接、不许加 emoji、不许自己补单位。
- 无值统一 `—`（em dash）；大数字位无值用 `--`。
- 时长单位是中文 `秒 / 分 / 时 / 天`，已由 `fmtDur()` 格式化（`6时25分`、`1天15时`）。
- 免责声明由 App 自己加一句：「预计续航按最近放电速率线性外推，仅供参考」。

---

## 7. `curve`（仅 `points=1`）

- 形状：`[[t, l], [t, l], …]`，`t` 毫秒、`l` 百分比。
- 数据源是**视窗内的点**（默认 `cycle`，`all=1` 时全部），已 `annotate()` 打标。
- **尖点（`jump=true`）不入曲线**。
- 上限 `CURVE_CAP = 240` 点：超出时等距抽稀（`step = (n-1)/(cap-1)`，四舍五入取下标），**保留首末点**。
- 时间严格递增（同毫秒重复点已在 `ptsOf()` 去重，只留先到的）。

---

## 8. 错误

| 状态码 | body | 场景 |
|---|---|---|
| 401 | `{"error":"unauthorized","hint":"请在请求头携带正确的 x-sync-token"}` | 缺 / 错 token |
| 400 | `{"error":"invalid_key","hint":"键仅允许字母、数字、. _ : - /，长度 1-256"}` | 键含非法字符或超长 |
| 400 | `{"error":"invalid_key","hint":"key 不能是内部键（@hist:...）"}` | 传了内部键 |

设备键不存在 **不是错误**：返回 `200` + `status="noData"` 的 `device`。

---

## 9. 用法示例

```bash
T=<SYNC_TOKEN>; B=https://<你的域名>
curl -s -H "x-sync-token: $T" "$B/dash/stats?key=watch/battery" | python3 -m json.tool
curl -s -H "x-sync-token: $T" "$B/dash/stats" | python3 -c 'import sys,json;d=json.load(sys.stdin);print([x["key"] for x in d["devices"]])'
curl -s -H "x-sync-token: $T" "$B/dash/stats?key=watch/battery&points=1" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["device"]["curve"]))'
```

Swift 侧最省事的写法：只解 `level` / `status` / `display` / `link` / `curve`，其余字段用不到就别解（多余字段不影响 `Decodable`）。模型骨架见 `IPAD_AGENT_PROMPT.md` §3。

---

## 10. 变更记录

| 版本 | 变更 |
|---|---|
| v11.6 | 新增本接口。九个算法函数从 `dash.ts` 浏览器 JS 逐字移植到 `src/stats.ts`；新增 `display` 成品文案、`status` 七值、`flags.gapRatio`、`curve` 抽稀；修掉「约 —后充满」与硬编码 55% 两处文案坑 |
