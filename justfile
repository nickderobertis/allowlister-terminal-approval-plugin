# allowlister-terminal-approval-plugin task runner.
#
# Conventions:
# - Successful recipes print little or nothing beyond the tool's own output.
# - Failing recipes preserve actionable output (paths, lints, diffs, codes).
# - Every recipe pins dependencies with `--locked`.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Minimum coverage enforced by `test-cov`, applied to lines, functions, and
# regions alike (a miss in any fails the command). Actual coverage sits above
# this; what remains uncovered is defensive terminal I/O that cannot fail under
# test. New code that adds reachable branches should ship with tests rather than
# lean on the margin.
cov-min := "95"

# Pinned developer tool versions (installed by `bootstrap`). CI installs the
# latest of each via taiki-e/install-action; these pins keep local setups
# reproducible.
nextest-version := "0.9.137"
llvmcov-version := "0.8.7"
deny-version := "0.19.8"
machete-version := "0.9.2"

_default:
    @just --list --unsorted

# Provision the dev toolchain: fetch deps, install the cargo subcommands the gate
# needs, and git hooks. Idempotent — safe to re-run and a no-op over anything
# already present. Prefers prebuilt binaries (cargo-binstall) and falls back to a
# source build so a network-restricted environment can still provision.
bootstrap:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo fetch --locked
    install_tool() {
        local spec="$1" bin="${1%@*}"
        command -v "$bin" >/dev/null && return 0
        if command -v cargo-binstall >/dev/null; then
            cargo binstall --no-confirm --disable-telemetry "$spec" && return 0
        fi
        echo "» building $spec from source"
        cargo install --locked --force "$spec"
    }
    install_tool "cargo-nextest@{{nextest-version}}"
    install_tool "cargo-llvm-cov@{{llvmcov-version}}"
    install_tool "cargo-deny@{{deny-version}}"
    install_tool "cargo-machete@{{machete-version}}"
    # lefthook is a Go binary (no cargo source build): install the prebuilt if
    # reachable, otherwise warn rather than fail.
    if ! command -v lefthook >/dev/null && command -v cargo-binstall >/dev/null; then
        cargo binstall --no-confirm --disable-telemetry lefthook \
            || echo "! lefthook unavailable; install it manually to enable git hooks"
    fi
    command -v lefthook >/dev/null && lefthook install || echo "» skipping git hooks (lefthook missing)"
    echo "✓ bootstrap complete"

# Fetch locked dependencies and confirm the pinned toolchain is present.
sync:
    cargo fetch --locked
    @rustc --version

# Run the plugin with a JSON payload on stdin, e.g.
# `echo '{"current_verdict":"allow"}' | just run`.
run *args:
    @cargo run --quiet --locked -- {{args}}

# Format the workspace in place.
format:
    cargo fmt --all

# Alias for `format`.
fmt: format

# Check formatting without writing (fails on any diff).
fmt-check:
    cargo fmt --all --check

# Type-check all targets and features (a phase of the `check` gate).
typecheck:
    cargo check --locked --all-targets --all-features

# Lint with every warning treated as an error.
lint:
    cargo clippy --locked --all-targets --all-features -- -D warnings

# Alias for `lint`.
clippy: lint

# Apply machine-applicable clippy fixes.
clippy-fix:
    cargo clippy --fix --allow-dirty --allow-staged --locked --all-targets --all-features

# Unit tests (library + binary): excludes the slower integration/e2e suite.
test:
    cargo nextest run --locked --status-level fail -E 'not kind(test)'

# The end-to-end suite that drives the compiled binary (stdin/stdout and the
# real `/dev/tty` prompt under a PTY).
test-e2e:
    cargo nextest run --locked --status-level fail -E 'kind(test)'

# Enforce line, function, and region coverage across all tests (unit + e2e); a
# miss in any one fails. `main.rs` (the thin I/O shell, driven by e2e) and the
# test sources themselves are excluded from the denominator.
test-cov:
    cargo llvm-cov nextest --locked --all-features \
        --ignore-filename-regex '(src/main\.rs|tests/)' \
        --fail-under-lines {{cov-min}} \
        --fail-under-functions {{cov-min}} \
        --fail-under-regions {{cov-min}}

# Build the API docs (warnings are errors).
doc:
    RUSTDOCFLAGS="-D warnings" cargo doc --locked --no-deps --all-features

# Security advisories for the dependency tree.
security:
    cargo deny --locked check advisories

# Dependency hygiene: bans, licenses, sources, and unused dependencies.
deps-check:
    cargo deny --locked check bans licenses sources
    cargo machete

# --- LLM-judge tier (llmlint) ------------------------------------------------
# Non-deterministic and needs an authenticated harness, so it is NOT part of
# `just check`; config lives in `llmlint.yml`.

# Install oneharness + llmlint (idempotent). Wired into the SessionStart hook.
setup-llmlint:
    @bash scripts/setup-llmlint.sh

# Run the LLM-judge over the configured set (or given paths). Quiet on success;
# on a missing binary, points at `just setup-llmlint`.
lint-llm *paths:
    llmlint {{paths}}

# Diff-scoped LLM-judge: only the lines this branch changed since main. This is
# the blocking PR check (its own CI workflow, separate from `check`).
lint-llm-diff *args:
    @bash scripts/lint-llm-diff.sh {{args}}

# Check the crate against its declared minimum supported Rust version.
# Requires the MSRV toolchain (`rustup toolchain install 1.88.0`).
msrv:
    cargo +1.88.0 check --locked --all-targets --all-features

# Install git hooks (needs lefthook).
hooks-install:
    lefthook install

# Run the pre-commit hook set against the working tree.
hooks:
    lefthook run pre-commit --all-files

# Debug build.
build:
    cargo build --locked

# Optimized release build (the shipped profile). With no argument, builds for the
# host (the dev gate and install-smoke); with a target triple, cross-compiles for
# that target (the per-platform release binaries in publish.yml).
build-release target="":
    cargo build --release --locked {{ if target != "" { "--target " + target } else { "" } }}

# Full quality gate. Stops at the first failing phase; minimal output on success.
# This is THE gate: format, type-check, lint, the full test suite (unit +
# integration + real-terminal e2e), enforced coverage, then dependency/security/
# docs/release checks. `bootstrap` then `check` is what CI runs and what proves
# the artifact; nothing here is warnings-only.
check:
    #!/usr/bin/env bash
    set -euo pipefail
    phase() { printf '\n» %s\n' "$1"; }
    phase "format";        just fmt-check
    phase "typecheck";     just typecheck
    phase "lint";          just lint
    phase "test";          just test
    phase "test-e2e";      just test-e2e
    phase "coverage";      just test-cov
    phase "deps-check";    just deps-check
    phase "security";      just security
    phase "docs";          just doc
    phase "release build"; just build-release
    printf '\n✓ check passed\n'

# Update dependencies and the lockfile, then re-run the full gate so the repo
# lands on current deps proven green. Review the diff before committing.
upgrade:
    cargo update
    @just check

# Remove build artifacts.
clean:
    cargo clean

# Noisy environment diagnostics (never part of the quality gate).
doctor:
    @echo "## toolchain" && rustc --version && cargo --version
    @echo "## tools" && for t in just cargo-nextest cargo-llvm-cov cargo-deny cargo-machete lefthook; do printf '%-16s ' "$t"; command -v "$t" || echo "MISSING"; done

lint-llm-validate:
    llmlint validate
