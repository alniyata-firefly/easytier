# EasyTier · 下游适配版

<p align="center"><img src="assets/brand/easytier.svg" width="80" height="80" alt="EasyTier"/></p>

下游项目状态：

[![Github release](https://img.shields.io/github/v/tag/alniyata-firefly/easytier)](https://github.com/alniyata-firefly/easytier/releases)
[![GitHub](https://img.shields.io/github/license/alniyata-firefly/easytier)](https://github.com/EasyTier/EasyTier/blob/main/LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/alniyata-firefly/easytier)](https://github.com/alniyata-firefly/easytier/commits/main)
[![GitHub issues](https://img.shields.io/github/issues/alniyata-firefly/easytier)](https://github.com/alniyata-firefly/easytier/issues)
[![GitHub Core Actions](https://github.com/alniyata-firefly/easytier/actions/workflows/build-linux.yml/badge.svg)](https://github.com/alniyata-firefly/easytier/actions/workflows/build-linux.yml)
[![GitHub GUI Actions](https://github.com/alniyata-firefly/easytier/actions/workflows/build-gui.yml/badge.svg)](https://github.com/alniyata-firefly/easytier/actions/workflows/build-gui.yml)
[![GitHub Test Actions](https://github.com/alniyata-firefly/easytier/actions/workflows/checks.yml/badge.svg)](https://github.com/alniyata-firefly/easytier/actions/workflows/checks.yml)

[简体中文](README.md) | [English](README_EN.md)

## 项目来源与下游改造

本仓库是独立维护的 **[EasyTier](https://github.com/EasyTier/EasyTier) 下游适配版本**。VPN 核心、通信协议、Tauri 客户端基础及上游文档来自 EasyTier 项目及其贡献者。本仓库记录的上游基线为 [`8b7f1f0196edb5b580829ed5f135050fb5853478`](https://github.com/EasyTier/EasyTier/commit/8b7f1f0196edb5b580829ed5f135050fb5853478)，提交日期为 2026 年 10 月 5 日，软件包版本为 `2.7.0`。本仓库的 `2.7.2` 为下游发布版本号，不代表 EasyTier 上游正式发布或认可。

本仓库新增和适配的主要内容：

- 中央网络管理、管理令牌接入、设备与网络成员管理，以及由节点确认结果的配置下发。
- React Web 控制台，以及基于 React 的 Windows、Android 界面，保留 EasyTier Core 与 Tauri 的集成。
- 多实例配置、服务器与节点资源观测、可选历史指标、IPv6 优先与 IPv4 回退，以及支持平台上的自动识别或手动选择上联网卡。
- Web 与客户端统一使用自行绘制的[蓝色三节点 SVG 标识](assets/brand/easytier.svg)。
- 网络统一配置压缩、KCP/QUIC、加密、直连协议和 DNS 后缀，向受管成员及服务端网关下发。网络明确值覆盖成员设置，省略的项沿用原值；实际变更可能重建网络实例并短暂重连。
- 补齐自定义 STUN、中转限速与策略、虚拟 IPv6、完整 SOCKS5 监听地址、端口白名单、实例名及 Linux 命名空间等管理配置接口，参见[配置与下发语义](docs/central-network-connectivity.md)。
- Android/iOS 隐藏不支持的上联网卡选择与绑定控件，导入和保存本地配置时清理这些选项；桌面端保留对应能力。

本下游适配版基于并修改 EasyTier 代码，继续遵循 **LGPL-3.0（GNU LGPL 第 3 版）**许可证。保留原始[许可证](LICENSE)、版权声明和贡献者说明；下游修改已在上文列明，对应源码在本仓库公开。内置 HarmonyOS Sans SC 和 Inter 分别遵循各自的[鸿蒙字体许可协议](easytier-web/frontend/public/fonts/LICENSE-HarmonyOS-Sans.txt)与 [SIL Open Font License 1.1](easytier-web/frontend/public/fonts/LICENSE-Inter-GoogleFonts.txt)；字体来源、未经修改的官方网页切片及许可记录见[字体来源清单](easytier-web/frontend/public/fonts/provenance.json)和[字体许可页面](easytier-web/frontend/public/fonts/font-notices.html)。

下文的详细功能说明、文档链接、安装脚本示例和贡献者信息保留自上游；其中安装脚本安装的是原始 EasyTier 发行版。本下游版本的安装包及对应源码请使用[本仓库 Releases](https://github.com/alniyata-firefly/easytier/releases)，构建与打包方式见 [GitHub Actions 构建说明](docs/github-actions.md)。

> ✨ 一个由 Rust 和 Tokio 驱动的简单、安全、去中心化的异地组网方案

## 界面预览

以下截图使用本下游版本的真实 React 界面和匿名示例数据。名称、地址、设备标识及指标均为演示内容；桌面客户端图片由浏览器预览界面并模拟 Core 数据，不代表真机联网测试。

| 控制台概览 | 网络成员管理 |
| --- | --- |
| ![控制台概览与示例资源指标](docs/images/console/overview.png) | ![使用匿名设备的网络成员管理](docs/images/console/network-members.png) |
| 网络传输设置 | 桌面客户端预览 |
| ![数据压缩、KCP、QUIC 与加密设置](docs/images/console/network-settings.png) | ![使用匿名示例网络的 React 桌面客户端](docs/images/console/desktop-client.png) |

[下载安装包](https://github.com/alniyata-firefly/easytier/releases) · [构建与打包说明](docs/github-actions.md)

📚 **[完整文档](https://easytier.cn)** | 🖥️ **[Web 控制台](https://easytier.cn/web)** | 📝 **[下载发布版本](https://github.com/alniyata-firefly/easytier/releases)** | 🧩 **[第三方工具](https://easytier.cn/guide/installation_gui.html#%E7%AC%AC%E4%B8%89%E6%96%B9%E5%9B%BE%E5%BD%A2%E7%95%8C%E9%9D%A2)**

## 特性

### 核心特性

- 🔒 **去中心化**：节点平等且独立，无需中心化服务
- 🚀 **易于使用**：支持通过网页、客户端和命令行多种操作方式
- 🌍 **跨平台**：支持 Win/MacOS/Linux/FreeBSD/Android 和 X86/ARM/MIPS 架构
- 🔐 **安全**：AES-GCM 或 WireGuard 加密，防止中间人攻击

### 高级功能

- 🔌 **高效 NAT 穿透**：支持 UDP 和 IPv6 穿透，可在 NAT4-NAT4 网络中工作
- 🌐 **子网代理**：节点可以共享子网供其他节点访问
- 🔄 **智能路由**：延迟优先和自动路由选择，提供最佳网络体验
- ⚡ **高性能**：整个链路零拷贝，支持 TCP/UDP/WSS/WG 协议

### 网络优化

- 📊 **UDP 丢包抗性**：KCP/QUIC 代理在高丢包环境下优化延迟和带宽
- 🔧 **Web 管理**：通过 Web 界面轻松配置和监控
- 🛠️ **零配置**：静态链接的可执行文件，简单部署

## 快速开始

### 📥 安装

选择最适合您需求的安装方式：

Linux（推荐）：
```bash
curl -fsSL "https://github.com/EasyTier/EasyTier/blob/main/script/install.sh?raw=true" | sudo bash -s install
```

Homebrew（MacOS/Linux）：
```bash
brew tap brewforge/chinese
brew install --cask easytier-gui
```

Windows（推荐，请以管理员权限运行）：
```powershell
irm "https://github.com/EasyTier/EasyTier/blob/main/script/install.ps1?raw=true" | iex
```

通过 cargo 安装（最新开发版本）：
```bash
cargo install --git https://github.com/EasyTier/EasyTier.git easytier
```

[下载预编译文件](https://github.com/alniyata-firefly/easytier/releases)（推荐，支持所有平台）

[通过 Docker 安装](https://easytier.cn/guide/installation.html#%E5%AE%89%E8%A3%85%E6%96%B9%E5%BC%8F)

[安装 OpenWrt ipk 软件包](https://github.com/EasyTier/luci-app-easytier)

附加步骤：

[一键注册系统服务](https://easytier.cn/guide/network/oneclick-install-as-service.html)（系统启动时自动后台运行）

### 🚀 基本用法

#### 使用共享节点快速组网

EasyTier 支持使用共享节点快速组网。当您没有公网 IP 时，可以使用公共共享节点。节点会自动尝试 NAT 穿透并建立 P2P 连接。当 P2P 失败时，数据将通过共享节点中继。

使用共享节点时，每个进入网络的节点需要提供相同的 `--network-name` 和 `--network-secret` 参数作为网络的唯一标识符。

以两个节点为例（请使用更复杂的网络名称以避免冲突）：

1. 在节点 A 上运行：

```bash
# 以管理员权限运行
sudo easytier-core -d --network-name abc --network-secret abc -p tcp://<共享节点IP>:11010
```

2. 在节点 B 上运行：

```bash
# 以管理员权限运行
sudo easytier-core -d --network-name abc --network-secret abc -p tcp://<共享节点IP>:11010
```

执行成功后，可以使用 `easytier-cli` 检查网络状态：

```text
| ipv4         | hostname       | cost  | lat_ms | loss_rate | rx_bytes | tx_bytes | tunnel_proto | nat_type | id         | version         |
| ------------ | -------------- | ----- | ------ | --------- | -------- | -------- | ------------ | -------- | ---------- | --------------- |
| 10.126.126.1 | abc-1          | Local | *      | *         | *        | *        | udp          | FullCone | 439804259  | 2.6.2-70e69a38~ |
| 10.126.126.2 | abc-2          | p2p   | 3.452  | 0         | 17.33 kB | 20.42 kB | udp          | FullCone | 390879727  | 2.6.2-70e69a38~ |
|              | PublicServer_a | p2p   | 27.796 | 0.000     | 50.01 kB | 67.46 kB | tcp          | Unknown  | 3771642457 | 2.6.2-70e69a38~ |
```

您可以测试节点之间的连通性：

```bash
# 测试连通性
ping 10.126.126.1
ping 10.126.126.2
```

注意：如果无法 ping 通，可能是防火墙阻止了入站流量。请关闭防火墙或添加允许规则。

为了提高可用性，您可以同时连接多个共享节点：

```bash
# 连接多个共享节点
sudo easytier-core -d --network-name abc --network-secret abc -p tcp://<公共节点IP>:11010 -p udp://<公共节点IP>:11010
```

#### 去中心化组网

EasyTier 本质上是去中心化的，没有服务器和客户端的区分。只要一个设备能与虚拟网络中的任何节点通信，它就可以加入虚拟网络。以下是如何设置去中心化网络：

1. 启动第一个节点（节点 A）：

```bash
# 启动第一个节点
sudo easytier-core -i 10.144.144.1
```

启动后，该节点将默认监听以下端口：
- TCP：11010
- UDP：11010
- WebSocket：11011
- WebSocket SSL：11012
- WireGuard：11013

2. 连接第二个节点（节点 B）：

```bash
# 使用第一个节点的公网 IP 连接
sudo easytier-core -i 10.144.144.2 -p udp://第一个节点的公网IP:11010
```

3. 验证连接：

```bash
# 测试连通性
ping 10.144.144.2

# 查看已连接的对等节点
easytier-cli peer

# 查看路由信息
easytier-cli route

# 查看本地节点信息
easytier-cli node
```

更多节点要加入网络，可以使用 `-p` 参数连接到网络中的任何现有节点：

```bash
# 使用任何现有节点的公网 IP 连接
sudo easytier-core -i 10.144.144.3 -p udp://任何现有节点的公网IP:11010
```

### 🔍 高级功能

#### 子网代理

假设网络拓扑如下，节点 B 想要与其他节点共享其可访问的子网 10.1.1.0/24：

```mermaid
flowchart LR

subgraph 节点 A 公网 IP 22.1.1.1
nodea[EasyTier<br/>10.144.144.1]
end

subgraph 节点 B
nodeb[EasyTier<br/>10.144.144.2]
end

id1[[10.1.1.0/24]]

nodea <--> nodeb <-.-> id1
```

要共享子网，在启动 EasyTier 时添加 `-n` 参数：

```bash
# 与其他节点共享子网 10.1.1.0/24
sudo easytier-core -i 10.144.144.2 -n 10.1.1.0/24
```

子网代理信息将自动同步到虚拟网络中的每个节点，每个节点将自动配置相应的路由。您可以验证子网代理设置：

1. 检查路由信息是否已同步（proxy_cidrs 列显示代理的子网）：

```bash
# 查看路由信息
easytier-cli route
```

![下游控制台节点路由表，使用匿名示例数据](docs/images/console/node-routes.png)

2. 测试是否可以访问代理子网中的节点：

```bash
# 测试到代理子网的连通性
ping 10.1.1.2
```

#### WireGuard 集成

EasyTier 可以作为 WireGuard 服务器，允许任何安装了 WireGuard 客户端的设备（包括 iOS 和 Android）访问 EasyTier 网络。以下是设置示例：

```mermaid
flowchart LR

ios[[iPhone<br/>已安装 WireGuard]]

subgraph 节点 A 公网 IP 22.1.1.1
nodea[EasyTier<br/>10.144.144.1]
end

subgraph 节点 B
nodeb[EasyTier<br/>10.144.144.2]
end

id1[[10.1.1.0/24]]

ios <-.-> nodea <--> nodeb <-.-> id1
```

1. 启动启用 WireGuard 门户的 EasyTier：

```bash
# 将一个 WireGuard 客户端注册为虚拟 peer 10.144.144.3
sudo easytier-core -i 10.144.144.1 \
  --network-secret portal-secret \
  --vpn-portal wg://0.0.0.0:11013 \
  --vpn-portal-private-key "$(wg genkey)" \
  --vpn-portal-client phone=10.144.144.3
```

2. 获取 WireGuard 客户端配置：

```bash
# 获取 WireGuard 客户端配置
easytier-cli vpn-portal
```

3. 如果输出配置中的 `Peer.Endpoint` 是通配地址，将其替换为 EasyTier
   节点的公网 IP/域名后即可导入。`Interface.Address` 只是客户端本地地址，
   可以改为任意 IPv4 地址；EasyTier 会把它转换成已注册的虚拟 peer 地址。

#### 自建公共共享节点

您可以运行自己的公共共享节点来帮助其他节点相互发现。公共共享节点只是一个普通的 EasyTier 网络（具有相同的网络名称和密钥），其他网络可以连接到它。

要运行公共共享节点：

```bash
# 公共共享节点无需指定 IPv4 地址
sudo easytier-core --network-name mysharednode --network-secret mysharednode
```

网络设置成功后，您可以轻松配置它以在系统启动时自动启动。请参阅 [一键注册服务指南](https://easytier.cn/en/guide/network/oneclick-install-as-service.html) 了解如何将 EasyTier 注册为系统服务。

## 相关项目

- [ZeroTier](https://www.zerotier.com/)：用于连接设备的全球虚拟网络。
- [TailScale](https://tailscale.com/)：旨在简化网络配置的 VPN 解决方案。

## 许可证

EasyTier 上游及本下游适配版均遵循 [GNU LGPL 第 3 版（LGPL-3.0）](LICENSE)。上游源码来自 [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier)，本仓库保留其历史和声明，并记录下游修改。

## 使用规范

请仅将 EasyTier 用于合法用途，并遵守适用的法律法规。使用者有责任确保其已获授权连接和管理相关网络与设备。
