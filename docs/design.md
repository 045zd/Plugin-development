# 学习通作业截止提醒（Edge 扩展）— 设计文档

> 本文件是项目内部接口契约。所有模块必须严格按此实现。
> 项目目标（已与用户确认的合规范围）：
> 1. 监控学习通网页版课程**作业**与**考试**的截止时间；
> 2. 临近截止时发**浏览器通知**与**邮件**（本地 SMTP 代理）；
> 3. 登录页**自动填充账号**（密码由 Edge 密码管理器负责，扩展不存密码）；
> 4. 未登录/会失效时发邮件提醒用户重新登录。
>
> 明确不做：自动答题、自动提交、自动登录（存密码）。这是学术不端与安全红线。

## 目录结构

```
chaoxing-due-watcher/
├── extension/                    # Edge 扩展（Manifest V3）
│   ├── manifest.json
│   ├── background/
│   │   ├── service-worker.js     # 入口：alarms、消息路由、扫描调度
│   │   ├── config.js             # 默认配置、常量
│   │   ├── storage.js            # chrome.storage 封装
│   │   ├── chaoxing.js           # 学习通采集（tabs + scripting 驱动）
│   │   ├── parser.js             # DOM 文本 → 结构化条目 + 截止时间解析
│   │   ├── course-filter.js      # 课表课程过滤 / 课程名匹配
│   │   └── notifier.js           # 浏览器通知 + 邮件 + 提醒去重
│   ├── shared/
│   │   └── xlsx.js               # 课表解析（zip+xml 手写解析，零依赖，可 Node 单测）
│   ├── content/
│   │   └── login-autofill.js     # 登录页账号自动填充
│   ├── popup/                    # 弹窗 UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── options/                  # 设置页 UI
│   │   ├── options.html
│   │   ├── options.css
│   │   └── options.js
│   └── assets/icons/             # icon16/32/48/128.png
├── mail-proxy/                   # Python 本地 SMTP 邮件代理（零第三方依赖）
│   ├── mail_proxy.py
│   ├── config.example.json
│   ├── start.bat
│   └── README.md
├── docs/design.md
└── references/                   # 开发期调研资料（不打包）
```

## chrome.storage.local 数据结构

```jsonc
{
  "config": {
    "scanIntervalMinutes": 60,      // 扫描间隔（分钟），范围 15~720
    "checkAssignments": true,       // 监控作业
    "checkExams": true,             // 监控考试
    "reminderHours": [72, 24, 6, 1],// 提醒阈值（小时，升序去重）
    "expiredAlert": true,           // 已过期也提醒一次
    "browserNotifications": true,   // 浏览器通知
    "emailEnabled": false,          // 邮件通知开关
    "mailProxyUrl": "http://127.0.0.1:8765",
    "maxCourses": 15,               // 单次扫描最多课程数
    "autoFillAccount": true,        // 登录页自动填账号
    "rememberedAccount": "",        // 记住的账号（手机号/超星号，仅账号）
    "courseFilterEnabled": false,   // 是否只用课表内课程过滤扫描结果
    "scheduleCourses": [],          // 课表课程名列表（≤60，去重）
    "dxAiChatAutoOpen": true,       // 跳转到作答页后自动打开大学搜题酱 AI 会话
    "showExpiredItems": false       // 是否显示已截止/时间未知的未交项分组
  },
  "items": [ /* Item[]，最近一次扫描结果 */ ],
  "scanMeta": {
    "lastScanAt": 0,                // epoch ms
    "lastScanOk": false,
    "lastError": "",
    "loggedIn": null,               // true/false/null(未知)
    "scannedCourses": 0,
    "source": "auto"                // "auto" | "manual"
  },
  "notified": { "<itemKey>": [24, 6] },  // 已提醒过的阈值（小时），用于去重
  "scanState": null               // 正在扫描时的运行时状态 {startedAt, step}
}
```

### Item（存储与消息共用）

