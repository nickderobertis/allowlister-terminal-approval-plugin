// tools/nx, the locked-install wrapper every gate recipe runs Nx through, in a
// scratch root with a stand-in `npm` on PATH: it installs on first use, reuses an
// install while package.json and package-lock.json are unchanged, reinstalls when
// either moves, and on a failed install says so without stamping success.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { repo } from "./tree.mjs";

let root;
let record;
before(() => {
  root = mkdtempSync(join(tmpdir(), "nx-wrapper-"));
  mkdirSync(join(root, "tools"));
  mkdirSync(join(root, "bin"));
  copyFileSync(join(repo, "tools/nx"), join(root, "tools/nx"));
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  record = join(root, "npm-calls");
  // The stand-in npm: records its argv; `ci` installs a node_modules/.bin/nx that
  // echoes its arguments, or fails when NPM_FAIL is set.
  writeFileSync(
    join(root, "bin/npm"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NPM_RECORD"
if [ -n "\${NPM_FAIL:-}" ]; then echo "npm ERR! simulated install failure" >&2; exit 1; fi
mkdir -p node_modules/.bin
printf '#!/usr/bin/env bash\\necho "nx $*"\\necho "env daemon=$NX_DAEMON cloud=$NX_NO_CLOUD tui=$NX_TUI" >&2\\n' > node_modules/.bin/nx
chmod +x node_modules/.bin/nx
`,
  );
  chmodSync(join(root, "bin/npm"), 0o755);
});
after(() => rmSync(root, { recursive: true, force: true }));

function nx(env = {}) {
  const out = spawnSync("bash", [join(root, "tools/nx"), "show", "projects"], {
    cwd: tmpdir(), // the wrapper must find its root from its own path
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, NPM_RECORD: record, ...env },
  });
  const calls = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean) : [];
  rmSync(record, { force: true });
  return { ...out, calls };
}

const stamp = () => join(root, "node_modules/.npm-ci-stamp");
const age = (file, secondsAgo) => {
  const t = Date.now() / 1000 - secondsAgo;
  utimesSync(file, t, t);
};

test("a failed first install reports npm's error and the next action, and stamps nothing", () => {
  const out = nx({ NPM_FAIL: "1" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /simulated install failure/);
  assert.match(out.stderr, /nx: 'npm ci' failed \(above\)/);
  assert.equal(existsSync(stamp()), false);
});

test("the first run installs from the lock, then runs Nx with the given arguments", () => {
  const out = nx();
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.calls, ["ci --no-audit --no-fund"]);
  assert.equal(out.stdout, "nx show projects\n");
  // One foreground process: no daemon, no cloud, no interactive TUI.
  assert.match(out.stderr, /env daemon=false cloud=true tui=false/);
  assert.ok(existsSync(stamp()));
});

test("an unchanged install is reused", () => {
  age(join(root, "package.json"), 60);
  age(join(root, "package-lock.json"), 60);
  const out = nx();
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.calls, []);
  assert.equal(out.stdout, "nx show projects\n");
});

test("a lock or manifest newer than the install triggers a reinstall", () => {
  for (const file of ["package-lock.json", "package.json"]) {
    age(stamp(), 30);
    const out = nx();
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.calls, [], `${file} still older than the stamp`);
    age(join(root, file), 0); // touched now: newer than the stamp
    const refreshed = nx();
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.deepEqual(refreshed.calls, ["ci --no-audit --no-fund"], `${file} moved`);
    age(join(root, file), 60);
  }
});

test("without node or npm on PATH it names the missing toolchain", () => {
  // A PATH holding only the coreutils the wrapper itself calls.
  const bare = join(root, "bare-bin");
  mkdirSync(bare);
  const which = (tool) => spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
  symlinkSync(which("dirname"), join(bare, "dirname"));
  const out = spawnSync(which("bash"), [join(root, "tools/nx"), "--version"], { encoding: "utf8", env: { PATH: bare } });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /node\/npm are not on PATH/);
});

test("a missing Nx executable or install stamp is repaired by reinstalling", () => {
  for (const missing of ["node_modules/.bin/nx", "node_modules/.npm-ci-stamp"]) {
    rmSync(join(root, missing));
    const out = nx();
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.calls, ["ci --no-audit --no-fund"], `${missing} removed`);
    assert.ok(existsSync(join(root, "node_modules/.bin/nx")) && existsSync(stamp()));
  }
});

test("a failed refresh of an existing install fails, and is retried on the next run", () => {
  age(stamp(), 30);
  age(join(root, "package-lock.json"), 0);
  const failed = nx({ NPM_FAIL: "1" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /nx: 'npm ci' failed \(above\)/);
  assert.equal(failed.stdout, "", "Nx does not run on a stale install");
  const retried = nx();
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(retried.calls, ["ci --no-audit --no-fund"], "the stale stamp makes the next run reinstall");
});
