# iPad Agent 提示词（WatchSync 只读客户端 + Widget）

> 整段复制给 iPad 端 agent 框架使用。接口契约自包含；**算法已经没有「客户端版本」了 —— 预测全部由服务端 `GET /dash/stats` 返回，视觉规范的真源是 `docs/DESIGN.md`**。
> 与 `docs/IOS_PROMPT.md` 的区别：这份**假设你在 iPad 上执行**（Swift Playgrounds / a-Shell），所以明确了「什么现在能做、什么必须回 Mac 做」，防止 agent 谎报构建成功。
>
> **v11.6 重要变更（先读这三条，否则整段返工）**
> 1. **不要写任何预测/续航算法**。服务端 `GET /dash/stats` 返回算好的数值和成品文案（`display.title` / `display.subtitle` / `display.lines`），你只解码显示。§5 已整体重写；`docs/ALGO.md` 只剩「解释数字为什么这么算」的用途。
> 2. **小组件必须自动刷新**：`Timeline(policy: .after(+15 分钟))` + 每次 `getTimeline` 都联网 + App 刷新后 `WidgetCenter.shared.reloadAllTimelines()`。这是**验收硬条款**（§6 + §9 第 6/7 条），只用 `.never` 或只刷一次 = 返工。
> 3. **不要自己设计 UI**。配色、字号、圆角、层级、状态词、文案格式一律照 `docs/DESIGN.md`。尤其：**不许按电量阈值分色**、不许自创「电量稳定」这类状态词、不许改写服务端给的 `display.*` 文案。

---

## 【提示词正文】

你是运行在 iPad 上的 iOS 工程师 agent。帮我实现 **WatchSync 电量看板客户端**（只读）以及桌面 Widget 的源码。

### 0. 先认清执行环境（这条决定你怎么交付，别跳读）

你很可能运行在 iPad 上（Swift Playgrounds / a-Shell / 文本编辑器），因此：

| 能力 | iPad 现状 | 你该怎么做 |
|---|---|---|
| Swift 语法检查 / 逻辑跑通 | ✅ Playgrounds 可执行 | 算法、解码、格式化**必须**真跑通并自测 |
| SwiftUI 界面预览 | ✅ 可在 Playgrounds App 项目里预览 | 做出来，截图或说明运行结果 |
| **Widget extension target** | ❌ **Playgrounds 建不了**（需要 Xcode 的 extension target + App Group + entitlements） | **只产出源码文件**，标注 `// TODO-XCODE:`，**不要声称已构建** |
| `xcodebuild` / 命令行构建 | ❌ 没有 | 禁止假装跑过 |
| 真机安装 | ❌ | 不要承诺 |

**硬规矩：凡是没真正执行过的，必须写「未验证」；凡是执行的，给出真实输出。禁止编造编译成功、禁止编造测试通过。**

### 1. 目标（两阶段交付）

**阶段 A（iPad 上必须做出来并跑通）**
1. 数据层：`Decodable` 模型 + `APIClient`（URLSession，async/await）。
2. 纯逻辑层：`BatterySnapshot`、`DurationEstimator`（续航估算，见 §5）、`Formatters`。
3. 自测：`DecodeTests.swift`，用固定 fixture 断言 `/dash/stats` 能解码并原样渲染 `display.*`（**不再有算法测试**），实际运行并贴输出。
4. UI：设备列表 / 详情 / 设置 三个 SwiftUI 界面，可预览。

**阶段 B（只产出源码，标注待 Xcode 构建）**
5. Widget：`TimelineProvider` + 小/中/大三尺寸 View，**源码写完整**，但不声称可运行。

### 2. 服务端契约（严格照此，字段名一个都不能改）

Base URL：从 `Config.swift` 的 `API_BASE_URL` 读取（我会填真实域名，形如 `https://xxx.workers.dev`）

鉴权：除 `/health` 外，所有请求都带
```
x-sync-token: <SYNC_TOKEN>
```
token 从 `Config.swift` 读，**不要硬编码进任何源码文件**，也不要写进要提交的文件；在 Playgrounds 里可以放一个 `Secrets.swift`（`Secrets.swift` 必须加进 `.gitignore` 清单，并在 README 说明）。

