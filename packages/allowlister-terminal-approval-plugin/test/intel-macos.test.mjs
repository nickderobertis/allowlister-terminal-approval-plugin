// Intel macOS is discontinued: a user there must be refused with a message that
// says so, not handed a launcher that reaches for an unpublished package. This
// host is not an Intel Mac, so the only double is the host identity Node reports
// (`process.platform`/`process.arch`, preloaded into every Node process npm
// spawns); the packed carrier, npm's install and postinstall, and the launcher
// all run for real.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const carrier = fileURLToPath(new URL("../", import.meta.url));
const refusal = /Intel macOS \(darwin-x64\) is no longer supported/;

let dir;
let tarball;
let env;
before(() => {
  dir = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? tmpdir(), "intel-macos-"),
  );
  const host = join(dir, "intel-mac-host.mjs");
  writeFileSync(
    host,
    'Object.defineProperty(process, "platform", { value: "darwin" });\n' +
      'Object.defineProperty(process, "arch", { value: "x64" });\n',
  );
  env = {
    ...process.env,
    npm_config_cache: join(dir, "cache"),
    NODE_OPTIONS: `--import ${host}`,
  };
  tarball = join(
    dir,
    execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], {
      cwd: carrier,
      encoding: "utf8",
    }).trim(),
  );
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("installing the carrier on Intel macOS is refused with a discontinued message", () => {
  const install = spawnSync(
    "npm",
    ["install", "-g", "--prefix", join(dir, "refused"), tarball, "--foreground-scripts"],
    { encoding: "utf8", env },
  );
  assert.notEqual(install.status, 0, "the install must fail, not leave a dead launcher");
  assert.match(`${install.stdout}${install.stderr}`, refusal);
});

test("with install scripts skipped, the launcher refuses on Intel macOS instead of resolving a package", () => {
  const prefix = join(dir, "ignored-scripts");
  execFileSync(
    "npm",
    ["install", "-g", "--prefix", prefix, tarball, "--ignore-scripts", "--silent"],
    { encoding: "utf8", env },
  );
  const run = spawnSync(join(prefix, "bin", "allowlister-terminal-approval-plugin"), [], {
    encoding: "utf8",
    env,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, refusal);
  assert.doesNotMatch(run.stderr, /Missing native/, "no package resolution is attempted");
});
