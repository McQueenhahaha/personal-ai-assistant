# Gmail 接入教程（零成本 OAuth 路线）

目标：让本地 OpenClaw/脚本通过 `gog` 读取你的个人 Gmail，不使用密码，不用 Maton/付费代理。

本机已准备好：

- `gog.exe`: `D:\AI\gogcli\gog.exe`
- `gog` 配置目录已重定向到：`D:\AI\personal-ai-assistant\data\appdata\gogcli`
- OpenClaw 技能：`gog` ready，`gmail-oauth` ready
- 导出脚本：`D:\AI\personal-ai-assistant\scripts\export-gmail-mail.ps1`

参考：

- Google Gmail API Quickstart: https://developers.google.com/workspace/gmail/api/quickstart/python
- Google OAuth Audience / Testing / Production: https://support.google.com/cloud/answer/15549945
- gog Quickstart: https://gogcli.sh/quickstart.html
- gog command spec: https://gogcli.sh/spec.html

## 1. 创建 Google Cloud 项目

1. 打开：https://console.cloud.google.com/projectcreate
2. 新建项目，例如：`personal-ai-assistant-gmail`
3. 切到这个项目。

## 2. 启用 Gmail API

1. 打开 Google Cloud Console 左侧菜单。
2. 进入 `APIs & Services` -> `Library`。
3. 搜索 `Gmail API`。
4. 点 `Enable`。

Google 官方 quickstart 也明确要求先在 Google Cloud 项目中启用 Gmail API。

## 3. 配置 OAuth consent screen

1. 进入 `APIs & Services` -> `OAuth consent screen`，或新版界面里的 `Google Auth Platform`。
2. 如果提示 `Get Started`，点进去。
3. App name 可以填：`Personal AI Assistant`
4. User support email 选你的 Gmail。
5. Audience 选 `External`。
6. Contact email 填你的 Gmail。
7. Data Access / Scopes 阶段可以先不手动加一堆 scope，后面 `gog` 授权时会请求 Gmail scope。
8. 如果停留在 `Testing`，把你的 Gmail 加到 test users。

重要：

- Testing 模式下，Google 说明 refresh token 可能 7 天后过期。
- 想避免每 7 天重新授权，去 Audience 页面点 `Publish app` 变成 In production。
- 个人自用通常会看到未验证应用警告，这是你自己的 OAuth app；确认项目是你创建的再继续。

## 4. 创建 Desktop OAuth Client

1. 进入 `APIs & Services` -> `Credentials`，或新版 `Google Auth Platform` -> `Clients`。
2. 点 `Create credentials` / `Create Client`。
3. Application type 选 `Desktop app`。
4. 名字填：`Personal AI Assistant Desktop`
5. 创建后下载 JSON。
6. 建议把它临时放到本地私密目录：

```text
D:\AI\personal-ai-assistant\data\private\google-oauth-client.json
```

不要把这个 JSON 发给别人；导入 `gog` 后可以删除这份下载副本。

## 5. 把 OAuth Client 交给 gog

打开 PowerShell：

```powershell
cd "D:\AI\personal-ai-assistant"
. .\scripts\openclaw-env.ps1
gog auth credentials set "D:\AI\personal-ai-assistant\data\private\google-oauth-client.json"
```

检查：

```powershell
gog auth credentials list
gog auth status
```

## 6. 授权你的 Gmail

只读接入推荐：

```powershell
gog auth add your@gmail.com --services gmail --gmail-scope readonly
```

把 `your@gmail.com` 换成你的个人邮箱。

浏览器会打开 Google 授权页面：

1. 选择你的 Gmail。
2. 如果看到 unverified app，确认项目是你自己建的，然后点 Advanced / Go to app。
3. 允许 Gmail 读取权限。
4. 完成后 `gog` 会把 refresh token 存到 Windows Credential Manager。

验证：

```powershell
gog auth list --check
gog gmail search "newer_than:7d -category:promotions -category:social" --max 10 --plain --gmail-no-send --account your@gmail.com
```

## 7. 写入 `.env`

编辑：

```text
D:\AI\personal-ai-assistant\.env
```

设置：

```text
GOG_ACCOUNT=your@gmail.com
```

## 8. 导出个人 Gmail 快照

```powershell
cd "D:\AI\personal-ai-assistant"
.\scripts\export-gmail-mail.ps1 -MaxMessages 30
```

导出文件会进入：

```text
D:\AI\personal-ai-assistant\data\personal-mail-drop
```

之后 digest 会把个人邮件纳入总结。

## 9. 常见问题

### token 7 天过期

原因：OAuth app 还在 Testing。

解决：Google Cloud Console -> OAuth consent screen / Audience -> `Publish app`。

### RMIT 学校 Gmail/Workspace 授权失败

这套 Gmail 教程只用于你的个人 Gmail。学校 Outlook/RMIT 已经用本地 Outlook Desktop 导出，不走第三方 OAuth。

### 授权后脚本说找不到账号

检查：

```powershell
. .\scripts\openclaw-env.ps1
gog auth list
gog auth doctor --check
```

然后确认 `.env` 的 `GOG_ACCOUNT` 和 `gog auth list` 里显示的一致。

### 我只想读邮件，不想让它发邮件

使用：

```powershell
gog auth add your@gmail.com --services gmail --gmail-scope readonly
```

并且本项目调用 Gmail 搜索时带 `--gmail-no-send`。后续如果要让它草拟回复，也仍然会要求你确认，不会自动发送。
