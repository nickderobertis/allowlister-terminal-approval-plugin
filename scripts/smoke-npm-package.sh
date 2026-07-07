#!/usr/bin/env bash
# Pre-publish smoke for the per-platform npm packaging.
#
# Installs the parent `@nickderobertis/allowlister-terminal-approval-plugin`
# package the way a user would, but resolving this host's platform package from a
# locally packed tarball instead of the registry (the version under test is not
# published yet). Verifies the install links the native Rust binary directly onto
# the command path — i.e. the command is the executable itself, no Node launcher
# in the hot path — and that it answers on stdin/stdout.
set -euo pipefail

packages_root="${1:-packages}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
export npm_config_cache="${npm_config_cache:-$tmp_dir/npm-cache}"

platform="$(node -e 'process.stdout.write(process.platform + "-" + process.arch)')"
case "$platform" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64)
    plat_pkg="allowlister-terminal-approval-plugin-$platform" ;;
  *) echo "npm package smoke: unsupported platform $platform" >&2; exit 1 ;;
esac

# Pack this host's platform package (it must already have its staged binary).
plat_tgz="$(cd "$packages_root/$plat_pkg" && npm pack --silent --pack-destination "$tmp_dir")"

# Copy the parent package and point this host's optional dependency at the local
# platform tarball so the install does not reach for the registry. The committed
# parent has no optionalDependencies (injected at publish time), so add just this
# host's entry here.
cp -r "$packages_root/allowlister-terminal-approval-plugin" "$tmp_dir/parent"
node -e '
  const fs = require("node:fs");
  const [path, name, tgz] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  delete manifest["//optionalDependencies"];
  manifest.optionalDependencies = {
    ...(manifest.optionalDependencies ?? {}),
    [name]: `file:${tgz}`,
  };
  fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
' "$tmp_dir/parent/package.json" "@nickderobertis/$plat_pkg" "$tmp_dir/$plat_tgz"

parent_tgz="$(cd "$tmp_dir/parent" && npm pack --silent --pack-destination "$tmp_dir")"

npm install --prefix "$tmp_dir/prefix" -g "$tmp_dir/$parent_tgz" --silent

cmd="$tmp_dir/prefix/bin/allowlister-terminal-approval-plugin"
"$cmd" --version >/dev/null
# A static allow defers without any prompt, so this needs no terminal.
printf '{"current_verdict":"allow","command":"git status","cwd":"/tmp"}' \
  | "$cmd" \
  | grep '"verdict":"defer"' >/dev/null

# The command on PATH must be the native binary itself, not the JS launcher
# (which begins with a `#!` shebang).
target="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$cmd")"
if [[ "$(head -c 2 "$target")" == "#!" ]]; then
  echo "npm package smoke: command on PATH is still the JS launcher, expected the native binary" >&2
  exit 1
fi

echo "npm package smoke: ok (native binary on PATH)"
