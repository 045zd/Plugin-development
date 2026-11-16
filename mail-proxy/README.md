# 本地 SMTP 邮件代理（mail-proxy）

「学习通作业截止提醒」Edge 扩展的本地发信组件。扩展在作业/考试临近截止时，把邮件内容 POST 给本代理；代理用你自己配置的 SMTP 邮箱把提醒发到你的收件箱。

- **只监听 `127.0.0.1`**，不对外网开放；
- **只使用 Python 标准库**，无第三方依赖，兼容 Python 3.10+；
- **只做发信**：不自动答题、不自动提交、不自动登录、不上传任何用户数据；
- 授权码只保存在同目录 `config.json`，不会写进日志，也不会通过 HTTP 返回给调用方。

协议的权威定义见 `../docs/design.md` 的「本地邮件代理 HTTP 协议（mail-proxy）」一节。

---

## 1. 文件说明

| 文件                         | 说明                                   |
| -------------------------- | ------------------------------------ |
| `mail_proxy.py`            | 主程序（HTTP 服务 + SMTP + 心跳守护）           |
| `config.example.json`      | 配置模板；复制为 `config.json` 后填写           |
| `config.outlook-oauth.example.json` | Outlook OAuth2 配置模板（个人 Outlook 推荐）  |
| `config.json`              | 你自己的配置，**包含授权码，不要外传**（本目录下默认不存在）     |
| `oauth_token.json`         | OAuth2 令牌文件（运行时生成，**包含 refresh token，不要外传**） |
| `start.bat`                | Windows 启动脚本（检查 Python 版本后启动）        |
| `README.md`                | 本文件                                  |
| `tests/test_mail_proxy.py` | 单元测试（标准库 unittest）                   |
| `proxy.log`                | 运行日志（运行时生成，超过 5MB 轮转为 `proxy.log.1`） |

---

## 2. 准备 Python

1. 安装 Python 3.10 或更高版本：<https://www.python.org/downloads/>
2. 安装时勾选 **Add python.exe to PATH**。
3. 打开 PowerShell 或 CMD 验证：
   ```bat
   python -V
   ```
   应输出 `Python 3.10.x` 或更高版本。
4. 如果提示找不到 python，重新安装并勾选 PATH；或在「设置 → 应用 → 应用执行别名」中关闭 Microsoft Store 的 `python.exe` 别名。

---

## 3. 获取 SMTP 授权码

> 授权码不是邮箱登录密码。QQ 邮箱、163 邮箱都必须使用「授权码 / 客户端授权密码」。  
> 授权码只显示一次，请立即复制保存。

### 3.1 QQ 邮箱

1. 登录 <https://mail.qq.com>。
2. 打开「设置 → 账号」（新版可能叫「账号与安全 → 安全设置」）。
3. 找到「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务」。
4. 开启 **POP3/SMTP 服务**（或 IMAP/SMTP 服务），按页面提示完成密保验证。
5. 点击「生成授权码」，复制得到的 16 位授权码（形如 `abcdwxyzefghijkl`）。
6. 填写配置时使用：
   | 项           | 值                                |
   | ----------- | -------------------------------- |
   | `smtp_host` | `smtp.qq.com`                    |
   | `smtp_port` | `465`（推荐）或 `587`                 |
   | `smtp_user` | 你的完整 QQ 邮箱，如 `12345678@qq.com`   |
   | `smtp_pass` | 上一步的授权码                          |
   | `mail_from` | 与 `smtp_user` 相同                 |
   | `mail_to`   | 收提醒的邮箱（可以还是自己）                   |
   | `use_ssl`   | 端口 465 填 `true`；端口 587 填 `false` |
   企业邮箱（腾讯企业邮）通常使用 `smtp.exmail.qq.com:465`，账号为完整企业邮箱地址。

### 3.2 163 邮箱

1. 登录 <https://mail.163.com>。
2. 打开「设置 → POP3/SMTP/IMAP」。
3. 开启 **SMTP 服务**，按提示完成手机验证。
4. 在「客户端授权密码」处设置/重置授权码（不是登录密码）。
5. 填写配置时使用：
   | 项           | 值                               |
   | ----------- | ------------------------------- |
   | `smtp_host` | `smtp.163.com`                  |
   | `smtp_port` | `465`（推荐）或 `25`                 |
   | `smtp_user` | 你的完整 163 邮箱，如 `abc@163.com`     |
   | `smtp_pass` | 客户端授权密码                         |
   | `mail_from` | 与 `smtp_user` 相同                |
   | `mail_to`   | 收提醒的邮箱                          |
   | `use_ssl`   | 端口 465 填 `true`；端口 25 填 `false` |
   126 邮箱同理：`smtp.126.com:465`。

