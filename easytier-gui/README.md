# EasyTier React GUI

本目录提供本分支的 Windows、macOS 和 Android 客户端。界面采用 React、TypeScript 与 Tauri 2，Core 编译进原生应用，不依赖另行安装的 Core 进程。来源和许可见[仓库 README](../README.md#项目来源与下游改造)及 [LICENSE](../LICENSE)。

## 客户端模式

- **本地模式**：维护本地网络配置、导入/导出 TOML，启动或停止本地 Core。
- **管理服务器接入**：填写自己的配置服务器地址和设备管理令牌；中央网络配置按其来源和权限展示。
- **桌面服务/远程 RPC 模式**：连接对应 Core；连接不可用时不把本机配置当成远端配置展示。

本地自管配置可在 Core 停止时创建、编辑、导入和保存；保存配置不会自动启动客户端。中央下发的只读配置不能通过离线编辑覆盖。Android 的停止操作等待原生 VPN 服务退出；状态、配置连接与网内连通性分别核对。

多实例、节点参数和配置类型主要共享于 `../easytier-web/frontend-lib`。界面位于 `src/react/`，Tauri bridge 位于 `src/native/`，原生入口位于 `src-tauri/`，移动 VPN 生命周期由 `../tauri-plugin-vpnservice` 实现。

## 本地检查

使用 Node.js 22、pnpm 10.12.4，先在仓库根目录按锁文件安装：

```sh
pnpm install --frozen-lockfile
pnpm --dir easytier-web/frontend-lib codegen:proto
pnpm --dir easytier-gui typecheck
pnpm --dir easytier-gui test:react
pnpm --dir easytier-gui test:native
```

浏览器回归使用 Playwright Chromium 和模拟 Tauri bridge。它们验证界面、持久化与时序，不代表系统 TUN / VPN 真机测试。例如离线配置流程：

```sh
pnpm --dir easytier-gui exec node --test tests/local-config-offline-browser.test.mjs
```

## 打包

正式发行使用当前 [GitHub Actions](../docs/github-actions.md)，桌面由 `ci/gui/` 准备平台配置与验证原生包，Android 由 `ci/android/` 驱动签名、构建和产物验证。不要沿用上游的 `pnpm -r build`、WASM 全量构建或旧 SDK 命令作为本分支发布流程。

Android 工程已存在，不重新运行 `tauri android init` 覆盖本分支原生改动。APK 使用原有私有签名、固定应用 ID `com.kkrainbow.easytier.adapted` 和递增 `versionCode`；公开上游测试签名不能用于正式发布。桌面应用 ID 保持 `com.kkrainbow.easytier`，以当前工作流中的平台配置为准。

## 字体与界面

客户端和 Web 共用自行绘制的[三节点标识](../assets/brand/easytier.svg)、平面布局、弹窗编辑及简体中文/英文翻译。设计约定见 [DESIGN.md](../easytier-web/frontend/DESIGN.md)。HarmonyOS Sans SC 与 Inter 的原始许可和来源保留于 [字体许可](public/fonts/font-notices.html)及[来源清单](public/fonts/provenance.json)。

GUI 版本来自本目录 `package.json`，Core 版本来自原生查询。核验构建身份时同时检查安装包摘要、源码提交和 `build-manifest.json`。
