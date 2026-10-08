#!/usr/bin/env bash
# The coverage gate, in three steps over cargo-llvm-cov's one profile directory
# (target/llvm-cov-target):
#
#   coverage.sh clear          drop every raw profile and instrumented artifact
#   coverage.sh test <crate>   run one crate's tests instrumented, keep the profiles
#   coverage.sh report         merge every crate's profiles; fail below the floor
#
# Each Rust project's `test` target is step two, `coverage:coverage-clear` step one
# and `coverage:coverage` step three, so the floor is enforced once over the union
# of both crates' runs: the terminal-approval-e2e journeys count toward the lines of
# the plugin crate they drive, exactly as the single pre-split run counted them.
# `--no-report` is what lets the crates share the directory (a reporting run would
# clear it first).
#
# The floor applies to lines, functions and regions alike — a miss in any fails —
# over the plugin crate's sources, excluding src/main.rs (the thin I/O shell, only
# reachable as the spawned binary) and every test file under tests/. What remains
# uncovered is defensive terminal I/O that cannot fail under test; new reachable
# branches ship with tests rather than lean on the margin. Never lower the floor
# to pass.
#
# Exit status: 0 success; 1 a test run, the report, or the floor failed; 2 a usage
# error (unknown step, wrong argument count, or a crate that is not a member).
set -euo pipefail

readonly COV_MIN=95
readonly IGNORE_REGEX='(src/main\.rs|tests/)'
readonly PLUGIN_CRATE="allowlister-terminal-approval-plugin"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ROOT
cd "$ROOT"

usage() {
  echo "coverage: $1" >&2
  echo "usage: tools/coverage/coverage.sh clear | test <crate> | report" >&2
  exit 2
}

[ $# -ge 1 ] || usage "no step given"
readonly STEP="$1"
case "$STEP" in
  clear | report) [ $# -eq 1 ] || usage "'$STEP' takes no arguments (got $(($# - 1)))" ;;
  test) [ $# -eq 2 ] || usage "'test' takes exactly one crate name (got $(($# - 1)) arguments)" ;;
  *) usage "unknown step '$STEP'" ;;
esac

require() {
  local out
  if ! out="$(cargo "$1" --version 2>&1)"; then
    printf '%s\n' "$out" >&2
    echo "coverage: 'cargo $1 --version' failed (above) — cargo-$1 is missing; run 'just bootstrap'." >&2
    exit 1
  fi
}

# The crate must be a workspace member: unchecked, a typo would measure nothing
# and pass. Members are read from `cargo metadata` (JSON parsed by Node, which the
# Nx toolchain already provides).
validate_crate() {
  local crate="$1" metadata members
  printf '%s' "$crate" | grep -Eq '^[a-z0-9][a-z0-9-]*$' \
    || usage "'$crate' is not a crate name (lowercase letters, digits, -)."
  if ! metadata="$(cargo metadata --format-version 1 --no-deps --locked 2>&1)"; then
    printf '%s\n' "$metadata" >&2
    echo "coverage: 'cargo metadata' failed (above); fix the manifests or Cargo.lock it names, then re-run." >&2
    exit 1
  fi
  if ! members="$(printf '%s' "$metadata" | node -e '
    const m = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const str = (v) => typeof v === "string" && v.length > 0;
    if (!Array.isArray(m.workspace_members) || !m.workspace_members.every(str)) throw new Error("workspace_members is not a list of package ids");
    if (!Array.isArray(m.packages) || !m.packages.every((p) => p && str(p.id) && str(p.name))) throw new Error("packages are not {id, name} objects");
    const ids = new Set(m.workspace_members);
    console.log(m.packages.filter((p) => ids.has(p.id)).map((p) => p.name).join("\n"));
  ' 2>&1)"; then
    printf '%s\n' "$members" >&2
    echo "coverage: could not read the workspace members from 'cargo metadata' (above); check the cargo version, and that node is on PATH ('just bootstrap')." >&2
    exit 1
  fi
  printf '%s\n' "$members" | grep -qxF -- "$crate" \
    || usage "'$crate' is not a member of this workspace; pass one of: $(printf '%s ' $members)"
}

case "$STEP" in
  clear)
    require llvm-cov
    cargo llvm-cov clean --workspace
    ;;

  test)
    readonly CRATE="$2"
    validate_crate "$CRATE"
    require llvm-cov
    require nextest
    # A suite that spawns the binary finds it beside its own test executables,
    # i.e. in target/llvm-cov-target/debug; build the instrumented copy there
    # first. Its one `--version` run adds a profile covering only the argument
    # handling a journey runs anyway.
    if [ "$CRATE" != "$PLUGIN_CRATE" ]; then
      if ! out="$(cargo llvm-cov --no-report run -p "$PLUGIN_CRATE" --bin "$PLUGIN_CRATE" --locked -- --version 2>&1)"; then
        printf '%s\n' "$out" >&2
        echo "coverage: building the instrumented $PLUGIN_CRATE binary failed (above); fix the build error, then re-run 'just test-e2e'." >&2
        exit 1
      fi
    fi
    exec cargo llvm-cov --no-report nextest -p "$CRATE" --locked --all-features --status-level fail
    ;;

  report)
    require llvm-cov
    if ! out="$(cargo llvm-cov report --summary-only --ignore-filename-regex "$IGNORE_REGEX" \
      --fail-under-lines "$COV_MIN" --fail-under-functions "$COV_MIN" --fail-under-regions "$COV_MIN" 2>&1)"; then
      printf '%s\n' "$out" >&2
      if printf '%s\n' "$out" | grep -q '^TOTAL '; then
        echo "coverage: below the ${COV_MIN}% floor (lines, functions or regions) over the unit + e2e runs; cover the gap with a test that drives the real behaviour." >&2
      else
        echo "coverage: no report could be produced (reason above); the crates' test targets must run first ('just test-cov')." >&2
      fi
      exit 1
    fi
    printf '%s\n' "$out" | grep '^TOTAL '
    ;;
esac
