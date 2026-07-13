#!/usr/bin/env bash
# SessionStart provisioner. Ensures just and the llmlint toolchain are ready for agent sessions.
set -eu
if ! command -v just >/dev/null 2>&1 && command -v uv >/dev/null 2>&1; then
  uv tool install rust-just >/dev/null 2>&1 || true
fi
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"
if [ -x scripts/setup-llmlint.sh ]; then
  scripts/setup-llmlint.sh
fi
