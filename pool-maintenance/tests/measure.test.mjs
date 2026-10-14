// The pool maintenance this repository declares, through its real entry points:
//
//   * onevcs.toml names the justfile's `pool-maintenance` recipe, and that recipe
//     prunes every target dir a .cargo/config.toml in this tree sets;
//   * measure.sh, the budget's command, run in a scratch root holding the real
//     justfile, the real measure.sh and the installed cargo-prune-superseded over a
//     one-crate fixture workspace (a stand-in tools/coverage/coverage.sh builds it
//     with real cargo, as the gate's test build does), clears an old backlog
//     untimed, then reports only the timed pass, which removes the alternative
//     build and nothing of the ordinary one; each way a step can fail, or the
//     workload can differ from the budget's, fails it without a report;
//   * `just install-prune-superseded` (bootstrap's step) installs exactly the
//     pinned release, with stand-ins for cargo and the installed pruner.
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

/**
 * A scratch root: the real justfile and measure.sh, a fixture crate, and a
 * stand-in gate test build that builds the fixture's test targets with real cargo
 * into the profile directory the gate's instrumented build uses. FIXTURE_FAULT,
 * when set, breaks one step the way a real checkout can:
 *   alt-build    the alternative-profile build fails;
 *   foreign      the ordinary build also leaves, once, an old superseded build of its own;
 *   fresh-alt    the ordinary build leaves every entry modified now;
 *   timed-fails  the ordinary build leaves, first on PATH (FIXTURE_BIN), a pruner
 *                that fails.
 */
function scratchRoot() {
  const root = mkdtempSync(join(tmpdir(), "pool-maintenance-"));
  scratch.push(root);
  mkdirSync(join(root, "pool-maintenance"));
  mkdirSync(join(root, "tools/coverage"), { recursive: true });
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "bin"));
  copyFileSync(join(repo, "justfile"), join(root, "justfile"));
  copyFileSync(join(repo, "pool-maintenance/measure.sh"), join(root, "pool-maintenance/measure.sh"));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n');
  writeFileSync(join(root, "src/lib.rs"), "pub fn answer() -> u32 { 42 }\n");
  writeFileSync(
    join(root, "tools/coverage/coverage.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = test ] || exit 2
export CARGO_TARGET_DIR=target/llvm-cov-target
profile=target/llvm-cov-target/debug
build() { cargo test --offline --no-run -q; }
entries() { for k in deps .fingerprint build incremental; do [ ! -d "$profile/$k" ] || find "$profile/$k" -mindepth 1 -maxdepth 1; done | sort; }
fault="\${FIXTURE_FAULT:-}"
if [ -n "\${CARGO_PROFILE_DEV_DEBUG:-}" ]; then
  [ "$fault" != alt-build ] || { echo "error: could not compile fixture" >&2; exit 101; }
  build; exit
fi
# Once: cargo would rebuild the backdated build on the next call, as outputs older than their sources.
if [ "$fault" = foreign ] && [ ! -e foreign-built ]; then
  touch foreign-built
  before="$(entries)"
  CARGO_PROFILE_DEV_OPT_LEVEL=2 build
  comm -13 <(printf '%s\\n' "$before") <(entries) | while IFS= read -r e; do find "$e" -exec touch -h -d "10 days ago" {} +; done
fi
build
case "$fault" in
  fresh-alt) find target -exec touch -h {} + ;;
  timed-fails) printf '#!/bin/sh\\necho "error: target: Permission denied (os error 13)" >&2\\nexit 1\\n' > "$FIXTURE_BIN/cargo-prune-superseded"; chmod +x "$FIXTURE_BIN/cargo-prune-superseded" ;;
esac
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

