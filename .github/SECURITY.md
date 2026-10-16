# Security policy

[简体中文](SECURITY.zh-CN.md) | English

This policy applies to [alniyata-firefly/easytier](https://github.com/alniyata-firefly/easytier), a downstream adaptation of [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier) under the repository's [LGPL-3.0 license](../LICENSE). Upstream reporting channels and support commitments do not automatically apply to this fork.

## Affected versions

Include the downstream release and full commit ID in a report, together with Core and GUI versions when they differ. Where practical, confirm whether current `main` is affected. This fork has no published long-term-support or older-version backport schedule; do not assume an upstream fix is already included in a downstream package.

## Reporting a vulnerability

Check [this repository's Security page](https://github.com/alniyata-firefly/easytier/security). If it offers **Report a vulnerability**, use that private form. This policy does not imply that GitHub private vulnerability reporting is enabled.

If a private form is unavailable, open a minimal [issue in this fork](https://github.com/alniyata-firefly/easytier/issues/new) asking how to arrange confidential reporting. Do not include the vulnerability, exploit, affected private endpoints, or credentials in that public request. Agree on a confidential channel with the maintainers before sending details. Do not send a downstream-only report to an upstream contact by default.

A useful confidential report contains:

- the affected release or commit and component;
- the platform and minimal configuration with secrets removed;
- the impact, prerequisites, and reproducible steps or minimal proof of concept;
- any known workaround and whether upstream is also affected.

Agree on disclosure before publishing exploit details. This repository does not promise a particular response deadline. Test only systems you are authorized to assess, avoid service disruption and access to other users' data, and never attach live tokens, private keys, signing files, or an unredacted runtime database.
