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

## Cloudflare Pages 部署

### 1. 创建 Pages 项目

在 Cloudflare Dashboard 中连接此 GitHub 仓库，并使用以下构建配置：

- 构建命令：留空
- 构建输出目录：`public`
- Root directory：留空

也可以通过 Wrangler 首次部署：

```powershell
npx wrangler login
npx wrangler pages project create emby-icons
npm run deploy
```

### 2. 创建并绑定 KV

```powershell
npx wrangler kv namespace create EMBY_ICONS
```

然后进入 Cloudflare Dashboard：

1. 打开 **Workers & Pages > emby-icons > Settings > Bindings**。
2. 添加 **KV namespace binding**。
3. 变量名填写 `EMBY_ICONS`，命名空间选择刚创建的 KV。
4. Production 和 Preview 环境都需要绑定。

### 3. 设置管理员令牌

```powershell
npx wrangler pages secret put ADMIN_TOKEN --project-name emby-icons
```

设置完成后重新部署。管理员令牌只保存在 Cloudflare Secret 和浏览器当前会话的 `sessionStorage` 中，不会写入仓库。

## 地址

- 管理面板：`https://<你的域名>/`
- 公开配置：`https://<你的域名>/emby-icons.json`
- 管理 API：`GET/PUT https://<你的域名>/api/icons`

KV 为空时，读取接口会返回仓库中的 `public/emby-icons.seed.json`。在管理面板首次保存后，后续读取会使用 KV 中的版本。

## 测试

```powershell
npm test
```

## 原始导入地址

- <https://raw.githubusercontent.com/arlettebrook/emby-icons/refs/heads/main/emby-icons.json>
- <https://s.nek.loc.cc/emby-icons>

新增图标也可以继续 Fork 仓库，修改根目录的 `emby-icons.json` 后提交 PR。
