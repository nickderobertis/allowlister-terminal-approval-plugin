// The CI workflow contract, read from the parsed workflow files:
//
//   * the fixed status-check contexts branch protection names are each reported
//     by exactly one job, on every pull request — no `if`, `needs`, path filter
//     or skippable step can leave one unreported;
//   * the gate job derives its tier and base explicitly, and — driven from a
//     synthetic event through the real router, the gate step's own script and
//     the real justfile (Nx stubbed to record its call) — runs the full sweep on
//     release-plz's release pull request and the affected tier on every other
//     pull request and on a push to main, with a failing sweep failing the job;
//   * the release re-gate in publish.yml is the full sweep over every project;
//   * notignored is a workflow and job of its own, outside the contract.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = join(repo, ".github/workflows");
const workflows = Object.fromEntries(
  readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => [f, parse(readFileSync(join(workflowsDir, f), "utf8"))]),
);
const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

// The fixed context contract, and the workflow file that reports each.
const CONTRACT = {
  "test (ubuntu-latest)": "ci.yml",
  "test (ubuntu-24.04-arm)": "ci.yml",
  "test (macos-latest)": "ci.yml",
  "install-smoke": "ci.yml",
  "pr-title": "pr-title.yml",
  llmlint: "llmlint.yml",
};
// Every target the gate ran before the project graph, by its graph name.
const GATE_TARGETS = ["format-check", "lint", "typecheck", "test", "build", "doc", "release-check", "coverage", "supply-chain"];

/** The status-check contexts a job reports: its name (or id), expanded over a literal `matrix.os`. */
function contexts(id, job) {
  const name = job.name ?? id;
  if (!name.includes("${{ matrix.os }}")) return [name];
  return job.strategy.matrix.os.map((os) => name.replaceAll("${{ matrix.os }}", os));
}

/** [file, id, job] for every job in every workflow. */
const allJobs = Object.entries(workflows).flatMap(([file, wf]) => Object.entries(wf.jobs ?? {}).map(([id, job]) => [file, id, job]));
const contractJobs = allJobs.filter(([, id, job]) => contexts(id, job).some((c) => c in CONTRACT));

test("each fixed context is reported by exactly one job, in its workflow", () => {
  for (const [ctx, file] of Object.entries(CONTRACT)) {
    const reporters = allJobs.filter(([, id, job]) => contexts(id, job).includes(ctx)).map(([f, id]) => `${f}:${id}`);
    assert.equal(reporters.length, 1, `${ctx} must be reported by exactly one job (found: ${reporters.join(", ") || "none"})`);
    assert.ok(reporters[0].startsWith(`${file}:`), `${ctx} is reported from ${file}`);
  }
});

test("every contract workflow runs on every pull request to the default branch", () => {
  const ci = workflows["ci.yml"].on;
  assert.equal(ci.pull_request, null, "ci.yml's pull_request trigger carries no paths/branches/types filter");
  assert.deepEqual(ci.push, { branches: ["main"] });
  for (const file of ["pr-title.yml", "llmlint.yml"]) {
    const pr = workflows[file].on.pull_request;
    assert.deepEqual(Object.keys(pr), ["types"], `${file} filters pull requests by activity type only`);
    for (const type of ["opened", "synchronize", "reopened"]) assert.ok(pr.types.includes(type), `${file} runs on ${type}`);
  }
});

test("no condition, dependency or skippable step can leave a contract job unreported or green", () => {
  assert.equal(contractJobs.length, 4, "test (matrix), install-smoke, pr-title, llmlint");
  for (const [file, id, job] of contractJobs) {
    for (const key of ["if", "needs", "continue-on-error"]) {
      assert.equal(job[key], undefined, `${file}:${id} must not set \`${key}\``);
    }
    if (job.strategy) assert.equal(job.strategy["fail-fast"], false, `${file}:${id}'s matrix must not cancel siblings`);
    for (const step of job.steps) {
      assert.equal(step.if, undefined, `${file}:${id} step ${step.name ?? step.uses} must not be conditional`);
      assert.equal(step["continue-on-error"], undefined, `${file}:${id} step ${step.name ?? step.uses} must not soft-fail`);
    }
  }
});

