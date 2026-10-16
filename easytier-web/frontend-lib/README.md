# EasyTier 共享前端模块

本目录为本分支 React Web 与 React GUI 提供共享 TypeScript 模块：API 数据类型、Proto 生成类型、网络配置转换、格式化与配置校验。

活动 React 界面直接按需导入 `src/types`、`src/modules`、`src/node-config` 等模块，不通过会导出旧 Vue 组件的总入口打包。此目录仍保留上游可选 Vue 组件和样式；它们不进入当前默认 React 发行包，构建会核对实际模块图。

在仓库根目录安装锁定依赖后，使用当前工作流的 protoc 35.1 生成协议类型：

```sh
pnpm --dir easytier-web/frontend-lib codegen:proto
```

生成结果位于被 Git 忽略的 `src/generated/`。发布与平台构建使用 [当前工作流](../../docs/github-actions.md)，不运行旧的递归 Vue / WASM 全量构建来生成 React 页面。

修改配置字段须同时核对 TypeScript、JSON/Protobuf、TOML 与 Rust 转换，保留未编辑的未知字段、可选字段 presence 及 uint64 精度。来源与许可证见[仓库 README](../../README.md#项目来源与下游改造)和 [LICENSE](../../LICENSE)。
