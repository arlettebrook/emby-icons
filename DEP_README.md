# Emby Icons

基于 Cloudflare Pages、Pages Functions 与 KV 的 Emby 图标配置管理面板。公开地址返回标准 `emby-icons.json`，管理页面支持结构化编辑、原始 JSON 编辑、图片预览、排序和校验。

## 本地开发

需要 Node.js 20 或更高版本。

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run dev
```

将 `.dev.vars` 中的 `ADMIN_TOKEN` 换成一个足够长的随机字符串。本地页面通常位于 `http://localhost:8788`，本地 KV 数据保存在 `.wrangler/state`。

## 通过 GitHub 部署到 Cloudflare Pages

### 1. `fork`本仓库

- 请 fork `master`分支。




### 2. 连接 GitHub 仓库

1. 登录 Cloudflare Dashboard。
2. 打开 **Workers & Pages**，选择 **Create application > Pages > Connect to Git**。
3. 授权 GitHub，并选择 `arlettebrook/emby-icons`。
4. Production branch 选择 `master`。
5. 使用以下构建配置：

| 配置项 | 值 |
| --- | --- |
| Framework preset | `None` |
| Build command | `npm run build` |
| Build output directory | `public` |
| Root directory | 留空 |

点击 **Save and Deploy**。仓库根目录的 `functions/` 会由 Cloudflare 自动识别为 Pages Functions，以后每次推送到 `master` 都会自动部署。

仓库不包含 `wrangler.toml` 或 `wrangler.jsonc`。这是有意设计：KV 和 Secret 由 Cloudflare Dashboard 管理，避免出现“此项目的绑定通过 Wrangler 配置管理”而无法在控制台添加绑定。

### 3. 创建并绑定 KV

首次部署完成后，在 Cloudflare Dashboard 创建一个 KV namespace，例如 `emby-icons-data`。

进入 **Workers & Pages > 你的 Pages 项目 > Settings > Bindings**：

1. 添加 **KV namespace binding**。
2. Variable name 必须填写 `EMBY_ICONS`。
3. KV namespace 选择刚创建的 `emby-icons-data`。
4. Production 和 Preview 环境都需要绑定。

### 4. 设置管理员令牌

进入 Pages 项目的 **Settings > Variables and Secrets**，添加：

- 类型：Secret
- Variable name：`ADMIN_TOKEN`
- Value：一个足够长且随机的管理员密码

同样建议为 Production 和 Preview 分别设置。变量名区分大小写，必须是 `ADMIN_TOKEN`。值只填写令牌本身，不要包含引号或 `ADMIN_TOKEN=` 前缀。

保存 KV Binding 和 Secret 后，在 **Deployments** 页面打开最新部署并点击 **Retry deployment**。已有部署不会自动获得刚修改的绑定。浏览器中重新打开管理页面；若之前输入过错误令牌，刷新后再次保存并输入新令牌即可。

管理员令牌只保存在 Cloudflare Secret 和浏览器当前会话的 `sessionStorage` 中，不会写入仓库。

## 地址

- 管理员面板：`https://<你的域名>/admin.html`
- 正式库编辑器：`https://<你的域名>/admin.html`
- 普通用户提交：`https://<你的域名>/submit.html`
- 提交状态：`https://<你的域名>/submission.html?id=<提交编号>`
- 公开配置：`https://<你的域名>/emby-icons.json`
- 管理 API：`GET/PUT https://<你的域名>/api/icons`
- 管理员远程导入：`POST https://<你的域名>/api/import`
- 已保存远程地址：`GET/POST https://<你的域名>/api/admin/remote-json-urls`
- 单条远程地址：`GET/PUT/DELETE https://<你的域名>/api/admin/remote-json-urls/<id>`

管理面板和公开配置接口只读取 `EMBY_ICONS` KV。KV 为空时，管理面板会提示导入 JSON；公开配置接口返回 404，不会回退到仓库文件。

注意：在线管理面板保存的是 Cloudflare KV，不会反向修改 GitHub 仓库中的根目录 `emby-icons.json`。

## 测试

```powershell
npm test
```

## 普通用户提交图标