**「铁律」：本客户端是纯只读，只允许 `GET`。禁止 `PUT`/`POST`/`DELETE`，禁止任何「上报电量」功能或文案。** 写入会覆盖 Android 端采集的真实数据。

#### 2.1 `GET /health`（唯一免 token）
```json
{"ok":true,"service":"cross-device-sync","time":"2026-11-06T04:00:00.000Z",
 "histRetentionMs":604800000,"histRetentionDays":7}
```
`histRetentionDays` 用于 UI 文案「数据保留 N 天」。**禁止硬编码 7。**

#### 2.2 `GET /list?prefix=`
```json
{"prefix":"","cursor":null,
 "keys":[{"key":"watch/battery","updatedAt":"2026-11-06T03:59:00.000Z"}]}
```
最多 100 条；`cursor` 非 null 表示还有下一页（v1 可不翻页，但要识别字段）。服务端已过滤 `@` 开头的内部键，客户端不用再过滤。

#### 2.3 `GET /<key>`
```json
{"key":"watch/battery",
 "value":{"level":64,"charging":0,"name":"手表","src":"hook","mv":"1.4.2"},
 "version":9,"updatedAt":"2026-11-06T03:59:00.000Z"}
```
404 → `{"error":"not_found","key":"..."}`，视为「该设备暂无数据」。

#### 2.4 `GET /dash/hist?key=<key>&range=<毫秒>`
`range`：`3600000`(1h) `10800000`(3h) `21600000`(6h) `86400000`(24h) `259200000`(3d) `604800000`(7d) `0`(窗口内全部)

```json
{"key":"watch/battery","label":"手表",
 "hist":[{"t":1762405140000,"l":66,"c":0,"v":9,"s":"hook","m":"1.4.2"},
         {"t":1762408740000,"l":65,"c":0,"v":10}],
 "total":2,"now":1762408800000,"retentionMs":604800000}
```

| 字段 | 含义 | 注意 |
|---|---|---|
| `t` | 毫秒 epoch | **不是秒**，解码用 `Int64` 再转 `Date(timeIntervalSince1970: Double(t)/1000)` |
| `l` | 电量 0–100 | **可能 `null`** → 模型用 `Int?` |
| `c` | `1` 充电 / `0` 未充 | **可能 `null`** → `Int?`，nil 按「未知」处理 |
| `v` `s` `m` | 版本/来源/模块版本 | 调试用，别显示给用户 |

**服务端已实现、你绝对不要重复实现的行为：**
1. `hist` 已**升序**且已按 `range` + 7 天窗口裁剪 → **客户端不要再过滤时间**。
2. `range` 超 7 天会被夹到 7 天；`range=0` = 「窗口内全部」（≤7 天），不是「有史以来」。
3. **值没变不会产生新点**（`l` 与 `c` 同时相同则跳过采样）→ 曲线是「稀疏点+长平台」，**不是丢数据**。最后一点距 `now` > 2 小时要在 UI 灰显「数据未更新」。
4. key 不存在返回 `200` + `hist: []`，**不是 404** → 用空态区分「无数据」和「请求失败」。
5. `label` 直接用，不要自己按 key 拼。

#### 2.5 `GET /dash/stats?key=&range=&all=1&points=1`（预测统计，v11.6 新增，**唯一该用的预测接口**）

```
GET /dash/stats?key=watch/battery            # 单设备
GET /dash/stats                              # 全部设备（按链路时间倒序）
GET /dash/stats?key=watch/battery&all=1      # 视窗=全部采样（默认「上一次充满之后」）
GET /dash/stats?key=watch/battery&points=1   # 附带 curve: [[t,l],...]（≤240 点，大号组件用）
GET /dash/stats?key=watch/battery&range=86400000
```

单设备返回（节选）：

