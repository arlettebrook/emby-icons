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

### 1. 将代码推送到 GitHub

当前开发分支是 `master`。提交代码并推送到 GitHub：

```powershell
git add README.md .dev.vars.example .gitignore functions package.json package-lock.json public scripts test
git commit -m "Add Cloudflare Pages icon manager"
git push origin master
```

不要提交 `.dev.vars`，它只用于本地开发并已被 `.gitignore` 排除。

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

- 管理面板：`https://<你的域名>/`
- 公开配置：`https://<你的域名>/emby-icons.json`
- 管理 API：`GET/PUT https://<你的域名>/api/icons`

管理面板和公开配置接口只读取 `EMBY_ICONS` KV。KV 为空时，管理面板会提示导入 JSON；公开配置接口返回 404，不会回退到仓库文件。

注意：在线管理面板保存的是 Cloudflare KV，不会反向修改 GitHub 仓库中的根目录 `emby-icons.json`。

## 测试

```powershell
npm test
```

## 原始导入地址

- <https://raw.githubusercontent.com/arlettebrook/emby-icons/refs/heads/main/emby-icons.json>
- <https://s.nek.loc.cc/emby-icons>

管理面板支持 JSON 文件导入、JSON 导出、复制 JSON 和粘贴导入。导入写入 KV 前需要管理员令牌。