普通用户通过 `/submit.html` 提交图标名称和 HTTPS URL。提交内容只会写入 D1 的待审核队列，不会直接修改 `EMBY_ICONS`；管理员登录 `/admin.html` 后，在同一页面的审核区域审核，审核通过后系统才会把图标追加到正式 KV 文档。

需要在 Cloudflare Pages 中配置以下绑定和变量：

- D1 database binding：变量名必须是 `DB`。绑定创建后无需手工执行 SQL；部署后的首次请求会自动创建或升级表结构，并在 `schema_migrations` 中记录已执行的迁移。若自动迁移失败，`/api/*` 会返回 `503`，静态页面仍可访问；修复数据库权限或容量后重试即可。
- KV binding：变量名仍是 `EMBY_ICONS`。
- Secret `ADMIN_TOKEN`：只给管理员使用，不能发给普通用户。
- Secret `ADMIN_SESSION_SECRET`：用于签发管理员网页登录会话，建议使用独立随机值。
- Secret `SUBMISSION_HASH_SECRET`：**必需**，用于哈希提交访问令牌和 IP；必须是独立随机值，不能与其他 Secret（尤其是 `ADMIN_TOKEN`）复用。缺失时提交与查询接口会返回 `503`，不会回退到其他密钥。
- `SUBMISSION_DAILY_LIMIT`：同一 IP 每 24 小时的提交上限，默认 `20`，可按实际使用量调整，最大 `100`。首次提交和被拒绝/已撤回后的重新提交都会消耗额度；待审核记录的普通修改、撤回和删除不会退还额度。额度记录保存在 `submission_attempts` 表，删除提交也不会恢复额度。
- `TURNSTILE_SECRET_KEY`：生产环境**必须**配置；未配置时生产环境的提交、修改和重新提交会直接拒绝（fail-closed）。本地非生产环境可不配置，也可用 `REQUIRE_TURNSTILE=true` 强制校验。

Turnstile 的 Site Key 不是秘密值，配置 `TURNSTILE_SECRET_KEY` 后，将 Site Key 填入 `public/submit.html` 与 `public/submission.html` 中的 `window.SUBMISSION_SITE_KEY`（两处使用同一个 Site Key）。首次提交、待审核记录的修改、被拒绝/已撤回后的「重新提交审核」都会校验 Turnstile；撤回和删除只用访问令牌。生产环境（`ENVIRONMENT=production`，或 `CF_PAGES_BRANCH` 为 `main`/`master`）缺少 `TURNSTILE_SECRET_KEY` 时会直接返回错误，不会放行。普通用户提交成功后会得到一次性访问令牌，令牌只保存在当前浏览器，服务端只保存哈希值。

本地开发可以使用本地 D1：

```powershell
npm run dev
```

首次访问任意页面或 API 时，运行时会自动建表。`npm run predev` 会先重新生成迁移模块，因此新增 `migrations/*.sql` 后直接启动开发服务器即可，不需要手工执行 SQL。

远程 D1 也不需要手工迁移：部署新版本后，第一次访问会按文件名顺序执行 `migrations/*.sql` 中尚未应用的迁移。迁移前请确保 `DB` 绑定已存在，否则运行时无法访问数据库。

如需手工补跑或排查自动迁移失败，可以按当前数据库名称执行：

```powershell
npx wrangler d1 execute <你的数据库名称> --remote --file=migrations/0001_submissions.sql
npx wrangler d1 execute <你的数据库名称> --remote --file=migrations/0002_submission_attempts.sql
```

当前迁移内容：`0001` 创建提交与审计相关表，`0002` 创建独立的 `submission_attempts` 额度表。自动迁移以 `migrations/*.sql` 为唯一来源，构建时由 `scripts/build.js` 生成并打包进 Functions；已执行的迁移不会重复运行。

审核通过前，普通用户不能修改正式图标库；管理员整份 JSON 保存接口仍然只接受 `ADMIN_TOKEN`。系统会在管理员保存或审核发布前，将旧版本写入 D1 的 `document_versions` 表，并在 `audit_logs` 中记录操作。

### 图标名称唯一（ICON_NAME_CONFLICT）