```json
{"key":"watch/battery","label":"手表","now":1762408800000,"retentionMs":604800000,"rangeMs":0,
 "device":{
   "level":64,"levelAt":1762408740000,
   "link":{"at":1762408740000,"ageMs":60000,"state":"ok"},
   "status":"discharging",
   "flags":{"linkStopped":false,"levelStale":false,"sparse":false,"gapRatio":0,"insufficient":false},
   "charging":{"on":false,"inferred":false,"elapsedMs":0,"elapsedText":"0 秒","gain":0,"from":null,"to":null,
               "rate":null,"rateText":"—","etaMs":null,"etaText":"—","full":false},
   "discharge":{"rate":2.56,"rateText":"2.56 %/h","regression":true,"lifeHours":39.1,"lifeText":"1 天 15 时",
                "lifeApprox":false,"delta24h":-18,"delta24hText":"-18%","points":42,"validPoints":42,"jumps":0},
   "charge":{"segments":1,"gain":30,"gainText":"+30%","avgRate":36.6,"avgRateText":"36.60 %/h","lastSegment":null},
   "display":{"title":"掉电 2.56 %/h","subtitle":"满电约 1 天 15 时",
              "lines":["电量 1 分前","链路 1 分前","24h 变化 -18% · 采样 42 条","掉电 2.56 %/h · 满电约 1 天 15 时"]}}}
```

全部设备返回 `{"key":"*","count":N,"devices":[...]}`，每项结构与上面的 `device` 相同。

- `status` 七值：`discharging` / `charging` / `inferredCharging` / `full` / `sparse` / `insufficient` / `noData`。
- `display.lines` 是 **1–5 行**，行数随状态变化，**不要假设固定 5 行**。
- `display.*` 是**成品文案**，逐字上屏，不许改写、不许拼接、不许加 emoji。
- 完整字段契约见线上 `/docs` 的「预测统计接口」一节（唯一真源）。

### 3. 模型定义（照这个写，别改名）

```swift
struct Health: Decodable { let histRetentionMs: Int; let histRetentionDays: Int }

struct KeyItem: Decodable { let key: String; let updatedAt: String? }
struct KeyList: Decodable { let prefix: String; let cursor: String?; let keys: [KeyItem] }

struct DeviceValue: Decodable {
    let level: Int?; let charging: Int?; let name: String?; let src: String?; let mv: String?
}
struct Record: Decodable { let key: String; let value: DeviceValue; let version: Int; let updatedAt: String }

struct Sample: Decodable { let t: Int64; let l: Int?; let c: Int?; let v: Int?; let s: String?; let m: String? }
struct HistResponse: Decodable {
    let key: String; let label: String; let hist: [Sample]
    let total: Int; let now: Int64; let retentionMs: Int
}

struct Device: Identifiable {
    let key: String; let label: String
    var level: Int?; var charging: Bool?; var updatedAt: Date?
}

// ---- 预测统计（v11.6）：只需解码，不要在这里加任何计算属性 ----
struct StatsDisplay: Decodable {
    let title: String
    let subtitle: String
    let lines: [String]        // 1–5 行，别假设固定 5
}
struct StatsLink: Decodable { let at: Int64?; let ageMs: Int64?; let state: String }
struct StatsCharging: Decodable {
    let on: Bool; let inferred: Bool
    let elapsedMs: Int64; let elapsedText: String
    let gain: Int; let from: Int?; let to: Int?
    let rate: Double?; let rateText: String
    let etaMs: Int64?; let etaText: String
    let full: Bool
}
struct StatsDischarge: Decodable {
    let rate: Double?; let rateText: String; let regression: Bool
    let lifeHours: Double?; let lifeText: String; let lifeApprox: Bool
    let delta24h: Int?; let delta24hText: String
    let points: Int; let validPoints: Int; let jumps: Int
}
struct StatsFlags: Decodable {
    let linkStopped: Bool; let levelStale: Bool; let sparse: Bool
    let gapRatio: Double; let insufficient: Bool
}
struct DeviceStats: Decodable {
    let key: String; let label: String
    let level: Int?; let levelAt: Int64?
    let link: StatsLink
    let status: String          // 七值枚举，先按 String 解，UI 用 switch
    let flags: StatsFlags
    let charging: StatsCharging
    let discharge: StatsDischarge
    let display: StatsDisplay
    let curve: [[Int64]]?       // 只有 points=1 才有；[t, l]
}
struct StatsResponse: Decodable {
    let key: String; let label: String?; let now: Int64
    let retentionMs: Int; let rangeMs: Int
    let device: DeviceStats?    // 单设备
    let count: Int?; let devices: [DeviceStats]?   // 全部设备
}
```
解码注意：`updatedAt` 是 ISO8601 带毫秒（`2026-11-06T03:59:00.000Z`），用 `ISO8601DateFormatter` 配 `.withFractionalSeconds`；解析失败**不要抛错崩界面**，置 nil。

