// The module-boundary check (tools/check-project-boundaries.mjs) as its
// `workspace:lint` target runs it: clean on the committed graph (including the
// drift check against the graph `nx graph` resolves), and refusing each kind of
// forbidden edge when one is introduced into a copy of the real tree.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { cleanup, copyTree, git, repo } from "./tree.mjs";

after(cleanup);

const checker = join(repo, "tools/check-project-boundaries.mjs");
const check = (root) => spawnSync("node", [checker, "--root", root], { encoding: "utf8" });

function edit(dir, file, change) {
  const path = join(dir, file);
  const json = JSON.parse(readFileSync(path, "utf8"));
  change(json);
  writeFileSync(path, JSON.stringify(json, null, 2));
}

test("the committed graph passes, and agrees with the graph Nx resolves", () => {
  const out = check(repo);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, "");
});

test("the library contract may not depend on a project that consumes it", () => {
  const dir = copyTree();
  edit(dir, "project.json", (p) => (p.implicitDependencies = ["npm-carrier"]));
  const out = check(dir);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /terminal-approval \(type:contract\) may not depend on npm-carrier \(type:app\)/);
});

test("nothing but the repo-level checks may depend on the e2e suite", () => {
  const dir = copyTree();
  edit(dir, "packages/allowlister-terminal-approval-plugin/project.json", (p) => p.implicitDependencies.push("terminal-approval-e2e"));
  edit(dir, ".github/project.json", (p) => p.implicitDependencies.push("terminal-approval-e2e"));
  const out = check(dir);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /npm-carrier \(type:app\) may not depend on terminal-approval-e2e \(type:e2e\)/);
  assert.match(out.stderr, /ci-workflows \(type:tooling\) may not depend on terminal-approval-e2e \(type:e2e\)/);
});

test("the crate may not depend on its e2e suite through Cargo either", () => {
  const dir = copyTree();
  const manifest = join(dir, "Cargo.toml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace("[dependencies]\n", '[dev-dependencies]\nterminal-approval-e2e = { path = "tests/e2e" }\n\n[dependencies]\n'),
  );
  const out = check(dir);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /terminal-approval \(type:contract\) may not depend on terminal-approval-e2e \(type:e2e\) — found Cargo dev dependency/);
});

test("every project carries one known type tag, and every Cargo member a project.json", () => {
  const dir = copyTree();
  edit(dir, ".github/project.json", (p) => (p.tags = ["scope:ci"]));
  git(dir, "rm", "-q", "-f", "tests/e2e/project.json");
  const out = check(dir);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /ci-workflows must carry exactly one type:\* tag/);
  assert.match(out.stderr, /Cargo member terminal-approval-e2e \(tests\/e2e\/Cargo.toml\) has no project.json beside it/);
});
