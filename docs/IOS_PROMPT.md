# iOS 端开发提示词（只读接收端 + 桌面小组件）

> 用法：把下面 **【提示词正文】** 整段复制给 iOS 开发 AI / 开发者。它自带全部后端契约，无需再读别的文件。
> 相关文档：`docs/TECH.md`（服务端实现）、`docs/REQUIREMENTS.md`（需求与硬约束）、**`docs/DESIGN.md`（视觉与文案规范，必读）**、**`docs/ALGO.md`（预测算法唯一实现，必读）**
> 版本：对应服务端 **v11.6**（新增 `GET /dash/stats`：预测结果由服务端算完，客户端零算法）
>
> **v11.6 变更（先读这四条，能省掉你 80% 的工作）**
> 1. **预测/续航/充电段不再移植算法**。服务端 `GET /dash/stats` 直接返回算好的数值**和成品文案**，客户端只解码显示。§6 已整体重写。
> 2. **小组件必须自动刷新**。`Timeline(policy: .after(+15 分钟))`、每次 `getTimeline` 都联网、App 前台刷新后 `WidgetCenter.reloadAllTimelines()`。这是**验收硬条款**（§5.5 + §9 第 8/9 条），漏了就是返工。
> 3. [`ALGO.md`](./ALGO.md) 降级为「口径解释」，只为让你看懂数字为什么这么算，**不是让你实现**。
> 4. **UI 不得自行设计**，配色/字号/圆角/文案全部按 [`DESIGN.md`](./DESIGN.md) 抄。

---

## 【提示词正文】

你是一名资深 iOS 工程师。请为我实现 **WatchSync 电量看板 iOS 客户端 + 桌面小组件（Widget）**。

### 0. 定位与铁律（先看这条，决定整个架构）

**这个 App 是纯接收端（read-only），绝不上报数据。**

- ✅ 允许的 HTTP 方法：**只有 `GET`**
- ❌ 禁止调用 `PUT`、`POST`、`DELETE` —— 后端会拒绝无关紧要，但更严重的是会污染数据源（数据由 Android 端采集，本 App 一旦写入就会覆盖真相）
- ❌ 不允许出现「上报本机电量」「同步我的 iPhone 电量」之类的功能或 UI 文案
- ❌ 不要请求任何写入权限的 token 变体，就用同一个只读 token

后端是已有的 Cloudflare Worker，**不要改动后端、不要新增接口**。

### 1. 一句话目标

做一个 iOS App + Widget：**随时看到我所有设备（手表、耳机、Android 手机等，由 Android 端采集）最近 7 天的电量**，并在桌面小组件上不打开 App 就能看到：

| 尺寸 | 内容 |
|---|---|
| 小号 `.systemSmall` | 各设备**当前电量**（最多 3 台，名称 + 百分比 + 充电图标） |
| 中号 `.systemMedium` | 各设备**预计续航**（按放电速率推算「还能用多久」） |
| 大号 `.systemLarge` | 中号内容 **+ 最近 24 小时电量曲线** |

### 2. 技术栈与工程要求

- Swift 6 / SwiftUI，最低 iOS 17，纯原生。Widget 用 **WidgetKit**。
- 两个 target：`WatchSync`（App）+ `WatchSyncWidget`（Widget Extension），并配置 **App Group** 共享数据。
- 图表：App 内可用系统 `Charts`；**Widget 内不要用 Charts**，用 `Canvas` / `Path` 自绘 sparkline（Widget 渲染预算紧、Charts 易踩渲染问题）。
- 架构：`View` + `@Observable ViewModel` + `APIClient`（`async/await` + `URLSession`）；共享层 `SharedStore`（App Group 读写）供 App 与 Widget 复用。
- 注释用中文，标识符用英文。

### 3. 后端契约（严格照抄，字段名一个都不能改）

Base URL：`https://<你的-worker-域名>`（从 `Config.xcconfig` 的 `API_BASE_URL` 注入）

鉴权头（**所有**请求都要带）：
```
x-sync-token: <SYNC_TOKEN>
```

