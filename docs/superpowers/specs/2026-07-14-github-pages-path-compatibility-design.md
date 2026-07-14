# GitHub Pages 子路径兼容设计

## 1. 目标

在保留公开仓库 `wxl1779766474/qingzhou-tools` 的前提下，让轻舟工具可从 GitHub Pages 项目地址 `https://wxl1779766474.github.io/qingzhou-tools/` 完整加载，并继续兼容现有 Sites 与本地开发环境。

成功标准：

- GitHub Pages 首页、样式和全部 JavaScript 模块均可正常加载。
- 六个工具、JSON 放大高亮和本地使用记录的行为不发生变化。
- 现有 Sites Worker 路由和本地开发入口继续可用。
- 构建与自动化测试全部通过。

## 2. 方案

采用用户确认的 A 方案：将浏览器入口中的站点内资源引用从域名根路径改为当前文档相对路径。

具体变更：

- `site/index.html` 中的样式、脚本和品牌首页链接改为 `./...`。
- `site/app.js` 中三个本地模块导入改为 `./...`。
- 不修改工具逻辑、界面结构、数据格式、LocalStorage 键名或历史记录内容。
- 不重命名仓库，不占用 `wxl1779766474.github.io` 账号主页仓库。

相对路径会基于当前页面目录解析：在 GitHub Pages 中解析到 `/qingzhou-tools/`，在 Sites 与本地根路径中仍解析到 `/`。

## 3. 构建与发布

- 保持现有 `scripts/build.mjs` 的 Worker 路由不变；入口文件中的相对引用在根路径部署时仍指向同一资源。
- GitHub Pages 使用公开仓库 `main` 分支的仓库根目录发布。
- 仓库根目录继续存放 `index.html`、CSS 和 JavaScript 文件，不引入框架、打包器或运行时依赖。
- 发布完成后以 GitHub Pages 返回的正式地址为准，不再依赖本地隧道。

## 4. 错误处理与兼容性

- 若 Pages 尚在构建，轮询部署状态，只有成功后才交付地址。
- 若 Pages 返回 404，先核对发布源是否为 `main`/根目录，再核对资源路径；不通过创建额外仓库规避。
- 若现有 Sites 构建回归，则回退相对路径变更并保留 GitHub 仓库，不影响用户数据。
- 所有用户输入与使用记录仍只保存在浏览器本地，不因托管平台改变而上传。

## 5. 验证

自动验证：

- 更新生产构建测试，使其接受并要求相对模块导入。
- 增加入口资源路径断言，防止重新引入 `/styles.css`、`/app.js` 或 `from "/..."`。
- 运行 `npm run build` 与 `npm test`。

发布验证：

- GitHub Pages 首页返回 200 且标题为“轻舟工具”。
- `styles.css`、`app.js`、`tools-core.js`、`history-core.js` 与 `qr.js` 均返回 200。
- 浏览器打开正式地址后确认页面不是拦截页，且 JSON 格式化与历史恢复入口可用。

## 6. 非目标

本次不调整 UI、不新增工具、不改变历史记录规则、不修改 Sites 访问策略，也不引入自定义域名。
