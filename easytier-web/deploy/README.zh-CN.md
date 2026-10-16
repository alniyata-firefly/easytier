# Linux 服务部署模板

本目录是本分支的 systemd 与可选历史采集配置。先按[安装说明](../../docs/installation.md)获取并校验本仓库 Linux x86_64 / ARM64 静态 musl 包；无需在部署机器编译 Rust。当前发行包不包含 VictoriaMetrics，也不使用旧交付目录中的 `BUILDINFO.json`。

## Web 与无 TUN 网关

在仓库根目录准备模板，以下命令需要系统管理权限。`./easytier-installed` 表示已校验解压的 Linux 包目录：

```sh
useradd --system --home-dir /var/lib/easytier --shell /usr/sbin/nologin easytier
install -d /opt/easytier/bin /etc/easytier
install -d -o easytier -g easytier -m 700 /var/lib/easytier
install -m 755 ./easytier-installed/easytier-web ./easytier-installed/easytier-core ./easytier-installed/easytier-cli /opt/easytier/bin/
install -m 600 easytier-web/deploy/web.env.example /etc/easytier/web.env
chown easytier:easytier /etc/easytier/web.env
install -m 644 easytier-web/deploy/easytier-web.service /etc/systemd/system/
```

已有 `easytier` 用户时跳过创建。先编辑 `/etc/easytier/web.env`：

- 设置自己的 `ET_ADVERTISED_CONFIG_SERVER_URL` 与 `ET_GATEWAY_PEER_URL`，两者均不附加设备令牌。
- 按访问方式设置 API 监听；反向代理部署可只监听 `127.0.0.1`。
- `ET_GATEWAY_RELAY_DATA=true` 允许服务端为不能直连的节点中转；设为 false 则不提供该数据中转。
- 首次只启用 Web 时移除 `ET_METRICS_*` 行。历史采集需完成下一节配置后再启用，不能沿用示例中的账户 ID。

```sh
systemctl daemon-reload
systemctl enable --now easytier-web.service
```

全新数据库有 `admin/admin` 和 `user/user` 初始账号，首次登录分别修改密码。已有数据库保留原账号。当前账号菜单位于侧边栏左下角头像。

此服务模板使用非 root 账户与 `PrivateDevices=true`，用于管理与无 TUN 网关；不用于在服务器创建本机 TUN。Core 节点的 TUN 权限由节点所在系统单独提供。

## 可选历史采集

实时资源与流量不依赖历史库。需要历史时，另行安装兼容的 VictoriaMetrics 单机程序至 `/opt/easytier/bin/victoria-metrics-prod`，或按自己的后端调整模板。它不随本仓库安装包提供。

```sh
install -d -o easytier -g easytier -m 700 /var/lib/easytier/history
install -m 644 easytier-web/deploy/promscrape.yml /etc/easytier/promscrape.yml
install -m 644 easytier-web/deploy/easytier-history.service /etc/systemd/system/
umask 077
openssl rand -hex 32 > /etc/easytier/collector.token
chown easytier:easytier /etc/easytier/collector.token
```

确认库中实际的网络拥有者账户编号，再设置环境文件中的 `ET_METRICS_COLLECTOR_USER_ID`。例如只读查询 admin 的编号：

```sh
python3 - <<'PY_ID'
import sqlite3
with sqlite3.connect('file:/var/lib/easytier/web.db?mode=ro', uri=True) as db:
    print(db.execute('select id from users where username=?', ('admin',)).fetchone())
PY_ID
```

同时配置稳定且唯一的 `ET_METRICS_WEB_ID`、`ET_METRICS_HISTORY_URL`、采集令牌文件和采集 API 地址；字段定义见[后端采集选项](../src/restful/observability.rs)。令牌只用于只读采集，不是设备管理令牌。

```sh
systemctl daemon-reload
systemctl restart easytier-web.service
systemctl enable --now easytier-history.service
```

模板历史库只监听 `127.0.0.1:8428`，数据保存在 `/var/lib/easytier/history/`；Web 数据库为 `/var/lib/easytier/web.db`，服务配置及令牌位于 `/etc/easytier/`。历史页面只在后端启用并产生数据后有可用曲线。

## 更新

停止目标服务、更换对应可执行文件并重启，保留数据库、历史数据和稳定 Web ID。服务端升级前保存数据库副本。设备管理令牌和采集令牌分别轮换；不把它们写入源码、截图或公开 Issue。

配置与下发语义见[中央组网文档](../../docs/central-network-connectivity.md)，平台打包和签名见[构建说明](../../docs/github-actions.md)。
