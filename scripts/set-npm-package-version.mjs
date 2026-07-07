#!/usr/bin/env node

// Set the version on the parent npm package and every per-platform package, and
// inject the parent's optional dependencies pinned to that exact version.
//
// The per-platform packages are kept out of the parent's committed package.json
// so the development lockfile stays in sync (their versions are never published
// at the placeholder 0.1.0). They are added here, at publish time, so the
// published parent resolves the matching native binary package from the registry.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2] ?? process.env.PLUGIN_VERSION;

if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/set-npm-package-version.mjs <semver>");
  process.exit(1);
}

const packagesDir = "packages";
const parent = "allowlister-terminal-approval-plugin";
const platformPackages = [
  "allowlister-terminal-approval-plugin-linux-x64",
  "allowlister-terminal-approval-plugin-linux-arm64",
  "allowlister-terminal-approval-plugin-darwin-x64",
  "allowlister-terminal-approval-plugin-darwin-arm64",
];

for (const dir of [parent, ...platformPackages]) {
  const path = join(packagesDir, dir, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.version = version;

  if (dir === parent) {
    // Drop the documentation placeholder and pin the real optional deps.
    delete manifest["//optionalDependencies"];
    manifest.optionalDependencies = Object.fromEntries(
      platformPackages.map((name) => [`@nickderobertis/${name}`, version]),
    );
  }

  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`set version ${version} across ${platformPackages.length + 1} packages`);
