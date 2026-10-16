# EasyTier React 管理控制台

面向 VPN 管理员的 React 19、TypeScript、Vite 前端。沿用 EasyTier Web 的会话、权限和 API，复用现有协议类型与数据格式化模块；不需要 PrimeVue 或额外图表依赖。共享协议模块位于 `frontend-lib`；仓库内的旧 Vue 配置生成器与可选贡献工具不进入当前默认发行包。

## 项目来源

本目录是 [EasyTier 下游适配仓库](../../README_CN.md#项目来源与下游改造)的 React Web 控制台，上游为 [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier)。现有 VPN Core、协议和管理后端继承上游；中央网络管理、令牌接入、配置确认、资源观测及本 React 界面由下游扩展。上游基线为 `8b7f1f0196edb5b580829ed5f135050fb5853478`，本仓库保留其 [LGPL-3.0 许可证](../../LICENSE)和贡献者说明。

Web、桌面与 Android 使用同一套自行绘制的[三节点 SVG 标识](../../assets/brand/easytier.svg)。布局、字体与交互约定见 [DESIGN.md](DESIGN.md)，字体沿用各自原始许可。

## 构建与运行

在仓库根目录安装锁定依赖，然后进入本项目：

```bash
pnpm install --frozen-lockfile
cd easytier-web/frontend
pnpm typecheck
pnpm test
pnpm build
```

`build` 先执行 TypeScript 检查，再生成 `dist/`。开发服务与构建预览共用端口 5188，选择一种运行：

```bash
# 开发服务
API_BASE_URL=http://127.0.0.1:21811 pnpm dev

# 构建后的预览服务
API_BASE_URL=http://127.0.0.1:21811 pnpm preview
```

Vite 监听 `0.0.0.0:5188`，端口冲突时直接报错。开发和预览均将 `/api`、`/auth/config` 代理至 `API_BASE_URL`，默认后端为 `http://127.0.0.1:21811`。路由使用 hash，兼容 `#/h`、`#/h/networks`、`#/h/deviceList` 等已有入口。

真实账户、密码、设备令牌和数据库由后端提供，不放入此仓库或前端构建。前端使用 cookie 会话；登录与改密码保持现有 MD5 请求契约。

## 管理能力

| 流程 | 现有 API 与行为 |
| --- | --- |
| 登录与账户 | `/api/v1/auth/*`；公开认证能力为 `/auth/config`；支持已启用的注册与 OIDC |
| 网络管理 | `/api/v1/networks`；创建、设置、删除、IPv6 默认策略及真实部署状态 |
| 成员管理 | `/networks/{id}/members`；注册设备加入、成员身份和地址、子网转发、移出网络 |
| 成员高级参数 | `/members/{deviceId}/config`；原项目26个开关及IPv6三态、接口/MTU/限速、监听/映射、子网与路由、出口/白名单/SOCKS5、端口转发、VPN客户端；保留未编辑的覆盖字段 |
| 管理访问令牌 | `/api/v1/device-access-tokens`；签发、轮换、真正删除；明文只在签发/轮换弹窗内保留 |
| 网络入网凭据 | `/networks/{id}/credentials`；安全网络的独立凭据、期限和权限组管理 |
| ACL | `/networks/{id}/acl-policy`；规则来源、目标、协议、端口、动作及顺序 |
| 设备实例 | `/api/v1/machines/{deviceId}/networks/*`；完整基础/节点参数/实例ACL/TOML编辑、配置启停；按设备权限和中央网络所有权限制写操作 |
| 连接与指标 | `proxy-rpc`、指标导出、历史能力与查询、`/api/v1/server/resources` |

表中简写的网络子路径均以 `/api/v1` 为前缀。外部认证控制器模式按 `console-info.webhook_auth` 隐藏本地中央管理流程，保留可用的设备实例读取。

移出网络保留设备记录及管理访问令牌；凭据成员关联的该网络入网凭据会随成员移除。删除设备、删除管理访问令牌与移出网络是不同操作。配置保存后展示 `pending`、`waiting_offline`、`applied`、`failed`、`unknown`，以节点确认判断应用结果。

实时流量按 uint64 精确差分，首次采样、计数回退或读取失败时速率未知。资源缺失显示“—”，主机采样15秒、磁盘采样90秒后标过期；服务器资源403停止请求并隐藏该区块。历史查询只在后端明确启用时运行，缺失采样保留断点。

## 设计依据

界面采用平面设计：白色与浅灰、细边界、紧凑布局、圆角按钮与弹窗编辑。后端权限及业务语义保留。

按钮全部描边或文字，不使用实心填充；输入focus不增加阴影、边框粗细或字体粗细；只保留一级导航，编辑使用弹窗。无拟物凸起、内阴影、多级菜单或抽屉。遵循键盘焦点、文字对比度、移动布局和reduced-motion。详见 [DESIGN.md](DESIGN.md)。

界面已去除副标题、字段小字提示、空状态引导和静态解释图例；实际数据、状态、错误及必要确认仍可查看。

网络拓扑图已按用户要求移除。概览保留设备、网络和服务器资源；网络详情的节点观测只采集当前选中的在线节点，提供连接、路由与指标列表。节点参数采用共享表单，与原项目选项核对一致，接收速率上限的单位为B/s；表单保存提交最新字段，TOML切换保留配置。IPv6端口转发仅在提交副本中适配后端所需的地址格式。


## 字体与国际化

Inter处理英文和数字，HarmonyOS Sans SC处理中文；代码编辑器使用等宽字体。字体来自Google Fonts和Huawei官方，保留原始分片、unicode-range及许可，只预载Inter Latin；实际字体和许可见`public/fonts/font-notices.html`。没有自行修改鸿蒙字形或字体文件。

使用i18next、react-i18next、i18next-http-backend，支持zh-CN/en，翻译按namespace加载。新增页面在`public/locales/{zh-CN,en}`维护相同key和插值；用户数据、UUID、TOML和协议字段不翻译。语言选择仅保存`easytier.locale`，不保存凭据；状态、通知、请求错误、ARIA和日期跟随语言。

## 验证与预览边界

`pnpm test` 执行当前 `package.json` 中列出的回归测试，覆盖精确uint64、未知/零值/过期/历史断点、IPv6继承、未编辑字段与嵌套值保留、IPv6转发序列化及实际字段校验。测试不读取私有数据、不访问网络，使用 Vite 已有的 esbuild 临时加载 TS 模块并清理输出。

本机预览可以使用独立数据库和本地 no-TUN Core 进程验证真实 API、资源和连接流程，但不等同于 Windows 或 Android 实机的 VPN 连通性验证。历史存储只有在后端启用并产生真实采样时才展示数据；未启用状态应如实显示。

具体交付版本以对应 Release 的安装包、源码提交、构建信息、校验和及验证记录为准。前端静态包、服务端和各平台客户端的构建与部署状态分别核对，不以文档或界面版本号替代实际运行文件的验证，也不将浏览器测试视为客户端实机测试。
