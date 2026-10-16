# EasyTier 平面管理控制台设计规范

本文定义本分支 React Web、桌面和 Android 界面的布局与交互约定。构建、部署和验证状态以对应发行记录为准。

## 标识与字体

代码来源和许可见[仓库 README](../../README.md#项目来源与下游改造)及 [LICENSE](../../LICENSE)。统一标识使用本仓库自行绘制的[三节点 SVG](../../assets/brand/easytier.svg)，网页图标、安装包和应用图标由同一份矢量文件生成。

HarmonyOS Sans SC 来自 Huawei 官方网页字体切片，遵循 [HarmonyOS Sans Fonts License Agreement](public/fonts/LICENSE-HarmonyOS-Sans.txt)；Inter 来自 Google Fonts，遵循 [SIL Open Font License 1.1](public/fonts/LICENSE-Inter-GoogleFonts.txt)。保留版权、[来源清单](public/fonts/provenance.json)和[许可页面](public/fonts/font-notices.html)，不修改字体文件。

## 交互原则

按钮采用描边或文字，不使用实心填充；输入焦点不加重阴影、边框或字体。全局平面布局，编辑使用弹窗，不做多级菜单或抽屉。内容模块用留白分隔，避免拼接成一片或套叠卡片。

## 配色与字体

主内容白色#ffffff；页面背景#f8f9fb；边界#e8ebef；正文#30343b；次要文字#626b78；强调#006eff。状态另用图标及文字表达。按钮、导航选中项不铺实色背景；正常内容不加阴影，弹窗允许低强度投影。

英文和数字Inter，中文HarmonyOS Sans SC，均同源自托管，font-display:swap。Inter采用原始Latin/Latin-ext WOFF2；鸿蒙采用Huawei官方原始网页切片，保留unicode-range与许可，不自行修改字体。正文400，标题/控件500，必要强调700。数值tabular-nums；代码编辑器保留等宽字体。

## 布局

桌面：简洁顶栏、唯一一级导航、独立主工作区。概览显示设备、网络和实际服务器资源，摘要采用与下方内容对齐的 KPI 卡片。移动端：顶栏、导航弹窗、单列内容。网络和设备列表紧凑但可读；详细页仅使用必要分类tab。编辑使用原生modal dialog。用户已要求移除网络拓扑图，节点连接、路由和运行指标通过列表与表格查看。

## 尺寸与交互

标题22px，正文13–14px，说明12px。桌面控件32–36px，手机触控44px；小控件圆角4px，模块/弹窗8px；细边界1px。间距8/12/16/24px。输入焦点保持原边框粗细、背景和字重，只有轻量颜色变化；无内阴影或凸起。所有图标统一24px画布、线条一致，表达网络、设备、配置、观测等已有业务。

页面不显示注释类说明：移除副标题、字段提示、空状态引导和静态解释图例。只显示操作名称、字段名称、实际数据和状态；保留动态错误、必要操作确认及凭据风险警告。配置表单须保留原项目全部有效配置能力，中央管理字段沿用原来的控制关系。

## 国际化与加载

使用i18next、react-i18next与官方HTTP backend；支持简体中文和English。翻译按页面namespace懒加载，切语言更新文案、状态、ARIA和日期格式。仅保存语言偏好，不保存明文凭据。页面路由按需加载；字体根据字重和unicode-range加载，禁止预载完整中文字体。

## 验收

检查真实浏览器desktop/tablet/mobile：无整页横溢，无旧拟物阴影/紫色，无filled按钮，modal焦点与ESC正常，中文/英文字体实际可用，两种语言关键页面可读，资源与节点观测真实。配置表单需核对原有字段、编辑、校验、保存和回读。检查 hooks 清理、异步结果的目标一致性、按需加载和可访问性。