function measure(root, env = {}) {
  const result = join(root, "result.json");
  const out = run("bash", ["pool-maintenance/measure.sh"], { cwd: root, env: { ...process.env, ONEBUDGETSPEC_RESULT: result, ...env } });
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
  // One line on success: the timed pass's workload, and the backlog pass apart from the figure.
  assert.match(out.stderr, /^measure: timed pass removed [1-9]\d* entries, all from the alternative build .*; the untimed backlog pass took [\d.]+ s, not the figure .*\n$/);

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

/** PATH without any directory holding a real cargo or cargo-prune-superseded. */
const pathWithout = () => process.env.PATH.split(":").filter((d) => !existsSync(join(d, "cargo")) && !existsSync(join(d, "cargo-prune-superseded")));

/**
 * Run measure.sh, with `fault`, over a root whose ordinary build already ran;
 * expect it to fail. A failure before the timed pass leaves no report; one after
 * it is a non-zero exit, which onebudgetspec check records as an error whatever
 * the pruner reported.
 */
function refused(fault, { setup = () => {}, beforeTimedPass = true, env = {} } = {}) {
  const root = scratchRoot();
  build(root, {});
  setup(root);
  const out = measure(root, { FIXTURE_FAULT: fault, FIXTURE_BIN: join(root, "bin"), PATH: `${join(root, "bin")}:${process.env.PATH}`, ...env });
  assert.equal(out.status, 1, out.stderr);
  if (beforeTimedPass) assert.equal(out.result, null, "nothing is reported");
  return out.stderr;
}

test("a failing gate build fails measure.sh by name, and nothing is reported", linuxOnly, () => {
  const stderr = refused("alt-build");
  assert.match(stderr, /could not compile fixture/);
  assert.match(stderr, /measure: the gate's test build of fixture failed \(above\); fix that build, then re-run/);
});

test("a missing pruner fails the backlog pass, naming bootstrap", linuxOnly, () => {
  const stderr = refused("", { env: { PATH: pathWithout().join(":") } });
  assert.match(stderr, /cargo-prune-superseded: command not found/);
  assert.match(stderr, /measure: the untimed backlog pass failed \(above\); .*just bootstrap/);
});

test("a failing timed pass fails measure.sh with the pruner's own error", linuxOnly, () => {
  const stderr = refused("timed-fails", { beforeTimedPass: false });
  assert.match(stderr, /error: target: Permission denied/);
  assert.match(stderr, /measure: the timed pass failed \(above\)/);
});

test("an alternative build already present within the window is refused, naming what to remove", linuxOnly, () => {
  const stderr = refused("", { setup: (root) => build(root, { CARGO_PROFILE_DEV_DEBUG: "line-tables-only" }) });
  assert.match(stderr, /measure: the alternative build created no new build entries.*remove target\/llvm-cov-target, then re-run/);
});

test("a timed pass that removes a build the alternative configuration did not create is refused, listing it", linuxOnly, () => {
  const stderr = refused("foreign", { beforeTimedPass: false });
  assert.match(stderr, /target\/llvm-cov-target\/debug\/\.fingerprint\/fixture-[0-9a-f]{16}\n/);
  assert.match(stderr, /measure: the timed pass removed the entries above, which the alternative build did not create/);
});

test("a timed pass that removes nothing is refused rather than reported", linuxOnly, () => {
  const stderr = refused("fresh-alt", { beforeTimedPass: false });
  assert.match(stderr, /measure: the timed pass removed none of the alternative build's entries/);
});

test("a result path onebudgetspec could not have set is refused before anything runs", linuxOnly, () => {
  const root = scratchRoot();
  for (const bad of ["relative/result.json", join(root, "missing-dir/result.json")]) {
    const out = run("bash", ["pool-maintenance/measure.sh"], { cwd: root, env: { ...process.env, ONEBUDGETSPEC_RESULT: bad } });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /measure: ONEBUDGETSPEC_RESULT .* run this through onebudgetspec check/);
    assert.ok(!existsSync(join(root, "target/llvm-cov-target")), "no build ran");
  }
});

/** `just install-prune-superseded` with stand-ins for cargo and an installed pruner reporting `installed`. */
function install(installed) {
  const bin = mkdtempSync(join(tmpdir(), "prune-install-"));
  scratch.push(bin);
  const record = join(bin, "calls");
  writeFileSync(join(bin, "cargo"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\n`);
  chmodSync(join(bin, "cargo"), 0o755);
  if (installed) {
    writeFileSync(join(bin, "cargo-prune-superseded"), `#!/usr/bin/env bash\necho "cargo-prune-superseded ${installed}"\n`);
    chmodSync(join(bin, "cargo-prune-superseded"), 0o755);
  }
  // Only the stand-ins and the shell's own tools: no real pruner or cargo on PATH.
  const path = [bin, ...pathWithout()].join(":");
  const just = run("bash", ["-c", "command -v just"]).stdout.trim();
  const out = run(just, ["install-prune-superseded"], { cwd: repo, env: { ...process.env, PATH: path } });
  assert.equal(out.status, 0, out.stderr);
  return existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : [];
}

test("bootstrap installs exactly the pinned pruner, replacing another version, and skips the pinned one", () => {
  assert.match(readFileSync(join(repo, "justfile"), "utf8"), /^bootstrap:[\s\S]*?^ {4}just install-prune-superseded$/m);
  const pin = readFileSync(join(repo, "justfile"), "utf8").match(/^prune-superseded-version := "([^"]+)"$/m)?.[1];
  assert.ok(pin, "one pinned version in the justfile");
  const installs = [`+stable install --locked cargo-prune-superseded --version =${pin}`];
  assert.deepEqual(install(null), installs, "missing: installed");
  assert.deepEqual(install("0.0.1"), installs, "another version: replaced");
  assert.deepEqual(install(pin), [], "the pinned version: left alone");
});
