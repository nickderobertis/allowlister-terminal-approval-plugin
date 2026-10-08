# AGENTS — tests/e2e (terminal-approval-e2e)

- These drive the compiled plugin binary, never the library: assert on the exit
  status, the `{verdict, reason}` stdout and, for the prompt, the terminal
  transcript — not merely that it starts.
- The binary is another crate's, so there is no `CARGO_BIN_EXE_*` here:
  `assert_cmd::cargo::cargo_bin` finds it beside the test executable
  (`target/debug`, or the instrumented copy in `target/llvm-cov-target/debug`).
  Run through `just test-e2e`, whose target builds it first — never against a
  stale build.
- This crate's `CARGO_PKG_VERSION` is a placeholder; compare against the plugin
  crate's version read from the root `Cargo.toml` (`plugin_version()`).
- The interactive prompt needs a real controlling terminal: allocate a PTY and
  make the child its session leader (`terminal.rs`, unix-only). Never pipe an
  `ask` payload without one — it would block on the runner's terminal.
- Nothing may depend on this project except the repo-level coverage aggregate
  (`tools/project-boundaries.json`).