```jsonc
{
  "key": "a:课程名:作业标题:截止时间戳",  // 稳定唯一键（a=assignment, e=exam）
  "type": "assignment",           // "assignment" | "exam"
  "course": "高等数学",
  "title": "第3章作业",
  "status": "未交",               // 未交/待互评/待批阅/已完成/已批阅/进行中/未开始/已结束/未知
  "deadline": 1791446340000,      // epoch ms；无法解析时为 null
  "deadlineText": "2026-10-20 23:59",
  "startText": "",                // 考试开始时间文本（作业可空）
  "score": "",                    // 分数文本（可空）
  "url": "https://...",           // 打开作业/考试列表的链接
  "extra": ""                     // 原始文本摘要（调试用）
}
```

## 消息协议（chrome.runtime.sendMessage）

popup / options → background（`sendMessage`，background 用 `sendResponse` 异步返回）：

| type | 请求 | 响应 |
|---|---|---|
| `GET_STATE` | `{}` | `{config, items, scanMeta, scanning: boolean}` |
| `SAVE_CONFIG` | `{config: Partial<Config>}` | `{ok: true, config}` |
| `SCAN_NOW` | `{}` | `{started: boolean, error?: string}`（不等待扫描完成） |
| `TEST_EMAIL` | `{}` | `{ok: boolean, error?: string}` |
| `CLEAR_ITEMS` | `{}` | `{ok: true}` |
| `OPEN_OPTIONS` | `{}` | `{ok: true}` |
| `OPEN_URL` | `{url}` | `{ok: true}`（后台用 `chrome.tabs.create` 打开，仅允许 http/https） |

约定：
- `sendResponse` 统一包成 `{ok: boolean, data?: any, error?: string}`，`GET_STATE` 的 data 是上述对象。
- 后台在 `self.addEventListener('message')` 中用 `return true` 保持异步响应通道。
- popup 打开时先 `GET_STATE`；点"立即检查"发 `SCAN_NOW` 后每 2s 轮询 `GET_STATE` 直到 `scanning === false`，刷新界面。

## 本地邮件代理 HTTP 协议（mail-proxy）

默认监听 `127.0.0.1:8765`，仅本机。所有响应带 CORS 头：
`Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: GET, POST, OPTIONS`、
`Access-Control-Allow-Headers: Content-Type`、`Access-Control-Allow-Private-Network: true`。
OPTIONS 预检返回 204。

| 方法/路径 | 请求体 | 响应 |
|---|---|---|
| `GET /health` | - | `{ok: true, version: "1.0.0", lastHeartbeat: 0, mailConfigured: true}`；OAuth2 模式额外含 `oauthAuthorized: boolean` |
| `POST /send` | `{subject, text, html?}` | `{ok: true}` 或 `{ok: false, error}` |
| `POST /heartbeat` | `{source: "extension", loggedIn, pending}` | `{ok: true, lastHeartbeat}` |

代理行为：
- SMTP 配置读同目录 `config.json`（含 `smtp_host, smtp_port, smtp_user, smtp_pass, mail_from, mail_to, use_ssl`）。
- 可选 `auth_method`：`password`（默认，SMTP LOGIN）或 `oauth2`（Outlook/Microsoft 365，SASL XOAUTH2）。
  OAuth2 模式使用 `oauth_client_id, oauth_tenant, oauth_scope, oauth_token_file`，不需要 `smtp_pass`。
- 心跳：记录 `lastHeartbeat`；后台线程每 5 分钟检查，若距上次心跳超过 `heartbeatTimeoutMinutes`（默认 180，且 ≥ 3×扫描间隔由扩展传入或配置），发一次"监控可能未运行"提醒邮件，提醒间隔至少 6 小时一次。
- 邮件用 `email.message.EmailMessage` + `smtplib.SMTP_SSL`（465）或 `SMTP`+starttls（587/25）。
- 任何 SMTP 错误都不能让进程崩溃；写日志到 `proxy.log`（同目录，简单轮转或追加）。
- OAuth2 令牌保存在本机 `oauth_token.json`（含 refresh token），不写日志、不出 HTTP 响应。

## 学习通采集流程（background/chaoxing.js）

