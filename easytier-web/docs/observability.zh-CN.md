# 历史指标与只读采集

实时指标仍由 Web 通过已认证的设备会话读取 Core。长期历史由 VictoriaMetrics 保存；浏览器通过 Web 查询当前用户拥有的设备和网络，不能直接提交 PromQL，也不会收到存储或采集凭据。未配置历史后端时，页面明确显示未启用历史，不把缺测显示为 0。

本适配保持 STUN 配置和原有连接、打洞策略不变。

## 主机资源

页面入口：网络 → 成员 → 节点详情 → 运行指标。本适配版 Linux Core 上报整机 CPU、RAM 总量/可用量、当前宿主进程 RSS，以及去重后的本地文件系统容量/可用量。同一 Core 进程的多个网络共享资源采样，不能把它们相加。嵌入 Web 的 Gateway 上报的是 Web 宿主进程 RSS。

资源按需读取并缓存：CPU/RAM/RSS 5 秒、磁盘 60 秒；文件 I/O 放在阻塞工作线程，多个同时请求只进行一次采样。CPU 首样本、读取失败和不支持的字段均保持未知。磁盘显示自己的采样时间，读取失败不更新旧样本时间。当前原生资源采集限 Linux；其他平台仍可接入 VPN，新 Core 明确报告采集不支持，旧 Core 显示版本不支持。

## Web 配置

为每套 Web 安装指定一个稳定且独立的 `metrics-web-id`。同一数据库迁移或升级时保留这个值；多套 Web 共用 VictoriaMetrics 时使用不同值。

```sh
easytier-web \
  --db /data/easytier/web.db \
  --metrics-web-id home-vpn \
  --metrics-history-url http://127.0.0.1:8428 \
  --metrics-collector-token-file /data/easytier/secrets/metrics-collector.token \
  --metrics-collector-user-id 1 \
  --metrics-collector-base-url http://10.0.3.11:11211
```

这些参数均可使用对应的 `ET_METRICS_*` 环境变量。只启用历史查询时，不需要配置 collector 的三个参数；启用采集时三个参数必须同时配置。`metrics-collector-user-id` 为数据库中的用户 ID，示例的 `1` 需要按部署环境核对。

采集凭据是单独生成的随机令牌，至少 32 个字符，存储文件在 Unix 上禁止组和其他用户读取（通常权限 `0600`）。它只能读取该用户已授权且在线的设备指标，不能下发配置、管理权限、读取其他用户设备或调用 internal 管理 API。不要把设备接入令牌或 `X-Internal-Auth` 全权管理令牌用于采集。令牌文件在启动时读取，轮换后更新采集器凭据并重启 Web。

需要给历史存储发送 Bearer 凭据时，可指定 `--metrics-history-token-file`；凭据仅由后端读取。所有 URL 都由服务启动配置提供，仅接受 HTTP/HTTPS，不接受 URL 中的用户名、密码、查询参数或 fragment。发现目标不使用请求中的 Host 或转发头。

## VictoriaMetrics 抓取配置

```yaml
scrape_configs:
  - job_name: easytier
    scrape_interval: 15s
    scrape_timeout: 10s
    honor_labels: true
    authorization:
      type: Bearer
      credentials_file: /data/easytier/secrets/metrics-collector.token
    http_sd_configs:
      - url: http://10.0.3.11:11211/api/metrics/discovery
        authorization:
          type: Bearer
          credentials_file: /data/easytier/secrets/metrics-collector.token
```

将此文件传给单节点 VictoriaMetrics：

```sh
victoria-metrics-prod \
  -httpListenAddr=127.0.0.1:8428 \
  -storageDataPath=/data/victoriametrics \
  -retentionPeriod=180d \
  -memory.allowedBytes=256MiB \
  -promscrape.config=/data/easytier/vm-scrape.yml \
  -promscrape.httpSDCheckInterval=30s
```

采集器发现在线设备中具有当前用户持久配置记录的网络实例后，按实例抓取。纯 CLI 或 `save=false` 的临时实例继续支持现有实时 RPC，需在 Web 保存配置后才纳入这套历史采集；发现、采集和历史查询使用相同归属依据。每条导出指标都带有服务端写入的 `web_id`、`user_id`、`machine_id`、`network_id`；设备自行提供的同名标签会被覆盖，防止跨用户伪装。采集失败、超时、设备离线或接入凭据撤销会得到非成功响应，由采集器记录 `up=0`，不会伪造成功样本。历史模板依赖同一套抓取生成的 `up`；没有 `up` 的手工导入数据不会作为健康历史显示。

## 页面和 API

在成员节点详情的运行指标页面中，实时资源与历史曲线同页分区展示，使用独立接口。历史支持预设时间范围和自定义范围；最大单次 31 天，步长至少 15 秒，每序列最多 2,000 点，最多 64 条序列。后端请求超时为 10 秒，响应体最多 8 MiB，同时最多 8 个存储查询。字节采用 1024 缩放显示 KiB/MiB/GiB，CPU 为整机 0–100%，图表时间使用浏览器本地时区。

页面预设最近 1 小时、6 小时、24 小时、7 天和 30 天；也可选择较早的自定义日期，步长自动调整。VictoriaMetrics 本身不提供这套 Web 的账户隔离，直接查询端口应限后端访问，浏览器使用已登录的 Web 页面。

