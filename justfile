# allowlister-terminal-approval-plugin task runner.
#
# Conventions:
# - Successful recipes print little or nothing beyond the tool's own output.
# - Failing recipes preserve actionable output (paths, lints, diffs, codes).
# - Every recipe pins dependencies with `--locked`.
# - The gate recipes DELEGATE to Nx (`tools/nx`): each project.json declares
#   what its targets run; the root only chooses which projects run them, by tier
#   (`affected`, the default, from the explicit base tools/nx-base.sh prints; or
#   `all`, the full sweep over every project). A mistyped tier aborts rather than
#   quietly buying a weaker one.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

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
    # Nx (the orchestrator every gate recipe delegates to) and the npm carrier
    # workspace, from the locked package-lock.json; tools/nx runs `npm ci`
    # whenever the lock moved.
    bash tools/nx --version >/dev/null
    echo "✓ bootstrap complete"

# Fetch locked dependencies and confirm the pinned toolchain is present.
sync:
    cargo fetch --locked
    @rustc --version

# Run the plugin with a JSON payload on stdin, e.g.
# `echo '{"current_verdict":"allow"}' | just run`.
run *args:
    @cargo run --quiet --locked -- {{args}}

# Run Nx targets at a tier: `affected` (the projects this change can reach, from
# an explicit merge base: NX_BASE when set, else the merge base with origin/main)
# or `all` (every project). Static output inlines every task's log, so a failing
# target's findings appear in the recipe's output.
[private]
nx-tier tier +args:
    #!/usr/bin/env bash
    set -euo pipefail
    case {{ quote(tier) }} in
        affected) base="$(bash tools/nx-base.sh)"; exec bash tools/nx affected --base="$base" --output-style=static {{ args }} ;;
        all) exec bash tools/nx run-many --output-style=static {{ args }} ;;
        *) printf "unknown tier '%s' — use 'affected' (the default) or 'all'\n" {{ quote(tier) }} >&2; exit 2 ;;
    esac

# Format in place (each project's `format` target).
format tier="affected": (nx-tier tier "-t format")

# Alias for `format`.
fmt tier="affected": (format tier)

# Check formatting without writing (fails on any diff).
fmt-check tier="affected": (nx-tier tier "-t format-check")

# Type-check all targets and features of each crate (a phase of the `check` gate).
typecheck tier="affected": (nx-tier tier "-t typecheck")

# Lint with every warning treated as an error: clippy per crate, plus the
# project-graph module boundaries (workspace:lint).
lint tier="affected": (nx-tier tier "-t lint")

# Clippy (-D warnings) over the Rust crates only: their `lint` targets.
clippy tier="affected": (nx-tier tier "-t lint --projects=tag:lang:rust")

# Apply machine-applicable clippy fixes across the workspace.
clippy-fix:
    cargo clippy --fix --allow-dirty --allow-staged --locked --workspace --all-targets --all-features

# Every test target except the binary-driving e2e suite: the crate's unit tests,
# the npm carrier's suite, and the tooling and workflow-contract suites.
test tier="affected": (nx-tier tier "-t test --exclude=tag:type:e2e")

# The end-to-end suite that drives the compiled binary (stdin/stdout and the
# real `/dev/tty` prompt under a PTY): terminal-approval-e2e:test, after
# terminal-approval:build. `check` runs it too.
test-e2e tier="affected": (nx-tier tier "-t test --projects=tag:type:e2e")

# Enforce 95% line, function, and region coverage over the unit + e2e runs:
# coverage:coverage runs after both crates' instrumented `test` targets and
# merges their profiles; the floor lives in tools/coverage/coverage.sh.
test-cov tier="affected": (nx-tier tier "-t coverage")

# Build the API docs (warnings are errors).
doc tier="affected": (nx-tier tier "-t doc")

# Supply chain: cargo-deny (advisories, bans, licenses, sources) + cargo-machete.
supply-chain tier="affected": (nx-tier tier "-t supply-chain")

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

# Diff-scoped LLM-judge, using llmlint's native diff scoping: a plain
# `--diff-base <ref>` takes the fork-point (merge-base) range, so only the files
# this branch changed since it forked from BASE are linted, and the judge reviews
# only their changed lines. This is the blocking PR check (its own CI workflow,
# separate from `check`). BASE defaults to origin/main (fetch it first if your
# clone lacks it); extra arguments are forwarded to llmlint.
lint-llm-diff base="origin/main" *args:
    llmlint --diff --diff-base "{{base}}" {{args}}

# Check every crate against the declared minimum supported Rust version.
# Requires the MSRV toolchain (`rustup toolchain install 1.88.0`).
msrv:
    @bash tools/nx run workspace:msrv --output-style=static

# Install git hooks (needs lefthook).
hooks-install:
    lefthook install

# Run the pre-commit hook set against the working tree.
hooks:
    lefthook run pre-commit --all-files

# Debug build of the plugin (terminal-approval:build).
build:
    @bash tools/nx run terminal-approval:build --output-style=static

# Optimized release build for the host: the terminal-approval:release-check
# target the gate runs.
release-check:
    @bash tools/nx run terminal-approval:release-check --output-style=static

# Optimized release build (the shipped profile). With no argument, builds for the
# host (the dev gate and install-smoke); with a target triple, cross-compiles for
# that target (the per-platform release binaries in publish.yml).
build-release target="":
    cargo build --release --locked {{ if target != "" { "--target " + target } else { "" } }}

# Full quality gate. This is THE gate: format check, type-check, lint (clippy and
# the project boundaries), every test target (unit, the real-terminal e2e, the npm
# carrier's suite, the tooling and workflow-contract suites), enforced coverage
# over the unit + e2e runs, docs, the release build, and the supply chain — over
# the projects this change can reach, or every project with `just check all`
# (the full sweep: the release-PR run and the release re-gate). `bootstrap` then
# `check` is what CI runs; nothing here is warnings-only, and any failing target
# fails the recipe.
check tier="affected": (nx-tier tier "-t format-check lint typecheck test build doc release-check coverage supply-chain")

# Update the Rust dependencies and Cargo.lock, then re-run the gate as the full
# sweep: an upgrade can reach any project, so the affected set would understate
# it. Review the diff before committing. The Nx toolchain is pinned exactly in
# package.json and bumped deliberately, not here.
upgrade:
    cargo update
    @just check all

# Remove build artifacts.
clean:
    cargo clean

# Noisy environment diagnostics (never part of the quality gate).
doctor:
    @echo "## toolchain" && rustc --version && cargo --version
    @echo "## tools" && for t in just node npm cargo-nextest cargo-llvm-cov cargo-deny cargo-machete lefthook; do printf '%-16s ' "$t"; command -v "$t" || echo "MISSING"; done

# Fast, deterministic llmlint gate — no model calls, no harness credential: config
# structure, that every `llmlint: ignore` directive names a real rule, and that
# edited versioned fragments bumped their `version:`. Arguments are forwarded
# (CI passes `--diff-base origin/main` to scope the version-bump check).
lint-llm-validate *args:
    llmlint validate {{args}}
