# 安全策略

简体中文 | [English](SECURITY.md)

本策略适用于 [alniyata-firefly/easytier](https://github.com/alniyata-firefly/easytier)。本项目基于上游 [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier) 适配，遵循仓库中的 [LGPL-3.0 许可证](../LICENSE)。上游的报告渠道和支持承诺不自动适用于本分支。

## 受影响版本

报告时请提供本分支的发布版本及完整提交 ID；Core 与 GUI 版本不同时请分别注明。条件允许时，确认当前 `main` 是否仍受影响。本分支没有公布长期支持或旧版本回移计划，也不能假定上游修复已包含在下游安装包中。

## 报告安全漏洞

请查看[本仓库的 Security 页面](https://github.com/alniyata-firefly/easytier/security)。如果页面提供 **Report a vulnerability**，请使用该私密表单。本策略不代表仓库已经启用 GitHub 私有漏洞报告功能。

如果没有私密表单，请在[本分支新建一个最简 Issue](https://github.com/alniyata-firefly/easytier/issues/new)，仅询问如何安排保密报告。该公开请求中不要包含漏洞、利用方式、受影响的私有地址或凭据。与维护者确认保密渠道后，再提供详细内容。下游独有的问题不要默认发送给上游联系人。

一份有效的保密报告应包括：

- 受影响的发布版本或提交及组件；
- 平台信息，以及移除敏感信息后的最小配置；
- 影响、触发前提、复现步骤或最小概念验证；
- 已知的临时措施，以及上游是否也受影响。

请先协商披露方式，再公开利用细节。本仓库没有承诺固定响应期限。仅测试已获授权的系统，避免干扰服务或访问其他用户的数据；不要附带有效令牌、私钥、签名文件或未经脱敏的运行数据库。