数据只能在已登录的浏览器会话里取。采集分两条路径，**聚合页优先、逐课程兜底**：

### 路径 A：移动版聚合页（v1.1+ 默认，秒级）

参考成熟油猴脚本（学习通作业/考试/任务列表）实测的页面结构：

1. 创建/复用**后台隐藏标签页**；
2. 导航到作业聚合页 `https://mooc1-api.chaoxing.com/work/stu-work`，等待加载 + 渲染
   （首次 1.3s，空则重试共 3 次约 4 秒），在页面 MAIN world 执行 `pageParseAggregateWorks()`：
   - 选择器：`#chaoxing-assignment-wrapper ul.nav > li` → `ul.nav > li`
   - 每项 `li` 的 `div[role="option"]` 内：`p`=标题，`span[0]`=状态文本（class 含 `status` 表示未交），
     `span[1]`=课程名，`.fr`=剩余时间；`li[data]`=作业链接（含 taskrefId/workId/courseId/clazzId）
3. 导航到考试聚合页 `https://mooc1-api.chaoxing.com/exam-ans/exam/phone/examcode`，执行
   `pageParseAggregateExams()`：
   - 选择器：`#chaoxing-assignment-wrapper ul.ks_list > li` → `ul.ks_list > li`
   - 每项：`dl > dt`=标题，`dl > dd`=剩余/考试时间，`span.ks_state`=状态，
     `div.ks_pic > img` 的 src 含 `ks_02` 表示已过期，`li[data]`=考试链接
4. 页面被重定向到 `passport2.chaoxing.com` → 判定未登录（`NOT_LOGGED_IN`）；
5. 两个聚合页**任一成功**即采用结果；两个都失败（登录除外）→ 回退路径 B。

**状态判定**（`parser.js` 的 `mapWorkStatus` / `mapExamStatus`）：
- 作业：**互评优先**——`待互评/未互评/互评中` → `待互评`（学生仍需操作，计入待办）；
  `已互评/互评完成` → `已完成`；
  再匹配已完成类文本（已完成/已批阅/已交/已提交/待批阅/已评分/未批阅/…）→ `已完成`；
  再匹配未交类（未交/未提交/未完成/待完成/待提交/去完成/…）→ `未交`；
  文本缺失时才用 class 标记兜底（class 含 `status` = 未交）；
- 考试：已完成类 → `已完成`；已过期（`ks_02`）/已结束 → `已结束`；进行中/未开始；其余 `未知`。

### 路径 B：逐课程采集（兜底）

1. 导航到 `https://mooc2-ans.chaoxing.com/mooc2-ans/visit/interaction`（建立会话）；
2. 页面内 fetch `https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1` 取课程列表
   （返回非 JSON / 含登录页特征 → `AUTH_REQUIRED`）；
3. 每门课（最多 `maxCourses`）：导航到
   `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid={courseId}&clazzid={classId}&cpi={cpi}&ismooc2=1&v=2`，
   点击 `a[data-url]` 中文本为「作业」/「考试」的 tab，取 `#frame_content-hd` 或 `iframe` 的 src，
   导航到 iframe URL 后解析旧版列表 DOM（`.ulDiv li` 等）；
4. 单门课失败只记录并继续；课程间 sleep 600ms（防风控）。

两条路径都失败时返回错误，保留上一次扫描结果；扫描结束后关闭后台标签页。
`scanChaoxing` 返回 `source: 'aggregate' | 'per-course'`，写入 `scanMeta.scanMode` 便于排查。

## 课表课程过滤（background/course-filter.js + shared/xlsx.js）

目的：学习通课程列表包含历史学期课程，用户上传本学期课表后只监控课表内课程。

- **课表解析（设置页）**：`options/options.html` 引入 `../shared/xlsx.js`；用户选择 `.xlsx`/`.csv` 后
  在本地解析（zip + xml 手写解析，`DecompressionStream('deflate-raw')` 解压，不联网、不上传）。
  每个非空单元格取前几行中第一个"像课程名"的片段作为候选（过滤星期/节次/时间/教室等噪声），
  用户在设置页勾选/手动补充后保存到 `config.scheduleCourses`。
