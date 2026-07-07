// Shared resolution for the per-platform native binary packages.
//
// Each supported platform ships the native `allowlister-terminal-approval-plugin`
// binary in its own npm package, declared as an optional dependency of this
// package. npm installs only the package whose `os`/`cpu` match the host, so
// resolving the binary is a matter of mapping the running platform/arch onto that
// package and asking Node where it landed in `node_modules`.
//
// The terminal approval experience is `/dev/tty`, so only unix platforms ship a
// binary; there is no Windows package.

const PLATFORM_PACKAGES = new Map([
  ["linux-x64", "allowlister-terminal-approval-plugin-linux-x64"],
  ["linux-arm64", "allowlister-terminal-approval-plugin-linux-arm64"],
  ["darwin-x64", "allowlister-terminal-approval-plugin-darwin-x64"],
  ["darwin-arm64", "allowlister-terminal-approval-plugin-darwin-arm64"],
]);

const SCOPE = "@nickderobertis";
const BINARY = "allowlister-terminal-approval-plugin";

/**
 * Describe the platform package for a given platform/arch, throwing for any
 * combination we do not publish a binary for. `file` is the binary's name.
 */
export function platformPackage(platform = process.platform, arch = process.arch) {
  const pkg = PLATFORM_PACKAGES.get(`${platform}-${arch}`);
  if (!pkg) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return { name: `${SCOPE}/${pkg}`, file: BINARY };
}

/**
 * The bare specifier Node uses to locate the native binary inside the installed
 * platform package, e.g.
 * `@nickderobertis/allowlister-terminal-approval-plugin-linux-x64/bin/allowlister-terminal-approval-plugin`.
 */
export function binarySpecifier(platform = process.platform, arch = process.arch) {
  const { name, file } = platformPackage(platform, arch);
  return `${name}/bin/${file}`;
}
