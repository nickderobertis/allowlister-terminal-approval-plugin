#!/usr/bin/env bash
# Check every crate under the minimum supported Rust version, read from its one
# source: `rust-version` in Cargo.toml's [workspace.package] table (every member
# inherits it). A `1.88` there selects the `1.88.0` toolchain.
#
# Usage: tools/msrv.sh
# Exit status: cargo's own; 1 when the version cannot be read or its toolchain is
# not installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
cd "$ROOT"

version="$(awk '
  /^\[/ { in_table = ($0 == "[workspace.package]") }
  in_table && /^rust-version[ \t]*=/ { gsub(/.*=[ \t]*"|".*/, ""); print; exit }
' Cargo.toml)"
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+(\.[0-9]+)?$' \
  || { echo "msrv: Cargo.toml's [workspace.package] states no plain rust-version (got '$version')." >&2; exit 1; }
case "$version" in *.*.*) ;; *) version="$version.0" ;; esac

if ! rustup run "$version" rustc --version >/dev/null 2>&1; then
  echo "msrv: the $version toolchain is not installed; run 'rustup toolchain install $version', then re-run." >&2
  exit 1
fi
exec cargo "+$version" check --locked --workspace --all-targets --all-features
