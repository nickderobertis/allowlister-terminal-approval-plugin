#!/usr/bin/env node

// Stage the release-built native binaries into the per-platform npm packages.
//
// Each platform package ships one native binary at `bin/`. At publish time the
// parent `@nickderobertis/allowlister-terminal-approval-plugin` package declares
// these as optional dependencies, so npm installs only the one matching the host
// and links the binary directly onto the command path.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Usage: stage-npm-package.mjs [artifactsDir] [platform...]
// With no platforms named, stages every platform (the full release). Naming a
// subset (e.g. just the host's `linux-x64`) stages only those — used by the
// install-smoke CI job, which builds one host binary rather than the full set.
const [, , artifactsDir = "dist/release-artifacts", ...requestedPlatforms] = process.argv;
const packagesDir = "packages";
const binary = "allowlister-terminal-approval-plugin";

// One package per unix platform; the release workflow names each artifact
// `<binary>-<platform>`.
const allPlatforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
for (const platform of requestedPlatforms) {
  if (!allPlatforms.includes(platform)) {
    throw new Error(
      `Unknown platform ${platform}; expected one of ${allPlatforms.join(", ")}`,
    );
  }
}
const platforms = requestedPlatforms.length > 0 ? requestedPlatforms : allPlatforms;

let stagedCount = 0;
for (const target of platforms) {
  const pkg = `${binary}-${target}`;
  const binDir = join(packagesDir, pkg, "bin");
  rmSync(binDir, { force: true, recursive: true });
  mkdirSync(binDir, { recursive: true });

  const artifactPath = findArtifact(artifactsDir, `${binary}-${target}`);
  const outputPath = join(binDir, binary);
  cpSync(artifactPath, outputPath);
  chmodSync(outputPath, 0o755);
  stagedCount += 1;
}

function findArtifact(root, name) {
  const directPath = join(root, name);
  if (existsSync(directPath)) {
    return directPath;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const nestedPath = join(root, entry.name, name);
    if (existsSync(nestedPath)) {
      return nestedPath;
    }
  }
  throw new Error(`Missing release artifact ${name} under ${root}`);
}

console.log(`staged ${stagedCount} native binaries into per-platform packages`);