#### 3.1 `GET /health`（唯一不需要 token 的接口）
```json
{"ok":true,"service":"cross-device-sync","time":"2026-11-06T04:00:00.000Z",
 "histRetentionMs":604800000,"histRetentionDays":7}
```
用途：拿到 `histRetentionDays` 用于 UI 文案「数据保留 7 天」。**不要硬编码 7**。

#### 3.2 `GET /list?prefix=`（列出所有键）
```json
{"prefix":"","cursor":null,
 "keys":[{"key":"watch/battery","updatedAt":"2026-11-06T03:59:00.000Z"},
         {"key":"ios/battery","updatedAt":"2026-11-06T03:58:00.000Z"}]}
```
- 上限 100 条；`cursor` 非 null 表示还有下一页（v1 可不翻页，但要识别）。
- 服务端已过滤内部键（`@` 开头），客户端**不需要**再过滤。

#### 3.3 `GET /<key>`（单条最新值）
```json
{"key":"watch/battery","value":{"level":64,"charging":0,"name":"手表","src":"hook","mv":"1.4.2"},
 "version":9,"updatedAt":"2026-11-06T03:59:00.000Z"}
```
- 404 → `{"error":"not_found","key":"..."}`，视为「该设备暂无数据」。
- 响应头带 `x-sync-version` / `x-sync-updated`，body 里都有，可忽略头。

#### 3.4 `GET /dash/hist?key=<key>&range=<毫秒>`（历史，核心）
`range` 取值：`3600000`(1h) / `10800000`(3h) / `21600000`(6h) / `86400000`(24h) / `259200000`(3天) / `604800000`(7天) / `0`(保留窗口内全部)

```json
{
  "key": "watch/battery",
  "label": "手表",
  "hist": [
    {"t": 1762405140000, "l": 66, "c": 0, "v": 9, "s": "hook", "m": "1.4.2"},
    {"t": 1762408740000, "l": 65, "c": 0, "v": 10}
  ],
  "total": 2,
  "now": 1762408800000,
  "retentionMs": 604800000
}
```

| 字段 | 含义 |
|---|---|
| `t` | 采样时间，**毫秒** epoch |
| `l` | 电量 0–100，**可能为 `null`** |
| `c` | `1` 充电中 / `0` 未充电，**可能为 `null`** |
| `v` | 服务端版本号（调试用，不要显示给用户） |
| `s` / `m` | 数据源标识 / 采集端模块版本，可选 |

**必须理解的服务端行为（客户端不要再实现一遍，也别当 bug 报）：**
1. `hist` 已**升序**，且已按 `range` 和 7 天窗口**双重裁剪**。客户端不要再过滤时间。
2. `range` 超过 7 天会被夹到 7 天；`range=0` = 「保留窗口内全部」（最多 7 天），不是「有史以来」。
3. **值没变就不会有新点**（`level` 与 `charging` 同时相同则跳过采样）。所以曲线是「稀疏点 + 长平台」，**这不是丢数据**。UI 上对「最后一点距 now > 2 小时」灰显提示「数据未更新」。
4. key 不存在返回 `200` + `hist: []`，**不是 404**。用空状态区分「无数据」与「请求失败」。
5. `label` 是服务端给的设备名，直接用，不要自己按 key 拼。
6. 只读端点无写入副作用，可放心高频调用（但仍要尊重 §7 的刷新节流）。

#### 3.5 `GET /dash/stats`（预测统计，v11.6 新增，**客户端唯一该调的预测接口**）

```
GET /dash/stats?key=watch/battery            # 单设备
GET /dash/stats                              # 全部设备（按链路时间倒序）
GET /dash/stats?key=watch/battery&all=1      # 视窗=全部采样（默认「上一次充满之后」）
GET /dash/stats?key=watch/battery&points=1   # 附带曲线点（大号组件用）
GET /dash/stats?key=watch/battery&range=86400000
```

单设备返回（节选，字段名一个都不能改）：

