// tools/msrv.sh in a scratch root with stand-in `rustup` and `cargo` on PATH:
// the toolchain it checks with comes from Cargo.toml's [workspace.package]
// rust-version, a malformed or missing version is refused, and a toolchain
// rustup cannot run is reported with rustup's own error.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { repo } from "./tree.mjs";

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "msrv-"));
  mkdirSync(join(root, "tools"));
  mkdirSync(join(root, "bin"));
  copyFileSync(join(repo, "tools/msrv.sh"), join(root, "tools/msrv.sh"));
  const stub = (name, body) => {
    writeFileSync(join(root, "bin", name), `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> "$MSRV_RECORD"\n${body}\n`);
    chmodSync(join(root, "bin", name), 0o755);
  };
  // rustup knows only the toolchains listed in MSRV_INSTALLED.
  stub("rustup", 'case " $MSRV_INSTALLED " in *" $2 "*) echo "rustc $2";; *) echo "error: toolchain \'$2\' is not installed" >&2; exit 1;; esac');
  stub("cargo", "exit 0");
});
after(() => rmSync(root, { recursive: true, force: true }));

function msrv(cargoToml, installed = "") {
  writeFileSync(join(root, "Cargo.toml"), cargoToml);
  const record = join(root, "calls");
  rmSync(record, { force: true });
  const out = spawnSync("bash", [join(root, "tools/msrv.sh")], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, MSRV_RECORD: record, MSRV_INSTALLED: installed },
  });
  return { ...out, calls: existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : [] };
}

const manifest = (version) => `[workspace]\nmembers = ["."]\n\n[workspace.package]\nedition = "2021"\nrust-version = ${version}\n\n[package]\nname = "x"\nrust-version = "9.9"\n`;

test("the committed manifest's rust-version selects the toolchain the workspace is checked with", () => {
  const out = msrv(readFileSync(join(repo, "Cargo.toml"), "utf8"), "1.88.0");
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.calls, ["rustup run 1.88.0 rustc --version", "cargo +1.88.0 check --locked --workspace --all-targets --all-features"]);
});

test("a three-part rust-version is used as is, and only [workspace.package] is read", () => {
  const out = msrv(manifest('"1.90.1"'), "1.90.1");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.calls.at(-1), "cargo +1.90.1 check --locked --workspace --all-targets --all-features");
});

test("a missing or malformed rust-version is refused before any toolchain runs", () => {
  for (const bad of [manifest("1.88"), manifest('"stable"'), "[workspace]\nmembers = []\n"]) {
    const out = msrv(bad, "1.88.0");
    assert.equal(out.status, 1);
    assert.match(out.stderr, /states no plain rust-version.*set it there as a quoted version/);
    assert.deepEqual(out.calls, []);
  }
});

test("a toolchain rustup cannot run is reported with rustup's own error, and nothing is checked", () => {
  const out = msrv(manifest('"1.88"'), "");
  assert.equal(out.status, 1);
  assert.match(out.stderr, /error: toolchain '1\.88\.0' is not installed/);
  assert.match(out.stderr, /rustup toolchain install 1\.88\.0/);
  assert.ok(!out.calls.some((c) => c.startsWith("cargo")));
});
