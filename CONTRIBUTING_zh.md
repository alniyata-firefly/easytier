# 本 EasyTier 分支贡献指南

简体中文 | [English](CONTRIBUTING.md)

本指南适用于 [alniyata-firefly/easytier](https://github.com/alniyata-firefly/easytier)。本项目基于上游 [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier) 进行下游适配，使用 React 管理控制台及桌面、移动端界面。贡献时请保留上游来源、版权声明和 [GNU LGPL 第 3 版许可证](LICENSE)。向本仓库提交修改，不代表已经向上游提交。

## 开发环境

请与当前活动工作流使用的版本保持一致：

| 工具 | 版本 |
| --- | --- |
| Node.js | 22 |
| pnpm | 10.12.4 |
| Rust | 1.95 |
| Protocol Buffers 编译器（`protoc`） | 35.1 |
| Python | CI 使用 3.12 |

原生构建还需要 Tauri、Rust 对应平台的编译器和系统库。Android 打包使用 Java 21、Android SDK 36、Build Tools 35.0.0 和 NDK 26.0.10792818；当前发布工作流构建 ARM64。平台依赖及签名要求以[构建文档](docs/github-actions.md)和当前[工作流](.github/workflows)为准。

```bash
git clone https://github.com/alniyata-firefly/easytier.git
cd easytier
git switch -c fix/describe-the-change main

# 整个工作区统一使用 CI 中的 pnpm 版本。
export npm_config_manage_package_manager_versions=false
export npm_config_package_manager_strict=false
pnpm install --frozen-lockfile
pnpm --dir easytier-web/frontend-lib codegen:proto
```

执行前请先安装表中工具。根目录和 GUI 的包管理器声明已统一为 pnpm 10.12.4；上述环境变量与当前 CI 保持一致，避免外部环境设置引发自动切换。

## 源码结构

| 路径 | 用途 |
| --- | --- |
| `easytier/` | Rust 网络核心 |
| `easytier-web/src/` | Web API 和管理后端 |
| `easytier-web/frontend/` | React 管理控制台 |
| `easytier-gui/src/react/` | React 桌面、移动端界面 |
| `easytier-gui/src/native/` | 客户端会话、本地存储和原生桥接 |
| `tauri-plugin-vpnservice/` | Android VPN 服务及桥接 |
| `easytier-web/frontend-lib/src/` | 共享 TypeScript 和生成的协议类型 |
| `ci/`、`.github/workflows/` | 当前打包校验和自动化 |

默认 Web 和 GUI 使用 React。保留的上游 Vue 工具只是可选源码，不属于默认管理界面。修改 React 时不要通过递归构建整个工作区来准备环境。`.github/upstream-workflows/` 中的归档文件不是活动 CI。

## 按改动范围验证

在仓库根目录运行与改动有关的检查：

```bash
pnpm --dir easytier-web/frontend typecheck
pnpm --dir easytier-web/frontend test
pnpm --dir easytier-gui typecheck
pnpm --dir easytier-gui test:react
pnpm --dir easytier-gui test:native
python3 ci/test_artifacts.py
python3 ci/test_public_source.py
python3 ci/public_source.py
```

本地配置管理的隔离浏览器回归测试：

```bash
pnpm --dir easytier-gui exec playwright install --with-deps chromium
pnpm --dir easytier-gui exec node --test --test-concurrency=1 tests/local-config-offline-browser.test.mjs
```

该测试通过模拟 Tauri 桥接，在回环地址运行 React 界面，不会启动 VPN；它不能代替原生安装包、Android 生命周期及真实隧道测试。其他浏览器测试需要按其夹具、预览服务要求以及源码检查工作流运行。

Rust 改动应执行格式检查及相关包的测试，不必把完整发布构建当作单元测试。会修改路由、接口、防火墙或 TUN 的测试应放到可丢弃虚拟机或隔离网络命名空间中；不要为了 UI 测试修改宿主机的全局网络配置。测试夹具不得使用生产凭据或生产网络。

发布打包、产物验证和可选签名见 [GitHub Actions 构建](docs/github-actions.md)。签名文件及密码必须放在 Git 之外，由 CI 使用文档列出的 Secrets。普通 Pull Request 不应依赖私有签名凭据。

## 提交 Pull Request

请在[本分支的问题追踪页](https://github.com/alniyata-firefly/easytier/issues)反馈问题，并从 `main` 创建分支，向 `main` 提交 Pull Request。

- 说明具体问题、修改后的行为，保持改动集中。
- 提供相关检查结果，区分浏览器模拟、原生测试和真实网络验证。
- 修改会话、配置或协议时，说明兼容性、迁移，以及受影响平台的启动、停止和重连行为。
- 命令或行为变化时同步文档；除非改动明确包含删除选项，否则保留已有配置能力。
- 日志、截图、测试夹具和提交历史中应移除凭据、带令牌的 URL、私钥、设备标识和私有部署信息。公开源码检查不能代替人工审查。

疑似安全漏洞请按[安全策略](.github/SECURITY.zh-CN.md)处理，不要在公开 Issue 中发布利用细节。
