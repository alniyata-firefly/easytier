# EasyTier · React 管理与客户端

<p align="center"><img src="assets/brand/easytier.svg" width="80" height="80" alt="EasyTier 三节点标识"/></p>

面向自建网络的 EasyTier 下游适配版，提供 React Web 控制台、内嵌 Core 的桌面和 Android 客户端，以及 Linux Core / CLI / Web 服务端。

[![构建与打包](https://github.com/alniyata-firefly/easytier/actions/workflows/packages.yml/badge.svg)](https://github.com/alniyata-firefly/easytier/actions/workflows/packages.yml)
[![源码检查](https://github.com/alniyata-firefly/easytier/actions/workflows/checks.yml/badge.svg)](https://github.com/alniyata-firefly/easytier/actions/workflows/checks.yml)
[![LGPL-3.0](https://img.shields.io/github/license/alniyata-firefly/easytier)](LICENSE)

[简体中文](README.md) | [English](README_EN.md)

[下载与发行](https://github.com/alniyata-firefly/easytier/releases) · [构建记录](https://github.com/alniyata-firefly/easytier/actions/workflows/packages.yml) · [安装与接入](docs/installation.md) · [问题反馈](https://github.com/alniyata-firefly/easytier/issues)

## 本分支提供什么

- **中央管理**：设备注册、管理访问令牌、网络与成员管理，以及节点确认的配置下发状态。
- **React 界面**：Web、桌面 GUI 与 Android 共用配置类型和界面规范，使用简体中文 / 英文国际化、HarmonyOS Sans SC 与 Inter 字体、自行绘制的三节点标识。
- **独立组网**：保留本地 TOML 配置与命令行组网能力，不要求所有网络接入中央管理。
- **网络配置**：网络统一下发压缩、KCP / QUIC、加密、协议偏好和 DNS 后缀；节点可配置子网转发、ACL、监听和映射、SOCKS5 等支持的 Core 参数。
- **双栈连接**：每对节点独立选择 IPv6 / IPv4，IPv6 优先并保留可用的 IPv4 或中转回退路径。
- **上联选择**：支持平台按实例自动识别上联网卡，或手动指定允许的网卡；移动端由系统选择 Wi-Fi / 蜂窝网络。
- **运行观测**：查看设备与服务端资源、节点连接、路由和实时流量；历史数据在后端启用存储后提供。
- **多实例**：一个 Core 进程可运行多个网络实例，CLI 和 GUI 可查看对应实例的状态。

网络策略应用可能重建实例并短暂重连；在线节点的应用结果与离线等待状态分别显示。具体配置和兼容边界见[中央组网与配置下发](docs/central-network-connectivity.md)、[上联网卡策略](docs/uplink-interface-policy.md)。

## 界面预览

截图来自本分支 React 界面，使用匿名示例数据。桌面截图采用模拟 Core 数据，展示界面效果。

| 控制台概览 | 网络成员 |
| --- | --- |
| ![控制台概览](docs/images/console/overview.png) | ![网络成员管理](docs/images/console/network-members.png) |
| 网络设置 | 桌面客户端 |
| ![网络传输配置](docs/images/console/network-settings.png) | ![React 桌面客户端](docs/images/console/desktop-client.png) |

## 下载与安装

当前源码版本为 **2.7.2**。各次构建对应的源码提交、文件摘要与验证结果随产物提供，源码版本号不表示所有平台的安装包都已发布。

| 平台 | 本仓库打包内容 |
| --- | --- |
| Linux x86_64 / ARM64 | 静态 musl `easytier-core`、`easytier-cli`、内嵌 React 页面的 `easytier-web`，`.tar.gz` |
| Windows x64 | 内嵌 Core 的 GUI，NSIS / MSI 安装包 |
| macOS Intel / Apple Silicon | 内嵌 Core 的 GUI，DMG / 应用归档 |
| Android ARM64 | 内嵌 Core 的已签名 APK |
| Web | React 静态资源包；需配合本分支管理后端 |

优先从[本仓库 Releases](https://github.com/alniyata-firefly/easytier/releases)获取已发布版本。尚未正式发布的构建可在成功工作流的 **Artifacts → release-packages** 下载，需要登录 GitHub。下载后核对同一产物集的 `SHA256SUMS` 与 `build-manifest.json`。

本分支没有发布到上游的 Homebrew、Docker Hub 或 OpenWrt 软件源。使用那些入口会得到其他版本；本仓库的[安装说明](docs/installation.md)和安装脚本使用当前仓库的产物格式。

## 接入中央管理

1. 部署本分支的 `easytier-web`，打开自己的控制台。
2. 在控制台签发设备管理访问令牌。
3. 客户端填写自己的管理服务器与令牌，或运行：

```sh
sudo ./easytier-core --config-server 'udp://vpn.example.com:22020/YOUR_DEVICE_TOKEN'
```

4. 在控制台核对设备是否在线，再将设备加入目标网络；成员页面查看配置是否已应用。

`vpn.example.com` 和 `YOUR_DEVICE_TOKEN` 是占位内容。Web 登录地址、配置服务器端口和 VPN 数据监听是不同入口；Web 的 HTTPS 反向代理不会自动代理 UDP 配置连接。具体端口与启动参数见[安装与接入](docs/installation.md)。

## 本地独立组网

两端使用相同的网络名和密钥，并分配不冲突的虚拟地址。以下为示例，需将密钥和可达节点地址替换为自己的值：

```sh
# 节点 A
sudo ./easytier-core --network-name example-net --network-secret CHANGE_ME \
  --ipv4 10.144.144.1 --rpc-portal 127.0.0.1:15888 --listeners udp://0.0.0.0:11010

# 节点 B
sudo ./easytier-core --network-name example-net --network-secret CHANGE_ME \
  --ipv4 10.144.144.2 --rpc-portal 127.0.0.1:15888 --peers udp://node-a.example.com:11010
```

使用 `./easytier-cli peer`、`./easytier-cli route` 查看状态；多实例先运行 `./easytier-cli --help` 选择对应实例。也可在 GUI 新建本地网络或导入 TOML。中央下发的配置与本地自管配置按来源分别管理。

## 开发与构建

构建使用 Rust 1.95、Node.js 22、pnpm 10.12.4，按仓库锁文件安装依赖。平台 SDK、签名和打包由当前 `.github/workflows/` 与 `ci/` 定义。

- [GitHub Actions 与签名配置](docs/github-actions.md)
- [贡献与本地验证](CONTRIBUTING_zh.md)
- [React Web](easytier-web/frontend/README.md) / [React GUI](easytier-gui/README.md)
- [Core 架构](docs/core-architecture.md)

活动界面位于 `easytier-web/frontend` 和 `easytier-gui/src/react`；`frontend-lib` 提供共享协议类型与配置转换。仓库仍保留上游的 Vue 配置生成器、贡献工具以及 Go / JS / WASI 等可选源码，它们不属于当前默认 React 交付包。旧上游工作流归档于 [`.github/upstream-workflows`](.github/upstream-workflows/README.md)，不会作为活动工作流执行。

自动化检查、包内容验证与浏览器模拟测试不能替代 Android / Windows / macOS 的实际 VPN 建链、后台切换和升级验收；以每次发行的验证记录为准。

## 项目来源与下游改造

本项目基于 **[EasyTier/EasyTier](https://github.com/EasyTier/EasyTier)**，保留 VPN Core、通信协议、原生集成及其贡献历史。记录的上游基线为 [`8b7f1f0196edb5b580829ed5f135050fb5853478`](https://github.com/EasyTier/EasyTier/commit/8b7f1f0196edb5b580829ed5f135050fb5853478)（2026-10-05，版本 2.7.0）。本分支在此基础上实现中央管理、令牌接入、配置确认、资源观测、双栈与上联策略及 React 界面；本仓库版本号独立维护。

代码继续遵循 **[GNU LGPL v3](LICENSE)**，保留原始许可证、版权和作者信息。对应修改源码在本仓库公开；发布包包含源码地址与许可声明。

HarmonyOS Sans SC 和 Inter 分别保留[鸿蒙字体许可](easytier-web/frontend/public/fonts/LICENSE-HarmonyOS-Sans.txt)与 [SIL OFL 1.1](easytier-web/frontend/public/fonts/LICENSE-Inter-GoogleFonts.txt)，详见[字体来源清单](easytier-web/frontend/public/fonts/provenance.json)。
