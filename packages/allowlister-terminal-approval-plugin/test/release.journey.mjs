// User install journey through production staging and smoke commands. No registry publication.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parse } from "yaml";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const binary = "allowlister-terminal-approval-plugin";
// PR macOS CI keeps its existing assertions; the publish job performs both real
// Darwin installs. The new packaging journey runs on Linux CI and local hosts.
const skipMacCi =
  process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_OS === "macOS";
test(
  "release builds, stages, packs, installs and runs the real native artifact; damaged payload fails",
  {
    skip:
      skipMacCi &&
      "Darwin native installs run in the release job; PR Mac assertions remain unchanged",
  },
  () => {
    const platform = `${process.platform}-${process.arch}`;
    assert.ok(
      ["linux-x64", "linux-arm64", "darwin-arm64"].includes(
        platform,
      ),
    );
    const dir = mkdtempSync(
      join(
        process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? "/tmp",
        "release-journey-",
      ),
    );
    try {
      const workflow = parse(
        readFileSync(join(repo, ".github/workflows/publish.yml"), "utf8"),
      );
      const darwin = workflow.jobs["build-darwin"].steps
        .map((step) => step.run ?? "")
        .join("\n");
      const declarations = [
        ...workflow.jobs["build-binary"].strategy.matrix.include,
        ...[
          ...darwin.matchAll(
            /cp target\/([^/]+)\/release\/allowlister-terminal-approval-plugin dist\/artifacts\/allowlister-terminal-approval-plugin-(darwin-[a-z0-9]+)/g,
          ),
        ].map((match) => ({ target: match[1], platform: match[2] })),
      ];
      const target = declarations.find(
        (row) => row.platform === platform,
      )?.target;
      assert.ok(target, `release declares ${platform}`);
      const toolchain = spawnSync("rustup", ["target", "add", target], {
        cwd: repo,
        encoding: "utf8",
      });
      assert.equal(toolchain.status, 0, toolchain.stderr);
      const build = spawnSync("just", ["build-release", target], {
        cwd: repo,
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stderr);
      cpSync(join(repo, "package.json"), join(dir, "package.json"));
      for (const path of ["packages", "scripts"])
        cpSync(join(repo, path), join(dir, path), { recursive: true });
      mkdirSync(join(dir, "dist/artifacts"), { recursive: true });
      const artifact = join(dir, "dist/artifacts", `${binary}-${platform}`);
      cpSync(join(repo, "target", target, "release", binary), artifact);
      const cargoVersion = readFileSync(join(repo, "Cargo.toml"), "utf8").match(
        /^version\s*=\s*"([^"]+)"/m,
      )[1];
      const run = (cmd, args) =>
        execFileSync(cmd, args, {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, npm_config_cache: join(dir, "cache") },
        });
      run("npm", ["run", "release:set-npm-version", "--", cargoVersion]);
      run("npm", [
        "run",
        "release:stage-npm",
        "--",
        "dist/artifacts",
        platform,
      ]);
      const packageDir = `packages/${binary}-${platform}`;
      const packed = run("npm", [
        "pack",
        `./${packageDir}`,
        "--silent",
        "--pack-destination",
        dir,
      ]).trim();
      const bytes = execFileSync("tar", [
        "-xOf",
        join(dir, packed),
        `package/bin/${binary}`,
      ]);
      const sha = (value) => createHash("sha256").update(value).digest("hex");
      assert.equal(
        sha(bytes),
        sha(readFileSync(artifact)),
        "npm payload reuses release binary byte for byte",
      );
      if (process.platform === "linux") {
        assert.equal(bytes.subarray(0, 4).toString("hex"), "7f454c46");
        assert.equal(
          bytes.readUInt16LE(18),
          process.arch === "arm64" ? 183 : 62,
        );
      } else {
        assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
        assert.equal(bytes.readUInt32LE(4), 0x0100000c, "arm64 Mach-O");
      }
      const manifest = JSON.parse(
        execFileSync(
          "tar",
          ["-xOf", join(dir, packed), "package/package.json"],
          {
            encoding: "utf8",
          },
        ),
      );
      assert.equal(manifest.version, cargoVersion);
      assert.deepEqual(manifest.os, [process.platform]);
      assert.deepEqual(manifest.cpu, [process.arch]);
      const smoke = run("npm", ["run", "release:smoke-npm"]);
      assert.match(smoke, /ok \(native binary on PATH\)/);
      assert.ok(
        smoke.includes(`${platform}@${cargoVersion} sha256=${sha(bytes)}`),
        "the installed payload hash is recorded and matches the released native input",
      );
      run("npm", ["run", "release:set-npm-version", "--", "9.9.9"]);
      const mismatch = spawnSync("npm", ["run", "release:smoke-npm"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: join(dir, "cache") },
      });
      assert.notEqual(
        mismatch.status,
        0,
        "a package tag cannot mislabel its native binary",
      );
      assert.match(mismatch.stderr, /binary version does not match package/);
      mkdirSync(join(dir, "target/release"), { recursive: true });
      cpSync(artifact, join(dir, "target/release", binary));
      const ci = parse(
        readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8"),
      );
      const synchronize = ci.jobs["install-smoke"].steps.find(
        (step) => step.name === "Match npm smoke versions to the built binary",
      );
      const recovered = spawnSync(
        "bash",
        ["-eo", "pipefail", "-c", synchronize.run],
        { cwd: dir, encoding: "utf8" },
      );
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.match(
        run("npm", ["run", "release:smoke-npm"]),
        /ok \(native binary on PATH\)/,
        "the production version-sync step recovers a version-only release's stale npm placeholder",
      );
      // The real installer must reject a corrupt native artifact; no boundary is mocked.
      writeFileSync(
        join(dir, packageDir, "bin", binary),
        "not an executable\n",
      );
      const bad = spawnSync("npm", ["run", "release:smoke-npm"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: join(dir, "cache") },
      });
      assert.notEqual(bad.status, 0, "damaged payload cannot pass install/run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// The Darwin release artifact set, proved at the artifact contract: a Linux host
// cannot build or run a Darwin binary, so a header-only arm64 Mach-O stands in
// for build-darwin's compiler output. Everything downstream runs publish.yml's
// own staging, versioning and publish steps for real; only the registry (`npm
// view`/`npm publish`, doubled by a recording `npm` that packs instead of
// uploading) and the forge (the release-attach action, whose file glob is
// enumerated rather than uploaded) are doubled. Nothing is published.
test("the release builds, stages and publishes exactly the arm64 macOS artifact; Intel macOS is refused", () => {
  const tag = "v1.2.3";
  const version = tag.slice(1);
  const dir = mkdtempSync(
    join(process.env.ONEPIPELINE_NODE_SCRATCH_DIR ?? "/tmp", "release-darwin-"),
  );
  try {
    cpSync(join(repo, "package.json"), join(dir, "package.json"));
    for (const path of ["packages", "scripts"])
      cpSync(join(repo, path), join(dir, path), { recursive: true });
    const workflow = parse(
      readFileSync(join(repo, ".github/workflows/publish.yml"), "utf8"),
    );
    const env = {
      ...process.env,
      GITHUB_REF_NAME: tag,
      npm_config_cache: join(dir, "cache"),
    };
    const sh = (script, extraEnv = {}) => {
      const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
        cwd: dir,
        encoding: "utf8",
        env: { ...env, ...extraEnv },
      });
      assert.equal(result.status, 0, `${script}\n${result.stderr}`);
      return result.stdout;
    };
    const step = (job, name) =>
      workflow.jobs[job].steps.find((s) => s.name === name).run;

    // build-darwin: one native arm64 macOS job, gated on the full test sweep and
    // ahead of every publication job.
    const darwin = workflow.jobs["build-darwin"];
    assert.equal(darwin["runs-on"], "macos-latest");
    assert.equal(darwin.needs, "test");
    for (const id of ["github-release", "npm-publish"])
      assert.ok(workflow.jobs[id].needs.includes("build-darwin"));
    const script = darwin.steps.map((s) => s.run ?? "").join("\n");
    assert.deepEqual(
      [...script.matchAll(/just build-release (\S+)/g)].map((m) => m[1]),
      ["aarch64-apple-darwin"],
    );
    assert.match(script, /rustup target add aarch64-apple-darwin\n/);
    assert.match(script, /test "\$\(uname -m\)" = arm64/);
    assert.doesNotMatch(script, /x86_64|darwin-x64|rosetta|arch -/i);
    assert.ok(
      !darwin.steps.some((s) => s.with?.architecture),
      "no non-native Node",
    );

    // Its staging lines, run for real over the stand-in compiler output.
    const machO = Buffer.alloc(32);
    machO.writeUInt32LE(0xfeedfacf, 0);
    machO.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
    machO.writeUInt32LE(2, 12); // MH_EXECUTE
    const [, builtTarget, darwinArtifact] = script.match(
      /cp target\/(\S+)\/release\/allowlister-terminal-approval-plugin (\S+)/,
    );
    assert.equal(builtTarget, "aarch64-apple-darwin");
    assert.equal(darwinArtifact, `dist/artifacts/${binary}-darwin-arm64`);
    sh(darwin.steps.find((s) => /set-npm-version/.test(s.run ?? "")).run);
    mkdirSync(join(dir, "dist/artifacts"), { recursive: true });
    writeFileSync(join(dir, darwinArtifact), machO);
    sh(
      script
        .split("\n")
        .filter((line) => /^\s*(npm run release:stage-npm|cmp) /.test(line))
        .join("\n"),
    );
    const uploads = darwin.steps.filter((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    );
    assert.deepEqual(
      uploads.map((s) => [s.with.name, s.with.path]),
      [["binary-darwin-arm64", darwinArtifact]],
    );

    // Requesting the Intel macOS target from the real staging interface is
    // refused, not silently skipped or built.
    writeFileSync(join(dir, "dist/artifacts", `${binary}-darwin-x64`), machO);
    const intel = spawnSync(
      "npm",
      ["run", "release:stage-npm", "--", "dist/artifacts", "darwin-x64"],
      { cwd: dir, encoding: "utf8", env },
    );
    assert.notEqual(intel.status, 0);
    assert.match(intel.stderr, /Intel macOS \(darwin-x64\) is no longer supported/);
    assert.ok(!readdirSync(join(dir, "packages")).some((p) => p.endsWith("-darwin-x64")));

    // download-artifact (merge-multiple) flattens every build job's upload; the
    // stray Intel file above is included to prove publication ignores it.
    const downloaded = join(dir, "dist/release-artifacts");
    mkdirSync(downloaded, { recursive: true });
    const elf = (machine) => {
      const bytes = Buffer.alloc(64);
      bytes.write("7f454c46020101", 0, "hex");
      bytes.writeUInt16LE(machine, 18);
      return bytes;
    };
    for (const { platform } of workflow.jobs["build-binary"].strategy.matrix.include)
      writeFileSync(
        join(downloaded, `${binary}-${platform}`),
        elf(platform === "linux-arm64" ? 183 : 62),
      );
    for (const name of readdirSync(join(dir, "dist/artifacts")))
      cpSync(join(dir, "dist/artifacts", name), join(downloaded, name));
    rmSync(join(downloaded, `${binary}-darwin-x64`));

    // github-release: the forge attaches what its glob matches.
    const attach = workflow.jobs["github-release"].steps.find((s) =>
      s.uses?.startsWith("softprops/"),
    );
    assert.equal(attach.with.tag_name, "${{ github.event.release.tag_name }}");
    assert.ok(attach.with.files.includes(`dist/release-artifacts/${binary}-*`));
    assert.deepEqual(
      readdirSync(downloaded).filter((name) => name.startsWith(`${binary}-`)).sort(),
      [`${binary}-darwin-arm64`, `${binary}-linux-arm64`, `${binary}-linux-x64`],
    );

    // npm-publish: version from the tag, stage everything, then publish through a
    // registry double that answers "not yet published" and packs what would ship.
    sh(step("npm-publish", "Set npm package versions from the tag"));
    sh(step("npm-publish", "Stage native binaries into the platform packages"));
    const realNpm = execFileSync("bash", ["-c", "command -v npm"], {
      encoding: "utf8",
    }).trim();
    const fakeBin = join(dir, "registry-double");
    const shipped = join(dir, "shipped");
    mkdirSync(fakeBin);
    mkdirSync(shipped);
    writeFileSync(
      join(fakeBin, "npm"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'case "$1" in',
        "  view) exit 1 ;;",
        `  publish) echo "$2" >> "${shipped}/order"; "${realNpm}" pack "$2" --silent --pack-destination "${shipped}" >/dev/null ;;`,
        '  *) echo "unexpected npm $*" >&2; exit 2 ;;',
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    sh(step("npm-publish", "Publish npm packages"), {
      PATH: `${fakeBin}:${process.env.PATH}`,
      NODE_AUTH_TOKEN: "unused-by-the-double",
    });
    assert.deepEqual(
      readFileSync(join(shipped, "order"), "utf8").trim().split("\n"),
      [
        `./packages/${binary}-linux-x64`,
        `./packages/${binary}-linux-arm64`,
        `./packages/${binary}-darwin-arm64`,
        `./packages/${binary}`,
      ],
    );
    const tarballs = readdirSync(shipped).filter((name) => name.endsWith(".tgz"));
    assert.deepEqual(
      tarballs.filter((name) => name.includes("darwin")),
      [`nickderobertis-${binary}-darwin-arm64-${version}.tgz`],
    );
    const fromTarball = (name, path, encoding) =>
      execFileSync("tar", ["-xOf", join(shipped, name), path], { encoding });
    const darwinTgz = `nickderobertis-${binary}-darwin-arm64-${version}.tgz`;
    const manifest = JSON.parse(
      fromTarball(darwinTgz, "package/package.json", "utf8"),
    );
    assert.equal(manifest.name, `@nickderobertis/${binary}-darwin-arm64`);
    assert.equal(manifest.version, version);
    assert.deepEqual(manifest.os, ["darwin"]);
    assert.deepEqual(manifest.cpu, ["arm64"]);
    const payload = fromTarball(darwinTgz, `package/bin/${binary}`);
    assert.ok(payload.equals(machO), "the staged Darwin payload is the built arm64 artifact");
    assert.equal(payload.readUInt32LE(4), 0x0100000c);
    const parent = JSON.parse(
      fromTarball(`nickderobertis-${binary}-${version}.tgz`, "package/package.json", "utf8"),
    );
    assert.deepEqual(parent.optionalDependencies, {
      [`@nickderobertis/${binary}-linux-x64`]: version,
      [`@nickderobertis/${binary}-linux-arm64`]: version,
      [`@nickderobertis/${binary}-darwin-arm64`]: version,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