- **过滤（service worker）**：扫描完成后、计算提醒前调用 `filterItemsBySchedule(items, config)`：
  - 未启用过滤或课表为空 → 原样返回；
  - 课程名与课表匹配（归一化后相等或包含，"高等数学" ↔ "高等数学A"）→ 保留；
  - 课程名无法确定的条目（如部分考试）→ 保留，避免漏提醒；
  - 其余过滤掉，数量记入 `scanMeta.filteredItems`，日志输出"课表过滤掉 N 条"。
- 单测：`tests/test_schedule.mjs`（xlsx/合并单元格/GBK CSV 解析 + 过滤逻辑）。

## 实验报告检查（background/report-check.js，v1.2.8）

目的：检查已提交的「实验」类作业是否真的完成、栏目是否空白、课程是否匹配。

- **选择范围**：`type === 'assignment'`、标题含「实验」、状态不属于
  `未交/进行中/未开始/未知`。
- **打开只读详情**：用隐藏标签页走「课程页 → 作业列表 → 条目 task 链接」；
  互评条目同时有 `eval-list` 和 `task` 两个链接，必须优先取 `task`
  （`eval-list` 是互评列表，不是作业详情）。`task?answerId=...` 会 302 到
  `mooc-ans/mooc2/work/view`（已提交只读页）。
- **提取内容**：`pageInspectReport` 读取 `iframe.attach-iframe` 的
  `objectid/filename/filetype/filesize`，去重后调用
  `https://mooc1.chaoxing.com/ananas/status/{objectid}?flag=normal` 获取
  文件大小与下载地址；docx 下载后解压 `word/document.xml` 取正文（限制 20k 字）。
- **判定**：
  - 顶层栏目 `实验内容和步骤` / `实验结果及分析` / `实验总结` / `心得体会` / `结论`
    存在但其内容 < 10 字 → `bad`（空白模板）；
  - 报告中 `课程名称：...` 与条目课程归一化后不一致 → `bad`；
  - 无附件且无文本答案 → `bad`；非 docx 附件或无法解析 → `warn`；
  - 其余 `ok`。
- **消息协议**：`CHECK_REPORTS` 启动（`{ok,started}`），`GET_REPORT_CHECK`
  返回 `{running,total,done,message,results,error}`；结果存
  `chrome.storage.local.reportCheckState`。检查与扫描互斥；10 分钟未完成视为超时。

## 提醒逻辑（notifier.js）

- 只对 `status` 属于待办集合（`未交/待互评/进行中/未开始/未知`）且 `deadline != null` 的条目提醒；
  `已完成/已批阅/已结束/待批阅` 不提醒。
- 计算 `hoursLeft = (deadline - now) / 3600000`：
  - 若 `0 < hoursLeft <= 阈值`：对该阈值提醒一次（记录到 `notified[key]`），
    浏览器通知标题：`[还剩 {时间}] 作业/考试即将截止`，正文：课程 + 标题 + 截止时间；
  - 若 `hoursLeft <= 0` 且 `expiredAlert`：提醒一次（阈值记为 0）。
- 浏览器通知 `chrome.notifications.create` 需要 `iconUrl: 'assets/icons/icon128.png'`，
  点击通知打开对应 `url`。
- 邮件：若 `emailEnabled`，把本次需要提醒的条目汇总成一封 HTML 邮件 POST 到代理 `/send`；
  未登录（`AUTH_REQUIRED`）时也发一封"学习通登录已失效，请重新登录"。
- 每次扫描成功后 POST 一次 `/heartbeat`（`loggedIn`, `pending` 数量）。

## popup UI 要求

- 尺寸约 380×520px，浅色主题，中文字体 `system-ui, "Microsoft YaHei", sans-serif`。
- 顶部：标题「学习通截止提醒」+ 状态徽标（已登录/未登录/未知）；副标题显示"上次检查：xx"。
- 工具行：`立即检查` 按钮（扫描中禁用并显示"检查中…"）、`设置` 按钮（打开 options）。
- 主列表：**未截止**的待办条目按 `deadline` 升序，卡片显示：类型标签（作业/考试）、课程名、标题、
  截止时间、剩余时间（颜色：>72h 灰、≤72h 黄、≤24h 橙、≤6h 红）、`打开` 按钮。
