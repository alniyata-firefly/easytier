# Linux 预编译包部署

使用交付包 `bin/` 中的二进制，无需在客户机器编译 Rust。先检查包内 `BUILDINFO.json` 的 CPU 架构与最低 glibc 版本；当前构建平台为 Linux amd64。Alpine/musl、Windows、手机系统不能直接使用此 Linux 包。其他系统的现有兼容 Core 可以接入管理与 VPN，新增 Linux 主机指标需要本适配版 Core。

## 安装 Web 与历史服务

下面命令以 root 执行。现有数据库升级前先保存数据库；新安装使用空目录。将 `bin/` 和 `deploy/` 视为交付包中的目录：

```sh
useradd --system --home-dir /var/lib/easytier --shell /usr/sbin/nologin easytier
install -d /opt/easytier/bin /etc/easytier
install -d -o easytier -g easytier -m 700 /var/lib/easytier /var/lib/easytier/history
install -m 755 bin/easytier-web bin/easytier-core bin/easytier-cli bin/victoria-metrics-prod /opt/easytier/bin/
install -m 600 deploy/web.env.example /etc/easytier/web.env
install -m 644 deploy/promscrape.yml /etc/easytier/promscrape.yml
umask 077
openssl rand -hex 32 > /etc/easytier/collector.token
chown easytier:easytier /etc/easytier/collector.token /etc/easytier/web.env
install -m 644 deploy/easytier-web.service deploy/easytier-history.service /etc/systemd/system/
```

若系统已存在 `easytier` 用户，无需重复创建。编辑 `/etc/easytier/web.env` 中的对外接入地址、端口、稳定安装 ID 和采集账户 ID，再启动服务。此部署模板设置 `ET_GATEWAY_RELAY_DATA=true`，允许服务器为无法直连的节点中转数据；设为 `false` 则仅提供管理与协调，不能用于这种数据中转。Web 的 HTTP 页面端口和客户端配置/VPN 入口是两个独立端口；TLS、端口映射按实际环境设置。

```sh
systemctl daemon-reload
systemctl enable --now easytier-web.service
```

空数据库沿用上游初始账号 `admin/admin` 和 `user/user`。分别登录后，通过右上角账号菜单 → 修改密码设置各自所需密码；该页面只修改当前登录账户。已有数据库保留原账号和密码。不要把示例账户编号当作实际编号。若已登录账户名为 `admin`，可只读查询其编号：

```sh
python3 - <<'PY'
import sqlite3
db = sqlite3.connect('file:/var/lib/easytier/web.db?mode=ro', uri=True)
print(db.execute('select id from users where username=?', ('admin',)).fetchone())
PY
```

将实际编号写入 `ET_METRICS_COLLECTOR_USER_ID` 后重启 Web；随后启动历史服务：

```sh
systemctl restart easytier-web.service
systemctl enable --now easytier-history.service
systemctl status easytier-web.service easytier-history.service
```

历史库只监听 `127.0.0.1:8428`，用户通过 Web 查看图表。数据保存在 `/var/lib/easytier/web.db` 和 `/var/lib/easytier/history/`，令牌及服务配置在 `/etc/easytier/`。改 URL、端口、保留时间或采集设置无需重新编译；更新相应配置再重启对应服务。

## 接入与查看

在 Web 创建设备管理令牌，执行生成的接入命令，再将设备加入网络。Linux Core 建立 TUN 的权限由客户端所在系统提供；Web 服务模板用于管理和无 TUN Gateway，不替代客户端的权限设置。

静态 NAT 场景在客户端网络配置中填写固定监听端口及对应公网映射地址。成员 → 节点详情 → 运行指标可查看资源和历史；刚启用采集时需要积累样本，CPU 首次采样保持未知。

升级时停止服务、更换 `bin/` 下程序并重新启动；保留数据库、历史目录和 `metrics-web-id`。管理令牌轮换需更新客户端接入参数，采集令牌轮换需更新令牌文件并重启 Web 和历史服务。

详细字段及权限说明见 `docs/device-management.zh-CN.md` 和 `docs/observability.zh-CN.md`。
