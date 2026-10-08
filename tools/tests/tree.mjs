// Scratch copies of this repository's tracked tree, for tests that change the
// project graph or commit to history without touching the real checkout.
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = [];

/** Remove every copy made so far (call from the suite's `after`). */
export function cleanup() {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** git in `dir`, with a fixed identity; returns trimmed stdout. */
export function git(dir, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

/**
 * A copy of the tracked (and untracked, not ignored) tree in a fresh git repo
 * with one commit. `nodeModules: true` gives the copy a node_modules of its own
 * whose entries link to this checkout's installed ones, plus a fresh tools/nx
 * install stamp — so the copy runs the locked Nx without `npm ci` and without
 * writing into this checkout. Without it the boundary checker skips its Nx
 * drift check.
 */
export function copyTree({ nodeModules = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "graph-tree-"));
  scratch.push(dir);
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const f of files) {
    let stat;
    try {
      stat = lstatSync(join(repo, f));
    } catch (err) {
      if (err.code === "ENOENT") continue; // deleted in the working tree
      throw err;
    }
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(join(repo, f)), join(dir, f));
    else copyFileSync(join(repo, f), join(dir, f));
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  if (nodeModules) {
    mkdirSync(join(dir, "node_modules"));
    for (const entry of readdirSync(join(repo, "node_modules"))) {
      if (entry === ".npm-ci-stamp") continue;
      symlinkSync(join(repo, "node_modules", entry), join(dir, "node_modules", entry));
    }
    writeFileSync(join(dir, "node_modules/.npm-ci-stamp"), "");
  }
  return dir;
}
