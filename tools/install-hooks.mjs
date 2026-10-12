// Install the retained hooks and retire only Lefthook's obsolete dispatcher.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const hook = resolve(execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-push"], { encoding: "utf8" }).trim());
if (existsSync(hook)) {
  const contents = readFileSync(hook, "utf8");
  if (contents.startsWith("#!/bin/sh\n") && contents.includes("\ncall_lefthook()\n") &&
      contents.trimEnd().endsWith('call_lefthook run "pre-push" "$@"')) {
    unlinkSync(hook);
  }
}
// --force permits installation at a configured hooksPath without unsetting it.
execFileSync("lefthook", ["install", "--force"], { stdio: "inherit" });