```json
{
  "key": "watch/battery", "label": "手表",
  "now": 1762408800000, "retentionMs": 604800000, "rangeMs": 0,
  "device": {
    "level": 64, "levelAt": 1762408740000,
    "link": { "at": 1762408740000, "ageMs": 60000, "state": "ok" },
    "status": "discharging",
    "flags": { "linkStopped": false, "levelStale": false, "sparse": false, "gapRatio": 0, "insufficient": false },
    "charging": { "on": false, "inferred": false, "elapsedMs": 0, "elapsedText": "0 秒",
                  "gain": 0, "from": null, "to": null, "rate": null, "rateText": "—",
                  "etaMs": null, "etaText": "—", "full": false },
    "discharge": { "rate": 2.56, "rateText": "2.56 %/h", "regression": true,
                   "lifeHours": 39.1, "lifeText": "1 天 15 时", "lifeApprox": false,
                   "delta24h": -18, "delta24hText": "-18%", "points": 42, "validPoints": 42, "jumps": 0 },
    "charge": { "segments": 1, "gain": 30, "gainText": "+30%", "avgRate": 36.6, "avgRateText": "36.60 %/h", "lastSegment": null },
    "display": {
      "title": "掉电 2.56 %/h",
      "subtitle": "满电约 1 天 15 时",
      "lines": ["电量 1 分前", "链路 1 分前", "24h 变化 -18% · 采样 42 条", "掉电 2.56 %/h · 满电约 1 天 15 时"]
    }
  }
}
```

全部设备返回 `{ "key": "*", "count": N, "devices": [ ... ] }`，`devices[i]` 结构与上面 `device` 相同。

| 参数 | 说明 |
|---|---|
| `key` | 设备键；不传或 `*` = 全部设备。非法键返回 `400 {"error":"invalid_key"}` |
| `range` | 毫秒，上限 `604800000`（7 天），超出被夹断 |
| `all=1` | 视窗改用**全部采样**；默认是「上一次充满之后」（与服务端 Web 看板一致） |
| `points=1` | 额外返回 `device.curve: [[t, l], ...]`，最多 240 点（已抽稀、保留首末点、不含尖点） |

> 完整字段契约（七种 `status`、每一条 `display` 文案口径、`curve` 抽稀规则）见线上 **`/docs` 的「预测统计接口」一节**。那份是唯一真源，本文只列你要用到的部分。

### 4. 数据共享层（App ↔ Widget）

建 App Group：`group.com.yourteam.watchsync`（App 与 Widget 两个 target 都勾上）。

**App Group 共享文件/Defaults 结构：**
```json
{
  "savedAt": 1762408800000,
  "health": {"retentionDays": 7},
  "devices": [
    {"key":"watch/battery","label":"手表","level":64,"charging":false,"updatedAt":"2026-11-06T03:59:00.000Z"}
  ],
  "hist": {
    "watch/battery": [{"t":1762405140000,"l":66,"c":0}]
  }
}
```
- `devices`：列表页数据（App 每次刷新后写入）。
- `hist`：**只存大号 Widget 需要的那几台设备的 24h 曲线**（默认 ≤4 台），不要把所有设备 7 天数据塞进去（App Group 有容量与性能成本）。
- Widget 读不到网络时**必须**用这份缓存渲染，不能显示红字/空白。

**Token 存哪：**
- 首选 **Keychain** + Keychain Sharing（`keychain-access-groups` 含 App Group ID），App 与 Widget 都能读。
- 若实现 Keychain Sharing 有阻碍，可退回 **App Group `UserDefaults`**（同设备沙盒内可行，但明文落盘，安全性略低）——**必须在 README 里写明这个取舍**。
- 禁止把 token 硬编码进任何 Swift 文件；`Config.xcconfig` 不进 git，只提交 `Config.xcconfig.example`。

### 5. Widget 实现要求（重点，别糊弄）