### 3.3 其他常见邮箱

| 邮箱                      | SMTP 服务器             | 端口与模式                                   |
| ----------------------- | -------------------- | --------------------------------------- |
| 126                     | `smtp.126.com`       | 465 + `use_ssl=true`                    |
| Gmail                   | `smtp.gmail.com`     | 465 + `use_ssl=true`（需应用专用密码；国内网络可能不可达） |
| Outlook / Microsoft 365 | `smtp.office365.com` | 587 + `use_ssl=false`（STARTTLS）         |
| 公司/学校邮箱                 | 询问管理员                | 以管理员给的为准                                |

> 部分邮箱要求 `mail_from` 必须与登录账号完全一致（QQ、163 都是这样），否则会被拒绝（`smtp_sender_refused`）。

> **Outlook.com 个人账号注意**：微软已对 Outlook.com 停用基础认证，用户名 + 密码/应用密码会返回 `535 5.7.3 Authentication unsuccessful`。个人 Outlook 账号必须使用 OAuth2，见 3.4。

### 3.4 Outlook / Microsoft 365（OAuth2，个人 Outlook 必看）

本代理支持 OAuth2 的 SMTP XOAUTH2 认证。它需要一个注册在 Microsoft Entra ID 里的**公共客户端应用**（public client），首次运行 `--oauth-login` 完成设备代码授权，之后用本地 `oauth_token.json` 里的 refresh token 自动续期。

> 前提：你需要有一个可注册应用的 Microsoft Entra 租户。学校/公司的 Microsoft 365 租户通常可用（可能需要管理员允许注册应用或授予 `SMTP.Send`）；个人 Outlook.com 账号本身不能直接注册应用，需要先有一个 Azure/Entra 租户。

**注册应用（一次性）**

1. 用有租户的账号登录 <https://entra.microsoft.com>；
2. 打开「应用注册」→「新注册」；
3. 名称随意，例如 `chaoxing-mail-proxy`；
4. 支持的账户类型选「任何组织目录中的账户和个人 Microsoft 账户」；
5. 重定向 URI 留空（设备代码流程不需要）；
6. 注册后进入「身份验证」→ 打开「允许公共客户端流」→ 保存；
7. 进入「API 权限」→「添加权限」→「我的组织使用的 API」→ 搜索 **Office 365 Exchange Online** → 委托的权限 → 勾选 **SMTP.Send** → 添加；
   - 如果页面提示需要管理员同意，请让租户管理员点「授予管理员同意」；
8. 进入「概述」，复制 **应用程序(客户端) ID**。

**填写 config.json**

```json
{
  "smtp_host": "smtp.office365.com",
  "smtp_port": 587,
  "smtp_user": "your_account@outlook.com",
  "mail_from": "your_account@outlook.com",
  "mail_to": "your_account@outlook.com",
  "use_ssl": false,
  "auth_method": "oauth2",
  "oauth_client_id": "粘贴上一步的客户端 ID",
  "oauth_tenant": "common",
  "oauth_scope": "https://outlook.office.com/SMTP.Send offline_access",
  "oauth_token_file": "oauth_token.json"
}
```

- `auth_method` 为 `oauth2` 时**不需要** `smtp_pass`，可以留空或删除；
- `oauth_tenant` 默认 `common`，同时支持个人账号和组织账号；若明确只登录个人账号，可改成 `consumers`；
- `oauth_scope` 必须包含 `https://outlook.office.com/SMTP.Send` 和 `offline_access`，否则拿不到 refresh token。

**首次授权**

```bat
python mail_proxy.py --oauth-login
```

按提示打开显示的网址，输入一次性代码并登录/同意权限。成功后同目录会生成 `oauth_token.json`。可用以下命令确认状态（不会显示令牌内容）：

```bat
python mail_proxy.py --oauth-status
```

之后正常双击 `start.bat` 启动即可；访问令牌过期时，代理会自动用 refresh token 刷新。