const gateJob = workflows["ci.yml"].jobs.test;

test("the gate job derives its tier explicitly from full history and runs the gate recipe at it", () => {
  const steps = gateJob.steps;
  const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout?.with?.["fetch-depth"], 0, "full history, so the merge base resolves");
  const router = steps.find((s) => s.id === "tier");
  assert.equal(router?.run, "node .github/scripts/gate-tier.mjs");
  const gate = steps.at(-1);
  assert.equal(gate.run, 'just check "$TIER"');
  assert.deepEqual(gate.env, { TIER: "${{ steps.tier.outputs.tier }}", NX_BASE: "${{ steps.tier.outputs.base }}" });
  assert.ok(steps.indexOf(router) < steps.indexOf(gate));
});

const realJust = spawnSync("bash", ["-c", "command -v just"], { encoding: "utf8" }).stdout.trim();
const journeySkip = !realJust && "just is not on PATH";

/**
 * The real justfile in a scratch root whose tools/nx records each Nx call (and
 * exits with GATE_NX_EXIT) instead of running it, and whose tools/nx-base.sh
 * prints NX_BASE — so a workflow step's own script drives the real recipes.
 */
function gateSandbox() {
  const dir = tempDir("gate-journey-");
  mkdirSync(join(dir, "tools"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "justfile"), readFileSync(join(repo, "justfile"), "utf8"));
  const record = join(dir, "nx-calls");
  writeFileSync(join(dir, "tools/nx"), `printf '%s\\n' "$*" >> "$GATE_NX_RECORD"\nexit "\${GATE_NX_EXIT:-0}"\n`);
  writeFileSync(join(dir, "tools/nx-base.sh"), 'printf "%s\\n" "$NX_BASE"\n');
  writeFileSync(
    join(dir, "bin/just"),
    '#!/usr/bin/env bash\nexec "$GATE_REAL_JUST" --justfile "$GATE_ROOT/justfile" --working-directory "$GATE_ROOT" "$@"\n',
  );
  chmodSync(join(dir, "bin/just"), 0o755);
  /** Run a script as Actions runs `shell: bash`; returns its status and each Nx call. */
  return (script, env = {}) => {
    rmSync(record, { force: true });
    const out = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        GATE_NX_RECORD: record,
        GATE_REAL_JUST: realJust,
        GATE_ROOT: dir,
        ...env,
      },
    });
    const calls = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean) : [];
    return { status: out.status, stderr: out.stderr, calls };
  };
}

/** An Nx call's mode, its --base, and the targets after `-t`. */
function parseNx(line) {
  const [mode, ...args] = line.split(" ");
  const base = args.find((a) => a.startsWith("--base="))?.slice("--base=".length);
  const t = args.indexOf("-t");
  const targets = t < 0 ? [] : args.slice(t + 1).filter((a) => !a.startsWith("--"));
  // Project filters: every flag but the base and the output style.
  const filters = args.filter((a) => a.startsWith("--") && !a.startsWith("--base=") && !a.startsWith("--output-style="));
  return { mode, base, targets, filters };
}

// A throwaway history: origin/main at M2, a feature branch F1 forked from M1.
let history;
before(() => {
  const dir = tempDir("gate-history-");
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const commit = (msg) => (git("commit", "-q", "--allow-empty", "-m", msg), git("rev-parse", "HEAD"));
  const m1 = commit("m1");
  const m2 = commit("m2");
  git("update-ref", "refs/remotes/origin/main", m2);
  git("switch", "-q", "-c", "feature", m1);
  commit("f1");
  history = { dir, m1, m2 };
});