#### 5.1 结构
- `StaticConfiguration`（v1 不需要用户选设备；若你想做多实例选设备，可用 `AppIntentConfiguration`，属于加分项）。
- 支持 `supportedFamilies: [.systemSmall, .systemMedium, .systemLarge]`。
- `TimelineProvider` 三个方法都要实现：`placeholder`（返回假数据，秒出）、`getSnapshot`（用缓存，别联网）、`getTimeline`（可联网）。
- 每个 entry 同时带上三种尺寸需要的数据，由 View 按 `widgetFamily` 分支渲染。

#### 5.2 `getTimeline` 逻辑（照这个顺序写）

1. 读 App Group 缓存 → **先用它构造 entry**（保证永远有东西可显示）。
2. 若 `savedAt` 距今 > 10 分钟：联网刷新（**每一次 `getTimeline` 都要走这一步，不是只有第一次**）
   - 超时 **6 秒**（Widget 时间预算紧，不要用 App 的 10 秒）
   - 并发：`GET /health` + `GET /list` + 各设备 `GET /dash/stats?key=...`（最多 6 台）
   - **只有大号组件**才加 `&points=1` 取曲线（最多 4 台）；小号/中号不要点曲线，省流量也省解码
   - 任一步失败：**静默沿用缓存**，绝不抛错、绝不显示「加载失败」
3. 成功则把**原始 JSON**（不是你自己算出来的数）写回 App Group，并用新数据构造 entry。
4. `return Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60)))`

**为什么是 15 分钟**：系统一天只给 Widget 有限次刷新（通常几十次），`policy: .after` 是「**建议** 15 分钟后叫我」，真正何时刷新由系统决定——低电量、后台受限、长时间没被看见都会延后。所以：

- ✅ 文案可以写「约 15 分钟更新一次」
- ❌ 文案**不许**写「实时」「每分钟同步」「秒级刷新」——系统不允许，写了就是骗用户
- ✅ 放置 1 小时以上、完全不打开 App，组件仍必须能自己变（靠的就是这条 policy + 每次联网）

#### 5.3 三种尺寸的具体布局

**小号（最省空间，只回答「现在多少电」）**
```
┌─────────────────┐
│ 设备电量         │
│ 手表      64% ⚡ │
│ 耳机      82%   │
│ 手机      37%   │
│ 2 分钟前更新     │
└─────────────────┘
```
- 最多 3 台，按 `updatedAt` 倒序。
- 每行：名称（`label`，超长截断）+ 电量数字（大字号 `%`）+ 充电时显示 `bolt.fill`。
- 电量数字**一律用主文字色**，不做「>50 绿 / 20–50 橙 / <20 红」这类阈值分色（Web 端就是不分色的，颜色只表达「事件」：充电中绿、推测充电青、掉电红、警示琥珀）。颜色 token 见 [`DESIGN.md`](./DESIGN.md) §1。
- 底部一行小字相对时间（`Text(date, style: .relative)`）。
- `level == nil` 显示 `--`，不要显示 0。

**中号（回答「还能用多久」）**
```
┌───────────────────────────────────────┐
│ 预计续航                                │
│ 手表  64%   约 1 天 3 小时    ⚡充电中   │
│ 耳机  82%   约 8 小时 30 分             │
│ 手机  37%   数据不足                    │
└───────────────────────────────────────┘
```
- 每台一行三列：名称 | 当前电量 | **预计续航**。
- 预计续航算法见 §6，**必须按公式实现**，不要自己发明。
- 状态优先级（与 Web 卡片一致，**不许自创中间态**）：`充电中 / 推测充电` > `数据不足` > `满电约 X` > `掉电 X %/h` > `—`。
  - 正在充电时显示「充电中 · 已充 49 分」，**不显示续航**（充电中算续航没有意义）。
  - 设备未上报 `c`、但电量在涨、段未闭合 → 写「推测充电」，不许直接写「充电中」。
  - Web 端没有「电量稳定 / 几乎不耗电」这种状态；电量长时间不变时它说的是「链路正常 · 电量 3 时 未变」，别自己发明第六种说法。

