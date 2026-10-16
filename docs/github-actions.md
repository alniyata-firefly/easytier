# GitHub Actions 构建

源码仓库：<https://github.com/alniyata-firefly/easytier>。这是基于上游 [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier) 的适配版本，保留上游许可证与历史。当前版本为 **2.7.2**。

## 构建入口

打开仓库 **Actions → Build packages → Run workflow**，选择分支和构建项目。

| 项目 | 构建结果 | 签名要求 |
| --- | --- | --- |
| Web | 当前 React 控制台静态包 | 无 |
| Linux x86_64 / ARM64 | 静态 musl Core、CLI、内嵌 Web | 无 |
| Windows x64 GUI | 内嵌 Core 的安装包 | 默认没有 Authenticode 签名 |
| macOS Intel / Apple Silicon GUI | 应用和 DMG | 默认未使用 Developer ID；可选正式签名 |
| Android ARM64 | 内嵌 Core 的 APK，16 KiB 对齐检查 | 必须使用现有 Android 签名 |

普通 `main` 推送运行源码检查和构建。未配置 Android 签名 Secrets 时，该次普通推送会明确跳过 Android，其余包继续；手动选择 Android 或发布版本标签时缺少签名会直接报错。只改 Markdown 或文档截图不触发全平台重编。

每次构建的 **Artifacts → release-packages** 包含汇总产物、SHA256SUMS 和 build-manifest.json。各平台通过完整 Git 提交 ID 与文件摘要核验，禁止混入其他提交的安装包。下载 Artifacts 需要登录 GitHub；发布到 Releases 的包按仓库可见性访问。

推送与 Cargo 版本相同的 `v*` 标签（例如当前 `v2.7.2`）会构建完整平台集合，全部成功后创建 **Draft release**。检查产物后再发布草稿。编译成功代表自动化及包内容检查通过，不能替代实体手机、Windows 和 macOS 的 VPN 实机验收。工作流不登录生产服务器，不自动部署。

## Android 签名

仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加：

| Secret 名称 | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 原签名 keystore/p12 文件的单行 Base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 口令 |
| `ANDROID_KEY_ALIAS` | 原签名别名 |
| `ANDROID_KEY_PASSWORD` | 原私钥口令 |

使用私有文件或密码管理器传入值，不要把签名文件、口令或 `.properties` 提交进 Git。CI 在临时目录恢复签名，检查证书指纹后编译并清理临时材料。

保持应用 ID `com.kkrainbow.easytier.adapted`、原签名证书与兼容升级的 `versionCode`。当前 `versionCode` 为 `2007003`，后续升版需递增。Android ARM64 构建使用 SDK 36、AGP 8.10.1 兼容配置，并核验 ELF LOAD/RELRO 和 APK ZIP 的 16 KiB 对齐。

## 可选 macOS 正式签名

默认不要求 Apple 开发者账号。需要正式签名时，添加下列 Secrets，再手动运行时勾选 `macos-sign`：

- `APPLE_CERTIFICATE`：Developer ID Application p12 的 Base64。
- `APPLE_CERTIFICATE_PASSWORD`：p12 口令。
- `APPLE_SIGNING_IDENTITY`：Developer ID Application 身份。
- `APPLE_ID`、`APPLE_PASSWORD`（App 专用密码）、`APPLE_TEAM_ID`：公证所需账号资料。

## 工作流与缓存

`packages.yml` 协调 Web、Linux、GUI、Android 和最终汇总。原上游构建配置归档在 `.github/upstream-workflows/`，不再作为活动工作流执行。当前流程不调用上游 SignPath、Docker Hub、其他仓库发布或生产部署配置。

Rust 工具链固定为 1.95，前端使用 Node.js 22 与 pnpm 10.12.4；依赖按 Cargo.lock、pnpm-lock.yaml 锁定。缓存按操作系统、架构、锁文件和编译参数隔离。首次构建需要下载 SDK 和完整编译 Rust，后续复用缓存；缓存不会打包进发行文件。

默认发布只编译当前 React Web 和 React GUI，不编译、打包旧 Vue 配置生成器，也不需要为管理台生成 Rust/WASM。共享 TypeScript/Proto 模块直接从源码使用。旧 Vue 工具及组件保留为上游可选源码，未进入当前交付包。构建时检查实际模块图；出现 Vue/PrimeVue 运行时代码会失败，生成的审计报告不包含构建机绝对路径。

## 公开文件与验收边界

源码检查会拒绝新增的私钥、签名文件、运行数据库、部署私有目录和构建输出。上游原有的公开测试签名与开发环境样例，只按固定路径及内容 SHA256 白名单保留；发行 APK 必须使用 Secrets 中的现有私有签名，不能回落到公开测试签名。检查结果只输出路径与规则名，不输出命中的凭据内容。

第三方 Actions 固定到完整提交 SHA。构建任务的 GitHub Token 只有源码读取权限，只有版本标签的草稿发布任务拥有仓库写权限；PR 检查不接收签名 Secrets。签名 Secrets 只传给对应平台任务，不使用整体继承。缓存限于依赖与指定 Rust 编译目录，不缓存临时签名目录、数据库或生产配置。

前端打包额外拒绝私密目录、环境文件、密钥、调试记录和非网页文件。GUI/Android 核对真实原生二进制中的 React 资源字节；Linux 启动实际发行 Web，核对 HTTP 返回的所有前端文件与本次提交的独立构建输入。Linux 同时在仅有 loopback 的网络命名空间中测试成员离线和网络参数下发，测试产物只上传 `proof.json`，不上传原始日志、临时数据库或配置。浏览器检查使用模拟 Tauri bridge，不能代替真机 VPN 连接和 Android 生命周期验收。

编译失败时，在相应平台任务中查看首个报错。修复提交后重新运行工作流；不要手工把不同提交的旧产物拼成一版发行。
