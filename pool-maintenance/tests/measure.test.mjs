// The pool maintenance this repository declares, through its real entry points:
//
//   * onevcs.toml names the justfile's `pool-maintenance` recipe, and that recipe
//     prunes every target dir a .cargo/config.toml in this tree sets;
//   * measure.sh, the budget's command, run in a scratch root holding the real
//     justfile, the real measure.sh and the installed cargo-prune-superseded over a
//     one-crate fixture workspace (a stand-in tools/coverage/coverage.sh builds it
//     with real cargo, as the gate's test build does), clears an old backlog
//     untimed, then reports only the timed pass, which removes the alternative
//     build and nothing of the ordinary one; a failing build fails it without a
//     report.
//
// Linux only, as measure.sh is (GNU find, touch and date).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const linuxOnly = { skip: process.platform !== "linux" && "measure.sh needs GNU find, touch and date" };
const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

test("onevcs.toml runs the pool-maintenance recipe, which prunes every configured target dir with a 2-day window", () => {
  const toml = readFileSync(join(repo, "onevcs.toml"), "utf8");
  assert.match(toml, /^schema_version = 1$/m);
  assert.match(toml, /^command = \["just", "pool-maintenance"\]$/m);
  const recipe = run("just", ["--show", "pool-maintenance"], { cwd: repo });
  assert.equal(recipe.status, 0, recipe.stderr);
  const line = recipe.stdout.split("\n").find((l) => l.includes("cargo-prune-superseded"));
  assert.ok(line, recipe.stdout);
  const args = line.trim().split(/\s+/);
  assert.deepEqual(args.slice(0, 3), ["cargo-prune-superseded", "--keep-within", "2d"]);
  // Each .cargo/config.toml's target-dir, resolved against the config's parent
  // directory as cargo resolves it (the tree sets it relative); `target` if none.
  const configs = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.cargo/config.toml"], { cwd: repo })
    .stdout.split("\n")
    .filter(Boolean);
  const dirs = configs.flatMap((config) => {
    const set = readFileSync(join(repo, config), "utf8").match(/^target-dir\s*=\s*"([^"]+)"/m);
    return set ? [join(dirname(dirname(config)), set[1])] : [];
  });
  assert.deepEqual(args.slice(3).sort(), (dirs.length ? dirs : ["target"]).sort());
});

/** A scratch root: the real justfile and measure.sh, a fixture crate, and a stand-in gate test build. */
function scratchRoot({ buildFails = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pool-maintenance-"));
  scratch.push(root);
  mkdirSync(join(root, "pool-maintenance"));
  mkdirSync(join(root, "tools/coverage"), { recursive: true });
  mkdirSync(join(root, "src"));
  copyFileSync(join(repo, "justfile"), join(root, "justfile"));
  copyFileSync(join(repo, "pool-maintenance/measure.sh"), join(root, "pool-maintenance/measure.sh"));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n');
  writeFileSync(join(root, "src/lib.rs"), "pub fn answer() -> u32 { 42 }\n");
  // Builds the fixture's test targets with real cargo into the profile directory
  // the gate's instrumented build uses; fails when told to, under the alternative
  // profile only.
  writeFileSync(
    join(root, "tools/coverage/coverage.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = test ] || exit 2
if [ -n "${buildFails ? "1" : ""}" ] && [ -n "\${CARGO_PROFILE_DEV_DEBUG:-}" ]; then echo "error: could not compile fixture" >&2; exit 101; fi
CARGO_TARGET_DIR=target/llvm-cov-target exec cargo test --offline --no-run -q
`,
  );
  chmodSync(join(root, "tools/coverage/coverage.sh"), 0o755);
  return root;
}

const profile = (root) => join(root, "target/llvm-cov-target/debug");
const KINDS = ["deps", ".fingerprint", "build", "incremental"];
/** Every build entry in the profile directory, as kind/name. */
const entries = (root) =>
  new Set(KINDS.flatMap((k) => (existsSync(join(profile(root), k)) ? readdirSync(join(profile(root), k)).map((e) => `${k}/${e}`) : [])));
const fingerprints = (root) => [...entries(root)].filter((e) => e.startsWith(".fingerprint/fixture-")).sort();

/** Build under `env`; return the entries that build created. */
function build(root, env) {
  const before = entries(root);
  const out = run("bash", ["tools/coverage/coverage.sh", "test", "fixture"], { cwd: root, env: { ...process.env, ...env } });
  assert.equal(out.status, 0, out.stderr);
  return [...entries(root)].filter((e) => !before.has(e));
}

function measure(root) {
  const result = join(root, "result.json");
  const out = run("bash", ["pool-maintenance/measure.sh"], { cwd: root, env: { ...process.env, ONEBUDGETSPEC_RESULT: result } });
  return { ...out, result: existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) : null };
}

test("measure.sh reports only the timed pass, which removes the alternative build and keeps the ordinary one", linuxOnly, () => {
  const root = scratchRoot();
  // A backlog: an old superseded build (opt-level 1), backdated 10 days, under the ordinary one.
  const backlog = build(root, { CARGO_PROFILE_DEV_OPT_LEVEL: "1" });
  const touched = run("find", [...backlog.map((e) => join(profile(root), e)), "-exec", "touch", "-h", "-d", "10 days ago", "{}", "+"]);
  assert.equal(touched.status, 0, touched.stderr);
  const ordinary = build(root, {});
  const backlogFps = backlog.filter((e) => e.startsWith(".fingerprint/fixture-"));
  const ordinaryFps = ordinary.filter((e) => e.startsWith(".fingerprint/fixture-"));
  assert.ok(backlogFps.length > 0 && ordinaryFps.length > 0);

  const out = measure(root);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /untimed backlog pass took [\d.]+ s \(not the figure\)/);
  assert.match(out.stderr, /timed pass removed [1-9]\d* entries, all from the alternative build/);

  const left = entries(root);
  for (const e of backlog) assert.ok(!left.has(e), `backlog ${e} cleared`);
  for (const e of ordinary) assert.ok(left.has(e), `ordinary ${e} kept`);
  // Only the ordinary build survives: the alternative build's entries went too.
  assert.deepEqual(fingerprints(root), ordinaryFps.sort());

  // The figure is the timed pass's own report, and its breakdown names the alternative build alone.
  assert.ok(out.result, "the timed pass reported");
  assert.equal(typeof out.result.value, "number");
  assert.ok(out.result.value >= 0);
  assert.equal(Number(out.result.detail.match(/builds removed: (\d+);/)?.[1]), ordinaryFps.length, out.result.detail);
});

test("a failing gate build fails measure.sh by name, and nothing is reported", linuxOnly, () => {
  const root = scratchRoot({ buildFails: true });
  build(root, {});
  const out = measure(root);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /could not compile fixture/);
  assert.match(out.stderr, /measure: the gate's test build of allowlister-terminal-approval-plugin failed/);
  assert.equal(out.result, null);
});
