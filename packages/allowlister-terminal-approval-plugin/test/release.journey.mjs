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
test("release builds, stages, packs, installs and runs the real native artifact; damaged payload fails", () => {
  const platform = `${process.platform}-${process.arch}`;
  assert.ok(
    ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(
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
    run("npm", ["run", "release:stage-npm", "--", "dist/artifacts", platform]);
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
      assert.equal(bytes.readUInt16LE(18), process.arch === "arm64" ? 183 : 62);
    } else {
      assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
      assert.equal(
        bytes.readUInt32LE(4),
        process.arch === "arm64" ? 0x0100000c : 0x01000007,
      );
    }
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", join(dir, packed), "package/package.json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(manifest.version, cargoVersion);
    assert.deepEqual(manifest.os, [process.platform]);
    assert.deepEqual(manifest.cpu, [process.arch]);
    assert.match(
      run("npm", ["run", "release:smoke-npm"]),
      /ok \(native binary on PATH\)/,
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
    run("npm", ["run", "release:set-npm-version", "--", cargoVersion]);
    // The real installer must reject a corrupt native artifact; no boundary is mocked.
    writeFileSync(join(dir, packageDir, "bin", binary), "not an executable\n");
    const bad = spawnSync("npm", ["run", "release:smoke-npm"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(dir, "cache") },
    });
    assert.notEqual(bad.status, 0, "damaged payload cannot pass install/run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