**安全提醒**

- `oauth_token.json` 里的 refresh token 等同于长期发信权限，**不要提交到 Git、不要发到群里、不要截图分享**；
- 需要撤销时：运行 `python mail_proxy.py --oauth-logout` 删除本地令牌，并在 Microsoft 账户的「应用和权限」里移除该应用；
- 设备代码流程只在 `--oauth-login` 时访问 `login.microsoftonline.com`，HTTP 服务本身仍然只监听 `127.0.0.1`。

---

## 4. 配置 config.json

1. 在 `mail-proxy` 目录下，把 `config.example.json` **复制**一份并改名为 `config.json`：
   ```bat
   copy config.example.json config.json
   ```
   也可以在资源管理器里右键复制、粘贴、重命名。
2. 用记事本或 VS Code 打开 `config.json`，按下表填写：
   | 字段                          | 必填 | 说明                                                   |
   | --------------------------- | -- | ---------------------------------------------------- |
   | `smtp_host`                 | 是  | SMTP 服务器地址，如 `smtp.qq.com`                           |
   | `smtp_port`                 | 是  | SMTP 端口，整数，如 `465`、`587`、`25`                        |
   | `smtp_user`                 | 是  | 登录账号，通常是完整邮箱地址                                       |
   | `smtp_pass`                 | 是  | SMTP 授权码（不是登录密码）                                     |
   | `mail_from`                 | 是  | 发件人地址，通常与 `smtp_user` 相同                             |
   | `mail_to`                   | 是  | 收件人；可以是一个字符串，也可以是数组                                  |
   | `use_ssl`                   | 是  | `true` = 隐式 SSL（465）；`false` = 明文 + STARTTLS（587/25） |
   | `auth_method`               | 否  | `password`（默认，QQ/163）或 `oauth2`（Outlook）  |
   | `oauth_client_id`           | OAuth2 必填 | Microsoft Entra 应用的客户端 ID           |
   | `oauth_tenant`              | 否  | 默认 `common`；个人账号可用 `consumers`         |
   | `oauth_scope`               | 否  | 默认 `https://outlook.office.com/SMTP.Send offline_access` |
   | `oauth_token_file`          | 否  | 令牌文件路径，默认同目录 `oauth_token.json`        |
   | `heartbeat_timeout_minutes` | 否  | 多久没收到扩展心跳就发「监控可能未运行」提醒，默认 `180`                      |
   | `port`                      | 否  | HTTP 监听端口，默认 `8765`；也可用 `--port` 覆盖                  |
3. 一个可用的例子（QQ 邮箱，SSL 465）：
   ```json
   {
     "smtp_host": "smtp.qq.com",
     "smtp_port": 465,
     "smtp_user": "12345678@qq.com",
     "smtp_pass": "你的16位授权码",
     "mail_from": "12345678@qq.com",
     "mail_to": "12345678@qq.com",
     "use_ssl": true,
     "heartbeat_timeout_minutes": 180,
     "port": 8765
   }
   ```
   `mail_to` 也可以写多个收件人：
   ```json
   "mail_to": ["me@qq.com", "backup@163.com"]
   ```
   或字符串形式：`"mail_to": "me@qq.com, backup@163.com"`。
4. **JSON 语法注意**：
   - 不能写注释（`//`、`#`）；
   - 最后一项后面不能有逗号；
   - 字符串必须用英文双引号；
   - 布尔值是小写 `true` / `false`；
   - 修改后保存为 **UTF-8** 编码（记事本默认即可）。
5. **安全提醒**：
   - `config.json` 里有授权码，**不要提交到 Git、不要发到群里、不要截图分享**；
   - 可以右键 `config.json` → 属性 → 安全 → 编辑，只保留当前用户权限；
   - 如果授权码泄露，去邮箱设置里「重置授权码」，并更新 `config.json`。

> `config.example.json` 里的 `smtp_pass` 故意留空。复制后不填授权码，`/health` 会显示 `mailConfigured: false`，`/send` 会返回 `mail_not_configured`。

---

## 5. 启动

### 5.1 双击启动（推荐）

双击 `start.bat`。脚本会：

1. `cd /d` 到脚本所在目录；
2. 检查 `python` 是否存在、版本是否 ≥ 3.10；
3. 运行 `python mail_proxy.py %*`。

