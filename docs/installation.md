# 安装与接入

本说明适用于 [alniyata-firefly/easytier](https://github.com/alniyata-firefly/easytier) 的适配版，当前源码版本为 2.7.2（预发布）。安装包、服务端与客户端须核对各自的源码提交和构建记录。

## 获取安装包

优先使用[本仓库 Releases](https://github.com/alniyata-firefly/easytier/releases)。没有正式发布的版本时，可登录 GitHub，在成功的 **Build packages** 工作流中下载 **release-packages**。这是 GitHub 的 artifact 外层 ZIP，解开后才是平台安装包。

2.7.2 系列均标记为预发布，仍可在 Releases 页面直接下载。下文的 Linux / Windows 自动下载脚本仅接受正式发布，安装预发布版本时请手动下载、校验并解压或运行对应安装包。

同一次构建提供 `build-manifest.json` 和 `SHA256SUMS`。在包含文件与清单的目录中校验；Linux / macOS 可使用：

```sh
sha256sum -c SHA256SUMS
# macOS 也可使用 shasum -a 256 -c SHA256SUMS
```

Windows 可用 `Get-FileHash -Algorithm SHA256 <安装包>`，与清单对应文件的值比较。不要混用不同构建的文件与清单。

## Linux

支持 x86_64 和 ARM64。包名类似 `easytier-linux-x86_64-2.7.2-<提交前8位>.tar.gz`，包含：

- `easytier-core`：VPN 节点，支持本地配置及管理令牌接入。
- `easytier-cli`：运行状态与实例管理。
- `easytier-web`：管理后端与内嵌 React Web 页面。
- `LICENSE`、`source.json`：许可、版本和源码提交。

校验下载文件后，解压到新目录，按需安装三个可执行文件。运行 Core 的 TUN 模式需要系统提供 `/dev/net/tun` 及对应网络管理权限。普通虚拟机缺少该设备时先检查宿主/容器配置，不通过更换令牌解决。

仓库提供基于正式 Release 的下载与解压入口，需要 Python 3，以及同目录的辅助脚本。仓库存在正式发布时，从完整仓库执行：

```sh
bash script/install.sh --version latest --directory ./easytier-installed
```

Alpine 未安装 Bash 时也可直接使用 `python3 script/release_downloader.py --version latest --directory ./easytier-installed`。

脚本只从本仓库下载、核对摘要并解压，不自动创建服务或修改系统网络；非空目标目录会被拒绝。未发布 Release 时使用前面的工作流产物方式，不会回退下载上游程序。

## Windows、macOS 与 Android

| 平台 | 安装方法 |
| --- | --- |
| Windows x64 | 选择同一构建的 NSIS `.exe` 或 `.msi`；安装包内嵌 Core |
| macOS Intel / Apple Silicon | 选择对应架构的 DMG；默认构建未使用 Developer ID 正式签名，正式签名由工作流单独配置 |
| Android ARM64 | 安装本仓库签名的 APK；覆盖升级必须保持应用 ID 与原签名 |

Windows 下载脚本支持：

```powershell
powershell -NoProfile -File script/install.ps1 -Version latest -Directory .\easytier-downloads -Format nsis
```

默认只下载并校验；添加 `-RunInstaller` 才运行安装器。`script/install.cmd` 调用同目录 PowerShell 脚本。当前没有 Windows ARM64 / 32 位独立 Core 的发行包。

Android 应用 ID 为 `com.kkrainbow.easytier.adapted`。上游 APK 和本 APK 可能具有不同应用 ID / 签名，不把二者视为可直接覆盖升级的同一应用。签名配置见[构建文档](github-actions.md#android-签名)。

## 启动管理服务

Linux 包中的 `easytier-web` 已内嵌 React 页面，不需要另起前端开发服务器。先在本机或通过 SSH 转发检查：

```sh
mkdir -p ./easytier-data
./easytier-web \
  --db ./easytier-data/et.db \
  --api-server-addr 127.0.0.1 \
  --api-server-port 11211 \
  --config-server-port 22020 \
  --advertised-config-server-url udp://vpn.example.com:22020
```

本机打开 `http://127.0.0.1:11211/`。远程部署可将 Web 与 API 统一反向代理到这个地址；在局域网直接访问时，按需更换 API 监听地址。省略 `--web-server-port` 时，内嵌页面与 API 共用端口，避免额外的前端/API跨域配置。更换自己的域名和端口，不把示例地址直接用于生产。

全新数据库带有初始账号 `admin/admin` 和 `user/user`；首次登录分别修改密码。已有数据库保留其原账号，不按文档重置。管理库包含账户、设备、令牌及网络配置，升级服务端前保存数据库副本；运行目录与数据库不提交进源码仓库。

| 入口 | 默认值与用途 |
| --- | --- |
| Web 与 REST API | TCP 11211；上例仅绑定 loopback，供浏览器或反向代理使用 |
| 配置连接 | UDP 22020；节点通过管理令牌连接，默认同时尝试 IPv4 / IPv6 监听 |
| 配置连接协议 | `--config-server-protocol` 可显式选择；客户端 URL 的协议须匹配 |
| 网内 VPN 数据 | 由实例的 `listeners` / 映射配置决定，不等同于 Web 或配置端口 |
| Core 管理 RPC | 按 Core 启动配置设置，CLI 应连接本机受控入口 |

只把实际使用的入口加入防火墙规则。配置端口使用 UDP 时，Web HTTP 反向代理不会转发它。设置固定 `--config-server-addr` 会限制该地址族；省略时采用默认双栈策略。更多监听与网关语义见[中央组网连接](central-network-connectivity.md)。

## 设备接入

在控制台创建**设备管理访问令牌**，然后在客户端的管理服务器配置中填写服务器与令牌，或执行：

```sh
sudo ./easytier-core --config-server 'udp://vpn.example.com:22020/YOUR_DEVICE_TOKEN'
```

设备在线后，由控制台将设备加入网络并设置成员配置，检查节点返回的应用状态。设备管理令牌与网络入网凭据用途不同；从某个网络移出成员，不等同于删除设备或删除其管理令牌。

有效管理令牌首次接入时会绑定设备标识。重装导致标识改变时，可在管理后台核对并审批设备身份变更请求；批准后绑定新的设备标识，并保留原成员配置与地址分配。管理认证和 VPN 连接分别显示，不能仅凭一个“已连接”状态判断两者都正常。

本地自管网络可通过 GUI 新建/导入 TOML，或使用 `easytier-core -c <配置文件>`。停止客户端和删除本地配置是不同操作。移动端不提供指定物理上联网卡的设置；Wi-Fi / 蜂窝切换由系统处理。

## 升级

先核对新包对应提交、摘要和平台，保留运行配置和数据库。解压到新目录后，停止目标服务、替换目标版本并重新启动。不要在运行时覆盖正在使用的可执行文件；Android 覆盖安装继续使用原签名。工作流只构建并收集产物，不会自动登录或部署到任何生产机器。

网络配置变更的应用状态在控制台查看。界面构建验证与真实设备 VPN 建链是不同验收项目；每次发布的验证记录说明具体覆盖范围。