### 4. 分层与节流

- `APIClient`：注入 `baseURL` 与 `token`，统一加头、统一错误映射。App 请求超时 10 秒。
- 并发拉多设备最新值：`withThrowingTaskGroup`，**同时最多 6 个**。
- 前台手动刷新最小间隔 60 秒（防止把免费配额打光）。
- 错误映射：`401` 提示「token 无效」**不重试**；`404` 视为无数据；`400 invalid_key` 不重试；`429`/`5xx` 指数退避最多 3 次（2s/8s/30s）；网络失败展示缓存 + 「离线」标记。

### 5. 预测数据：**只调接口，不写算法**（v11.6）

> 这一节以前叫「续航估算 / 充电统计（唯一实现）」，要求你移植 13 组用例。**现在全部作废。**
> 预测已经由服务端 `GET /dash/stats` 算完，还顺手把要显示的字也拼好了。

#### 5.1 你只需要做三件事

1. `APIClient.stats(key:points:all:range:)` → 解码成 `StatsResponse`。
2. UI 把 `device.display.title` / `subtitle` / `lines` **原样渲染**。
3. `device.status` 只用来选样式（颜色/图标），**不用来算任何数**。

| status | 界面表现 |
|---|---|
| `discharging` | 掉电速率 + 满电续航（`display.*` 已含） |
| `charging` | 「充电中 · 已充 X」+「约 X 后充满」/「已到 100%，可以拔电了」 |
| `inferredCharging` | 同上，但用「推测充电」措辞（设备不报 `c`） |
| `full` | 「已充满」+「满电约 X」 |
| `sparse` | 「数据不足」+「采样太稀疏，约 N% 的时间没有数据」 |
| `insufficient` | 「数据不足」+「有效样本不足，暂不外推」 |
| `noData` | 「无数据」+「等等客户端上报」 |

#### 5.2 明确不要写的东西

- ❌ `DurationEstimator`（这个类型现在不存在了）、`olsRate`、`statOf`、`chgStat`、`sparseOf` 的 Swift 版。
- ❌ 清洗/打标/回归/充电段状态机，任何一行都别写。
- ❌ C1–C8 / D1 / S1–S4 那 13 组用例（它们归服务端自测，客户端没有算法可测）。
- ❌ 自己算 24h 变化、自己判稀疏、自己判尖点、自己拼时长文案。

#### 5.3 兜底

- 接口失败 → 用**上次成功的 JSON 缓存**渲染；App 内标「离线」，Widget 内静默。
- 字段缺失/解码失败 → 按 `noData` 处理，显示 `--`，**不崩、不显示英文错误**。
- 免责声明照写：「预计续航按最近放电速率线性外推，仅供参考」。

### 6. Widget 源码（阶段 B，只写不构建）

写这三个文件，放在 `Widget/` 目录，每个文件顶部加：
```swift
// TODO-XCODE: 此文件属于 Widget Extension target，需在 Mac 上用 Xcode 创建
// Widget Extension 并配置 App Group（group.com.yourteam.watchsync）后才能构建。
// 在 Swift Playgrounds 中无法构建/预览本文件。
```