看到类似输出即成功：

```text
[2026-10-19 19:00:00] INFO 邮件代理已启动：http://127.0.0.1:8765 （健康检查 /health）
```

关闭窗口或按 `Ctrl+C` 停止。

### 5.2 命令行启动

在 `mail-proxy` 目录打开 PowerShell / CMD：

```bat
python mail_proxy.py
python mail_proxy.py --port 8799
python mail_proxy.py --config "D:\somewhere\config.json"
python mail_proxy.py --oauth-login
python mail_proxy.py --oauth-status
python mail_proxy.py --oauth-logout
```

参数：

| 参数              | 说明                                    |
| --------------- | ------------------------------------- |
| `--port`        | 覆盖 `config.json` 里的 `port`，范围 1-65535 |
| `--config`      | 指定配置文件路径；默认是脚本同目录的 `config.json`      |
| `--oauth-login` | 执行 OAuth2 设备代码授权并保存令牌（不启动 HTTP 服务）    |
| `--oauth-status`| 查看 OAuth2 令牌状态（不显示令牌内容）               |
| `--oauth-logout`| 删除本地 OAuth2 令牌文件                     |
| `--version`     | 显示版本                                  |
| `--help`        | 显示帮助                                  |

> 如果 `config.json` 不存在或字段不完整，代理**仍然会启动** HTTP 服务（这样 `/health` 可用），只是 `/send` 返回 `mail_not_configured`，控制台会打印友好提示。

### 5.3 验证是否正常

1. 浏览器打开：<http://127.0.0.1:8765/health>
2. 应返回类似：
   ```json
   {"ok": true, "version": "1.0.0", "lastHeartbeat": 0, "mailConfigured": true}
   ```
   - `mailConfigured: true` 表示配置完整；
   - `lastHeartbeat` 是扩展最后一次心跳的 **epoch 毫秒**时间戳（0 表示还没收到过）。
3. 在扩展的设置页（options）里把「邮件代理地址」填成 `http://127.0.0.1:8765`，点「发送测试邮件」。
4. 收件箱应收到测试邮件；如果没有，看 `proxy.log` 和下一节的常见错误。

---

## 6. HTTP 接口（给扩展用）

服务只绑定 `127.0.0.1`。所有响应都带 CORS 头：

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Allow-Private-Network: true
```

`OPTIONS` 预检返回 `204`，无响应体。

| 方法/路径             | 请求体                                                              | 成功响应                                                                           |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /health`     | 无                                                                | `{"ok": true, "version": "1.0.0", "lastHeartbeat": 0, "mailConfigured": true}` |
| `POST /send`      | `{"subject": "...", "text": "...", "html": "..."}`（`html` 可选）    | `{"ok": true}`                                                                 |
| `POST /heartbeat` | `{"source": "extension", "loggedIn": true, "pending": 3}`（字段均可选） | `{"ok": true, "lastHeartbeat": 1791446340000}`                                 |

> `auth_method=oauth2` 时，`/health` 会额外返回 `oauthAuthorized`（布尔值），表示本地是否存在可用令牌；password 模式的响应保持不变。

错误响应：

- 未配置邮件：HTTP `200` + `{"ok": false, "error": "mail_not_configured"}`
- SMTP 失败：HTTP `200` + `{"ok": false, "error": "..."}`，例如 `smtp_auth_failed`、`smtp_timeout`、`network_error: ...`
- OAuth2 失败：`oauth_login_required`（需要重新运行 `--oauth-login`）、`oauth_refresh_failed`、`oauth_network_error`、`oauth_token_file_error`
- 请求体不是合法 JSON：HTTP `400` + `{"ok": false, "error": "invalid_json"}`
- 缺少 `subject`、`text`/`html` 都为空、类型不对：HTTP `400` + `{"ok": false, "error": "invalid_request"}`
- 路径不存在：HTTP `404`；方法不对：HTTP `405`

> 代理不会在响应中返回 SMTP 账号、授权码、邮件正文或服务器原始凭据。

---

## 7. 心跳与「监控可能未运行」提醒

- 扩展每次扫描结束后会 `POST /heartbeat`。
- 代理后台线程每 **60 秒**检查一次：
  - 距离最后一次心跳超过 `heartbeat_timeout_minutes`（默认 180 分钟），且 SMTP 已配置；
  - 距离上次同类提醒至少 **6 小时**；
  - 满足条件就发一封「【学习通截止提醒】邮件代理：插件监控可能未运行」。
