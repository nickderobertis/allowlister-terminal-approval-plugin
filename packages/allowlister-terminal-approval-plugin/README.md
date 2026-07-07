# @nickderobertis/allowlister-terminal-approval-plugin

npm installer for the [allowlister terminal approval
plugin](https://github.com/nickderobertis/allowlister-terminal-approval-plugin) —
the allowlister terminal approval experience as a standalone dynamic approval
plugin.

```console
npm install -g @nickderobertis/allowlister-terminal-approval-plugin
allowlister-terminal-approval-plugin --version
```

Installing pulls in the one per-platform package matching your host and links the
native Rust binary directly onto your `PATH`, so allowlister spawns the
executable itself with no Node process in the hot path. Unix only (Linux and
macOS): the prompt renders on the controlling terminal (`/dev/tty`).

See the [repository](https://github.com/nickderobertis/allowlister-terminal-approval-plugin)
for how to configure it in allowlister's `plugins` array.
