# iOS 端开发提示词

> 用法：把下面的 **【提示词正文】** 整段复制给 iOS 开发 AI / 开发者。它自带全部后端契约，不需要再读别的文件。
> 相关文档：`docs/TECH.md`（服务端实现）、`docs/REQUIREMENTS.md`（需求与约束）

---

## 【提示词正文】

你是一名资深 iOS 工程师。请为我实现一个 **WatchSync 电量看板 iOS 客户端**。

### 0. 一句话目标

做一个 iOS App：**能查看我所有设备（Android 手表/耳机/手机、iPhone）最近 7 天的电量曲线**，并**可选地**把本机 iPhone 电量上报到同一后端。后端是已有的 Cloudflare Worker，**不要改动后端，只做客户端**。

### 1. 技术栈与工程要求

- Swift 6 / SwiftUI，最低 iOS 17，纯原生，不引第三方库（图表用系统 `Charts`）。
- 架构：`View` + `@Observable ViewModel` + 一个 `APIClient`（`async/await` + `URLSession`）。不要引入重型架构框架。
- 所有网络失败都要有可读错误，不要静默 catch 全部异常。
- 代码注释用中文，变量名用英文。
- 不写单元测试以外的花活；但 `APIClient` 的解码层要有单元测试（用 JSON fixture，不联网）。

### 2. 后端契约（务必严格照此实现，字段名一个都不能改）

Base URL：`https://<你的-worker-域名>`（我会在 `Config.xcconfig` 里提供，变量名 `API_BASE_URL`）

鉴权：所有 `/list`、`/:key`、`/dash/hist` 请求必须带请求头
```
x-sync-token: <SYNC_TOKEN>
```
`SYNC_TOKEN` 从 `Config.xcconfig` 注入 → 生成到 `Info.plist` 或 Swift 常量。**绝对不要**把 token 明文写进 Swift 源码或提交进 git。

#### 2.1 健康检查（不需要 token）
```
GET /health
→ 200 {"ok":true,"service":"cross-device-sync","time":"2026-11-06T04:00:00.000Z",
        "histRetentionMs":604800000,"histRetentionDays":7}
```
**用途：启动时调一次，把 `histRetentionMs` 存进内存，用于 UI 上标注「数据保留 X 天」，不要硬编码 7。**

#### 2.2 列出所有键
```
GET /list?prefix=<可选前缀>
→ 200 {"prefix":"","cursor":null,
        "keys":[{"key":"watch/battery","updatedAt":"2026-11-06T03:59:00.000Z"}, ...]}
```
- 最多返回 100 条，`cursor` 非 null 时表示还有下一页（本期可以不翻页，但要识别该字段）。
- 服务端已过滤内部键，客户端**不需要**再过滤 `@`。

#### 2.3 读单条最新值
```
GET /<key>
→ 200 {"key":"watch/battery","value":{...},"version":9,"updatedAt":"2026-11-06T03:59:00.000Z"}
→ 404 {"error":"not_found","key":"watch/battery"}
```
响应头会带 `x-sync-version`、`x-sync-updated`（客户端可用，也可忽略，body 里都有）。