1. `WatchSyncWidgetBundle.swift`：`@main` WidgetBundle，只含一个 widget。
2. `WatchSyncWidget.swift`：`StaticConfiguration`，`supportedFamilies: [.systemSmall, .systemMedium, .systemLarge]`，`TimelineProvider` 实现 `placeholder` / `getSnapshot` / `getTimeline`。
   - `getTimeline` 逻辑：先读 App Group 缓存构造 entry（保证永远有内容）→ 若 `savedAt` 超过 10 分钟则尝试联网（**6 秒超时**，最多 6 台设备并发；设备状态一律拉 `GET /dash/stats?key=...`，只有 large 才额外加 `&points=1` 取 `curve`）→ 失败静默用缓存 → `Timeline(entries: [entry], policy: .after(now + 15*60))`。
   - **每一次 `getTimeline` 都要走联网那一步**（有 10 分钟节流，但不是「只刷一次」）。
   - App 前台刷新成功后必须调 `WidgetCenter.shared.reloadAllTimelines()`。
   - **验收硬条款**：组件放置 **1 小时以上**、完全不打开 App，仍必须自动更新；断网时静默用缓存不报错；文案不许承诺「实时 / 每分钟同步」（系统一天只给有限次刷新，15 分钟是请求不是保证）。
   - **Widget 里一律不显示错误文本**，只用缓存或空态。
3. `WidgetViews.swift`：按 `widgetFamily` 分支渲染。
   - 小号：最多 3 台，每行「名称 + 电量% + 充电时 `bolt.fill`」+ 底部相对时间。`level == nil` 显示 `--`（不要显示 0）。电量数字**一律用主文字色** `#e6ecf8`，**不做阈值分色**（>50 绿 / <20 红是错的）：颜色只表达事件 —— 充电中 `#34d399`、推测充电 `#5eead4`、掉电 `#f87171`、警示 `#fbbf24`。
   - 中号：每行「名称 | 电量 | 预计续航」，状态优先级 `充电中 / 推测充电` > `数据不足` > `满电约 X` > `掉电 X %/h` > `—`。充电中显示「充电中 · 已充 49 分」，**不显示续航**；没有「电量稳定」这种状态。
   - 大号：中号内容（最多 4 行）+ 每台一条 24h 曲线。
   - 曲线**用 `Canvas` 或 `Path` 自绘，禁止 Swift Charts**；`l == nil` 断开不连线；只有 1 个点时画圆点不画线；充电段用淡色横带或换色（二选一）；容器高约 70pt，左下标最小值、右上标最大值。
   - iOS 17 必须设置 `.containerBackground(...)`。
   - 支持深色模式；`widgetURL` 深链到详情页。

缓存结构（App 与 Widget 共享，`SharedStore`）：
```json
{"savedAt":1762408800000,
 "health":{"retentionDays":7},
 "devices":[{"key":"watch/battery","label":"手表","level":64,"charging":false,"updatedAt":"..."}],
 "hist":{"watch/battery":[{"t":1762405140000,"l":66,"c":0}]}}
```
`hist` 只存大号要用的 ≤4 台设备的 24h 数据，别把所有设备 7 天数据塞进去。

### 7. App 界面（三屏）

> 视觉**一律照 `docs/DESIGN.md`**（色彩 tokens、字号、圆角、层级、九种状态、文案格式都在里面）。**不要自己设计 UI**，只把 Web 看板的卡片/统计面板翻译成 SwiftUI。

1. **列表**：`/health` → `/list` → 并发 `GET /:key`。每行名称/电量/充电图标/相对时间，按 `updatedAt` 倒序；下拉刷新；空态与离线态要有设计。
2. **详情**：`GET /dash/hist`。顶部当前值 + 「数据保留 N 天」（来自 `/health`）；中部 `Charts` 折线（App 内可以用 Charts；`l==nil` 断开；充电段背景色）；选择器 `1h/3h/6h/24h/3d/7d/全部`（**没有 30 天**）；下部采样点表格（时间、电量、充电、`m`）。
3. **设置**：后端地址（只读）、保留天数、token 输入、立即刷新、上次刷新结果、一句「本应用仅读取数据，不会修改任何设备状态」。

### 8. 交付物清单