- 代理刚启动后的第一个 `heartbeat_timeout_minutes` 是宽限期（以启动时间计算），不会刚启动就误报。
- 发送失败也会记入 6 小时间隔，避免每 60 秒重试造成邮件风暴；失败原因写 `proxy.log`。
- 恢复心跳后，超时提醒自动停止。

如果经常收到「监控可能未运行」：

1. 确认 Edge 正在运行、扩展已启用；
2. 确认扩展设置里的代理地址是 `http://127.0.0.1:8765`（端口要与启动参数一致）；
3. 检查 Edge 的扩展后台是否被浏览器休眠（可在 `edge://extensions` 中确认）；
4. 电脑休眠/关机时间超过阈值也会触发，属正常。

---

## 8. 日志

- 位置：`mail-proxy/proxy.log`（与脚本同目录），控制台同时输出。
- 内容：启动/停止、配置文件状态、邮件**主题**与发送结果、心跳超时提醒结果、HTTP 异常。
- **不记录**：邮件正文、SMTP 授权码、`config.json` 内容。
- 单个文件超过 **5 MB** 时轮转一次：旧文件改名为 `proxy.log.1`（只保留一份），新日志继续写 `proxy.log`。
- 排查问题时先看 `proxy.log` 的最后几十行。

---

## 9. 设置开机自启

> 建议用「任务计划程序」；「启动文件夹」最简单。两种都只影响当前 Windows 用户。

### 方式 A：启动文件夹（最简单）

1. 按 `Win + R`，输入 `shell:startup`，回车。
2. 在打开的「启动」文件夹里右键 → **新建 → 快捷方式**。
3. 浏览到 `D:\...\chaoxing-due-watcher\mail-proxy\start.bat`，完成。
4. 右键快捷方式 → 属性 → 把「起始位置」留空即可（`start.bat` 内部会自己 `cd`）。
5. 重启电脑，登录后应自动弹出代理窗口并输出启动日志。

### 方式 B：任务计划程序（推荐，可无窗口）

1. 开始菜单搜索「任务计划程序」→ 打开。
2. 右侧「创建任务」（不是「创建基本任务」）。
3. **常规**：
   - 名称：`学习通邮件代理`
   - 选择「只在用户登录时运行」（简单，不需要保存密码）；
   - 勾选「使用最高权限运行」通常**不需要**。
4. **触发器**：新建 → 「登录时」→ 确定。
5. **操作**：新建 → 「启动程序」：
   - 程序或脚本：`C:\Users\你的用户名\AppData\Local\Programs\Python\Python312\pythonw.exe`  
     （或直接 `python.exe`；`pythonw.exe` 不显示黑窗口）
   - 添加参数：`mail_proxy.py`
   - 起始于：`D:\...\chaoxing-due-watcher\mail-proxy`
6. **条件**：可以取消「只有在计算机使用交流电源时才启动此任务」等限制。
7. **设置**：勾选「如果任务失败，按以下频率重新启动」，例如 1 分钟。
8. 保存后右键任务 →「运行」，然后在浏览器访问 `/health` 验证。

> 用 `pythonw.exe` 时没有控制台，出问题只能看 `proxy.log`。  
> 如果 Python 是 Microsoft Store 版，`pythonw.exe` 路径可能不同；建议到 python.org 安装。

### 方式 C：不建议的做法

- 用 `nssm` 注册成 Windows 服务：需要额外软件，且服务运行在 Session 0，排查麻烦，不建议普通用户使用。
- 把 `start.bat` 放进「启动」文件夹但电脑设置了自动登录：可以工作，但会弹窗口；介意的话用方式 B。

---

## 10. 常见错误与排查

### 10.1 `smtp_auth_failed`（认证失败）

日志/响应里出现 `smtp_auth_failed`，或邮箱收到「登录失败」提示：

- **用了登录密码而不是授权码**：QQ/163 必须用授权码/客户端授权密码；
- 授权码已过期或被重置：回邮箱设置重新生成；
- `smtp_user` 不是完整邮箱地址；
- QQ 邮箱未开启 POP3/SMTP 服务；
- 163 未开启 SMTP 服务或未设置客户端授权密码；
- 企业邮箱可能需要单独申请 SMTP 权限，或使用专用客户端密码。