**大号（中号内容 + 曲线）**
```
┌───────────────────────────────────────┐
│ 预计续航（同中号，最多 4 行）             │
├───────────────────────────────────────┤
│ 手表 · 最近 24 小时                      │
│   ╱╲    ╱╲___                          │
│  ╱  ╲__╱     ╲___                      │
│ 40% ─────────────── 100%               │
├───────────────────────────────────────┤
│ 手机 · 最近 24 小时（同上）               │
└───────────────────────────────────────┘
```
- 曲线：`Canvas` 或 `Path` 自绘，连续折线 + 轻微渐变填充。
- **必须处理**：`l == nil` 的点断开（不连线）；只有一个点时不画线，画一个圆点。
- 充电区段（`c == 1`）在曲线下方画一条淡色横带或给曲线段换色（二选一，别都做）。
- 曲线容器固定高度（如 70pt），Y 轴不必画刻度，但要在左下角标最小值、右上角标最大值，否则看不出量级。
- 4 台设备放不下时截断，末尾显示「+N 台」。

#### 5.4 其他 Widget 细节
- 点击组件用 `widgetURL` 深链到 App 的设备详情页（`.small` 只能整块跳一个 URL，跳到第一台设备）。
- App 在前台刷新成功后调用 `WidgetCenter.shared.reloadAllTimelines()`，让组件立刻更新。
- 支持深色模式；支持 `containerBackground`（iOS 17 必须设置，否则组件会报错或显示异常）。
- 提供 `.redacted(reason: .placeholder)` 友好的占位数据。

#### 5.5 自动刷新（**验收硬条款，不通过就是没做完**）

小组件「装上去就不动了」是本项目已经踩过一次的坑。下面六条逐条可验，缺一条就打回：

| # | 条款 | 怎么验 |
|---|---|---|
| R1 | `getTimeline` 返回 `Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60)))` | 读代码；`policy: .never` 或 `.atEnd` 一律不合格 |
| R2 | **每次** `getTimeline` 都尝试联网（有 10 分钟缓存节流，但不是「只刷一次」） | 杀掉 App，等 30 分钟看组件是否变 |
| R3 | App 前台刷新成功后调 `WidgetCenter.shared.reloadAllTimelines()` | 在 App 里下拉刷新，组件几秒内跟着变 |
| R4 | 组件放置 **≥1 小时**、不打开 App，仍会自动更新（系统调度限制内） | 实测挂机 1 小时截图对比 |
| R5 | 断网时静默用缓存渲染，**不出现任何错误文本/红叹号** | 飞行模式后看三种尺寸 |
| R6 | README 与 App 文案写明「系统限制刷新频率，15 分钟是请求不是保证」 | 查文案 |

**刷新预算说明（要写进 README）**：WidgetKit 对每个组件每天有几十次刷新额度，超额会被系统丢弃；`policy: .after` 只是请求。因此不要为了「实时」把间隔改到 1 分钟——那既不会生效，还会让后台刷新被系统限流，反而更不准。

### 6. 预测数据：**只调接口，不许自己算**

> v11.6 起，预测这件事整个搬到服务端了。
> **你不写算法、不移植函数、不跑用例**——`GET /dash/stats` 已经把速率、续航、充电段、预计充满，连「该显示什么字」都算好返回。

#### 6.1 只要这五个字段

| 字段 | 类型 | 怎么用 |
|---|---|---|
| `device.status` | 七值枚举 | 决定显示哪种态（见 6.2），**不要自己算状态** |
| `device.display.title` | string | 直接上屏（标题行） |
| `device.display.subtitle` | string | 直接上屏（副标题行） |
| `device.display.lines[]` | string[]（1–5 行） | 中大号的说明行，逐行渲染；**行数随状态变化，不要假设固定 5 行** |
| `device.level` / `device.link.ageMs` | number | 小号只显示数字时用；`link.ageMs` 超 2 小时标「数据未更新」 |

其余字段（`discharge.*`、`charging.*`、`charge.*`、`flags.*`、`curve`）都已备好，需要时直接读，**但绝不要拿原始 `hist` 自己再算一遍**。

