# AGENTS — tools (workspace, coverage)

- Checks here span the whole workspace, so they run whenever a Rust crate or a
  project definition changes; keep them cheap.
- Every project needs a `project.json` with exactly one `type:*` tag, and every
  Cargo member one beside its `Cargo.toml`; a new tag needs a constraint in
  `project-boundaries.json`. Express a real dependency as a Cargo path dependency
  or `implicitDependencies` — the checker reads both and reconciles the latter
  with `nx graph`. Nx selects affected projects by file ownership, never by a
  target's `{workspaceRoot}` inputs.
- `coverage/coverage.sh` owns the 95% floor and its exclusions; each Rust
  project's `test` target writes profiles through it, and `coverage:coverage`
  merges them; `coverage:test` drives the script against a stand-in cargo. Never
  lower the floor to pass.
- Scripts use Node built-ins and bash only (no npm imports), so they run without
  the Nx install; tests drive them on scratch copies of the real tree.