### 10.2 连接超时 / `network_error` / `smtp_timeout`

- `smtp_host` 拼错，或 `smtp_port` 与服务器不匹配；
- 本机防火墙/杀毒软件拦截 Python 出站连接；
- 公司/学校网络封了 465 或 25 端口：换 587（`use_ssl=false`）或换网络；
- DNS 解析失败：检查网络，尝试 `ping smtp.qq.com`；
- 代理软件（Clash 等）开了「全局/TUN」导致 SMTP 被劫持：把 Python 或 465/587 加入直连。

### 10.3 端口被封

- 很多运营商封 **25 端口**（垃圾邮件防护）。不要用 25，改用 **465 SSL** 或 **587 STARTTLS**。
- 公司网络常封 **465**，可试 **587**。
- 如果所有端口都不通，用手机热点测试，确认是网络问题。

### 10.4 SSL 与 STARTTLS 的区别

| 模式          | 端口  | `use_ssl` | 代码路径                          | 特点                  |
| ----------- | --- | --------- | ----------------------------- | ------------------- |
| 隐式 SSL      | 465 | `true`    | `smtplib.SMTP_SSL`            | 连接建立即 TLS           |
| 显式 STARTTLS | 587 | `false`   | `smtplib.SMTP` + `starttls()` | 先明文连接，再升级 TLS       |
| 明文/STARTTLS | 25  | `false`   | `smtplib.SMTP` + `starttls()` | 常被运营商封；服务器不支持时按明文继续 |

常见错误搭配：

- **465 + `use_ssl=false`**：客户端把 TLS 握手包当 SMTP 命令，服务器回乱码，最终 `SMTPServerDisconnected` / `smtp_disconnected` / SSL 错误。
- **587 + `use_ssl=true`**：直接对明文端口做 TLS 握手，超时或 `ssl.SSLError`。
- 端口和 `use_ssl` 必须匹配；不确定时优先 **465 + `true`**。

### 10.5 `mail_not_configured`

`/send` 返回这个错误，或 `/health` 的 `mailConfigured` 为 `false`：

- `config.json` 不存在：复制 `config.example.json` 并填写；
- `smtp_host`、`smtp_port`、`mail_from`、`mail_to` 缺失或为空；
- `smtp_user` 填了但 `smtp_pass` 为空（或反过来）；
- `mail_from` / `mail_to` 不是合法邮箱格式；
- `config.json` 不是合法 JSON（多了逗号、注释、中文引号）；
- 修改配置后不需要重启：代理按文件修改时间自动重新加载，刷新 `/health` 即可。

### 10.6 端口被占用（`WinError 10048`）

启动失败，提示无法监听 `127.0.0.1:8765`：

- 已经有一个代理在运行（任务管理器结束旧的 `python.exe`）；
- 其他程序占用了 8765：换端口：
  ```bat
  python mail_proxy.py --port 8799
  ```
  同时把扩展设置里的代理地址改成 `http://127.0.0.1:8799`。

### 10.7 `smtp_sender_refused` / `smtp_recipients_refused`

- QQ/163 要求 `mail_from` 与登录账号一致；
- `mail_to` 地址拼错，或收件服务器拒收；


- 收件人邮箱满了、不存在，或被反垃圾策略拒绝。

### 10.8 收到了测试邮件，但正式提醒没收到

- 扩展里没开「邮件通知」（`emailEnabled`）；
- 扩展扫描失败/未登录，没有触发 `/send`（看 popup 状态和 `proxy.log`）；
- 收件箱把邮件判为垃圾邮件：检查垃圾箱，把发件人加入白名单；
- 提醒阈值未命中（只在临近截止的阈值触发）。

### 10.9 中文乱码

- 代理用 UTF-8 组装邮件（主题 RFC 2047 编码、正文 UTF-8），主流客户端正常；
- 若乱码，检查邮件客户端编码设置，或把正文改为纯文本测试；
- 不要用记事本把 `config.json` 存成 ANSI 以外的异常编码；保持 UTF-8。

### 10.10 无法写入 `proxy.log`

- 目录只读或被安全软件锁定：把整个 `mail-proxy` 放到用户目录下，或给当前用户写权限；
- 日志写不进去时代理仍会运行（仅控制台输出），但排查会困难。

