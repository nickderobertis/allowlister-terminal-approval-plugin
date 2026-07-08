# AGENTS.md

Durable instructions for humans and agents in this repo. Write for a future
maintainer, not as a session log. Keep it terse — it is always-loaded context.
`CLAUDE.md` is a symlink to this file; edit `AGENTS.md` only.

## What this repo is

The **allowlister terminal approval experience** as a standalone
[allowlister](https://github.com/nickderobertis/allowlister) dynamic approval
plugin. On an `ask` verdict it renders the flagged command fragments (or tool
call) on the controlling terminal (`/dev/tty`) and returns the operator's
allow/deny; on any other verdict it defers. Shipped two ways:

- a **library** (`allowlister_terminal_approval`) whose prompt renderer and
  `/dev/tty` runner power [allowlister-remote](https://github.com/nickderobertis/allowlister-remote)'s
  local-approval race — the reason it lives in its own repo;
- a **binary** (`allowlister-terminal-approval-plugin`), distributed on
  crates.io and npm, that allowlister runs per gated command.

## Stack and composition

Built from the create-repo references (`compose_repo_plan.py --shape cli
--language rust --releasing`; see `REPO_PLAN.md`).

- **Product shape:** cli (a spawn-once allowlister plugin)
- **Language(s):** rust
- **References composed:** base.md, shapes/cli.md, languages/rust.md, intersections/rust-cli.md, ci.md, releasing.md, llmlint.md
- **Distribution:** crates.io (library) + npm carrier with per-platform native
  binaries (the plugin) + GitHub Release archives. Mirrors allowlister's
  release-plz/`.cargo` setup and allowlister-remote's npm-carrier pattern.
- **Excluded, and why:**
  - *Windows target* — the terminal experience *is* `/dev/tty`; the crate still
    compiles on Windows (so remote's Windows build is unaffected) but the binary
    ships for unix only, where it does something. A Windows `CONIN$`/`CONOUT$`
    prompt is a possible follow-up.
  - *Perf/bench suite* — the plugin is a trivial spawn-once decision with no perf
    surface worth gating; `.cargo/config.toml` already tunes cold start.

## Command surface

Use the `just` recipes; do not hand-roll equivalents.

- `just bootstrap` — provision from a clean clone (deps + cargo subcommands + hooks).
- `just check` — the full gate (format, type-check, lint, unit + e2e, coverage,
  deps/security, docs, release build). Must pass before any commit or PR.
- `just test` / `just test-e2e` / `just lint` / `just format` — individual steps.
- `just upgrade` — update deps then re-run `just check`.
- `just lint-llm` / `just lint-llm-diff` — the LLM-judge tier (llmlint), separate
  from `check` and non-deterministic; config in `llmlint.yml`, `just setup-llmlint`
  installs it. `lint-llm-diff` is the blocking, diff-scoped PR check.

## Commits, releases, and merging

- **Squash-merge only, via PR, with auto-merge.** The default branch is
  protected: merge/rebase disabled, so one PR is one squash commit whose subject
  is the PR title (Conventional Commits — enforced by the `pr-title` check).
  Queue with `gh pr merge --auto --squash`; merged head branches auto-delete.
- **All gating checks required:** `test (ubuntu-latest)`, `test (ubuntu-24.04-arm)`,
  `test (macos-latest)`, `install-smoke`, `pr-title`, and `llmlint` (the LLM-judge
  tier, separate from `check`; needs the `CLAUDE_CODE_OAUTH_TOKEN` secret), plus linear
  history and no force-push. Releases also need `RELEASE_PLZ_TOKEN`, `NPM_TOKEN`,
  `CARGO_REGISTRY_TOKEN` + the `PUBLISH_TO_CRATES_IO` variable — declared in
  `gh-secrets.json` (`gh-secrets sync`).
- **PRs follow `.github/pull_request_template.md`** (terse What/Why); it becomes
  the squash body.
- **Releases are fully automated (release-plz).** A Conventional-Commit push to
  `main` opens/updates a release PR that bumps `Cargo.toml` + `CHANGELOG.md`;
  auto-merge tags `vX.Y.Z`, which fires `publish.yml`: it builds the per-platform
  binaries, cuts the GitHub Release with checksums, publishes to crates.io
  (gated on `PUBLISH_TO_CRATES_IO`), and publishes the npm carrier. No manual
  version edits, tags, or deploys.

## Invariants (non-negotiable)

- Strict gate, no warnings-only mode. Coverage ≥ 95% (lines/functions/regions).
- **Tests drive the real binary across real boundaries** — never mock the layer
  under test. The interactive prompt is exercised under a real PTY (`tests/terminal.rs`).
- Validate external input (the stdin payload) at the boundary.
- Never commit secrets; keep every grant (agent allowlist, CI token) least-privilege.

## Conventions

- **The prompt output is a contract shared with allowlister-remote.**
  `local_prompt` is parameterized only by `PromptLabels` (banner + instruction);
  everything else is identical across products. `lib.rs` has a test proving
  remote's exact wording still renders, so remote can consume this crate without
  changing its terminal UX. Change the shared body deliberately.
- **The plugin protocol is allowlister's**, snake_case (`current_verdict`,
  `command`, `fragments`, `tool.raw`, …), protocol v3. Additive: read what you
  need, ignore unknown fields. See allowlister's "Dynamic approval plugins".
- **`main.rs` is the thin I/O shell** (excluded from coverage); judgment lives in
  the library. `run_prompt_loop` is the unit-tested seam behind the `/dev/tty` I/O.

## Keeping the allowlist current

The agent command allowlist lives in `.claude/settings.json`; the tool enforces
it. Keep it current — add a new routine command rather than re-approving it each
session; keep it narrow.

## After the main task

Act on two standing goals every task, folding them in when they're the
lowest-error path and proposing the rest as follow-ups: (1) engineer the context
for next time (real e2e for what the user sees, scripts that shrink output to
signal, terse notes here); (2) keep the codebase and environment clean,
repeatable, and reproducible (`just bootstrap` from a clean clone). Skip busywork.
