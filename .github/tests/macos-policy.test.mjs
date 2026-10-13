import assert from "node:assert/strict";
import { test, after } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workflows } from "../macos-graph.mjs";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(
  join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? "/tmp", "macos-policy-"),
);
after(() => rmSync(scratch, { recursive: true, force: true }));
const git = (...args) =>
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd: scratch, encoding: "utf8" },
  ).trim();
git("init", "-q");
writeFileSync(
  join(scratch, "Cargo.toml"),
  '[package]\nname = "example"\nversion = "1.0.0"\n[dependencies]\nserde = "1"\n',
);
writeFileSync(
  join(scratch, "Cargo.lock"),
  'version = 3\n[[package]]\nname = "example"\nversion = "1.0.0"\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry"\n',
);
writeFileSync(join(scratch, "CHANGELOG.md"), "# Changelog\n\n## 1.0.0\n");
writeFileSync(
  join(scratch, "package.json"),
  '{"name":"example","version":"1.0.0","dependencies":{"other":"1"}}',
);
mkdirSync(
  join(scratch, "packages/allowlister-terminal-approval-plugin-darwin-arm64"),
  { recursive: true },
);
writeFileSync(
  join(
    scratch,
    "packages/allowlister-terminal-approval-plugin-darwin-arm64/package.json",
  ),
  JSON.stringify({
    name: "@nickderobertis/allowlister-terminal-approval-plugin-darwin-arm64",
    version: "1.0.0",
    cpu: ["arm64"],
  }),
);
git("add", ".");
git("commit", "-qm", "base");
const base = git("rev-parse", "HEAD");
const payload = (
  ref = "release-plz-test",
  fork = false,
  login = "nickderobertis",
) => ({
  pull_request: {
    title: "release: v1.0.1",
    user: { login },
    head: { ref, repo: { full_name: fork ? "fork/example" : "owner/example" } },
    base: { repo: { full_name: "owner/example" } },
  },
});
export function invoke(
  event,
  head = "HEAD",
  eventName = "pull_request",
  raw = false,
) {
  const path = join(scratch, "event.json");
  writeFileSync(path, raw ? event : JSON.stringify(event));
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
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_OUTPUT: "" },
    },
  );
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}
function change(path, text) {
  git("reset", "--hard", base);
  writeFileSync(join(scratch, path), text);
  git("add", path);
  git("commit", "-qm", "change");
}
test("real classifier subprocess: branch authority and parsed non-version data, with conservative failures", () => {
  change(
    "Cargo.toml",
    '[package]\nname = "example"\nversion = "1.0.1"\n[dependencies]\nserde = "1"\n',
  );
  assert.equal(invoke(payload()).isReleaseOnly, true);
  assert.equal(
    invoke(payload("release-plz-test", false, "github-actions[bot]"))
      .isReleaseOnly,
    true,
  );
  for (const event of [
    payload("feature"),
    payload("feature", false, "github-actions[bot]"),
    payload("release-plz-test", true),
  ])
    assert.equal(invoke(event).macosRequired, true);
  assert.equal(invoke(payload(), "missing").macosRequired, true);
  assert.equal(
    invoke("{bad", "HEAD", "pull_request", true).macosRequired,
    true,
  );
  assert.equal(invoke(null).macosRequired, true);
  for (const event of [
    "push",
    "release",
    "schedule",
    "workflow_run",
    "workflow_dispatch",
    "repository_dispatch",
  ])
    assert.equal(invoke(null, "missing", event).macosRequired, false);
  change(
    "Cargo.toml",
    '[package]\nname = "example"\nversion = "1.0.1"\n[dependencies]\nserde = "2"\n',
  );
  assert.equal(invoke(payload()).macosRequired, true);
  change(
    "Cargo.lock",
    'version = 3\n[[package]]\nname = "example"\nversion = "1.0.1"\n[[package]]\nname = "serde"\nversion = "2.0.0"\nsource = "registry"\n',
  );
  assert.equal(invoke(payload()).macosRequired, true);
  change(
    "Cargo.lock",
    'version = 3\n[[package]]\nname = "example"\nversion = "1.0.1"\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry"\n',
  );
  assert.equal(invoke(payload()).isReleaseOnly, true);
  change(
    "package.json",
    '{"name":"example","version":"1.0.1","dependencies":{"other":"2"}}',
  );
  assert.equal(invoke(payload()).macosRequired, true);
  change(
    "package.json",
    '{"name":"example","version":"1.0.1","dependencies":{"other":"1"}}',
  );
  assert.equal(invoke(payload()).isReleaseOnly, true);
  change(
    "package.json",
    '{"dependencies":{"other":"1"},"version":"1.0.1","name":"example"}',
  );
  assert.equal(
    invoke(payload()).isReleaseOnly,
    true,
    "JSON object key order is not a semantic field change",
  );
  change("Cargo.toml", "broken");
  assert.equal(invoke(payload()).macosRequired, true);
  change("source.rs", "fn changed() {}");
  assert.equal(invoke(payload()).macosRequired, true);
});
test("classifier edge cases through git histories and the real parsing subprocess", () => {
  assert.equal(
    invoke(payload(), base).macosRequired,
    true,
    "empty diff requires proof",
  );
  change("CHANGELOG.md", "# Changelog\n\n## 1.0.1\n- Fixed behavior.\n");
  assert.equal(invoke(payload()).isReleaseOnly, true);
  change("CHANGELOG.md", "unstructured document");
  assert.equal(invoke(payload()).macosRequired, true);
  const path =
    "packages/allowlister-terminal-approval-plugin-darwin-arm64/package.json";
  change(
    path,
    JSON.stringify({
      name: "@nickderobertis/allowlister-terminal-approval-plugin-darwin-arm64",
      version: "1.0.1",
      cpu: ["arm64"],
    }),
  );
  assert.equal(invoke(payload()).isReleaseOnly, true);
  change(
    path,
    JSON.stringify({
      name: "@nickderobertis/allowlister-terminal-approval-plugin-darwin-arm64",
      version: "1.0.1",
      cpu: ["x64"],
    }),
  );
  assert.equal(invoke(payload()).macosRequired, true);
  for (const text of [
    '[package]\nname = "unexpected"\nversion = "1.0.1"\n',
    '[package]\nname = "example"\nversion = "invalid"\n',
  ]) {
    change("Cargo.toml", text);
    assert.equal(invoke(payload()).macosRequired, true);
  }
  for (const text of [
    'version = 3\n[[package]]\nname = "other"\nversion = "1.0.0"\n',
    'version = 3\n[[package]]\nname = "example"\nversion = "1.0.1"\n[[package]]\nname = "example"\nversion = "1.0.2"\n',
  ]) {
    change("Cargo.lock", text);
    assert.equal(invoke(payload()).macosRequired, true);
  }
  for (const version of [
    "1.0.1",
    "1.0.1-beta.2",
    "1.0.1+build",
    "invalid",
    "1.0",
    "1.0.1\n",
  ]) {
    change(
      "Cargo.toml",
      `[package]\nname = "example"\nversion = ${JSON.stringify(version)}\n[dependencies]\nserde = "1"\n`,
    );
    const cargo = invoke(payload());
    change(
      "package.json",
      JSON.stringify({
        name: "example",
        version,
        dependencies: { other: "1" },
      }),
    );
    assert.equal(
      invoke(payload()).isReleaseOnly,
      cargo.isReleaseOnly,
      `shared version grammar: ${version}`,
    );
  }
  git("reset", "--hard", base);
  rmSync(join(scratch, "Cargo.toml"));
  git("add", "Cargo.toml");
  git("commit", "-qm", "delete manifest");
  assert.equal(invoke(payload()).macosRequired, true);
  const badMode = spawnSync(
    "python3",
    [join(repo, ".github/semantic-release.py"), "unknown", "example"],
    { input: JSON.stringify(["", ""]), encoding: "utf8" },
  );
  assert.notEqual(badMode.status, 0);
  assert.match(badMode.stderr, /expected manifest or lock/);
});
test("shared strict SemVer accepts every existing release tag and agrees with the real npm setter", () => {
  const pattern = new RegExp(
    readFileSync(
      join(repo, "scripts/release-version-pattern.txt"),
      "utf8",
    ).trim(),
  );
  const tags = execFileSync("git", ["tag", "--list", "v*"], {
    cwd: repo,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const tag of tags)
    assert.ok(
      pattern.test(tag.slice(1)),
      `existing release ${tag} remains accepted`,
    );
  const dir = mkdtempSync(join(scratch, "setter-"));
  for (const platform of [
    "",
    "-linux-x64",
    "-linux-arm64",
    "-darwin-x64",
    "-darwin-arm64",
  ]) {
    const path = join(
      dir,
      "packages",
      `allowlister-terminal-approval-plugin${platform}`,
    );
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({
        name: `@nickderobertis/allowlister-terminal-approval-plugin${platform}`,
        version: "1.0.0",
      }),
    );
  }
  for (const version of [
    "1.0.1",
    "1.0.1-beta.2",
    "1.0.1+001",
    "1.0.1-beta+build.2",
    "01.0.0",
    "1.0.0-.",
    "1.0.0-beta_1",
    "1.0.0-01",
    "invalid",
    "1.0.1\n",
  ]) {
    change(
      "package.json",
      JSON.stringify({
        name: "example",
        version,
        dependencies: { other: "1" },
      }),
    );
    const classification = invoke(payload());
    const setter = spawnSync(
      "node",
      [join(repo, "scripts/set-npm-package-version.mjs"), version],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(
      setter.status === 0,
      classification.isReleaseOnly,
      `setter/classifier parity: ${version}`,
    );
    if (setter.status !== 0) {
      assert.match(
        setter.stderr,
        /strict SemVer without surrounding whitespace/,
      );
      assert.ok(setter.stderr.includes(JSON.stringify(version)));
    }
    if (setter.status === 0)
      assert.equal(
        JSON.parse(
          readFileSync(
            join(
              dir,
              "packages/allowlister-terminal-approval-plugin/package.json",
            ),
            "utf8",
          ),
        ).version,
        version,
      );
  }
});
test("production CLI validates arguments/events and transports decisions through GITHUB_OUTPUT", () => {
  const event = join(scratch, "transport-event.json"),
    output = join(scratch, "transport-output");
  const args = ["classify", "--event", event, "--base", base, "--head", "HEAD"];
  const invoke = (arguments_, name = "pull_request") => {
    const env = { ...process.env, GITHUB_OUTPUT: output };
    if (name === undefined) delete env.GITHUB_EVENT_NAME;
    else env.GITHUB_EVENT_NAME = name;
    return spawnSync(
      "node",
      [join(repo, ".github/macos-policy.mjs"), ...arguments_],
      { cwd: scratch, encoding: "utf8", env },
    );
  };
  change(
    "Cargo.toml",
    '[package]\nname = "example"\nversion = "1.0.1"\n[dependencies]\nserde = "1"\n',
  );
  for (const [eventPayload, required, release] of [
    [payload(), false, true],
    [payload("feature"), true, false],
  ]) {
    writeFileSync(event, JSON.stringify(eventPayload));
    writeFileSync(output, "");
    const out = invoke(args);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout).macosRequired, required);
    assert.equal(
      readFileSync(output, "utf8"),
      `macosRequired=${required}\nisReleaseOnly=${release}\n`,
    );
  }
  for (const name of ["", "pull_requst", "unsupported"]) {
    const out = invoke(args, name);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /unsupported GITHUB_EVENT_NAME/);
    assert.ok(out.stderr.includes(JSON.stringify(name)));
  }
  const env = { ...process.env, GITHUB_OUTPUT: "" };
  delete env.GITHUB_EVENT_NAME;
  writeFileSync(event, "{malformed");
  const absent = spawnSync(
    "node",
    [join(repo, ".github/macos-policy.mjs"), ...args],
    { cwd: scratch, encoding: "utf8", env },
  );
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(JSON.parse(absent.stdout).macosRequired, true);
  for (const invalid of [
    ["classify"],
    ["classify", "--event", event, "--base", base],
    ["classify", "--event", event, "--base", base, "--base", "HEAD"],
    ["classify", "--event", event, "--unknown", base, "--head", "HEAD"],
    ["classify", "--event", event, "--base", base, "--head"],
  ]) {
    const out = invoke(invalid);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /expected|invalid classifier option/);
  }
  const nonPR = invoke(
    ["classify", "--event", event, "--base", "", "--head", ""],
    "push",
  );
  assert.equal(nonPR.status, 0, nonPR.stderr);
  assert.equal(JSON.parse(nonPR.stdout).macosRequired, false);
});
test("protected carrier drives real command for third-party result boundary", () => {
  for (const policy of [
    "success",
    "failure",
    "cancelled",
    "skipped",
    undefined,
  ])
    for (const required of ["true", "false", undefined])
      for (const proof of [
        "success",
        "failure",
        "cancelled",
        "skipped",
        undefined,
      ]) {
        const carrier = workflows["ci.yml"].jobs["macos-result"];
        const out = spawnSync(
          "bash",
          ["-eo", "pipefail", "-c", carrier.steps.at(-1).run],
          {
            cwd: repo,
            encoding: "utf8",
            env: {
              ...process.env,
              MACOS_REQUIRED: required ?? "",
              POLICY_RESULT: policy ?? "",
              PROOF_RESULT: proof ?? "",
            },
          },
        );
        const accepted =
          policy === "success" &&
          ["true", "false"].includes(required) &&
          (proof === "success" ||
            (proof === "skipped" && required === "false"));
        assert.equal(
          out.status === 0,
          accepted,
          JSON.stringify({ policy, required, proof }),
        );
        if (accepted && proof === "skipped")
          assert.match(out.stdout, /intentionally omitted/);
      }
});