图标名称在所有写入入口都强制唯一（`functions/_shared/icons.js` 的 `normalizeIconName` 统一规范化：NFKC 全角半角折叠、连续/首尾空白压缩、大小写折叠）。管理员整份 JSON 保存、导入去重与提交审核共用同一套判定。

审核通过时如果与已发布图标同名，接口返回结构化 `409`：

```json
{ "error": "…", "code": "ICON_NAME_CONFLICT", "conflict": { "index": 0, "name": "OkEmby", "url": "…" }, "suggestions": ["OkEmby01", "OkEmby02"] }
```

审核界面会预检冲突并提供三种处理方式：**改名后通过**（`approve-rename`，默认填入 `suggestions[0]`，如 `OkEmby01`）、**替换现有**（`replace`，覆盖同名条目的名称与图片地址，并清理其余同名重复项）、**拒绝**（`reject`）。

为修复审核失败后 KV/D1 不一致：当图标已写入 KV 但 D1 状态更新失败时，提交**不会**回退为 `pending`（避免重复发布的死循环），而是返回 `PUBLISH_RECOVERY_REQUIRED` 并保留 `approving` 状态；重试时会命中幂等分支直接补写 D1。

### Telegram Bot 审核交互

Bot 只支持私聊，不支持群组或频道。配置的 Chat ID 必须是管理员本人与 Bot 私聊的正整数用户 ID（例如 `123456789`）；负数群组/频道 ID 会被拒绝，旧配置中的非私聊 ID 会被忽略。群组和频道中的消息与按钮回调都会被直接忽略。

管理页面使用单一的 **停止 Bot 服务** 开关统一控制提交通知、审核通知、用户命令、按钮交互和 Mini App 入口。停止前会二次确认；停止后会注销 Webhook、清空待处理更新、删除命令菜单并重置菜单按钮，但保留 Token、Chat ID 和审核配置，取消停止并保存即可恢复。若 Webhook 注销或菜单清理失败，服务端仍会拒绝处理更新；合法 Telegram 重试会收到 `204` 静默确认，避免持续重试，管理员可再次保存停止状态重试清理。

在管理页面启动 Telegram Bot 服务后，Bot 会发送带操作按钮的审核卡片（优先用 `sendPhoto` 发送缩略图卡片，失败时回退为纯文本卡片）：