/** Route a synthetic event through the real router and return what it writes to GITHUB_OUTPUT. */
function route(eventName, payload) {
  const dir = tempDir("gate-event-");
  const event = join(dir, "event.json");
  const output = join(dir, "output");
  writeFileSync(event, JSON.stringify(payload));
  writeFileSync(output, "");
  const out = spawnSync("node", [join(repo, ".github/scripts/gate-tier.mjs")], {
    cwd: history.dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
  });
  assert.equal(out.status, 0, out.stderr);
  return Object.fromEntries(
    readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
}

const pullRequest = (headRef) => ({
  pull_request: {
    head: { ref: headRef, repo: { full_name: "nickderobertis/allowlister-terminal-approval-plugin" } },
    base: { ref: "main", repo: { full_name: "nickderobertis/allowlister-terminal-approval-plugin" } },
  },
});

test("event -> router -> gate step -> justfile: the release PR sweeps, every other PR and a push to main run the affected tier", { skip: journeySkip }, () => {
  const run = gateSandbox();
  const gate = gateJob.steps.at(-1);
  const cases = [
    ["release-plz's release pull request", "pull_request", pullRequest("release-plz-2026-10-07T12-00-00Z"), "run-many", undefined],
    ["an ordinary pull request", "pull_request", pullRequest("feature"), "affected", history.m1],
    ["a push to main", "push", { before: history.m1 }, "affected", history.m1],
  ];
  for (const [what, eventName, payload, mode, base] of cases) {
    const { tier, base: routedBase } = route(eventName, payload);
    // The step's env, as Actions expands it from the router's outputs.
    const { status, stderr, calls } = run(gate.run, { TIER: tier, NX_BASE: routedBase });
    assert.equal(status, 0, `${what}: ${stderr}`);
    assert.equal(calls.length, 1, `${what}: one Nx invocation`);
    const call = parseNx(calls[0]);
    assert.equal(call.mode, mode, `${what} runs nx ${mode}`);
    assert.equal(call.base, base, `${what} keys off ${base ?? "no base (the sweep)"}`);
    assert.deepEqual(call.targets, GATE_TARGETS, `${what} runs every gate target`);
    assert.deepEqual(call.filters, [], `${what} narrows to no subset of projects`);
  }
});

test("a failing sweep on the release PR fails the gate step, and so the required context", { skip: journeySkip }, () => {
  const run = gateSandbox();
  const { tier, base } = route("pull_request", pullRequest("release-plz-2026-10-07T12-00-00Z"));
  assert.equal(tier, "all");
  const red = run(gateJob.steps.at(-1).run, { TIER: tier, NX_BASE: base, GATE_NX_EXIT: "1" });
  assert.notEqual(red.status, 0, "a red `nx run-many` must fail `just check all`, and with it test (<os>)");
  assert.equal(parseNx(red.calls[0]).mode, "run-many");
  // A mistyped tier aborts before Nx runs rather than buying a weaker tier.
  const typo = run('just check "$TIER"', { TIER: "al" });
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown tier 'al'/);
  assert.deepEqual(typo.calls, []);
});

test("publish.yml re-gates the release as the full sweep over every project", { skip: journeySkip }, () => {
  const run = gateSandbox();
  const gates = workflows["publish.yml"].jobs.test.steps.map((s) => s.run).filter((r) => /\bjust\b/.test(r ?? ""));
  assert.deepEqual(gates, ["just bootstrap", "just check all"]);
  const { status, stderr, calls } = run(gates[1]);
  assert.equal(status, 0, stderr);
  const sweep = parseNx(calls[0]);
  assert.deepEqual([sweep.mode, sweep.targets, sweep.filters], ["run-many", GATE_TARGETS, []]);
  for (const needs of [workflows["publish.yml"].jobs["build-binary"].needs, workflows["publish.yml"].jobs["crates-publish"].needs]) {
    assert.ok([needs].flat().includes("test"), "the artifacts publish only after the gate");
  }
});

test("notignored is its own workflow and job, reports no contract context, and skips forks", () => {
  const wf = workflows["notignored.yml"];
  assert.ok("pull_request" in wf.on);
  assert.deepEqual(wf.permissions, { contents: "read", "pull-requests": "write" });
  const [[id, job], ...rest] = Object.entries(wf.jobs);
  assert.equal(rest.length, 0);
  assert.ok(!contexts(id, job).some((c) => c in CONTRACT));
  assert.equal(job.if, "github.event.pull_request.head.repo.full_name == github.repository");
  assert.ok(job.steps.some((s) => s.uses === "nickderobertis/notignored@v0"));
  for (const [file, jobId, other] of allJobs) {
    assert.ok(![other.needs ?? []].flat().includes(id) || file === "notignored.yml", `${file}:${jobId} must not need notignored`);
  }
});
