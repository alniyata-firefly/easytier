# EasyTier 2.7 Web 适配版

基于上游 `v2.7.0`（`8b7f1f0196edb5b580829ed5f135050fb5853478`）。这是独立的补充 VPN 管理项目。

## 设备接入

1. 登录 Web，在设备页面创建管理令牌。可以提前指定 Core 的 `machine_id`，也可以在第一次接入时绑定。
2. 保存创建响应给出的接入命令；完整令牌只显示一次。
3. 在设备上执行命令。设备上线后，将它加入所需网络。管理接入本身不会授权加入 VPN。

沿用 Core 原有的设备 ID。令牌为 256 位随机值，数据库只存 SHA-256 摘要；一个账户的同一设备只能有一个有效管理令牌。用户名不再是本地中心模式的接入凭据。外部 webhook 模式仍由外部控制器管理认证。

轮换后需要在设备上更新 `--config-server` 参数并重连。撤销或过期会阻止管理连接及后续配置获取；VPN 身份仍由网络成员及其网络凭据独立控制。删除设备会撤销其管理令牌并移除中心网络成员；设备封禁还会禁止发放新令牌。

Secure Mode 下新加入的设备默认使用独立凭据。角色选择可以显式切换为可信管理节点，既有永久成员不自动迁移。标准 WireGuard 客户端没有 Core 设备 ID，继续使用独立客户端记录和 WireGuard 密钥。

## 配置与状态

网络详情区分保存与生效，展示每台设备的目标版本、已应用版本和错误，以及 Gateway 状态。离线设备等待上线，失败配置由后台重试。

Gateway 凭据和 `exit_nodes` 使用已验证的热更新。必须重建 Gateway 时，先启动候选实例；失败时保留旧实例及原客户端配置，等待重试。路由、连接器及其他涉及生命周期的变更仍使用重建流程。

ACL 支持 TCP、UDP、ICMP、ICMPv6 和 Any，编辑保存保留原协议。凭据支持 ACL 组、代理网段授权、有效期、续期与轮换。

## 指标、拓扑和 LAN

节点详情调用实际 Core Stats RPC，展示可用的实例、链路和 WireGuard 客户端指标。累计流量按 uint64 精确处理；速率使用真实采样间隔，首样本和计数重置不产生假流量。缺失数据显示未知。

拓扑按授权成员、实际连接和路由信息绘制：连接与路由关系分开显示，不把只有路由记录的路径当作直连。IPv6 隧道端点、NAT 状态和下一跳沿用 Core 实际上报。

新 Core 增加兼容的 `InterfaceNetwork` 报告，保留实际 IPv4/IPv6 掩码。LAN 建议只选私有 IPv4 地址；旧 Core 未报告掩码时要求手动填写。当前上游中心代理网段仍仅支持 IPv4，IPv6 接口只用于展示真实信息。

HTTP Prometheus 导出接口：

```text
GET /api/v1/machines/{machine-id}/networks/{instance-id}/metrics
GET /api/internal/users/{user-id}/machines/{machine-id}/networks/{instance-id}/metrics
```

第一项使用 Web 登录会话及设备归属校验；第二项仅在配置既有 `--internal-auth-token` 后启用，使用 `X-Internal-Auth`，适合受信任的内部采集器。被撤销的设备会话不能继续导出指标。输出为 Prometheus 文本，不在 Web 中另建长期时序数据库。

## 编译和运行

使用仓库锁定的 Rust 1.95、pnpm 10.12.4，并安装 Protobuf 编译器及开发头文件、CMake 和项目要求的链接器。先构建前端，再构建 embed 后端：

```sh
pnpm install --frozen-lockfile
pnpm --dir easytier-web/frontend build
cargo build --locked --release -p easytier-web -p easytier --features easytier-web/embed --bins
```

`easytier-web` 已包含 Web 静态资源，客户端为 `easytier-core`，诊断工具为 `easytier-cli`。准确 LAN 掩码需要本适配版 Core，其他已有 Core 协议保持兼容。Linux 二进制需要与构建环境兼容的系统库；不要把本机预览包误当成已测试的所有平台发行包。

管理服务和 VPN Gateway 可以共享配置服务器端口。示例：

```sh
./easytier-web --db ./web.db \
  --api-server-addr 0.0.0.0 --api-server-port 11211 \
  --config-server-protocol udp --config-server-port 32220 \
  --advertised-config-server-url udp://vpn.example.com:32220 \
  --gateway-peer-url udp://vpn.example.com:32220 \
  --disable-registration
```

`--advertised-config-server-url` 是发给客户端的完整管理入口，可与浏览器域名或 API 域名不同，支持 IPv6 字面地址和 WebSocket 路径前缀。TLS、NAT 端口映射与对外域名按实际部署环境配置。更改入口后应使用新生成的接入命令。

已有数据库会自动迁移新增令牌表，保持已有账户、网络和永久成员。更换程序前保存数据库，首次启动确认登录及配置生效状态。迁移后的旧用户名接入方式需要改为新设备令牌。

## 验证

```sh
cargo test --locked -p easytier-web
cargo test --locked -p easytier-core --lib endpoint_debug_never_contains_device_token
cargo test --locked -p easytier-core --lib connector_diagnostics_redact_256_bit_token
cargo test --locked -p easytier --lib reports_actual_interface_prefixes
cargo test --locked -p easytier --lib connection_events_redact_every_endpoint
```

前端单元测试和浏览器回归脚本位于 `frontend-lib/tests` 和 `frontend/tests`。真实端到端测试接受显式 Web/Core/CLI 二进制路径，使用隔离数据库、独立端口和无 TUN 配置；测试不连接生产网络。测试结果、构建身份和预览包校验值记录在交付目录的验证说明中。
