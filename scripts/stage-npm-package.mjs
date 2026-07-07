#!/usr/bin/env node

// Stage the release-built native binaries into the per-platform npm packages.
//
// Each platform package ships one native binary at `bin/`. At publish time the
// parent `@nickderobertis/allowlister-terminal-approval-plugin` package declares
// these as optional dependencies, so npm installs only the one matching the host
// and links the binary directly onto the command path.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const [, , artifactsDir = "dist/release-artifacts"] = process.argv;
const packagesDir = "packages";
const binary = "allowlister-terminal-approval-plugin";

// One package per unix platform; the release workflow names each artifact
// `<binary>-<platform>`.
const platforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

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