### 10.11 OAuth2 相关错误

- `oauth_login_required`：本地没有 refresh token，或 refresh token 已失效/被撤销。运行
  `python mail_proxy.py --oauth-login` 重新授权；
- `oauth_refresh_failed`：令牌端点返回了其他错误（如 `invalid_client`）。检查
  `oauth_client_id` 是否正确、应用是否启用了「公共客户端流」、是否添加了 `SMTP.Send` 权限；
- `oauth_network_error`：无法连接 `login.microsoftonline.com`。检查网络、代理/Clash 规则，
  确认 `login.microsoftonline.com` 走直连或可用代理；
- `oauth_token_file_error`：`oauth_token.json` 无法读写或 JSON 损坏。检查文件权限；必要时
  删除后重新 `--oauth-login`；
- `AADSTS` 错误通常出现在浏览器授权页：`AADSTS700016`（client ID 不存在/租户不匹配）、
  `AADSTS65001`（未同意权限，需要管理员同意 `SMTP.Send`）、`AADSTS50020`（账号不在该租户）。
- 个人 Outlook.com 账号如果无法注册应用：需要先有一个 Entra 租户，或改用 QQ/163 发件、
  收件仍填 Outlook。

---

## 11. 安全与合规

- **仅本机使用**：代码固定绑定 `127.0.0.1`，不要改绑 `0.0.0.0`，也不要做端口转发/内网穿透。
- **只发提醒邮件**：不包含自动答题、自动提交、自动登录、自动打开作业等功能。
- **不保存密码**：扩展不存学习通密码；本代理只保存你填的 SMTP 授权码，用于发信。
- **凭据不落日志、不出接口**：`proxy.log` 只记主题与结果；HTTP 响应不返回账号/授权码。
- **OAuth2 令牌**：`oauth_token.json` 含 refresh token，权限等同长期发信权限；不要外传、不要提交到 Git，可用 `--oauth-logout` 删除本地令牌。
- **本机调用无鉴权**：任何本机程序都能访问 `127.0.0.1:8765`。这是为简化扩展对接的设计；如果介意，可改端口并只告诉扩展，或在本机防火墙中限制。
- **不要部署到公网服务器**：它不是给多人使用的邮件网关。
- 如果授权码泄露：立刻在邮箱设置中重置授权码，更新 `config.json`，并检查 `proxy.log` 是否有异常发送记录。

---

## 12. 运行测试

在 `mail-proxy` 目录下：

```bat
python -m py_compile mail_proxy.py
python -m unittest discover -s tests -v
```

测试覆盖：

- `/health` 字段、CORS 头、`OPTIONS` 204；
- `/send` 未配置时返回 `mail_not_configured`、参数校验、非法 JSON；
- `/heartbeat` 更新 `lastHeartbeat`；
- 用本地假 SMTP 服务器（`socketserver` 实现最小协议）验证真实 `smtplib` 发送成功，并解析邮件主题/正文；
- monkeypatch `smtplib.SMTP` 覆盖连接失败、认证失败（不泄露授权码）、超时、STARTTLS 降级、`SMTP_SSL` 分支；
- 心跳超时守护：超时触发、6 小时限流、启动宽限期、未配置不发、发送异常不崩溃；
- 配置解析（snake_case / camelCase、数组/字符串 `mail_to`、非法值回退）与错误脱敏；
- OAuth2 配置校验、access token 缓存、refresh token 刷新、`invalid_grant` 需重新登录、设备代码登录保存令牌、XOAUTH2 发送分支。

测试**不访问外网、不需要真实邮箱**。测试会在项目内创建 `.test-tmp` 临时目录并自动清理；如果被安全软件锁定，可手动删除。

---

## 13. 停止与卸载

1. 在运行窗口按 `Ctrl+C`，或在任务管理器结束对应的 `python.exe` / `pythonw.exe`。
2. 删除第 9 节添加的开机自启项（快捷方式或计划任务）。
3. 如需彻底删除：删除整个 `mail-proxy` 目录；`config.json` 里有授权码，删除前请确认不再需要。
4. 扩展设置里把「邮件代理地址」清空或关闭「邮件通知」。

---

## 14. 版本

当前版本 `1.0.0`，HTTP 协议与 `docs/design.md` 一致。
