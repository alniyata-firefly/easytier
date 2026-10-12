# EasyTier Core 2.7 统一配置适配版

本包提供独立的 `easytier-core` 和 `easytier-cli`，用于先部署节点、以后接入中心管理。包含日志中管理令牌的遮蔽、真实 IPv4/IPv6 接口掩码报告、Linux 主机资源采集，以及单 TOML 多实例启动和采集参数配置。STUN 和原有 VPN 选路协议保持原样，本包不部署 Web。

## 安装前确认

预编译程序不需要在部署机器安装 Rust。检查包内 `BUILDINFO.json` 的 CPU 架构、运行库下限、源码提交和程序版本。最低 glibc 版本以本次交付元数据为准；Linux GNU 构建不能直接用于 Alpine/musl。

```sh
bin/easytier-core --version
bin/easytier-cli --version
bin/easytier-core --help
```

资源采集目前由 Linux 原生 Host 提供。其他平台通过能力字段报告支持情况，不把未支持、未采样或采集失败伪造成数值零。

## 一个文件管理多个网络

将 `deploy/core.toml.example` 复制为 `/etc/easytier/core.toml`。该文件的根 `[host_resources]` 控制当前 Core 进程的资源采集；每个 `[[instances]]` 是一个独立网络，使用原来单实例 TOML 的配置字段。两个示例分别使用 `alpha`、`beta` 名称、不同的 UUID、IPv4 网段和监听端口。

结构如下，具体可用示例见交付文件：

```toml
[host_resources]
enabled = true
interval_seconds = 5
disk_interval_seconds = 60

[[instances]]
instance_id = "80e5e024-7a63-447e-99f1-c4b58d031ad9"
instance_name = "alpha"
ipv4 = "10.250.1.1/24"
listeners = ["tcp://127.0.0.1:21101", "udp://127.0.0.1:21101"]

[instances.network_identity]
network_name = "example-alpha"
network_secret = "REPLACE_WITH_ALPHA_RANDOM_NETWORK_SECRET"

[instances.flags]
no_tun = true

[[instances]]
instance_id = "24c8d713-026b-4c1f-bf53-0792efa84307"
instance_name = "beta"
ipv4 = "10.250.2.1/24"
listeners = ["tcp://127.0.0.1:21102", "udp://127.0.0.1:21102"]

[instances.network_identity]
network_name = "example-beta"
network_secret = "REPLACE_WITH_BETA_RANDOM_NETWORK_SECRET"

[instances.flags]
no_tun = true
```

完整部署示例没有公网对等节点、配置服务器地址或官方组网入口；监听局限在本机，TUN、UPnP 和自动打洞关闭。它用于本地检查，不是正式 VPN 配置。正式部署时替换示例密钥、生成每个新实例的独立 UUID，并填写真实地址、端口和对等节点；既有网络直接沿用原身份与密钥。不能将同一份实例身份复制成另一台节点的新身份。

启动只需要指定主配置：

```sh
/opt/easytier/bin/easytier-core --config-file /etc/easytier/core.toml
```

CPU、RAM、Core RSS 和磁盘由进程内实例共享一个采集器。每个网络的状态、流量、路由、连接和 WireGuard 客户端指标按各自实例 UUID 统计。汇总主机占用时不能把同一进程通过多个实例重复输出的主机指标相加。

## 采集参数

| 设置 | 命令行 | 环境变量 | 默认值 |
| --- | --- | --- | --- |
| 采集开关 | `--host-resources-enabled` | `ET_HOST_RESOURCES_ENABLED` | `true` |
| CPU、内存和 RSS 的最短采样间隔 | `--host-resources-interval` | `ET_HOST_RESOURCES_INTERVAL` | `5` 秒 |
| 磁盘的最短采样间隔 | `--host-resources-disk-interval` | `ET_HOST_RESOURCES_DISK_INTERVAL` | `60` 秒 |

同一设置的优先级为 **CLI > 环境变量 > 主配置 TOML > 默认值**。各层可以只提供部分设置，缺失值由下一层补齐；不需要独立的资源配置文件参数。

资源间隔允许 `1..3600` 秒，磁盘间隔允许 `1..86400` 秒，磁盘间隔必须大于或等于资源间隔。开关接受 `true` 或 `false`。最终参数不合法时应纠正配置，不依赖静默回退默认值。

参数在进程启动时生效。修改文件或环境变量后需要重启 Core；此次没有文件监听或运行时热更新。采集按需进行：收到资源查询后，达到最短间隔才产生新样本，其余查询复用缓存。没有查询时不会按这个间隔后台扫描。

例如检查配置，并用 CLI 覆盖文件中的开关：

```sh
/opt/easytier/bin/easytier-core \
  --config-file /etc/easytier/core.toml \
  --host-resources-enabled false \
  --check-config
```

`--check-config` 不启动 VPN。首次 CPU 样本没有采样区间，CPU 值保持未知；达到资源间隔后的再次查询才能得到利用率。磁盘有单独时间戳，失败刷新不会把旧数据标成刚采集。

## 安装与服务模板

以下是部署教程，本次交付不会替你运行或启动服务。已有 Core 应保留其网络配置和状态目录，再替换二进制，不用示例覆盖正式配置。新机器可按以下路径安装：

```sh
install -d -m 755 /opt/easytier/bin
install -d -m 700 /etc/easytier /var/lib/easytier
install -m 755 bin/easytier-core bin/easytier-cli /opt/easytier/bin/
install -m 600 deploy/core.toml.example /etc/easytier/core.toml
install -m 600 deploy/easytier-core.env.example /etc/easytier/core.env
install -m 644 deploy/easytier-core.service.example /etc/systemd/system/easytier-core.service
```

