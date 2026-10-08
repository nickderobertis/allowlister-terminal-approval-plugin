// tools/nx-base.sh, the explicit base the affected tier keys off, against a
// throwaway history: NX_BASE when it is a plain ref that resolves, else the merge
// base with origin/main; anything else refused before a target runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { git, repo } from "./tree.mjs";

const script = join(repo, "tools/nx-base.sh");
let dir;
let sha;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "nx-base-"));
  git(dir, "init", "-q", "-b", "main");
  const commit = (msg) => (git(dir, "commit", "-q", "--allow-empty", "-m", msg), git(dir, "rev-parse", "HEAD"));
  const m1 = commit("m1");
  const m2 = commit("m2");
  git(dir, "update-ref", "refs/remotes/origin/main", m2);
  git(dir, "switch", "-q", "-c", "feature", m1);
  const f1 = commit("f1");
  sha = { m1, m2, f1 };
});
after(() => rmSync(dir, { recursive: true, force: true }));

function base(nxBase, cwd = dir) {
  const { NX_BASE: _unset, ...env } = process.env;
  if (nxBase !== undefined) env.NX_BASE = nxBase;
  return spawnSync("bash", [script], { cwd, encoding: "utf8", env });
}

test("without NX_BASE, the base is the fork point from origin/main", () => {
  const out = base(undefined);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, `${sha.m1}\n`);
  assert.match(out.stderr, /merge-base with origin\/main/);
  assert.equal(base("").stdout, `${sha.m1}\n`, "an empty NX_BASE (the sweep's routed base) falls back the same way");
});

test("NX_BASE wins when it is a plain ref or SHA that resolves", () => {
  for (const ref of [sha.m2, "origin/main"]) {
    const out = base(ref);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, `${ref}\n`);
  }
});

test("an NX_BASE that is not a plain ref, or does not resolve, is refused", () => {
  for (const bad of ["main;id", "$(id)", "-p", "a..b", "no-such-ref"]) {
    const out = base(bad);
    assert.equal(out.status, 1, bad);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /^nx-base: NX_BASE/, bad);
  }
});

test("a clone without origin/main is told how to fix it", () => {
  const bare = mkdtempSync(join(tmpdir(), "nx-base-bare-"));
  try {
    git(bare, "init", "-q", "-b", "main");
    git(bare, "commit", "-q", "--allow-empty", "-m", "only");
    const out = base(undefined, bare);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /git fetch origin main/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
