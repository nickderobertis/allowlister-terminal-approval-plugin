# allowlister-terminal-approval-plugin

The **allowlister terminal approval experience** as a standalone
[allowlister](https://github.com/nickderobertis/allowlister) dynamic approval
plugin — and the reusable library that powers
[allowlister-remote](https://github.com/nickderobertis/allowlister-remote)'s
local prompt.

When allowlister can't settle a shell command or tool call statically it emits an
`ask` verdict. This plugin turns that `ask` into a clear prompt on your
controlling terminal — the command fragments that actually tripped the gate
("needs your attention"), the full command, the cwd, and, for a tool call, its
arguments as formatted JSON — then reads a single `[a]llow`/`[d]eny` and returns
the verdict. For every other verdict it defers instantly, so allowlister's fast
path is untouched.

```
allowlister approval required

Needs your attention:
  gh pr merge 42 --squash
    ask before merging a PR

Full command:
  gh pr merge 42 --squash

  cwd: /workspace/app
Allow this action? [a]llow / [d]eny:
```

Unlike allowlister's built-in prompt, it surfaces the exact flagged fragments (so
you approve the one line that tripped, not a wall of shell) and renders a tool
call's real arguments — the same decomposition allowlister-remote's web app
shows, because both render it from this crate.

## Install

Via npm (links the native binary directly onto your `PATH`, no Node in the hot
path):

```console
npm install -g @nickderobertis/allowlister-terminal-approval-plugin
allowlister-terminal-approval-plugin --version
```

Or via Cargo:

```console
cargo install allowlister-terminal-approval-plugin
```

Prebuilt binaries and checksums are also attached to each
[GitHub Release](https://github.com/nickderobertis/allowlister-terminal-approval-plugin/releases).

**Unix only** (Linux and macOS): the prompt renders on the controlling terminal
(`/dev/tty`). The library still compiles everywhere, but the binary ships for
unix, where it has something to do.

## Configure allowlister

Point allowlister at the plugin process in your `.allowlister.jsonc` (or global
config):

```jsonc
{
  "plugins": [
    {
      "name": "terminal approval",
      "command": ["allowlister-terminal-approval-plugin"],
      "timeout_ms": 120000
    }
  ]
}
```

Now `allowlister check` (and every agent it gates) prompts at your terminal for
exactly the commands allowlister would `ask` about, and defers everything else.
Give it a generous `timeout_ms`: the plugin blocks while it waits for you.

### How it decides

The plugin reads allowlister's protocol-v3 payload on stdin and prints a
`{ "verdict", "reason" }` object on stdout:

| Situation | Verdict |
| --- | --- |
| allowlister's verdict is `ask` and a terminal is present | your `allow` / `deny` |
| allowlister's verdict is `allow` / `deny` / `defer` (or missing) | `defer` (untouched) |
| `ask`, but no controlling terminal (CI, piped stdio) | `defer` (falls back to allowlister) |
| unparsable payload | `ask` (surfaces the anomaly to a human) |

A plugin `deny` blocks the command; a plugin `allow` upgrades allowlister's
`defer`; a `defer` leaves allowlister's own decision unchanged — see allowlister's
[dynamic approval plugin protocol](https://github.com/nickderobertis/allowlister#dynamic-approval-plugins).

## Library

The crate exposes the terminal approval experience so allowlister-remote (and any
other consumer) can reuse it rather than re-implement it:

- `local_prompt(&PromptLabels, command, cwd, flagged, tool_input)` — render the
  exact prompt text (parameterized only by the product banner + instruction).
- `start_local_prompt(...)` — open the prompt on `/dev/tty` and get a channel of
  the operator's decision; allowlister-remote races this against a decision
  arriving over the network.
- `flagged_fragments`, `tool_input_json`, `request_summary`, `static_decision`,
  `parse_local_input` — the payload helpers behind the prompt.

## Development

```console
just bootstrap   # deps + cargo subcommands + git hooks (idempotent)
just check       # the full gate: fmt, lint, unit + real-terminal e2e, coverage, deps, docs
just test-e2e    # drive the compiled binary, incl. the /dev/tty prompt under a PTY
```

See [`AGENTS.md`](AGENTS.md) for the full command surface, invariants, and how
releases work. Releases are automated: a Conventional-Commit merge to `main`
drives a release-plz PR whose merge tags the version and publishes to crates.io,
npm, and the GitHub Release.

## License

MIT — see [LICENSE](LICENSE).