#### 2.4 读历史（核心接口）
```
GET /dash/hist?key=<key>&range=<毫秒，0 或省略=保留窗口内全部>
→ 200 {
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

**字段语义（务必理解，否则图表会画错）：**

| 字段 | 含义 |
|---|---|
| `t` | 采样时间，**毫秒** epoch |
| `l` | `level`，电量百分比 0–100；可能为 `null`（上报没带） |
| `c` | `charging`，`1` 充电中 / `0` 未充电；可能为 `null` |
| `v` | 服务端记录版本号，仅用于调试 |
| `s` | 数据来源标识，可选 |
| `m` | 采集端模块版本，可选 |

**关键行为（都是服务端已实现的，客户端别重复实现、也别以为是 bug）：**
1. `hist` **已按时间升序**排列，且**已按 `range` 和 7 天窗口双重裁剪**。客户端不需要再过滤时间。
2. `range` 传大于 7 天的值会被服务端夹到 7 天；`range=0` 表示「保留窗口内全部」（最多 7 天），**不是**「有史以来全部」。
3. **值未变化时不会产生新点**：如果 `level` 和 `charging` 都没变，服务端跳过该采样。所以曲线会长时间是「平台 + 稀疏点」，**这不是丢数据**。UI 上要对「最后一点距 now 超过 2 小时」做灰显提示（例如「数据未更新，可能设备未变化或未联网」）。
4. `key` 不存在时返回 `200` + `hist: []`，**不是 404**。请用空状态 UI 区分「这台设备没数据」和「请求失败」。
5. `label` 是服务端给的设备显示名，直接用，不要自己按 key 拼。

#### 2.5 上报（可选功能，默认关闭）
```
PUT /<key>
Content-Type: application/json
x-sync-token: <SYNC_TOKEN>
body: {"value": {"level": 76, "charging": 1, "name": "iPhone", "src": "ios", "mv": "1.0.0", "ts": 1762408800000}}
→ 200 {"key":"ios/battery","value":{...},"version":3,"updatedAt":"..."}
```
- `value` 里服务端只认这几个名字：`level`、`charging`、`src`、`mv`、`ts`、`name`。其它字段会被忽略。
- `ts` **必须是毫秒**（>1e12）。传秒级（如 1762408800）会被判定不合理，服务端回退用自己的时间——曲线时间轴就偏了。
- body 上限 24 KB，超了返回 `413`。
- 可选并发控制：请求头带 `x-sync-base-version: <上次 GET 到的 version>`，不匹配时返回 `409` 并回带 `current`。**本期单向覆盖，不需要传这个头。**

### 3. 能力边界（先看清楚再动手，别做做不到的事）

- ✅ **能读**：本机 iPhone 电量 —— `UIDevice.current.isBatteryMonitoringEnabled = true`，然后 `batteryLevel`（0.0–1.0，**-1 表示未知，必须处理**）× 100 取整；`batteryState` 映射为 `charging`：`.charging` / `.full` → `1`，`.uncharging` / `.unknown` → `0`。
- ✅ **能读**：后端里的所有设备记录（手表、耳机等，由 Android 端上报）。
- ❌ **不能读**：AirPods 的电量（Apple 私有协议，无公开 API）。
- ⚠️ **不保证能读**：其它蓝牙设备电量 —— 只有实现标准 BLE Battery Service（UUID `0x180F`）的设备才可读。**本期不做**，不要写 CoreBluetooth 扫描逻辑。
- ❌ **不要**内置看板密码、不要实现 WebView 登录、不要爬 `/dash` 页面。

### 4. 上报策略（启用时）

- 触发时机：App 进入前台、`scenePhase` 变 `.active`、以及后台刷新回调时各检查一次。
- **变化阈值**：`level` 与上次成功上报相比变化 ≥ 1 个百分点**或** `charging` 状态翻转，才发请求；否则跳过（省配额，且服务端本来也会去重）。
- 上报 key 固定为 `ios/battery`（服务端会把它识别为设备键，展示名取 `value.name`，所以 `name` 传 `"iPhone"` 或机型名）。
- 失败重试：指数退避，最多 3 次（间隔 2s / 8s / 30s）；`401` **不重试**（立刻提示「token 无效」），`413` 不重试（说明客户端有 bug）。
- 首次上报前先 `GET /ios/battery`；`404` 属正常（第一次），不用报错。

### 5. 后台刷新（必须如实实现，不许画饼）

- 用 `BGAppRefreshTask`：`BGTaskSchedulerPermittedIdentifiers` 加 identifier（如 `com.example.watchsync.refresh`），在 `Info.plist` 声明 `UIBackgroundModes: fetch`。
- 注册 `BGTaskScheduler.shared.register(...)` 要在 `didFinishLaunching` 里、启动完成前。
- **系统不保证时机**：`earliestBeginDate` 建议 `Date().addingTimeInterval(15*60)`，实际可能几小时才跑一次、也可能不跑。**UI 上不要说「每分钟同步」**这类做不到的话。
- 任务结束必须 `task.setTaskCompleted(success:)`，并**在结束时重新 schedule 下一次**，否则后台刷新会永久停止。
- 后台任务里有时间预算（约 30 秒），超时要主动取消。

### 6. UI 要求

三个界面即可，别过度设计：

1. **设备列表页**
   - 启动：`GET /health` → `GET /list` → 对每个键 `GET /<key>` 取最新值（并发，最多同时 6 个）。
   - 每行：设备名（`value.name` 或 key）、当前电量（大字号）、充电状态图标、最后更新时间（相对时间，如「3 分钟前」）。
   - 按 `updatedAt` 倒序。空列表给空状态提示。

2. **设备详情页**
   - `GET /dash/hist?key=<key>&range=<选中值>`。
   - 顶部：当前电量 + 充电状态 + 「数据保留 7 天」的说明（用 `/health` 拿到的 `histRetentionDays`）。
   - 中部：`Charts` 折线图，X 轴时间、Y 轴 0–100。**必须做**：`l == nil` 的点跳过不画（用 `LineMark` 逐点，缺失处断开）；充电区段可用 `RectangleMark` 或背景色标注。
   - 时间范围选择器：`1h / 3h / 6h / 24h / 3d / 7d / 全部`（与 Web 看板一致，对应 range = 3600000 / 10800000 / 21600000 / 86400000 / 259200000 / 604800000 / 0）。**不要提供 30 天选项**（服务端也拿不到）。
   - 下部：采样点表格（时间、电量、充电、`m` 模块版本），支持按时间倒序。

3. **设置页**
   - 显示后端地址、保留天数（来自 `/health`）、「上报本机电量」开关（默认关）、「立即上报」按钮、上次上报结果/错误。
   - token 输入框（可选，方便调试）：写入 Keychain，不写入 `UserDefaults`。

### 7. 安全要求（硬性）

- `SYNC_TOKEN` 存 **Keychain**（`kSecClassGenericPassword`，`kSecAttrAccessibleAfterFirstUnlock`），App 启动时读取。
- 允许通过 `Config.xcconfig` 注入默认 token（个人自用），但**该文件不进 git**（`.gitignore` 里排除），仓库里只提交 `Config.xcconfig.example`。
- 禁止打印 token 到日志；错误日志里对 token 做 `***` 屏蔽。
- 禁止 `NSAllowsArbitraryLoads`；只走 HTTPS。
- 不实现任何 `DELETE` 调用（服务端会连历史一起删，误删不可恢复）。

### 8. 错误处理矩阵

| 状态码 | 含义 | 客户端行为 |
|---|---|---|
| 200 | 成功 | 正常渲染 |
| 400 | `invalid_key`（key 含非法字符或以 `@` 开头） | 提示「设备键非法」，不重试 |
| 401 | token 错误/缺失 | 提示去设置页填 token，不重试 |
| 404 | 键不存在（仅 `GET /:key`） | 视为「该设备暂无数据」 |
| 409 | 版本冲突（仅带 `x-sync-base-version` 时） | 本期不会出现；若出现则重新 GET 后重试一次 |
| 413 | body > 24 KB | 提示「上报数据过大」，不重试 |
| 429 | 限流 | 读 `Retry-After`（若有），退避后重试最多 1 次 |
| 5xx | 服务端错误 | 指数退避重试最多 3 次 |
| 网络失败 | 无网/超时 | 展示缓存数据 + 「离线」标记；有网后自动刷新 |

超时：请求 10 秒。

### 9. 验收标准（我会逐条验）

1. 首次启动、token 正确时，列表页能显示后端里已有的设备（例如「手表」）和当前电量。
2. 点进详情，默认展示 **近 7 天**曲线；切换到 1h/24h 数据量随之变化；**没有 30 天选项**。
3. 构造一个只有 7 天内数据的场景，图表 X 轴不会出现 7 天之前的点。
4. 把某台设备的最后更新时间改早（或用长时间未更新的真实设备），列表/详情有「数据陈旧」的灰显提示。
5. 拔掉网络，App 不崩溃，展示「离线」并可下拉重试；恢复网络后自动刷新。
6. token 改成错的 → 明确提示「token 无效」，**不无限重试**。
7. 打开「上报本机电量」→ 电量变化 1% 后能上报成功，且 Web 看板出现 `ios/battery` 这台设备。
8. 后台刷新：`BGTaskScheduler` 注册成功（模拟器可用 `_simulateLaunchForTaskWithIdentifier` 验证）；任务完成后重新 schedule，不出现「只跑一次就没了」。
9. 仓库里 `grep` 不到明文 token。

### 10. 交付物

1. 可编译运行的 Xcode 工程（iOS 17+，SwiftUI）。
2. `Config.xcconfig.example`（含 `API_BASE_URL`、`SYNC_TOKEN` 占位符）+ 更新后的 `.gitignore`。
3. `README-iOS.md`：如何配置 token、如何验证后台刷新、已知限制（读不到 AirPods 电量、后台刷新不保证时机）。
4. `APIClient` 解码层的单元测试（用真实响应样例做 fixture，包含 `hist: []`、`l: null`、`charging: null` 三种边界）。

### 11. 禁止事项（违反即返工）

- ❌ 不要改后端代码，不要新增接口。
- ❌ 不要内置 `DASH_PWD`、不要走 WebView 登录、不要抓 `/dash` 页面。
- ❌ 不要自己在前端再裁剪一次 7 天窗口（服务端已裁剪，重复裁剪只会在时钟偏移时误删数据）。
- ❌ 不要因为「曲线有长时间平台」就以为丢数据、去补点或伪造采样。
- ❌ 不要把 `range` 传大于 604800000 的值并期待拿到更多数据。
- ❌ 不要承诺「实时同步」「每分钟刷新」这类系统不允许的能力。
- ❌ 不要实现 `DELETE`。

---

## 附：给用户的落地备注

| 事项 | 说明 |
|---|---|
| 阻塞点：token 分发 | 服务端目前只有单个 `SYNC_TOKEN`。个人自用、不分发 → `.xcconfig` 注入够用；若要上架/分发，需先做「设备级 token」，属后端新需求（见 `REQUIREMENTS.md` §7-D2） |
| `ios/battery` 键 | 满足服务端设备键规则 `^[a-z][a-z0-9_-]{0,20}/battery$`，会被看板当设备显示，展示名取 `value.name` |
| 服务端部署状态 | 截至本提示词编写时，v11 改动**仅在本地仓库**（`3c3021b`、`21674dd`），线上仍是 v10。**iOS 联调前必须先 `npx wrangler deploy`**，否则 `/dash/hist` 会 404 |
| 联调自检 | `curl -H "x-sync-token: $TOKEN" "$BASE/dash/hist?key=watch/battery&range=0"` 能返回 JSON，就说明后端就绪 |