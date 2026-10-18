#!/usr/bin/env python3
"""Run explicit host-safe Rust regression scopes; fail on an empty selector.

These tests use synthetic Hosts, temporary files/SQLite and loopback/ring RPC.
They do not require a TUN, a real controller, production credentials or signing.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import shlex
import subprocess


ROOT = Path(__file__).resolve().parent.parent
PLAN = (
    ("easytier-proto", ("--lib",), ("api::tests::",)),
    ("easytier-core", ("--lib",), (
        "instance::config::tests::",
        "management::full::process_rpc::tests::",
        "management::full::remote_client::tests::",
        "instance::tests::portable_runtime::cancelled_delete_finishes_stop_and_keeps_wait_blocked",
    )),
    ("easytier", ("--lib",), (
        "common::log::tests::",
        "core::shutdown::tests::",
        "instance::config::tests::",
        "instance::config_storage::tests::",
    )),
    ("easytier-web", ("--bin", "easytier-web"), (
        "server_logs",
        "restful::server_resources::tests::",
        "db::management_connection_events::tests::",
        "db::device_rebind_requests::tests::",
        "client_manager::runtime_reconcile::tests::",
        "client_manager::session::runtime_revision::tests::",
        "client_manager::session::webhook_validation::tests::",
        "client_manager::session::lifecycle_tests::",
        "central_network::device_auth::tests::",
        "central_network::temporary_peers::tests::",
        "restful::network::tests::",
    )),
)

SERVER_LOGS_PLAN = (
    ("easytier", ("--lib",), ("common::log::tests::",)),
    ("easytier-web", ("--bin", "easytier-web"), (
        "server_logs",
        "restful::server_resources::tests::",
    )),
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Print the fixed test plan without invoking Cargo")
    parser.add_argument("--server-logs-only", action="store_true", help="Run only logger, server logs and server administrator authorization tests")
    args = parser.parse_args()
    failures = []
    for package, targets, scopes in SERVER_LOGS_PLAN if args.server_logs_only else PLAN:
        command = ["cargo", "test", "--locked", "-p", package, *targets]
        if not args.dry_run:
            # Listing compiles the actual test target first. Validate every
            # scope so module renames or disabled features cannot silently pass.
            listed = subprocess.run([*command, "--", "--list"], cwd=ROOT, text=True, stdout=subprocess.PIPE)
            if listed.returncode:
                failures.append(f"{package}: test target did not compile or list")
                continue
            tests = [line.removesuffix(": test") for line in listed.stdout.splitlines() if line.endswith(": test")]
        for scope in scopes:
            selected = [*command, scope, "--", "--test-threads=1"]
            if args.dry_run:
                print(shlex.join(selected))
                continue
            matching = [name for name in tests if scope in name]
            if not matching:
                failures.append(f"{package}: no tests match {scope}")
                continue
            print(f"Testing {package}: {scope} ({len(matching)} tests)", flush=True)
            if subprocess.run(selected, cwd=ROOT).returncode:
                failures.append(f"{package}: {scope} failed")
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