- 已截止且未提交的条目默认**完全隐藏**；`config.showExpiredItems === true` 时在底部显示
  「已截止/时间未知的未交项 N 项」折叠分组（默认收起）。聚合页对已过期作业通常不再显示
  「剩余时间」，解析出的 `deadline` 为 `null` 且 `status === '未交'` 时也归入该分组
  （v1.2.10 修复）；作业若重新开放，下一次扫描会重新识别为普通待办。
  「已过期也提醒一次」的通知逻辑不受影响。
- **跳转**：整张卡片与 `打开` 按钮都可点击（键盘 Enter/空格亦可），通过 `OPEN_URL`
  交给后台打开；条目 `url` 缺失时退回对应列表页。
- **详情页 → 作答页**：聚合页给的链接是详情页，其「开始答题/考试」按钮依赖 App JS Bridge，桌面端无效。
  `background/open-tab.js` 的处理顺序：
  1. 加载详情页，先解析/记录手机版 `doHomeWork` / `doExam` 地址作为兜底；
  2. **作业优先走电脑版**：课程页 → 点「作业」→ 电脑版列表 iframe → 按 `workId` 取条目链接 →
     `mooc-ans/mooc2/work/task` 302 到 `mooc-ans/mooc2/work/dowork`（第三方搜题插件适配的页面）；
  3. **互评任务优先走电脑版**：手机版 `work/phone/eval-list` 先解析出电脑版列表里的
     `mooc-ans/mooc2/work/eval-list?...`（优先取 eval-list 而不是 task），失败回退手机版；
  4. **考试优先走电脑版**：直接构造 `exam/test/examcode/examnotes?...`；
  5. 电脑版失败 → 手机版作答页；再失败 → 详情页。
  同一条目的电脑版地址缓存 10 分钟（`work` / `peer` 分开）；通知点击复用同一逻辑。
- **大学搜题酱联动**：`dxAiChatAutoOpen` 为 true 时，落定作答页后向页面注入脚本，
  轮询 `#dx-sibebar-container` 的 open shadow root，点击 `.chat-btn`（文字「AI 会话」）。
  第三方插件未安装时 10 秒内找不到按钮，静默跳过，不影响跳转；设置页可关闭。
- 已完成/已批阅条目折叠在"已完成的 N 项"里（默认收起）。
- 空状态：未登录时提示"请先在 Edge 中登录学习通网页版"并给登录页链接；无数据时提示"点击立即检查"。
- 底部小字：`仅提醒，不自动答题` / 版本号。
- 所有动态文本用 `textContent`，禁止 `innerHTML` 拼用户数据（防 XSS）。

## options UI 要求

- 分区卡片：监控设置 / 提醒设置 / 邮件通知 / 登录填充 / 数据管理。
- 控件：数字输入、开关（checkbox）、阈值多选（72/24/6/1 小时）、文本输入（代理地址、账号）。
- 保存按钮统一"保存设置"（或控件 change 自动保存，二选一，推荐显式保存 + 顶部提示"已保存"）。
- 邮件区：`发送测试邮件` 按钮（调 `TEST_EMAIL`），显示结果；附"如何配置邮件代理"说明链接到 mail-proxy/README.md 的内容摘要。
- 登录填充区：说明"扩展只保存账号，不保存密码；密码由 Edge 密码管理器保存，请登录时勾选浏览器保存密码"，
  提供"记住账号"输入框，以及"在 Edge 设置中保存学习通密码"的提示。
- 数据管理：清空缓存数据、恢复默认设置。

## 合规与安全红线（所有模块遵守）

- 不实现自动答题、自动提交、自动登录；
- 不保存、不传输用户密码；
- 邮件只发往用户自己配置的收件人；
- 所有网络请求只针对 `*.chaoxing.com` 与用户配置的 `127.0.0.1` 代理。
