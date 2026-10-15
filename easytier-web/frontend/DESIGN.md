# EasyTier 平面管理控制台设计规范

用户于2026-10-14明确取消原拟物方案。本文替代旧四份拟物简报的视觉要求，保留实际 API、权限、设备与网络行为。具体版本的构建、部署和验证状态以对应 Release 的交付记录为准。

## 设计与标识来源

本项目是 [EasyTier 的下游适配](../../README_CN.md#项目来源与下游改造)，上游为 [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier)，基线提交和代码许可见仓库 README 与 [LICENSE](../../LICENSE)。本文描述下游自行实现的 React Web、Windows 和 Android 界面约定，不代表 EasyTier 上游或 Ubiquiti 官方设计规范。

视觉参考包括 [UniFi Network 10.5 官方介绍](https://blog.ui.com/article/introducing-network-10-5)、[UniFi Design Center 机架演示](https://design.ui.com/projects/default/rack)和[拓扑演示](https://design.ui.com/projects/8176bab0-48eb-4465-877a-e81d52c5a815/topology)。参考范围是布局、信息密度、留白、控件和线性图标风格。本项目不是 Ubiquiti 官方项目，未获其官方背书，也不将参考站点视为商标或图标的授权来源。

统一品牌图标是本仓库自行绘制的[蓝色三节点 SVG](../../assets/brand/easytier.svg)：以三个节点和连线表达组网，网页图标、安装包与应用图标由同一份矢量标识生成。它不是从 UniFi 页面提取的 SVG，也不是 Ubiquiti 官方标识。上游原有作者、商标归属和许可说明继续保留。

HarmonyOS Sans SC 来自 Huawei 官方网页字体切片，遵循 [HarmonyOS Sans Fonts License Agreement](public/fonts/LICENSE-HarmonyOS-Sans.txt)；Inter 来自 Google Fonts，遵循 [SIL Open Font License 1.1](public/fonts/LICENSE-Inter-GoogleFonts.txt)。保留字体版权、协议、[来源清单](public/fonts/provenance.json)和[许可页面](public/fonts/font-notices.html)，不重新切割或修改官方字体文件。

## 依据与优先级

参考 UniFi Network 10.5 官方演示及 design.ui.com 的实际页面。官方站点顶栏约50px、导航约50px、主蓝色rgb(0,110,255)、控件小圆角和轻边界。用户要求优先：按钮采用描边或文字，禁止实心填充；输入焦点不加重阴影、边框或字体；全局平面布局和弹窗编辑，不做多级菜单和抽屉。内容模块用留白分隔，避免拼接成一片或套叠卡片。

## 配色与字体

主内容白色#ffffff；页面背景#f8f9fb；边界#e8ebef；正文#30343b；次要文字#626b78；强调#006eff。状态另用图标及文字表达。按钮、导航选中项不铺实色背景；正常内容不加阴影，弹窗允许低强度投影。

英文和数字Inter，中文HarmonyOS Sans SC，均同源自托管，font-display:swap。Inter采用原始Latin/Latin-ext WOFF2；鸿蒙采用Huawei官方原始网页切片，保留unicode-range与许可，不自行修改字体。正文400，标题/控件500，必要强调700。数值tabular-nums；代码编辑器保留等宽字体。

## 布局

桌面：简洁顶栏、唯一一级导航、独立主工作区。概览显示设备、网络和实际服务器资源，摘要为一行轻量数据。移动端：顶栏、导航弹窗、单列内容。网络和设备列表紧凑但可读；详细页仅使用必要分类tab。编辑使用原生modal dialog。用户已要求移除网络拓扑图，节点连接、路由和运行指标通过列表与表格查看。官方项目已通过授权的只读浏览器会话核对，作为平面布局、控件和图标风格的参考；未修改官方项目。

## 尺寸与交互

标题22px，正文13–14px，说明12px。桌面控件32–36px，手机触控44px；小控件圆角4px，模块/弹窗8px；细边界1px。间距8/12/16/24px。输入焦点保持原边框粗细、背景和字重，只有轻量颜色变化；无内阴影或凸起。所有图标统一24px画布、线条一致，表达网络、设备、配置、观测等已有业务。

页面不显示注释类说明：移除副标题、字段提示、空状态引导和静态解释图例。只显示操作名称、字段名称、实际数据和状态；保留动态错误、必要操作确认及凭据风险警告。配置表单须保留原项目全部有效配置能力，中央管理字段沿用原来的控制关系。

## 国际化与加载

使用i18next、react-i18next与官方HTTP backend；支持简体中文和English。翻译按页面namespace懒加载，切语言更新文案、状态、ARIA和日期格式。仅保存语言偏好，不保存明文凭据。页面路由按需加载；字体根据字重和unicode-range加载，禁止预载完整中文字体。

## 验收

检查真实浏览器desktop/tablet/mobile：无整页横溢，无旧拟物阴影/紫色，无filled按钮，modal焦点与ESC正常，中文/英文字体实际可用，两种语言关键页面可读，资源与节点观测真实。配置表单需核对原有字段、编辑、校验、保存和回读。使用已读取的官方frontend-design做布局和截图自检，React Best Practices用于hooks、按需加载与可访问性；用户明确选定的字体和样式优先于通用技能偏好。