#### 6.2 `status` 七值 → 界面表现

| status | 含义 | title 形如 | subtitle 形如 |
|---|---|---|---|
| `discharging` | 正常放电 | `掉电 2.56 %/h` | `满电约 1 天 15 时` |
| `charging` | 正在充电（设备自报） | `充电中 · 已充 49 分` | `约 34 分后充满` / `已到 100%，可以拔电了` |
| `inferredCharging` | 靠电量上涨推断的充电（手表不给 `c`） | `推测充电 · 已充 20 分` | 同上 |
| `full` | 已满且不在充电 | `已充满` | `满电约 1 天 15 时` |
| `sparse` | 采样太稀疏，不给续航 | `数据不足` | `采样太稀疏，约 62% 的时间没有数据` |
| `insufficient` | 有效样本不足，不外推 | `数据不足` | `有效样本不足，暂不外推` |
| `noData` | 一台设备都没上报过 | `无数据` | `等等客户端上报` |

叠加标记：`flags.linkStopped`（链路已停，进程可能被冻结）、`flags.levelStale`（链路正常但电量长时间未变）。

#### 6.3 文案规则（和 Web 看板逐字一致）

- `display.*` 是**成品文案**：直接渲染，**不许改写、不许拼接、不许加 emoji**。
- 无值统一用 `—`（em dash）；大数字位没有值时用 `--`。
- 时长是中文单位 `秒 / 分 / 时 / 天`，服务端已格式化（如 `1 天 15 时`），客户端**不要自己拼时长**。
- 电量数字**不做阈值分色**（红/黄/绿），统一主色；颜色见 `DESIGN.md`。

#### 6.4 明确不要做的事

- ❌ 不要移植 `ALGO.md` 里的 `olsRate` / `statOf` / `chgStat` / `sparseOf`，仓库里那套已经是服务端的内部实现。
- ❌ 不要写 `DurationEstimator` 这个类型，也不要写「还能用多久」的推算代码。
- ❌ 不要跑 C1–C8 / D1 / S1–S4 那 13 组算法用例——它们现在只用于**服务端**自测（`src/stats.ts` + 交叉一致性测试），客户端没有算法可测。
- ❌ 不要在客户端再做「上一次充满之后」的切窗，服务端默认就是这个视窗；需要全部历史才传 `&all=1`。
- ❌ 不要自己判断稀疏、不要自己判尖点、不要自己算 24h 变化。

#### 6.5 兜底

- 接口失败：继续用**上一次成功的 JSON 缓存**渲染，App 内标「离线」，Widget 内静默不报错。
- 解码失败（字段缺失）：按 `noData` 处理，显示 `--`，**不要崩溃、不要显示英文错误**。
- 免责声明（App 内 + README 都要有）：「预计续航按最近放电速率线性外推，仅供参考」。

### 7. App 端界面（三屏即可）

> 视觉**一律照 [`DESIGN.md`](./DESIGN.md)**：色值、字号、圆角、层级、文案、状态矩阵都在那份里，它是 Web 看板的唯一真源。**不要自己设计 UI、不要自创色板、不要重新排布**——你只需要把 Web 的卡片和统计面板翻译成 SwiftUI。Web → SwiftUI 的对应表在 `DESIGN.md` §9。

1. **设备列表**：`/health` → `/list` → 并发 `GET /:key`。每行：名称、当前电量、充电图标、相对更新时间。按 `updatedAt` 倒序。下拉刷新。空态/离线态要设计。
2. **设备详情**：`GET /dash/hist`。顶部当前值 + 「数据保留 7 天」（用 `/health`）；中部 `Charts` 折线（`l==nil` 断开、充电段背景色）；时间选择器 `1h/3h/6h/24h/3d/7d/全部`，**没有 30 天**；下部采样点表格（时间、电量、充电状态、`m` 模块版本）。
3. **设置**：后端地址（只读显示）、保留天数、token 输入（写 Keychain）、「立即刷新」按钮、上次刷新时间与结果、一句 App 说明「本应用仅读取数据，不会修改任何设备状态」。

