# iPad Agent 提示词（WatchSync 只读客户端 + Widget）

> 整段复制给 iPad 端 agent 框架使用。接口契约自包含；但**算法与视觉的真源在 `docs/ALGO.md` 与 `docs/DESIGN.md`**，本文 §5 只是必须照做的摘要。
> 与 `docs/IOS_PROMPT.md` 的区别：这份**假设你在 iPad 上执行**（Swift Playgrounds / a-Shell），所以明确了「什么现在能做、什么必须回 Mac 做」，防止 agent 谎报构建成功。
>
> **v11.5 重要变更（先读这条，否则整段返工）**
> 1. §5 的旧算法（过滤充电点 → 首末差分 → `slope <= 0.2` 视为稳定 → 240h 上限 → 分钟圆到 5 的倍数）**已全部废弃**。它会被 `90↔100` 的锯齿骗到 3.47 %/h（满电 28.8 小时），而真实放电只有 1.2 %/h。现行算法见 §5，唯一真源是 Web 看板的 `chgStat`/`statOf`，完整口径与伪码在 `docs/ALGO.md`。
> 2. **不要自己设计 UI**。配色、字号、圆角、层级、状态词、文案格式一律照 `docs/DESIGN.md`，你只做「等价翻译」。尤其：**不许按电量阈值分色**、不许自创「电量稳定」这类状态词。
> 3. 若你已经开始按旧算法写 `DurationEstimator`，**停下来，按 §5 重写**，不要「保留原结构再打补丁」。

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
3. 自测：`AlgorithmTests.swift`，用固定样本断言 §5 的**全部分支**，实际运行并贴输出。
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
```
解码注意：`updatedAt` 是 ISO8601 带毫秒（`2026-11-06T03:59:00.000Z`），用 `ISO8601DateFormatter` 配 `.withFractionalSeconds`；解析失败**不要抛错崩界面**，置 nil。

### 4. 分层与节流

- `APIClient`：注入 `baseURL` 与 `token`，统一加头、统一错误映射。App 请求超时 10 秒。
- 并发拉多设备最新值：`withThrowingTaskGroup`，**同时最多 6 个**。
- 前台手动刷新最小间隔 60 秒（防止把免费配额打光）。
- 错误映射：`401` 提示「token 无效」**不重试**；`404` 视为无数据；`400 invalid_key` 不重试；`429`/`5xx` 指数退避最多 3 次（2s/8s/30s）；网络失败展示缓存 + 「离线」标记。

### 5. 续航估算 / 充电统计（唯一实现，**禁止自研**）

> 完整口径、阈值、伪码、13 组校验用例见 `docs/ALGO.md`。Web 看板已经实现了这一套，你的输出必须与它**逐位一致**：同样一份 `hist`，Web 说 39 小时，你就得说 39 小时。

**旧口径（已废弃，不许再用）**：丢 `c==1` → 首末差分 → `slope <= 0.2` 判「电量稳定」 → 240h 上限 → 分钟圆到 5 的倍数。
失效证据：耳机 `90↔100` 锯齿下它算出 3.47 %/h（满电 28.8h），真实约 1.2 %/h；而且「电量稳定」这个状态在 Web 端**根本不存在**，不要自创。

**处理管线（顺序不能变）**

1. **清洗**：丢 `l == nil`；**同一毫秒只保留先到的那条**（模块会在同一 tick 连写 79 和 75，不去重会凭空多出一次「掉电」）。
2. **打标**：
   - `rep = (c == 1)` —— 设备自称充电，**不可单独作依据**（手表恒为 0）
   - `jump = |b-a| >= 8 && |b-c| >= 8 && |a-c| <= 2` —— 孤立尖点，不参与统计，曲线也不画
   - `inf = !rep && l - prevL >= 1` —— 相对上一个**非尖点**上涨
3. **放电速率**：最小二乘回归，样本只取「两端都不在充电」的相邻点。样本 `< 3` 或斜率 `>= 0` → 回退首末差分 `sum/span`，并给结果打 `~`。
4. **续航** = `100 / rate`；`> 720h` 不给（**不是 240h**）。
5. **充电侧状态机**（`已充多久 / 充电速率 / 预计充满`）：起段 = 上报充电或开始上涨；**持平必须续段**；**只有掉电才收段**；尖点跳过。
   - `elapsed = last.t - last.t0`，**绝不外推到 now**（息屏冻结会把「已充 5 小时」吹成 8 小时）
   - `rate = curGain / elapsed`，需 `elapsed > 180000ms` 且 `curGain > 0`，否则 `nil`（不许显示 `0.00 %/h`）
   - `eta = (100 - lastL) / rate`；`lastL >= 100` 时为 `nil`，UI 写「已充满」
6. **稀疏设备**（跨度 >= 2h 且间隔 > 1.5h 的空档占比 > 55%）→ 「数据不足」，不给续航。
7. **格式化**：时长按 `fmtDur` 原样（90s 内「刚刚」、90min 内「X 分」、48h 内「X 时 Y 分」、以上「X 天 Y 时」）。**不许把分钟圆到 5 的倍数**（那是旧口径）。

枚举建议（去掉 `stable` / `over10Days`，它们已不存在）：
```swift
enum DurationEstimate: Equatable {
    case charging(elapsedSec: Int, rate: Double?, eta: Double?, isInferred: Bool)
    case insufficient          // 样本不足 / 稀疏 / 续航 > 720h
    case hours(Double, isStale: Bool)
    case unknown               // 完全没有 l 数据
}
```
> `推测充电`（`c` 缺失但电量在涨）用 `isInferred = true` 区分，Web 端会把它染成青色 `#5eead4` 并写「推测充电」四个字，**不许直接说「充电中」**。