- **通过并发布**：无名称冲突时，点击「✅ 通过并发布」会先进入二次确认，需再点击「🛡️ 确认通过并发布」才真正发布，避免误触；有冲突时改为提供建议名、手动改名和替换入口。
- **编辑并发布**：点击「✏️ 编辑并发布」后，Bot 会提示按格式回复修改后的内容（第一行名称、第二行图片 URL、其余为说明），校验名称唯一性与 HTTPS URL 后直接发布，无需先改名再发布。
- **改名并通过**：直接回复新的图标名称即可（无需引用消息），Bot 会用新名称发布；名称不合法或仍有冲突时在卡片内提示重试。
- **拒绝**：先打开原因菜单，可选择图片模糊、图标重复、图片无法访问，也可直接回复自定义原因（无需引用消息），提示与编号直接显示在卡片上，不再单独发送一条输入提示。点击“不填原因，确认拒绝”，或发送 /reject、/skip，可不填原因拒绝；/reject 原因 可直接指定原因。
- **替换现有**：先显示将被替换的同名条目及现有 URL，必须再次确认。确认前若同名条目已经变化，会重新要求核对。
- **下一条待审核**：任一审核结束后，卡片按钮会切换为「➡️ 下一条待审核」，点击即可直接拉取下一条待审核卡片；也可随时发送 `/queue` 查看完整待审核列表并跳转。
- **取消和超时**：输入及替换确认 10 分钟内有效。点击卡片的取消按钮，或发送 /cancel，可返回当前真实审核状态；超时后的下一次交互会恢复卡片。输入提示直接折叠在审核卡片内，操作结束后随卡片在原位置刷新或恢复，不会残留额外的提示消息。
- **/start 与 /help**：Bot 服务运行时，任何用户（包括管理员）在私聊中发送 `/start` 或 `/help` 都会收到频道公告 [MikuNaNChannel/8](https://t.me/MikuNaNChannel/8) 的转发；Bot 需要先被添加为 `@MikuNaNChannel` 的管理员，且频道不能开启「限制保存内容」，否则 Telegram 会拒绝转发。转发被禁止时会自动改为复制，复制也不可用时发送公告链接。普通用户只会看到干净链接；只有配置的管理员会话会附加一段简短的失败原因，便于区分权限或内容保护问题，该诊断信息不会影响主流程。
- **提交图标入口**：公告转发、复制或链接兜底之后，Bot 会再发送一条「需要提交图标？」的轻提示，并附带「🖼 提交图标」URL 按钮，指向 `https://t.me/emby_icons_bot/submit?startapp=channel8`。Mini App 会读取 `start_param`（兼容 `tgWebAppStartParam`）并在页面显示频道公告来源提示。启用 Telegram 时，Bot 菜单按钮也会配置为「提交图标」，指向 `https://t.me/emby_icons_bot/submit?startapp=menu`。这要求 BotFather 中已将短名 `submit` 配置为 Mini App；菜单设置失败不会阻止 Bot 服务设置保存。

- **Bot 命令菜单**：Bot 服务运行时，Bot 会注册命令菜单。普通用户默认只看到 `/start`、`/help`、`/submit`；配置的审核会话通过独立 scope 额外看到 `/queue`、`/cancel`、`/reject`、`/skip`。`/submit` 只在私聊中响应，并发送 `web_app` 按钮，点击即打开提交 Mini App（`startapp=command`）。命令菜单与「提交图标」Mini App 菜单按钮是两个独立入口；命令注册失败不会阻止 Bot 服务设置保存，管理员会看到提示并写入审计日志。

审核卡片使用 HTML `parse_mode`（名称、状态加粗，用户内容自动转义），并按消息长度自动截断，保证不超过 Telegram 的文本上限。每次按钮回调会先把 toast 文案细分（如「正在准备发布…」「正在改名并发布…」「请回复拒绝原因…」「已取消操作」「正在打开下一条待审核…」），再执行数据库操作，避免所有按钮都提示同一句话。发送 `/queue` 可随时查看待审核列表并直接跳转，队列为空时会给出提示。

输入会话按 Chat ID 和审核人隔离。同一审核人切换输入操作时会结束旧操作；私聊直接发送文字即可、无需引用消息，旧卡片或旧提示的回复不会触发审核。快捷确认和取消按钮也只对发起该次操作的审核人有效。允许发起审核的范围由配置的私聊 Chat ID 决定。

处理结果在原卡片更新，已通过、已拒绝或已撤回的提交不会再次进入输入流程。卡片更新失败时会恢复审核入口；已完成审核但无法修改原消息时会另发结果通知。输入提示与审核卡片是同一条消息，操作结束后就地在卡片内清除。升级前已经进入旧版输入流程的审核，可发送 /cancel 恢复卡片后重新操作；不需要数据库迁移。

## 原始导入地址

- <https://raw.githubusercontent.com/arlettebrook/emby-icons/refs/heads/main/emby-icons.json>
- <https://s.nek.loc.cc/emby-icons>

管理面板支持 JSON 文件导入、远程 URL 导入、JSON 导出、复制 JSON 和粘贴导入。远程地址可保存到 `EMBY_ICONS` KV 的 `settings/remote-json-urls.json`，并通过管理员 API 完成新增、列表、单条读取、修改和删除；保存的地址可附带最多 100 个字符的备注，用于区分不同图标库。保存的地址会在再次打开导入窗口时显示，并可点击“获取”直接拉取远程 JSON，或选择后编辑地址与备注。新增和修改接口接收 `{"url":"https://example.com/icons.json","note":"示例图标库"}`；修改时不传 `note` 会保留原备注。地址接口仅允许管理员会话或 `ADMIN_TOKEN` 访问，最多保存 50 个地址，并拒绝重复、非法、带凭据或指向私网的 URL。所有导入只追加 `icons`，不会覆盖当前的 `name` 和 `description`；导入会按照 `name` 去重。导入写入 KV 前需要管理员令牌。公开配置复制按钮会复制 `/emby-icons.json` 当前内容。