### 8. 错误处理与节流

| 情况 | 行为 |
|---|---|
| 401 | 提示「token 无效或已更换」，跳设置页；**不重试** |
| 404（`GET /:key`） | 该设备视为「暂无数据」，不报错 |
| 400 `invalid_key` | 提示「设备键非法」，不重试 |
| 429 | 读 `Retry-After`，退避后最多重试 1 次 |
| 5xx / 网络失败 | 展示缓存 + 「离线」标记；指数退避最多 3 次（2s/8s/30s） |
| 所有错误 | **Widget 一律静默用缓存**，绝不在组件上显示报错文本 |

- App 请求超时 10 秒；Widget 请求超时 6 秒。
- 前台刷新最小间隔 60 秒（防止用户狂下拉把配额打光）。

### 9. 验收标准（我会逐条验）

**基础功能**

1. 首次启动、token 正确 → 列表页显示后端已有设备（如「手表」）与当前电量。
2. 详情页默认 **近 7 天**曲线；切 1h/24h 数据量变化；**没有 30 天选项**。
3. 小号组件：显示最多 3 台设备电量，数字与 App 一致；充电设备有闪电图标。

**预测数据（v11.6 新口径）**

4. 中号组件显示的是 `display.title` + `display.subtitle` **原文**，与 `https://<域名>/dash/stats?key=...` 返回逐字相同（不许出现客户端自己拼的「还能用 X 小时」）。
5. 七种 `status` 各造一份 fixture（`discharging` / `charging` / `inferredCharging` / `full` / `sparse` / `insufficient` / `noData`），界面表现符合 §6.2 表；**没有出现「约 —后充满」这类破折号拼进句子的文案**。
6. **全局搜索代码：没有 `DurationEstimator`、没有 `olsRate/statOf/chgStat/sparseOf` 的 Swift 复刻**。预测只来自接口。

**小组件刷新（硬条款，逐条验）**

7. 断网后三种尺寸都仍显示上次数据，且不出现任何错误文本/红叹号。
8. App 前台下拉刷新后，`WidgetCenter.reloadAllTimelines()` 生效，组件在几秒内更新。
9. **组件放置 1 小时以上、完全不打开 App，仍自动刷新**（`policy: .after(15min)` + 每次 `getTimeline` 联网）。
10. 文案中**没有**「实时」「每分钟同步」这类系统不允许的承诺；README 写了刷新预算说明。

**安全与只读**

11. 全局搜索代码：**没有 `PUT`/`POST`/`DELETE` 调用**，没有「上报」类 UI。
12. 仓库 `grep` 不到明文 token；`Config.xcconfig` 已被 `.gitignore` 排除。

### 10. 交付物

1. 可编译运行的 Xcode 工程（App + Widget 两个 target，含 App Group 配置）。
2. `Config.xcconfig.example`（`API_BASE_URL`、`SYNC_TOKEN` 占位）+ 更新后的 `.gitignore`。
3. `README-iOS.md`：token 配置、App Group 与 Keychain Sharing 设置步骤、Widget 刷新机制与限制、预计续航算法说明与免责声明、已知限制。
4. `APIClient` 解码层单元测试（fixture 覆盖：`hist: []`、`l: null`、`c: null`、单点历史、跨 7 天边界）。
5. `APIClient` 对 `/dash/stats` 的解码测试（不再有算法单测）：fixture 覆盖七种 `status`、`display.lines` 行数 1 与 5 两种、`curve` 缺失与存在、`flags.linkStopped=true`、`level=null`。断言「拿到什么都只渲染、不计算」。

### 11. 禁止事项（违反即返工）

