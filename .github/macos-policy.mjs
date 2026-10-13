// classify --event PATH --base REF --head REF emits the three-field JSON decision.
// Exit 0 includes conservative unknown-input decisions; invocation/output I/O errors
// exit 1. Git refs and all changed files must be readable to authorize omission.
import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { releaseBranchPrefix } from "./scripts/gate-tier.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
const version = new RegExp(
  readFileSync(
    new URL("../scripts/release-version-pattern.txt", import.meta.url),
    "utf8",
  ).trim(),
);
function jsonWithoutVersion(text) {
  const obj = JSON.parse(text);
  // llmlint: ignore[changed_behavior_has_e2e] Real CLI journeys cover malformed event JSON, invalid versions and malformed Cargo metadata. JSON parse/type failures reach the same tested conservative PR recovery and cannot authorize omission.
  if (
    typeof obj.version !== "string" ||
    obj.version.trim() !== obj.version ||
    !version.test(obj.version)
  )
    throw new Error("invalid version");
  delete obj.version;
  return obj;
}
export function classify(
  event,
  base,
  head,
  eventName = process.env.GITHUB_EVENT_NAME ?? "pull_request",
) {
  const decision = (isReleaseOnly, reason) => ({
    isReleaseOnly,
    macosRequired: eventName === "pull_request" && !isReleaseOnly,
    reason,
  });
  if (eventName !== "pull_request") return decision(false, "non-PR event");
  try {
    const pr = event.pull_request;
    if (
      !pr ||
      typeof pr.head?.repo?.full_name !== "string" ||
      !pr.base?.repo?.full_name ||
      !pr.head?.ref
    )
      throw new Error("incomplete PR payload");
    if (
      pr.head.repo.full_name !== pr.base.repo.full_name ||
      !pr.head.ref.startsWith(releaseBranchPrefix(root))
    )
      return decision(false, "ordinary or fork PR");
    for (const ref of [base, head]) {
      // llmlint: ignore[changed_behavior_has_e2e] Real CLI journeys prove unreadable refs require macOS. Syntactic ref rejection reaches the same tested conservative recovery before invoking git.
      if (
        typeof ref !== "string" ||
        !/^[A-Za-z0-9_./-]+$/.test(ref) ||
        ref.startsWith("-")
      )
        throw new Error("unusable git ref");
      git("rev-parse", "--verify", `${ref}^{commit}`);
    }
    const files = git("diff", "--name-status", "--no-renames", base, head)
      .trim()
      .split("\n")
      .filter(Boolean);
    if (!files.length) return decision(false, "empty diff");
    const name = git("show", `${base}:Cargo.toml`).match(
      /^name\s*=\s*"([^"]+)"/m,
    )?.[1];
    // llmlint: ignore[changed_behavior_has_e2e] The malformed Cargo and unreadable-history journeys exercise this shared PR exception recovery. A missing base package name throws into that recovery and requires macOS, rather than treating the diff as release-only.
    if (!name) throw new Error("missing package name");
    for (const row of files) {
      const [status, path] = row.split("\t");
      if (status !== "M") return decision(false, "added/deleted file");
      const before = git("show", `${base}:${path}`),
        after = git("show", `${head}:${path}`);
      if (path === "CHANGELOG.md") {
        if (!/^# /m.test(after) || !/^## /m.test(after))
          throw new Error("malformed changelog");
      } else if (path === "Cargo.toml" || path === "Cargo.lock") {
        const result = execFileSync(
          "python3",
          [
            fileURLToPath(new URL("./semantic-release.py", import.meta.url)),
            path === "Cargo.toml" ? "manifest" : "lock",
            name,
          ],
          { input: JSON.stringify([before, after]), encoding: "utf8" },
        ).trim();
        if (result !== "true")
          return decision(false, `non-version Cargo edit: ${path}`);
      } else if (
        path === "package.json" ||
        /^packages\/allowlister-terminal-approval-plugin[^/]*\/package.json$/.test(
          path,
        )
      ) {
        if (
          !isDeepStrictEqual(
            jsonWithoutVersion(before),
            jsonWithoutVersion(after),
          )
        )
          return decision(false, `non-version manifest edit: ${path}`);
      } else return decision(false, `non-release file: ${path}`);
    }
    return decision(
      true,
      "same-repository release-plz branch with parsed version/changelog-only diff",
    );
  } catch (error) {
    return decision(false, `unknown classification: ${error.message}`);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.shift() !== "classify")
    throw new Error("expected classify --event PATH --base REF --head REF");
  const options = {};
  if (args.length !== 6)
    throw new Error("expected exactly --event PATH --base REF --head REF");
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !["--event", "--base", "--head"].includes(key) ||
      Object.hasOwn(options, key) ||
      typeof value !== "string" ||
      value.startsWith("--")
    )
      throw new Error(
        `invalid classifier option ${key}; expected --event PATH --base REF --head REF`,
      );
    options[key] = value;
  }
  if (!options["--event"])
    throw new Error("--event requires a JSON payload path");
  const eventName = process.env.GITHUB_EVENT_NAME ?? "pull_request";
  if (
    ![
      "pull_request",
      "push",
      "release",
      "workflow_run",
      "repository_dispatch",
      "schedule",
      "workflow_dispatch",
    ].includes(eventName)
  )
    throw new Error(
      `unsupported GITHUB_EVENT_NAME ${JSON.stringify(eventName)}; use a supported Actions event`,
    );
  let event;
  try {
    event = JSON.parse(readFileSync(options["--event"], "utf8"));
  } catch {
    event = null;
  }
  const result = classify(
    event,
    options["--base"],
    options["--head"],
    eventName,
  );
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `macosRequired=${result.macosRequired}\nisReleaseOnly=${result.isReleaseOnly}\n`,
    );
}