```
WatchSync.playground/          或 .swiftpm App 项目（阶段 A，可运行）
  Sources/Config.swift          BASE_URL + token 读取（不含明文）
  Sources/Models.swift          §3 的模型
  Sources/APIClient.swift
  Sources/StatsModels.swift     §3 的 /dash/stats 模型（纯 Decodable，无计算）
  Sources/Views/*.swift         三屏
  Tests/DecodeTests.swift       /dash/stats 解码测试（七种 status + lines 1/5 行 + curve 有无）
Widget/                        阶段 B，仅源码 + TODO-XCODE 标注
  三个文件见 §6
README-iPad.md                 见下
.gitignore                     排除 Secrets.swift / *.xcconfig
```
`README-iPad.md` 必须写清：token 怎么填、哪些部分已在 iPad 验证、哪些必须回 Mac（Widget / App Group / Keychain Sharing）、续航估算的免责声明（线性外推，仅供参考）、小组件刷新机制与「15 分钟是请求不是保证」的限制、已知限制。

### 9. 完成自检（逐条回答，别笼统说"已完成"）

1. `DecodeTests` 实际输出是什么？七种 `status` 的 fixture 是否都能解码并原样渲染 `display.title/subtitle`（不是你自己拼的文案）？
2. 解码遇到 `l: null` / `c: null` / `hist: []` 分别怎么处理？
3. 断网时详情页显示什么？会不会白屏或弹错误？
4. 代码里是否出现 `PUT`/`POST`/`DELETE`？（应为 0 处）
5. 有没有把 7 天、604800000 硬编码进 UI 文案？（应该用 `/health` 的返回值）
6. Widget 部分你**没有**构建，是否已在文件头标注 `TODO-XCODE`？`getTimeline` 是否返回 `policy: .after(+15 分钟)`（不是 `.never`）？App 刷新后是否调了 `reloadAllTimelines()`？
7. token 是否只出现在被 gitignore 的文件里？

### 10. 禁止事项（违反即返工）

- ❌ 任何写操作（`PUT`/`POST`/`DELETE`）；任何「上报电量」功能或 UI。
- ❌ 内置看板密码、走 WebView 登录、抓 `/dash` 页面。
- ❌ 客户端再裁一次 7 天窗口（服务端已裁，重复裁会在时钟偏移时误删）。
- ❌ 因为曲线有长平台就补点/伪造采样。
- ❌ `range` 传 > `604800000` 还期待更多数据。
- ❌ Widget 里用 Swift Charts。
- ❌ 承诺「实时」「每分钟同步」。
- ❌ 在 Widget 上显示报错文本。
- ❌ **自己实现预测/续航算法**。v11.6 起全部由 `GET /dash/stats` 提供。出现 Swift 版 `DurationEstimator` / 回归 / 充电段状态机 = 返工。
- ❌ **小组件不写自动刷新**（`policy: .never`、只在首次联网、不调 `reloadAllTimelines()`）= 返工。
- ❌ 改写或重拼 `display.title` / `display.subtitle` / `display.lines`（包括「拆开再自己加单位」）。
- ❌ **自己设计 UI**：自创色板/圆角/动效、按电量阈值分色、自创状态词。一律照 `docs/DESIGN.md`。
- ❌ **声称做了实际没做的构建/测试**（这条是底线）。

---

## 附：给用户的落地备注

| 事项 | 说明 |
|---|---|
| 为什么分两阶段 | iPad 的 Swift Playgrounds **无法创建 Widget Extension target**，App Group / Keychain Sharing / entitlements 也都得在 Xcode 里配。所以阶段 B 只能出源码，回 Mac 才构建 |
| 想省事的话 | 阶段 A 的产物可以直接在 Playgrounds 里当「单页 App」跑起来看真实数据，先把 `Config.swift` 的域名和 token 填上就行 |
| 域名 | 你已上线，填 `https://<你的真实域名>`；自检 `curl -s $BASE/health` 应能看到 `"histRetentionDays":7` |
| 后续想加「指定设备」 | 需要 `AppIntentConfiguration`，同样只能在 Xcode 里做 |