服务模板以 root 运行，保留 TUN/网络设置、原始套接字和低端口监听所需的 `CAP_NET_ADMIN`、`CAP_NET_RAW`、`CAP_NET_BIND_SERVICE`。模板设置 `XDG_DATA_HOME=/var/lib`，管理接入的设备身份文件固定在 `/var/lib/easytier/machine_id`，与 `ProtectHome=true` 和可写状态目录一致。它读取统一配置及 `core.env`，工作目录为 `/var/lib/easytier`，RPC 只监听 `127.0.0.1:15888`。单实例更新按 UUID 定向写回主配置，保留其他实例和根资源设置；原子替换需要 `/etc/easytier` 目录可写，因此模板允许写入该目录。自定义持久凭据或日志文件时，使用 `/var/lib/easytier` 下的路径，避免把状态文件放进此模板隐藏的 HOME 或其他只读目录。

编辑配置后检查，再由部署人员启动：

```sh
/opt/easytier/bin/easytier-core --config-file /etc/easytier/core.toml --check-config
systemctl daemon-reload
systemctl enable --now easytier-core.service
```

三个资源环境变量默认注释，避免无意覆盖主文件。管理令牌和私钥不写进服务命令行。日志脱敏不改变真实认证，也不能替代配置文件权限保护。

## CLI 查看每个实例

CLI 使用同一个本机 RPC，`--instance-id`（`-i`）按 UUID 选择实例，`--instance-name`（`-n`）按名称选择实例。优先使用稳定 UUID；示例里的名称互不重复。未指定选择器时，现有 CLI 会列出全部运行实例，并按名称和 UUID 区分结果。

```sh
# 查看全部实例的节点状态；JSON 多实例结果包含 instance_id、instance_name。
/opt/easytier/bin/easytier-cli --rpc-portal 127.0.0.1:15888 --output json node info

# 按名字查看 alpha 的连接，beta 的路由。
/opt/easytier/bin/easytier-cli --rpc-portal 127.0.0.1:15888 --instance-name alpha peer
/opt/easytier/bin/easytier-cli --rpc-portal 127.0.0.1:15888 --instance-name beta route

# 按 UUID 取得对应网络的指标及进程共享的主机资源。
/opt/easytier/bin/easytier-cli --rpc-portal 127.0.0.1:15888 \
  --instance-id 80e5e024-7a63-447e-99f1-c4b58d031ad9 stats prometheus
```

CLI 语法来自当前程序的 `--help` 和多实例选择实现。Web 通过既有实例列表及按 UUID 选择的 RPC 获取各网络状态；交付验证记录提供旧适配 Web 查看和切换本地双实例的实际浏览器结果，本次没有新增 Web 产品功能。

## 指标和验证方法

资源通过 Stats RPC 和 Prometheus 文本报告，包含平台支持能力、当前开关和生效间隔。`supported` 表示平台能够采集，`enabled` 表示当前允许采集；Linux 上关闭后支持能力仍成立，但不继续提供资源样本。CPU、RAM、Core RSS、磁盘容量及独立采样时间戳使用实际观测值，未知数据保持缺失。

验证时先查询样本，观察资源间隔内的缓存复用及间隔后时间戳推进，磁盘应按独立间隔推进。把 `enabled` 改成 `false` 并重启，确认开关变化、旧样本不再输出。分别用 CLI 和环境变量覆盖文件，再查询实际生效参数。格式错误、零值、越界及磁盘间隔小于资源间隔应产生明确启动错误。

多实例检查应确认两个 UUID 都在线，各自名称、地址、监听端口和流量独立。针对一个 UUID 修改配置后，重读主文件并重启，确认另一个实例及 `[host_resources]` 均保留，且每个实例只启动一次。CLI 遍历全部实例时，各结果的 UUID 与名称应正确。

真实接口地址报告包含 IPv4/IPv6 实际掩码，不等于自动发布所有接口为 VPN 代理网段。是否发布 LAN 网段仍由网络配置决定。

既有 Web 的资源新鲜度判断使用固定窗口。接入旧 Web 时建议保持 `5/60` 秒默认值；自定义时使用资源间隔不大于 `10` 秒、磁盘间隔不大于 `60` 秒，避免稀疏采样显示为过期。更长间隔适合能够按实际设置判断新鲜度的采集端。

本说明提供验证方法，不声明全部测试已经通过。交付包中的验证记录说明实际运行的检查、二进制身份和测试边界。

## 以后迁移到中心管理

保持 `machine_id` 及其本地持久状态。已有进程若没有设置 `XDG_DATA_HOME`，Linux 默认身份文件可能在 `$HOME/.local/share/easytier/machine_id`。改为此服务部署前，应将原身份文件按 0600 权限迁移到 `/var/lib/easytier/machine_id`；也可以在 `core.env` 明确设置 `ET_MACHINE_ID` 为原设备 UUID。不要在迁移旧设备时仅更换状态路径并让管理接入生成新身份。迁移每个网络时保留 `instance_id`、`instance_name`、`network_identity`、虚拟地址、监听端口、Secure Mode 私钥与凭据，以及 WireGuard Portal 的服务端和客户端密钥。只保留网络名称不能替代这些身份字段。

后续 Web 需要先导入已有网络，再接管对应实例；当前本包没有实现一键导入接管。控制器管理令牌和 VPN 网络密钥是两套不同凭据。添加 `ET_CONFIG_SERVER` 前应确认控制器与原实例身份一致，避免同时从本地与中心加载重复实例。资源设置保留在主文件根部，作用于整个进程，不需给每个网络重复配置，也不需重新编译。
