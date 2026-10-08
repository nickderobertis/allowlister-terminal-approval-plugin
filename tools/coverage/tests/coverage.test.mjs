// tools/coverage/coverage.sh in a scratch root with a stand-in `cargo` on PATH
// whose `metadata` is the real cargo over this checkout's workspace: a crate
// that is not a member is refused before anything is measured, each step runs
// the cargo-llvm-cov command it names, and the report fails at the floor with a
// message that says which failure it was.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const realCargo = spawnSync("bash", ["-c", "command -v cargo"], { encoding: "utf8" }).stdout.trim();
const PLUGIN = "allowlister-terminal-approval-plugin";

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "coverage-"));
  mkdirSync(join(root, "tools/coverage"), { recursive: true });
  mkdirSync(join(root, "bin"));
  copyFileSync(join(repo, "tools/coverage/coverage.sh"), join(root, "tools/coverage/coverage.sh"));
  writeFileSync(
    join(root, "bin/cargo"),
    `#!/usr/bin/env bash
printf 'cargo %s\\n' "$*" >> "$COV_RECORD"
case "$1 $2" in
  "metadata "*) [ -z "$COV_METADATA_FAIL" ] || { echo "error: failed to parse manifest" >&2; exit 101; }
    cd "$COV_REPO" && exec "$COV_REAL_CARGO" "$@" ;;
  *" --version") case " $COV_MISSING " in *" $1 "*) echo "error: no such command: \`$1\`" >&2; exit 101;; esac ;;
  "llvm-cov report") printf '%s\\n' "$COV_REPORT_OUT"; exit "\${COV_REPORT_STATUS:-0}" ;;
esac
exit 0
`,
  );
  chmodSync(join(root, "bin/cargo"), 0o755);
});
after(() => rmSync(root, { recursive: true, force: true }));

function coverage(args, env = {}) {
  const record = join(root, "calls");
  rmSync(record, { force: true });
  const out = spawnSync("bash", [join(root, "tools/coverage/coverage.sh"), ...args], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      COV_RECORD: record,
      COV_REPO: repo,
      COV_REAL_CARGO: realCargo,
      COV_MISSING: "",
      COV_METADATA_FAIL: "",
      ...env,
    },
  });
  return { ...out, calls: existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : [] };
}

const measured = (calls) => calls.filter((c) => /^cargo llvm-cov (--no-report|clean|report)/.test(c));

test("a malformed step or argument count is a usage error, and nothing runs", () => {
  for (const args of [[], ["bogus"], ["clear", "x"], ["report", "x"], ["test"], ["test", "a", "b"]]) {
    const out = coverage(args);
    assert.equal(out.status, 2, `${args}: ${out.stderr}`);
    assert.match(out.stderr, /usage: tools\/coverage\/coverage\.sh clear \| test <crate> \| report/);
    assert.deepEqual(out.calls, []);
  }
});

test("a crate that is not a workspace member is refused before anything is measured", { skip: !realCargo && "cargo is not on PATH" }, () => {
  for (const [crate, why] of [
    ["allowlister-terminal-aproval-plugin", /is not a member of this workspace; pass one of: .*allowlister-terminal-approval-plugin .*terminal-approval-e2e/],
    ["Not_A_Crate", /is not a crate name/],
  ]) {
    const out = coverage(["test", crate]);
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, why);
    assert.deepEqual(measured(out.calls), []);
  }
});

test("each workspace member's tests run instrumented without a report; the e2e crate builds the instrumented binary first", { skip: !realCargo && "cargo is not on PATH" }, () => {
  const unit = coverage(["test", PLUGIN]);
  assert.equal(unit.status, 0, unit.stderr);
  assert.deepEqual(measured(unit.calls), [`cargo llvm-cov --no-report nextest -p ${PLUGIN} --locked --all-features --status-level fail`]);

  const e2e = coverage(["test", "terminal-approval-e2e"]);
  assert.equal(e2e.status, 0, e2e.stderr);
  assert.deepEqual(measured(e2e.calls), [
    `cargo llvm-cov --no-report run -p ${PLUGIN} --bin ${PLUGIN} --locked -- --version`,
    "cargo llvm-cov --no-report nextest -p terminal-approval-e2e --locked --all-features --status-level fail",
  ]);
});

test("an unreadable workspace or a missing cargo subcommand fails with its cause, before measuring", () => {
  const metadata = coverage(["test", PLUGIN], { COV_METADATA_FAIL: "1" });
  assert.equal(metadata.status, 1);
  assert.match(metadata.stderr, /failed to parse manifest[\s\S]*'cargo metadata' failed/);
  assert.deepEqual(measured(metadata.calls), []);

  const missing = coverage(["clear"], { COV_MISSING: "llvm-cov" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cargo-llvm-cov is missing; run 'just bootstrap'/);
  assert.deepEqual(measured(missing.calls), []);
});

test("clear drops the shared profile directory for every crate", () => {
  const out = coverage(["clear"]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(measured(out.calls), ["cargo llvm-cov clean --workspace"]);
});

test("the report enforces the 95% floor on lines, functions and regions over the crate's sources", () => {
  const total = "TOTAL  100  3  97.00%  10  0  100.00%  200  4  98.00%";
  const ok = coverage(["report"], { COV_REPORT_OUT: `Filename ...\n${total}` });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), total);
  assert.deepEqual(measured(ok.calls), [
    "cargo llvm-cov report --summary-only --ignore-filename-regex (src/main\\.rs|tests/) --fail-under-lines 95 --fail-under-functions 95 --fail-under-regions 95",
  ]);

  const below = coverage(["report"], { COV_REPORT_OUT: "TOTAL  100  6  94.00%", COV_REPORT_STATUS: "1" });
  assert.equal(below.status, 1);
  assert.match(below.stderr, /below the 95% floor/);

  const none = coverage(["report"], { COV_REPORT_OUT: "error: no input files specified", COV_REPORT_STATUS: "1" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no input files specified[\s\S]*no report could be produced/);
});