- ❌ 任何写操作（`PUT`/`POST`/`DELETE`）、任何「上报电量」功能。
- ❌ 内置 `DASH_PWD`、走 WebView 登录、抓 `/dash` 页面。
- ❌ 客户端再裁一次 7 天窗口（服务端已裁，重复裁只会在时钟偏移时误删）。
- ❌ 因为「曲线长时间平台」就补点或伪造采样。
- ❌ `range` 传大于 `604800000` 并期待更多数据。
- ❌ 在 Widget 里用 Swift Charts（改用 Canvas/Path）。
- ❌ 承诺「实时」「每分钟同步」这类系统不允许的能力。
- ❌ **自己实现预测/续航算法**。v11.6 起预测全部由 `GET /dash/stats` 提供，客户端只解码显示。出现任何 Swift 版 `DurationEstimator` / 回归 / 充电段状态机 = 返工。
- ❌ **小组件不写自动刷新**（只给 `policy: .never`、只在首次联网、不调 `reloadAllTimelines()`）= 返工。见 §5.5六条。
- ❌ 改写 `display.title` / `display.subtitle`，或把它们拆开重新拼装。
- ❌ **自己设计 UI**：自创色板、自创圆角、加 Hero 图/动效、按电量阈值分色、自创状态词。视觉一律照 [`DESIGN.md`](./DESIGN.md)，只允许「等价翻译」。
- ❌ 在 Widget 上显示错误文本/红色叹号（只能用缓存或空态）。

### 12. 开发状态回写（必须做，和代码一起交付）

协作台 `/dev` 与 `/status` 靠 KV 里的 `status/*` 聚合各端进度。**每个里程碑完成后 PUT 一次 `status/ios`**（这是你唯一的写操作，其余一律只读）：

| 时机 | `phase` 写什么 |
|---|---|
| 工程能跑通、能拉到数据 | `M1 骨架跑通` |
| 三个尺寸都能正确显示 `display.title/subtitle/lines` | `M2 组件显示就绪` |
| §5.5 六条刷新条款自测通过 | `M3 自动刷新已验收` |
| §9 验收 12 条全绿 | `交付` |

```bash
curl -X PUT https://cross-device-sync.beluga233.workers.dev/status/ios \
  -H "x-sync-token: $SYNC_TOKEN" -H "content-type: application/json" \
  -d '{"value":{"id":"ios","name":"iOS 客户端","role":"只读 App + 小组件","phase":"M3 自动刷新已验收","doing":"在做大号组件的 24h 曲线","next":["§9 验收 12 条"],"blockers":[],"owner":"iOS-AI","updatedAt":1793969700000}}'
```

- `next` / `blockers` 都是字符串数组（各最多 6 条）；没卡点就传空数组，不要省略字段。
- `updatedAt` 是**毫秒**时间戳；不写会退回 KV 记录的 ISO 时间，协作台会显示成「很久没更新」。
- 只写 `status/ios`，别碰 `status/server` / `status/android` / `status/ipad`。
- 回写失败不影响开发，但要在最终交付说明里提一句。

---

## 附：给用户的落地备注

| 事项 | 说明 |
|---|---|
| 定位已锁定为只读 | 需求变更已确认：iOS 不上报，只读。因此**不需要**设备级 token 那套东西，单 `SYNC_TOKEN` 只读使用即可（但它仍能写，所以不要外传） |
| 需要的键 | 只读 App 会自动发现 `/list` 里的所有键；`watch/battery`、`dev/<hex>`、`xxx/battery` 都会显示为设备 |
| 小组件显示哪几台 | v1 按 `updatedAt` 倒序取前 3（小号）/ 前 4（中大号）。若你想要指定设备，再说，我加 `AppIntentConfiguration` |
| 预计续航的坑 | 服务端「值不变不落点」会让平台期样本稀疏，所以算法强制要求 ≥3 点且跨度 ≥1 小时，否则直说「数据不足」——宁可少说，不要瞎算 |
| 服务端就绪条件 | 必须已 `deploy`（v11.6）。自检两条：`curl -H "x-sync-token: $TOKEN" "$BASE/dash/hist?key=watch/battery&range=0"` 有 `hist`，且 `curl -H "x-sync-token: $TOKEN" "$BASE/dash/stats?key=watch/battery"` 有 `device.display.title`，即就绪 |