import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repo } from "./tree.mjs";

// Ordinary Git commits and pushes: no hook bypass and no command doubles.
test("setup retires the generated pre-push hook and ordinary pushes reach the remote", (t) => {
  // Bootstrap permits environments without the optional hook manager.
  const manager = spawnSync("lefthook", ["version"], { encoding: "utf8" });
  if (manager.error?.code === "ENOENT") {
    t.skip("lefthook is missing; install it to run the real-hook push journey");
    return;
  }
  assert.equal(manager.status, 0, String(manager.error || manager.stderr || manager.stdout));
  const root = mkdtempSync(join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR || process.env.TMPDIR || "/tmp", "hooks-"));
  const dir = join(root, "clone");
  mkdirSync(dir);
  const run = (bin, args) => {
    const result = spawnSync(bin, args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_TRACE: "1" } });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  const git = (...args) => run("git", args).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Hook test");
    git("config", "user.email", "hooks@example.com");
    git("init", "--bare", "-q", join(root, "remote.git"));
    git("remote", "add", "origin", join(root, "remote.git"));
    mkdirSync(join(dir, "tools"));
    for (const file of ["justfile", "lefthook.yml", "tools/install-hooks.mjs"]) copyFileSync(join(repo, file), join(dir, file));
    // Let the actual manager generate the legacy dispatcher, then migrate it.
    writeFileSync(join(dir, "lefthook.yml"), readFileSync(join(repo, "lefthook.yml"), "utf8") + '\npre-push:\n  commands:\n    llmlint-validate:\n      run: llmlint validate\n');
    run("lefthook", ["install"]);
    assert.ok(existsSync(join(dir, ".git/hooks/pre-push")));
    copyFileSync(join(repo, "lefthook.yml"), join(dir, "lefthook.yml"));
    const bootstrapHooks = readFileSync(join(repo, "justfile"), "utf8")
      .match(/    if command -v lefthook >\/dev\/null; then\n[\s\S]*?    fi/)[0];
    const missingTools = join(root, "empty-path");
    mkdirSync(missingTools);
    const missingManager = spawnSync("/bin/bash", ["-eu", "-o", "pipefail", "-c", bootstrapHooks], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: missingTools },
    });
    assert.equal(missingManager.status, 0, missingManager.stderr);
    assert.equal(missingManager.stdout, "");
    assert.match(missingManager.stderr, /lefthook missing; install lefthook, then run just hooks-install/);
    // Execute bootstrap's hook stage itself, without provisioning unrelated tools.
    const setup = () => run("bash", ["-eu", "-o", "pipefail", "-c", bootstrapHooks]);
    setup();
    const push = () => {
      assert.equal(existsSync(join(dir, ".git/hooks/pre-push")), false);
      const result = spawnSync("git", ["push", "origin", "main"], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_TRACE: "1" } });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const output = result.stdout + result.stderr;
      assert.doesNotMatch(output, /hooks\/pre-push|lefthook run/);
      assert.doesNotMatch(output, /llmlint|clippy|nextest|cargo deny|capture/);
      assert.equal(git("--git-dir", join(root, "remote.git"), "rev-parse", "refs/heads/main"), git("rev-parse", "HEAD"));
      assert.equal(git("status", "--porcelain"), "");
    };
    git("add", ".");
    git("commit", "-qm", "first");
    push();
    writeFileSync(join(dir, "llmlint.yml"), "# changed guarded configuration\n");
    writeFileSync(join(dir, "bad.txt"), "trailing whitespace \n");
    git("add", ".");
    const rejected = spawnSync("git", ["commit", "-qm", "must reject"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout + rejected.stderr, /trailing whitespace/);
    rmSync(join(dir, "bad.txt"));
    git("add", "-A");
    git("commit", "-qm", "changed");
    push();
    push();
    setup();
    push();
    assert.ok(existsSync(join(dir, ".git/hooks/pre-commit")));
    // Shared paths and unrelated custom hooks survive setup too.
    mkdirSync(join(dir, "shared-hooks"));
    git("config", "core.hooksPath", "shared-hooks");
    const custom = "#!/bin/sh\n# custom pre-push owned by the operator\nexit 0\n";
    writeFileSync(join(dir, "shared-hooks/pre-push"), custom);
    setup();
    assert.equal(git("config", "core.hooksPath"), "shared-hooks");
    assert.equal(readFileSync(join(dir, "shared-hooks/pre-push"), "utf8"), custom);
    assert.ok(existsSync(join(dir, "shared-hooks/pre-commit")));
    // A legacy dispatcher at the shared path is retired without changing the path.
    writeFileSync(join(dir, "lefthook.yml"), readFileSync(join(repo, "lefthook.yml"), "utf8") + '\npre-push:\n  commands:\n    validate:\n      run: llmlint validate\n');
    run("lefthook", ["install", "--force"]);
    copyFileSync(join(repo, "lefthook.yml"), join(dir, "lefthook.yml"));
    setup();
    assert.equal(existsSync(join(dir, "shared-hooks/pre-push")), false);
    assert.equal(git("config", "core.hooksPath"), "shared-hooks");
    rmSync(join(dir, "tools/install-hooks.mjs"));
    const failedSetup = spawnSync("bash", ["-eu", "-o", "pipefail", "-c", bootstrapHooks], { cwd: dir, encoding: "utf8" });
    assert.notEqual(failedSetup.status, 0, "bootstrap propagates installer failure");
    assert.match(failedSetup.stderr, /install-hooks.mjs/);
    assert.doesNotMatch(failedSetup.stdout + failedSetup.stderr, /skipping git hooks/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
