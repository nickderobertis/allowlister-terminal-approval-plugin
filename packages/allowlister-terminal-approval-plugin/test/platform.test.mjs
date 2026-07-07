import assert from "node:assert/strict";
import { test } from "node:test";

import { binarySpecifier, platformPackage } from "../lib/platform.mjs";

test("maps every supported unix platform to its package and binary", () => {
  const cases = [
    ["linux", "x64", "allowlister-terminal-approval-plugin-linux-x64"],
    ["linux", "arm64", "allowlister-terminal-approval-plugin-linux-arm64"],
    ["darwin", "x64", "allowlister-terminal-approval-plugin-darwin-x64"],
    ["darwin", "arm64", "allowlister-terminal-approval-plugin-darwin-arm64"],
  ];
  for (const [platform, arch, pkg] of cases) {
    assert.deepEqual(platformPackage(platform, arch), {
      name: `@nickderobertis/${pkg}`,
      file: "allowlister-terminal-approval-plugin",
    });
    assert.equal(
      binarySpecifier(platform, arch),
      `@nickderobertis/${pkg}/bin/allowlister-terminal-approval-plugin`,
    );
  }
});

test("throws on an unsupported platform (the terminal experience is unix-only)", () => {
  assert.throws(() => platformPackage("win32", "x64"), /Unsupported platform: win32-x64/);
  assert.throws(() => platformPackage("linux", "ia32"), /Unsupported platform: linux-ia32/);
});
