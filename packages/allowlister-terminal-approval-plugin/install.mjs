// Post-install step: link the native binary directly onto the command path.
//
// npm has already installed the one platform package that matches this host (the
// others are skipped by their `os`/`cpu` fields). We copy that native binary over
// the JS launcher at `bin/allowlister-terminal-approval-plugin`, which is the file
// the command symlinks to. After this the command on PATH is the Rust executable
// itself — no Node process is spawned per invocation, which matters because
// allowlister can call the plugin hundreds of times in a single agent session.
//
// If anything goes wrong we leave the JS launcher in place as a working fallback
// and never fail the install.

import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { binarySpecifier } from "./lib/platform.mjs";

const require = createRequire(import.meta.url);
// Resolve symlinks so a workspace link does not make us look like an install.
const here = realpathSync(dirname(fileURLToPath(import.meta.url)));

// When this package lives in its source monorepo (linked as a workspace rather
// than installed under node_modules), overwriting the launcher would clobber the
// committed source file. Detect that by walking up to a `workspaces`-bearing
// package.json without first crossing a `node_modules` boundary.
function inWorkspaceCheckout(startDir) {
  let dir = startDir;
  for (;;) {
    if (basename(dir) === "node_modules") {
      return false;
    }
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      try {
        if (JSON.parse(readFileSync(manifestPath, "utf8")).workspaces) {
          return true;
        }
      } catch {
        // Ignore unreadable/partial manifests and keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

if (inWorkspaceCheckout(here)) {
  console.log("allowlister-terminal-approval-plugin: source checkout detected, keeping the JS launcher");
} else {
  try {
    const native = require.resolve(binarySpecifier());
    const onPath = join(here, "bin", "allowlister-terminal-approval-plugin");
    copyFileSync(native, onPath);
    chmodSync(onPath, 0o755);
    console.log(
      "allowlister-terminal-approval-plugin: linked the native binary directly onto the command path",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`allowlister-terminal-approval-plugin: keeping the JS launcher fallback (${message})`);
  }
}
