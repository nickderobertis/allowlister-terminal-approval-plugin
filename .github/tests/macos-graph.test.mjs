import assert from "node:assert/strict";
import { test } from "node:test";
import { schemaVersion, measurements } from "../macos-telemetry.mjs";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  workflows,
  resolve,
  triggered,
  digest,
  matrix,
} from "../macos-graph.mjs";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const required = [
  "test (ubuntu-latest)",
  "test (ubuntu-24.04-arm)",
  "test (macos-latest)",
  "install-smoke",
  "llmlint",
  "pr-title",
];
const events = [
  ["pull_request", "opened"],
  ["pull_request", "synchronize"],
  ["pull_request", "reopened"],
  ["push", "base"],
  ["push", "release-merge"],
  ["push", "tag"],
  ["release", "published"],
  ["workflow_run", "completed"],
  ["repository_dispatch", ""],
  ["schedule", ""],
  ["workflow_dispatch", "default"],
  ["workflow_dispatch", "opt-in"],
];
test("actual workflow graph and classifier across twelve event classes, three diffs and both ownership classes; record telemetry", () => {
  const dir = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? "/tmp", "graph-history-"),
  );
  try {
    const git = (...args) =>
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
        { cwd: dir, encoding: "utf8" },
      ).trim();
    git("init", "-q");
    writeFileSync(
      join(dir, "Cargo.toml"),
      '[package]\nname = "example"\nversion = "1.0.0"\n',
    );
    writeFileSync(join(dir, "source.rs"), "fn main() {}\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const runs = [],
      scenarios = [],
      lifecycles = [];
    const runEvent = (event, policy, label) =>
      Object.entries(workflows)
        .filter(([, wf]) => triggered(wf, event))
        .map(([file]) => ({
          scenario: label,
          workflow: file,
          event: event.name,
          action: event.action,
          head:
            event.payload?.pull_request?.head?.sha ??
            event.tag ??
            "fixture-base",
          tag: event.tag ?? null,
          rows: resolve(file, event, policy),
        }));
    for (const diff of ["source", "version-only", "dependency-content"])
      for (const fork of [false, true]) {
        git("reset", "--hard", base);
        writeFileSync(
          join(dir, diff === "source" ? "source.rs" : "Cargo.toml"),
          diff === "source"
            ? 'fn main() { panic!("change"); }\n'
            : `[package]\nname = "example"\nversion = "1.0.1"\n${diff === "dependency-content" ? '[dependencies]\nserde = "2"\n' : ""}`,
        );
        git("add", ".");
        git("commit", "-qm", diff);
        const head = git("rev-parse", "HEAD");
        for (const [name, action] of events)
          for (const crates of [false, true]) {
            const pr = {
              head: {
                ref: diff === "source" ? "feature" : "release-plz-fixture",
                sha: head,
                repo: {
                  full_name: fork
                    ? "fork/repo"
                    : "nickderobertis/allowlister-terminal-approval-plugin",
                },
              },
              base: {
                ref: "main",
                sha: base,
                repo: {
                  full_name:
                    "nickderobertis/allowlister-terminal-approval-plugin",
                },
              },
              user: { login: "nickderobertis" },
            };
            const event = {
              name,
              action,
              crates,
              branch: action === "tag" ? undefined : "main",
              tag:
                action === "tag" || name === "release" ? "v1.0.1" : undefined,
              inputs: { diagnostic: action === "opt-in" },
              payload:
                name === "pull_request"
                  ? { pull_request: pr }
                  : name === "release"
                    ? { release: { tag_name: "v1.0.1" } }
                    : {},
              upstream: "publish",
            };
            const path = join(dir, "event.json");
            writeFileSync(path, JSON.stringify(event.payload));
            const out = spawnSync(
              "node",
              [
                join(repo, ".github/macos-policy.mjs"),
                "classify",
                "--event",
                path,
                "--base",
                base,
                "--head",
                head,
              ],
              {
                cwd: dir,
                encoding: "utf8",
                env: {
                  ...process.env,
                  GITHUB_EVENT_NAME: name,
                  GITHUB_OUTPUT: "",
                },
              },
            );
            assert.equal(out.status, 0, out.stderr);
            const policy = JSON.parse(out.stdout);
            assert.equal(
              policy.macosRequired,
              name === "pull_request" && !(diff === "version-only" && !fork),
            );
            const label = `${name}:${action}:${diff}:${fork ? "fork" : "same"}:crates-${crates}`;
            scenarios.push({ label, event, policy });
            const resolved = runEvent(event, policy, label);
            runs.push(...resolved);
            const macProof = resolved
              .flatMap((run) => run.rows)
              .find((row) => row.job === "macos-test");
            if (macProof)
              assert.equal(
                macProof.enabled,
                policy.macosRequired ||
                  (name === "workflow_dispatch" && action === "opt-in"),
                `${label}: actual Mac proof routing`,
              );
            if (name === "pull_request")
              for (const ctx of required)
                assert.equal(
                  resolved
                    .flatMap((run) => run.rows)
                    .filter((row) => row.name === ctx && row.enabled).length,
                  1,
                  `${label}: ${ctx}`,
                );
            if (
              name !== "pull_request" &&
              name !== "release" &&
              action !== "opt-in"
            )
              assert.ok(
                resolved.every((run) => run.rows.every((row) => !row.macos)),
                `${label}: automatic non-PR event`,
              );
          }
      }
    const unreadablePath = join(dir, "unreadable-event.json");
    writeFileSync(unreadablePath, "{malformed");
    const unknown = spawnSync(
      "node",
      [
        join(repo, ".github/macos-policy.mjs"),
        "classify",
        "--event",
        unreadablePath,
        "--base",
        "missing",
        "--head",
        "missing",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_OUTPUT: "",
        },
      },
    );
    assert.equal(unknown.status, 0, unknown.stderr);
    const unknownPolicy = JSON.parse(unknown.stdout),
      unknownEvent = {
        name: "pull_request",
        action: "synchronize",
        branch: "main",
        payload: {},
      };
    const unknownRuns = runEvent(
      unknownEvent,
      unknownPolicy,
      "unknown-input PR",
    );
    assert.ok(
      unknownRuns
        .flatMap((run) => run.rows)
        .some((row) => row.job === "macos-test" && row.macos),
    );
    runs.push(...unknownRuns);
    scenarios.push({
      label: "unknown-input PR",
      event: unknownEvent,
      policy: unknownPolicy,
    });
    // Automatic fan-out comes from the production release-plz commands and workflow triggers.
    const releaseSteps = workflows["release-plz.yml"].jobs["release-plz"].steps
      .map((s) => s.run ?? "")
      .join("\n");
    assert.match(releaseSteps, /release-plz release-pr/);
    assert.match(releaseSteps, /release-plz release --git-token/);
    for (const crates of [false, true]) {
      const ordinaryScenario = scenarios.find(
        (s) =>
          s.label === `pull_request:synchronize:source:same:crates-${crates}`,
      );
      const releaseScenario = scenarios.find(
        (s) =>
          s.label === `pull_request:opened:version-only:same:crates-${crates}`,
      );
      const ordinary = runEvent(
        ordinaryScenario.event,
        ordinaryScenario.policy,
        "ordinary push",
      );
      const merge = runEvent(
        { name: "push", branch: "main", crates },
        { macosRequired: false },
        "base merge",
      );
      const releasePR = runEvent(
        releaseScenario.event,
        releaseScenario.policy,
        "semantic release-only PR",
      );
      const releaseMerge = runEvent(
        { name: "push", branch: "main", crates },
        { macosRequired: false },
        "release PR merge",
      );
      const tag = runEvent(
        { name: "push", tag: "v1.0.1", crates },
        { macosRequired: false },
        "release tag",
      );
      const release = runEvent(
        {
          name: "release",
          action: "published",
          tag: "v1.0.1",
          payload: { release: { tag_name: "v1.0.1" } },
          crates,
        },
        { macosRequired: false },
        "pre-publication release build",
      );
      const downstream = [
        ...ordinary,
        ...merge,
        ...releasePR,
        ...releaseMerge,
        ...tag,
        ...release,
      ].flatMap((run) =>
        runEvent(
          {
            name: "workflow_run",
            action: "completed",
            upstream: workflows[run.workflow].name,
            crates,
          },
          { macosRequired: false },
          `downstream ${run.workflow}`,
        ),
      );
      lifecycles.push({
        crates,
        runs: [
          ...ordinary,
          ...merge,
          ...releasePR,
          ...releaseMerge,
          ...tag,
          ...release,
          ...downstream,
        ],
      });
    }
    mkdirSync(join(repo, ".github/.telemetry"), { recursive: true });
    writeFileSync(
      join(repo, ".github/.telemetry/macos-policy.json"),
      JSON.stringify(
        {
          schemaVersion,
          measurements: measurements(runs, lifecycles),
          digest: digest(),
          scenarios,
          runs,
          lifecycles,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("real SDK measurement commands consume writer output and reject stale/malformed inputs", () => {
  const telemetry = JSON.parse(
    readFileSync(join(repo, ".github/.telemetry/macos-policy.json"), "utf8"),
  );
  const dir = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? "/tmp", "budget-reader-"),
  );
  try {
    const path = join(dir, "telemetry.json"),
      report = join(dir, "result.json");
    const invoke = (args) =>
      spawnSync("node", [join(repo, ".github/macos-budget.mjs"), ...args], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, ONEBUDGETSPEC_RESULT: report },
      });
    writeFileSync(path, JSON.stringify(telemetry));
    for (const [metric, actual] of [
      [
        "jobs-per-run",
        Math.max(
          ...telemetry.runs.map(
            (run) => run.rows.filter((row) => row.macos).length,
          ),
        ),
      ],
      [
        "runs-per-change",
        Math.max(
          ...telemetry.lifecycles.map(
            (cycle) =>
              cycle.runs.filter((run) => run.rows.some((row) => row.macos))
                .length,
          ),
        ),
      ],
    ]) {
      const out = invoke(["--metric", metric, "--telemetry", path]);
      assert.equal(out.status, 0, out.stderr);
      assert.equal(JSON.parse(out.stdout).value, actual);
      const result = JSON.parse(readFileSync(report, "utf8"));
      assert.equal(result.value, actual);
      const detail = JSON.parse(result.detail);
      assert.ok(detail.runs.every((run) => run.rows.some((row) => row.macos)));
      assert.deepEqual(detail.scenarios, telemetry.scenarios);
      assert.equal(detail.lifecycles.length, telemetry.lifecycles.length);
      for (const [index, cycle] of detail.lifecycles.entries()) {
        assert.equal(
          cycle.crates,
          telemetry.lifecycles[index].crates,
          "optional publication metadata is preserved",
        );
        assert.ok(
          cycle.runs.every((run) => run.rows.some((row) => row.macos)),
          "lifecycle detail contains only Mac-spending runs",
        );
        for (const original of telemetry.lifecycles[index].runs) {
          const preserved = cycle.runs.some(
            (run) =>
              run.workflow === original.workflow &&
              run.scenario === original.scenario,
          );
          assert.equal(
            preserved,
            original.rows.some((row) => row.macos),
            `${original.scenario}: lifecycle detail follows actual runner rows`,
          );
        }
      }
    }
    const corrupt = (edit) => {
      const value = structuredClone(telemetry);
      edit(value);
      return value;
    };
    const invalidInputs = [
      { ...telemetry, digest: "stale" },
      corrupt((value) => delete value.schemaVersion),
      { ...telemetry, schemaVersion: schemaVersion + 1 },
      { ...telemetry, runs: [] },
      { ...telemetry, runs: null },
      { ...telemetry, runs: [null] },
      corrupt((value) => (value.runs[0].workflow = null)),
      corrupt((value) => (value.runs[0].event = 42)),
      corrupt((value) => delete value.runs[0].rows),
      corrupt((value) => (value.runs[0].rows = "missing rows")),
      corrupt((value) => (value.runs[0].rows = [])),
      corrupt((value) => (value.runs[0].rows[0] = null)),
      corrupt((value) => (value.runs[0].rows[0].target = null)),
      corrupt((value) => (value.runs[0].rows[0].enabled = "true")),
      corrupt((value) => (value.runs[0].rows[0].macos = "false")),
      corrupt((value) => (value.runs[0].rows[0].runner = "self-hosted")),
      corrupt(
        (value) => (value.runs[0].rows[0].macos = !value.runs[0].rows[0].macos),
      ),
      { ...telemetry, lifecycles: [] },
      { ...telemetry, lifecycles: null },
      corrupt((value) => delete value.lifecycles[0].runs),
      corrupt((value) => (value.lifecycles[0].runs = "missing lifecycle runs")),
      corrupt((value) => (value.lifecycles[0].runs = [])),
      corrupt((value) => delete value.scenarios),
      { ...telemetry, scenarios: null },
      { ...telemetry, scenarios: [] },
      { ...telemetry, measurements: {} },
      corrupt((value) => (value.measurements.jobsPerRun += 1)),
      corrupt((value) => (value.measurements.runsPerChange += 1)),
    ];
    for (const invalid of invalidInputs) {
      writeFileSync(path, JSON.stringify(invalid));
      const out = invoke(["--metric", "jobs-per-run", "--telemetry", path]);
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, /telemetry/);
    }
    assert.notEqual(invoke(["--metric", "jobs-per-run"]).status, 0);
    assert.notEqual(
      invoke(["--metric", "jobs-per-run", "--telemetry", join(dir, "missing")])
        .status,
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unresolved runner/call expressions fail instead of reporting zero", () => {
  for (const spec of [
    [],
    {},
    null,
    false,
    "${{ inputs.matrix }}",
    { os: [] },
    { include: [] },
  ])
    assert.throws(() => matrix({ strategy: { matrix: spec } }), /unresolved/);
  assert.deepEqual(matrix({}), [{}], "no matrix is one ordinary job instance");
  for (const [config, event] of [
    [{ branches: ["main"] }, { name: "push", branch: "other" }],
    [{ tags: ["v1.0.0"] }, { name: "push", tag: "v2.0.0" }],
    [{ types: ["published"] }, { name: "release", action: "created" }],
    [{ workflows: ["publish"] }, { name: "workflow_run", upstream: "CI" }],
  ])
    assert.equal(triggered({ on: { [event.name]: config } }, event), false);
  workflows["invalid.yml"] = {
    jobs: { bad: { "runs-on": "${{ mystery.runner }}" } },
  };
  assert.throws(
    () => resolve("invalid.yml", { name: "push" }, {}),
    /Unrecognized named-value|mystery/,
  );
  workflows["invalid.yml"] = {
    jobs: { bad: { uses: "owner/repo/.github/workflows/remote.yml@main" } },
  };
  assert.throws(
    () => resolve("invalid.yml", { name: "push" }, {}),
    /unresolved reusable call/,
  );
  workflows["invalid.yml"] = {
    jobs: { bad: { uses: "./.github/workflows/missing.yml" } },
  };
  assert.throws(
    () => resolve("invalid.yml", { name: "push" }, {}),
    /unresolved reusable workflow/,
  );
  workflows["invalid.yml"] = {
    jobs: { nested: { uses: "./.github/workflows/pr-title.yml" } },
  };
  assert.ok(
    resolve("invalid.yml", { name: "pull_request" }, {}).some(
      (row) => row.name === "pr-title",
    ),
    "local reusable calls are traversed",
  );
  workflows["invalid.yml"] = {
    jobs: {
      grid: {
        "runs-on": "${{ matrix.os }}",
        strategy: {
          matrix: {
            os: ["ubuntu-latest", "macos-latest"],
            target: ["first", "second"],
            exclude: [{ os: "macos-latest", target: "second" }],
            include: [
              { os: "macos-latest", target: "first", extra: "included" },
              { os: "windows-latest", target: "third" },
            ],
          },
        },
      },
    },
  };
  const expanded = resolve("invalid.yml", { name: "push" }, {});
  assert.deepEqual(
    expanded.map((row) => [row.runner, row.target]),
    [
      ["ubuntu-latest", "first"],
      ["ubuntu-latest", "second"],
      ["macos-latest", "first"],
      ["windows-latest", "third"],
    ],
  );
  assert.equal(
    matrix(workflows["invalid.yml"].jobs.grid).find(
      (row) => row.os === "macos-latest",
    ).extra,
    "included",
  );
  workflows["nested.yml"] = {
    jobs: {
      grid: {
        "runs-on": "${{ matrix.os }}",
        if: "inputs.enabled",
        strategy: { matrix: { os: ["ubuntu-latest", "macos-latest"] } },
      },
    },
  };
  workflows["invalid.yml"] = {
    jobs: {
      call: {
        uses: "./.github/workflows/nested.yml",
        strategy: { matrix: { enabled: [true, false] } },
        with: { enabled: "${{ matrix.enabled }}" },
      },
    },
  };
  const calls = resolve("invalid.yml", { name: "push" }, {});
  assert.deepEqual(
    calls.map((row) => [row.runner, row.enabled]),
    [
      ["ubuntu-latest", true],
      ["macos-latest", true],
      ["ubuntu-latest", false],
      ["macos-latest", false],
    ],
  );
  for (const condition of [false, "false"]) {
    workflows["invalid.yml"].jobs.call.if = condition;
    assert.ok(
      resolve("invalid.yml", { name: "push" }, {}).every(
        (row) => !row.enabled && !row.macos,
      ),
      "disabled caller suppresses every nested runner",
    );
  }
  delete workflows["invalid.yml"].jobs.call.if;
  workflows["invalid.yml"].jobs.call.with = { diagnostic: true };
  assert.throws(
    () => resolve("invalid.yml", { name: "push" }, {}),
    /cannot opt into diagnostics/,
  );
  workflows["nested.yml"] = {
    jobs: {
      capture: {
        name: "capture (${{ inputs.marker }})",
        "runs-on": "${{ inputs.runner }}",
      },
    },
  };
  for (const [inputs, expected] of [
    [{ runner: "macos-latest", marker: "literal" }, "literal"],
    [
      { runner: "${{ matrix.os }}", marker: "prefix-${{ matrix.marker }}" },
      "prefix-token",
    ],
    [{ runner: "${{ matrix.os }}", marker: "${{ matrix.marker }}" }, "token"],
    [{ runner: "${{ matrix.os }}", marker: "${{ matrix.number }}" }, "7"],
  ]) {
    workflows["invalid.yml"] = {
      jobs: {
        call: {
          uses: "./.github/workflows/nested.yml",
          with: inputs,
          strategy: {
            matrix: { os: ["macos-latest"], marker: ["token"], number: [7] },
          },
        },
      },
    };
    const forwarded = resolve("invalid.yml", { name: "pull_request" }, {});
    assert.deepEqual(
      forwarded.map((row) => [row.runner, row.name, row.macos]),
      [["macos-latest", `capture (${expected})`, true]],
      "caller scalar inputs reach the real callee expression evaluation",
    );
  }
  delete workflows["nested.yml"];
  assert.equal(
    triggered(
      { on: { schedule: [{ cron: "0 0 * * *" }] } },
      { name: "schedule" },
    ),
    true,
  );
  for (const config of [
    { paths: ["src/**"] },
    { "branches-ignore": ["main"] },
    { tags: ["v*"] },
  ])
    assert.throws(
      () =>
        triggered({ on: { push: config } }, { name: "push", branch: "main" }),
      /unsupported trigger/,
    );
  delete workflows["invalid.yml"];
});
// This host cannot execute Darwin binaries or a GitHub-hosted Mac job. The real
// release staging/publish journey (registry and forge doubled) is in the
// carrier's release.journey.mjs; this test pins the declared targets. macOS ships
// arm64 only, built natively on the one Mac release job; actual Mac execution
// remains third-party evidence, so this test does not claim it ran.
test("release targets and exact-tag artifact dependencies preserve every platform with one native arm64 Darwin compile", () => {
  const wf = workflows["publish.yml"];
  const linux = matrix(wf.jobs["build-binary"]);
  assert.deepEqual(
    linux.map((c) => [c.platform, c.target]),
    [
      ["linux-x64", "x86_64-unknown-linux-musl"],
      ["linux-arm64", "aarch64-unknown-linux-musl"],
    ],
  );
  const darwin = wf.jobs["build-darwin"];
  const script = darwin.steps.map((s) => s.run ?? "").join("\n");
  assert.deepEqual(
    [...script.matchAll(/just build-release (\S+)/g)].map((m) => m[1]),
    ["aarch64-apple-darwin"],
  );
  assert.match(
    script,
    /target\/aarch64-apple-darwin\/release\/allowlister-terminal-approval-plugin dist\/artifacts\/allowlister-terminal-approval-plugin-darwin-arm64/,
  );
  assert.match(script, /release:stage-npm -- dist\/artifacts darwin-arm64\n/);
  assert.match(script, /test "\$\(uname -m\)" = arm64/);
  assert.match(
    script,
    /lipo -verify_arch arm64 dist\/artifacts\/allowlister-terminal-approval-plugin-darwin-arm64/,
  );
  assert.doesNotMatch(
    script,
    /x86_64|darwin-x64|rosetta|arch -/i,
    "no Intel macOS build, cross-compile or Rosetta step",
  );
  assert.ok(!darwin.steps.some((s) => s.with?.architecture));
  assert.deepEqual(
    darwin.steps
      .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
      .map((step) => step.with.name),
    ["binary-darwin-arm64"],
  );
  for (const job of [wf.jobs["github-release"], wf.jobs["npm-publish"]])
    for (const step of job.steps.filter((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    )) {
      assert.equal(
        step.with["run-id"],
        undefined,
        "artifacts come from this exact release run",
      );
      assert.equal(step.with["github-token"], undefined);
    }
  for (const id of ["github-release", "npm-publish"])
    for (const needed of ["build-binary", "build-darwin"])
      assert.ok(wf.jobs[id].needs.includes(needed));
  assert.equal(
    wf.jobs["github-release"].steps.find((s) =>
      s.uses?.startsWith("softprops/"),
    ).with.tag_name,
    "${{ github.event.release.tag_name }}",
  );
  const npm = wf.jobs["npm-publish"].steps.map((s) => s.run ?? "").join("\n");
  for (const platform of [...linux.map((c) => c.platform), "darwin-arm64"])
    assert.match(
      npm,
      new RegExp(
        `publish_pkg allowlister-terminal-approval-plugin-${platform}`,
      ),
    );
  assert.doesNotMatch(npm, /darwin-x64/);
});

// Every job that publishes (forge release, npm, crates.io) must wait, through its
// needs chain, on the Apple Silicon build succeeding: plain `needs` (no
// always()/failure() override) means a failed build-darwin skips the job.
test("every publishing job depends on the arm64 Darwin build succeeding", () => {
  const { jobs } = workflows["publish.yml"];
  const needsOf = (id) => [jobs[id].needs ?? []].flat();
  const upstream = (id, seen = new Set()) => {
    for (const dep of needsOf(id))
      if (!seen.has(dep)) {
        seen.add(dep);
        upstream(dep, seen);
      }
    return seen;
  };
  const publishing = Object.keys(jobs).filter((id) =>
    jobs[id].steps.some(
      (s) =>
        /\b(npm|cargo) publish\b/.test(s.run ?? "") ||
        s.uses?.startsWith("softprops/action-gh-release@"),
    ),
  );
  assert.deepEqual(publishing.sort(), [
    "crates-publish",
    "github-release",
    "npm-publish",
  ]);
  for (const id of publishing) {
    assert.ok(upstream(id).has("build-darwin"), `${id} needs build-darwin`);
    assert.doesNotMatch(
      String(jobs[id].if ?? ""),
      /always\(|failure\(|cancelled\(/,
      `${id} must not run past a failed build-darwin`,
    );
  }
  assert.ok(!upstream("build-darwin").has("crates-publish"));
});