**移植完必须逐条跑过这 13 组用例**（等间隔 1h，`H = 3600000`），与服务端 `docs/ALGO.md` §9 完全同源：

| # | 输入 | 期望 |
|---|---|---|
| C1 | `40, 45, 50, 55` | 充电段 1 个，`l0=45`，`curGain=10`，`elapsed=1H`，`rate=10 %/h`，`eta=4.5H` |
| C2 | `40, 45, 50, 48` | 段 1 个已闭合，`gain=5`，`eta=nil`，`avgRate=5 %/h` |
| C3 | `60, 58, 55` | 无充电段，`rate=nil` |
| C4 | `90, 100`（c=1） | `rate=10 %/h`，**`eta=nil`**（已满） |
| C5 | `50`（单点，c=1） | 段 1 个但 `rate=nil`（没有时长，不许除以 0） |
| C6 | `60, 60`（c=1，2h） | **`rate=nil`**（不给 0.00） |
| C7 | `40, 45, 45, 50` | 1 段 3 点，`elapsed=2H`，`rate=2.5 %/h`（持平不断段） |
| C8 | `50, 50(c=1), 45` | 段 1 个已闭合，零充入段不进 `avgRate`，`avgRate=nil` |
| D1 | `(t,77), (t,75), (t+H,79)` | 去重后 2 点，`drops=0` |
| S1 | `100, 96`（间隔 2h） | `rate=2 %/h`，`reg=false`，`life=50h` |
| S2 | `100, 99, 98, 97, 96` | `rate=1 %/h`，`reg=true`，`life=100h` |
| S3 | `50, 95, 50` | 中点 `jump=true`，不计采样不计掉电 |
| S4 | `60, 60` 平盘 | `rate=nil`，`life=nil`（不给「剩余 0 小时」） |

**这 13 组全过才算对齐。** 在 `README-iPad.md` 里贴真实运行输出，不要只写「已通过」。

**这是粗估，不是承诺。** App 内与 README 都要有一句「预计续航按最近放电速率线性外推，仅供参考」。

### 6. Widget 源码（阶段 B，只写不构建）

写这三个文件，放在 `Widget/` 目录，每个文件顶部加：
```swift
// TODO-XCODE: 此文件属于 Widget Extension target，需在 Mac 上用 Xcode 创建
// Widget Extension 并配置 App Group（group.com.yourteam.watchsync）后才能构建。
// 在 Swift Playgrounds 中无法构建/预览本文件。
```

1. `WatchSyncWidgetBundle.swift`：`@main` WidgetBundle，只含一个 widget。
2. `WatchSyncWidget.swift`：`StaticConfiguration`，`supportedFamilies: [.systemSmall, .systemMedium, .systemLarge]`，`TimelineProvider` 实现 `placeholder` / `getSnapshot` / `getTimeline`。
   - `getTimeline` 逻辑：先读 App Group 缓存构造 entry（保证永远有内容）→ 若 `savedAt` 超过 10 分钟则尝试联网（**6 秒超时**，最多 6 台设备并发，只有 large 才拉 `/dash/hist?range=86400000`）→ 失败静默用缓存 → `Timeline(entries: [entry], policy: .after(now + 15*60))`。
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
  Sources/DurationEstimator.swift
  Sources/Views/*.swift         三屏
  Tests/AlgorithmTests.swift    §5 的 13 组用例断言
Widget/                        阶段 B，仅源码 + TODO-XCODE 标注
  三个文件见 §6
README-iPad.md                 见下
.gitignore                     排除 Secrets.swift / *.xcconfig
```
`README-iPad.md` 必须写清：token 怎么填、哪些部分已在 iPad 验证、哪些必须回 Mac（Widget / App Group / Keychain Sharing）、续航估算的免责声明（线性外推，仅供参考）、已知限制。

### 9. 完成自检（逐条回答，别笼统说"已完成"）

1. `AlgorithmTests` 实际输出是什么？§5 表格里 C1–C8、D1、S1–S4 共 13 组是否逐条覆盖通过？
2. 解码遇到 `l: null` / `c: null` / `hist: []` 分别怎么处理？
3. 断网时详情页显示什么？会不会白屏或弹错误？
4. 代码里是否出现 `PUT`/`POST`/`DELETE`？（应为 0 处）
5. 有没有把 7 天、604800000 硬编码进 UI 文案？（应该用 `/health` 的返回值）
6. Widget 部分你**没有**构建，是否已在文件头标注 `TODO-XCODE`？
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
- ❌ **自己重写/「优化」预测算法**。它是 §5 与 `docs/ALGO.md` 那套，Web 已实现，你只移植。改算法前先提 issue 说明现算法错在哪。
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