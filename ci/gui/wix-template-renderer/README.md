# WiX template renderer

This standalone diagnostic uses `handlebars = 6.3.0` and
`serde_json = 1.0.140`, the exact versions in the official
[Tauri CLI 2.7.1 source tag](https://github.com/tauri-apps/tauri/tree/tauri-cli-v2.7.1).
Its renderer follows the WiX bundler's `Handlebars::new()`,
`register_escape_fn(handlebars::no_escape)`, `register_template_string`, and
`render` sequence. It retains Tauri's default non-strict template mode.

The command accepts `<template> <context.json> <output>`. Inputs and output are
UTF-8; the context must be a JSON object. Errors use fixed messages and never
print template contents, context values, or raw Rust error details.

The checked-in `Cargo.lock` was derived with Python TOML parsing, without
running Cargo. It contains the complete upstream dependency closure of the two
direct dependencies: 74 registry packages plus this diagnostic package. Every
upstream package record retains its original version, registry source,
checksum, and dependency edges, including version-qualified dependency names.
The source files used were fetched from the official source tag:

| Source | SHA-256 |
| --- | --- |
| Root `Cargo.lock` | `044141034fdbd513086fa0ce998b17a83c27ca751e749a52a0cb19c10030f18e` |
| `tauri-bundler/Cargo.toml` | `d9e25b48645c0e0ff46ebc9cbae29f9240f410a3f61a3818cbd6f8cecc5c1ab9` |
| WiX bundler module | `74380283ad0557e8d9c4eaf7c942e4632d730386744a7afaca36d3ecf17c3b68` |

The upstream workspace enables features that this small crate does not need.
Windows CI copies the crate to a temporary directory and runs `cargo metadata`
without compiling. Cargo may trim inactive dependency edges and packages in
that temporary lockfile. Before compilation, CI compares every resolved
registry package's version, source, and checksum against the checked-in closure,
rejects added or changed identities, and enforces the two exact direct versions.
Only after that validation does CI run `cargo build --locked --release`.
It validates the lock again after the build and records both original and
resolved lock hashes. The checked-in files are not rewritten by CI. No local
Cargo or native execution is needed to prepare this renderer.