- `GET /api/v1/observability/capabilities`：需要登录，返回当前能力和允许的指标。
- `GET /api/v1/machines/{machine-id}/networks/{instance-id}/metrics/history?metric=traffic_rx_rate&start=...&end=...&step=...`：需要当前 owner 登录，使用 Unix 秒。
- `GET /api/metrics/discovery`：需要独立采集 Bearer 凭据，返回 Prometheus HTTP 服务发现结果。
- `GET /api/metrics/users/{user-id}/machines/{machine-id}/networks/{instance-id}/scrape`：相同只读凭据，返回附带稳定身份标签的 Prometheus 文本。

允许的历史指标为 `traffic_tx_rate`、`traffic_rx_rate`、`traffic_tx_bytes`、`traffic_rx_bytes`、`rpc_error_rate`、`host_cpu_percent`、`host_memory_used_bytes`、`host_process_rss_bytes`、`host_disk_used_bytes`。业务流量按当前网络隔离；累计字节是 Core 当前计数器，Core 重启会重置，速率使用处理计数器重置的 `rate`。

主机资源是整机指标，多个网络实例可能返回同一份资源快照。历史先选择同一设备最新的合法采样时间，再去除重复，不把多个实例的数据相加。资源样本有效期 30 秒，磁盘样本有效期 120 秒；采集组件失败、过期、未来时间明显异常或目标不健康时曲线断开。资源采集不支持的平台不提供这些指标。

历史查询允许设备离线，但必须仍有当前用户所属的设备记录和该实例的持久配置；删除设备、删除实例或迁移 owner 后，原查询不能继续访问其历史。查询前后都检查归属，历史返回中再次校验稳定身份标签。旧实例历史不会因相同网络名称而混入新 UUID 实例。

返回格式：

```json
{
  "available": true,
  "metric": "traffic_rx_rate",
  "unit": "bytes_per_second",
  "start": 1780000000,
  "end": 1780000060,
  "step": 15,
  "series": [
    {"labels": {"web_id": "home-vpn", "user_id": "1", "machine_id": "...", "network_id": "..."},
     "values": [[1780000000, 1200], [1780000030, null]]}
  ]
}
```

没有样本时 `series` 为空，非有限值转为 `null`，不补零。未配置历史返回 `503 / metrics_history_disabled`；非法查询范围返回 `400`；存储超时返回 `504`；非法或过大的存储响应返回 `502`。

存储查询只使用请求范围内的完整步长网格点：起点向上对齐，终点向下对齐，响应中的 `start`/`end` 仍保留用户原始范围。这避免 VictoriaMetrics 结果缓存向下取整起点时产生越界样本；缓存保持启用，返回样本仍须通过严格范围和归属校验。短窗口没有网格点时返回空 `series`，包含一个网格点时正常返回单点。

## 验证边界

普通测试覆盖只读鉴权、标签覆盖、固定模板、响应隔离、时间与点数边界、离线归属、删除后访问和超时。独立引擎合同测试需要显式指定官方 VictoriaMetrics 二进制并运行 ignored 测试：

```sh
ET_VM_TEST_BIN=/path/to/victoria-metrics-prod \
  cargo test -p easytier-web synthetic_victoriametrics_templates_choose_latest_and_leave_failure_gaps -- --ignored
```

此合同测试使用明确标记的合成作用域，验证旧的高 CPU 不覆盖新的低 CPU、异常未来时间不阻断正常样本、其他用户样本不泄露、磁盘失败与离线速率产生缺口。真实 Core、只读采集和浏览器验收需要独立验证，不能用合成数据替代。

真实集成脚本使用预编译的 Web/Core/CLI 文件，不连接生产网络：

```sh
ET_VM_BIN=/path/to/victoria-metrics-prod \
  node --test easytier-web/frontend/tests/observability-native-e2e.test.mjs
ET_RUN_DATAPLANE=1 ET_WG_BIN=/path/to/wg \
  node --test easytier-web/frontend/tests/dataplane-native-e2e.test.mjs
```

前者测试实际采集、入库、权限、离线历史及 Chromium 页面。后者需要 root、Linux 网络命名空间、TUN、内核 WireGuard 和 `wg`，接口和路由位于临时命名空间，结束后清理。标准 WireGuard 客户端测试不能代替真实手机系统的最终验收。

客户端已有固定监听端口和公网映射地址。静态 NAT 示例：公网 UDP 32020 转发到客户端 UDP 22020；监听填写 `udp://0.0.0.0:22020`，映射地址填写 `udp://公网地址:32020`。当前未增加主动连接的固定源端口设置。

官方存储文档：[单机版](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/)、[HTTP 服务发现](https://docs.victoriametrics.com/victoriametrics/sd_configs/#http_sd_configs)。

## Web 服务端自身资源

首页的服务端资源卡片使用 `GET /api/v1/server/resources`，直接在 Web 进程中读取本机 CPU、内存、服务进程 RSS 和文件系统空间，不借用任何受管 Core 节点的数据，也不依赖 Gateway、在线设备或网络实例。采样复用 Linux 原生进程级单例：资源缓存 5 秒，磁盘缓存 60 秒，按请求触发，不增加后台采集定时器。

此接口需要登录且当前用户属于数据库实际的 `admins` 管理组；按用户 ID 单独查组关系，普通用户返回 `403 / server_resources_forbidden`，首页隐藏该卡片，其余功能正常。组权限撤销后立即生效，设备令牌、只读采集 Bearer 或 internal 管理令牌不能替代此接口的管理员登录会话。返回 `{host_resources_supported, host_resources?}`，嵌套字段与节点资源接口一致，64 位整数使用字符串。未知值不补零，第一次 CPU 样本尚无时间间隔时不提供 CPU 百分比，不支持的平台明确返回不支持。
