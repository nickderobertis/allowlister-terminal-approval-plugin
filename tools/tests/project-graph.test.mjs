// The project graph through real Nx and the real justfile, in a scratch copy of
// this tree with its own git history: which projects a change selects (the
// affected tier), the order the e2e suite and the coverage aggregate run in, and
// the npm carrier's suite running as a graph target in both tiers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { cleanup, copyTree, git } from "./tree.mjs";

after(cleanup);

let dir;
let base;
before(() => {
  dir = copyTree({ nodeModules: true });
  base = git(dir, "rev-parse", "HEAD");
});

// NODE_TEST_CONTEXT is how node:test marks its own children; a `node --test` the
// recipe spawns would see it and skip its files, passing vacuously.
const { NODE_TEST_CONTEXT: _child, ...parentEnv } = process.env;
// No colour, so the assertions read plain text whatever terminal the suite runs under.
const env = {
  ...parentEnv,
  NX_DAEMON: "false",
  NX_NO_CLOUD: "true",
  NX_TUI: "false",
  NX_SKIP_NX_CACHE_WARNING: "true",
  FORCE_COLOR: "0",
  NO_COLOR: "1",
};
const nx = (...args) => {
  const out = spawnSync("node_modules/.bin/nx", args, { cwd: dir, encoding: "utf8", env });
  assert.equal(out.status, 0, out.stderr + out.stdout);
  return out.stdout;
};

/** Commit `edits` (path -> appended text) on top of the base; return the projects Nx calls affected. */
function affectedBy(edits) {
  git(dir, "reset", "-q", "--hard", base);
  for (const [file, text] of Object.entries(edits)) appendFileSync(join(dir, file), text);
  git(dir, "commit", "-q", "-am", "change");
  return JSON.parse(nx("show", "projects", "--affected", `--base=${base}`, "--head=HEAD", "--json")).sort();
}

test("a change to the crate's sources selects the crate and its e2e suite", () => {
  const projects = affectedBy({ "src/prompt.rs": "\n// touched\n" });
  for (const p of ["terminal-approval", "terminal-approval-e2e", "coverage"]) assert.ok(projects.includes(p), `${p} in ${projects}`);
});

test("a change to the carrier's sources or tests selects the carrier and nothing Rust", () => {
  for (const file of [
    "packages/allowlister-terminal-approval-plugin/lib/platform.mjs",
    "packages/allowlister-terminal-approval-plugin/test/platform.test.mjs",
  ]) {
    assert.deepEqual(affectedBy({ [file]: "\n// touched\n" }), ["npm-carrier"], file);
  }
});

test("a change to the e2e suite reaches the coverage aggregate but not the crate it drives", () => {
  const projects = affectedBy({ "tests/e2e/cli.rs": "\n// touched\n" });
  assert.ok(projects.includes("terminal-approval-e2e"));
  assert.ok(projects.includes("coverage"));
  assert.ok(!projects.includes("terminal-approval"), `${projects}`);
  assert.ok(!projects.includes("npm-carrier"), `${projects}`);
});

test("agent notes reach no project", () => {
  assert.deepEqual(affectedBy({ "AGENTS.md": "\n" }), []);
});

/** The task graph Nx would run for `args`, as task id -> its dependencies. */
function taskGraph(...args) {
  // Outside the copy: a file inside it would itself be a change the root project owns.
  const out = mkdtempSync(join(tmpdir(), "task-graph-"));
  try {
    nx(...args, `--graph=${join(out, "graph.json")}`);
    return JSON.parse(readFileSync(join(out, "graph.json"), "utf8")).tasks.dependencies;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("the e2e suite runs after the binary's build, and coverage after every profile-producing test", () => {
  const e2e = taskGraph("run", "terminal-approval-e2e:test");
  assert.deepEqual(e2e["terminal-approval-e2e:test"].sort(), ["coverage:coverage-clear", "terminal-approval:build"]);
  const coverage = taskGraph("run", "coverage:coverage");
  assert.deepEqual(coverage["coverage:coverage"].sort(), ["terminal-approval-e2e:test", "terminal-approval:test"]);
});

/** The Nx arguments a justfile recipe hands its tier helper. */
function recipeArgs(recipe) {
  const justfile = readFileSync(join(dir, "justfile"), "utf8");
  const m = justfile.match(new RegExp(`^${recipe} tier="affected": \\(nx-tier tier "([^"]+)"\\)$`, "m"));
  assert.ok(m, `the ${recipe} recipe delegates to nx-tier`);
  return m[1].split(" ");
}

test("the carrier's suite is a target of the full sweep and of the gate", () => {
  for (const recipe of ["test", "check"]) {
    const tasks = Object.keys(taskGraph("run-many", ...recipeArgs(recipe)));
    assert.ok(tasks.includes("npm-carrier:test"), `\`just ${recipe} all\` runs npm-carrier:test (got ${tasks})`);
  }
});

const realJust = spawnSync("bash", ["-c", "command -v just"], { encoding: "utf8" }).stdout.trim();

test("`just test` on a carrier-only change runs the carrier's suite as its graph target, and fails when it fails", { skip: !realJust && "just is not on PATH" }, () => {
  const justTest = () => spawnSync("just", ["test"], { cwd: dir, encoding: "utf8", env: { ...env, NX_BASE: base } });
  affectedBy({ "packages/allowlister-terminal-approval-plugin/test/platform.test.mjs": "\n// touched\n" });
  const green = justTest();
  assert.equal(green.status, 0, green.stderr + green.stdout);
  assert.match(green.stdout, /nx run npm-carrier:test/);
  assert.match(green.stdout, /ℹ pass [1-9]/, "the carrier's tests actually ran");
  assert.doesNotMatch(green.stdout, /nx run (terminal-approval|coverage|workspace|ci-workflows)/);
  affectedBy({
    "packages/allowlister-terminal-approval-plugin/test/platform.test.mjs":
      '\ntest("induced failure", () => assert.equal(1, 2));\n',
  });
  const red = justTest();
  assert.notEqual(red.status, 0, "a failing carrier test fails `just test`");
  assert.match(red.stdout + red.stderr, /induced failure/);
});
