// Resolve this repository's Actions graph. Unknown expressions/calls are errors.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse } from "./tooling/node_modules/yaml/dist/index.js";
import {
  Lexer,
  Parser,
  Evaluator,
  data,
} from "./tooling/node_modules/@actions/expressions/dist/index.js";
const root = fileURLToPath(new URL("./", import.meta.url));
export const workflows = Object.fromEntries(
  readdirSync(`${root}workflows`)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, parse(readFileSync(`${root}workflows/${f}`, "utf8"))]),
);
function convert(value) {
  if (value === null || value === undefined) return new data.Null();
  if (typeof value === "boolean") return new data.BooleanData(value);
  if (typeof value === "number") return new data.NumberData(value);
  if (typeof value === "string") return new data.StringData(value);
  if (Array.isArray(value)) return new data.Array(...value.map(convert));
  return new data.Dictionary(
    ...Object.entries(value).map(([key, value]) => ({
      key,
      value: convert(value),
    })),
  );
}
export function expression(source, context) {
  const text = source.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const functions = new Map(
    ["always", "success", "failure", "cancelled"].map((name) => [
      name,
      {
        name,
        minArgs: 0,
        maxArgs: 0,
        call: () =>
          new data.BooleanData(name === "always" || name === "success"),
      },
    ]),
  );
  const ast = new Parser(new Lexer(text).lex().tokens, Object.keys(context), [
    ...functions.values(),
  ]).parse();
  return new Evaluator(ast, convert(context), functions).evaluate();
}
export function interpolate(value, context) {
  if (typeof value !== "string")
    throw new Error(`unresolved runner/value ${JSON.stringify(value)}`);
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr) =>
    expression(expr, context).coerceString(),
  );
}
export function matrix(job) {
  const spec = job.strategy?.matrix;
  if (spec === undefined) return [{}];
  if (
    !spec ||
    typeof spec !== "object" ||
    Array.isArray(spec) ||
    !Object.keys(spec).length
  )
    throw new Error("unresolved dynamic matrix");
  let rows = [{}];
  for (const [key, values] of Object.entries(spec).filter(
    ([key]) => !["include", "exclude"].includes(key),
  )) {
    if (!Array.isArray(values) || !values.length)
      throw new Error(`unresolved matrix ${key}`);
    rows = rows.flatMap((row) =>
      values.map((value) => ({ ...row, [key]: value })),
    );
  }
  if (Object.keys(spec).every((k) => ["include", "exclude"].includes(k))) {
    if (!Array.isArray(spec.include) || !spec.include.length)
      throw new Error("unresolved empty matrix");
    return spec.include.map((row) => ({ ...row }));
  }
  rows = rows.filter(
    (row) =>
      !spec.exclude?.some((ex) =>
        Object.entries(ex).every(([k, v]) => row[k] === v),
      ),
  );
  for (const inc of spec.include ?? []) {
    const compatible = rows.filter((row) =>
      Object.keys(spec)
        .filter((k) => !["include", "exclude"].includes(k))
        .every((k) => !(k in inc) || inc[k] === row[k]),
    );
    if (compatible.length) compatible.forEach((row) => Object.assign(row, inc));
    else rows.push({ ...inc });
  }
  return rows;
}
export function triggered(wf, event) {
  if (!wf.on || typeof wf.on !== "object" || Array.isArray(wf.on))
    throw new Error("unsupported workflow trigger form");
  const config = wf.on?.[event.name];
  if (!Object.hasOwn(wf.on ?? {}, event.name)) return false;
  const allowed = {
    push: ["branches", "tags"],
    pull_request: ["types"],
    release: ["types"],
    workflow_run: ["types", "workflows", "branches"],
    workflow_dispatch: ["inputs"],
    repository_dispatch: ["types"],
    schedule: [],
  };
  // llmlint: ignore[boundary_inputs_validated] GitHub and actionlint validate cron declarations. This model resolves an explicitly supplied schedule event by trigger presence; the workload does not simulate cron times, so a second cron parser would not strengthen the scheduling proof.
  if (config && event.name !== "schedule") {
    if (typeof config !== "object" || Array.isArray(config))
      throw new Error("unsupported trigger configuration");
    for (const key of Object.keys(config)) {
      if (!allowed[event.name]?.includes(key))
        throw new Error(`unsupported trigger filter ${key}`);
      if (
        key !== "inputs" &&
        (!Array.isArray(config[key]) ||
          config[key].some(
            (value) => typeof value !== "string" || /[*?![\]{}]/.test(value),
          ))
      )
        throw new Error(`unsupported trigger pattern ${key}`);
    }
  }
  if (config?.types && !config.types.includes(event.action)) return false;
  if (config?.branches && !config.branches.includes(event.branch)) return false;
  if (config?.tags && !config.tags.includes(event.tag)) return false;
  if (config?.workflows && !config.workflows.includes(event.upstream))
    return false;
  return true;
}
export function resolve(file, event, policy, stack = []) {
  if (stack.includes(file)) throw new Error(`recursive workflow call: ${file}`);
  const wf = workflows[file];
  if (!wf) throw new Error(`unresolved reusable workflow: ${file}`);
  const needs = Object.fromEntries(
    Object.keys(wf.jobs).map((id) => [id, { result: "success", outputs: {} }]),
  );
  needs["macos-policy"] = {
    result: "success",
    outputs: { macosRequired: String(policy.macosRequired) },
  };
  const github = {
    event_name: event.name,
    event: event.payload ?? {},
    repository: "nickderobertis/allowlister-terminal-approval-plugin",
    ref: event.tag
      ? `refs/tags/${event.tag}`
      : `refs/heads/${event.branch ?? "main"}`,
    ref_name: event.tag ?? event.branch ?? "main",
  };
  const rows = [];
  for (const [id, job] of Object.entries(wf.jobs)) {
    const context = {
      github,
      needs,
      inputs: event.inputs ?? {},
      vars: { PUBLISH_TO_CRATES_IO: event.crates ? "true" : "false" },
    };
    const enabled =
      job.if === undefined ||
      (typeof job.if === "boolean"
        ? job.if
        : expression(job.if, context).coerceString() === "true");
    if (job.uses) {
      if (!job.uses.startsWith("./.github/workflows/"))
        throw new Error(`unresolved reusable call ${job.uses}`);
      for (const cell of matrix(job)) {
        const callerContext = { ...context, matrix: cell };
        const inputs = Object.fromEntries(
          Object.entries(job.with ?? {}).map(([key, value]) => {
            if (typeof value !== "string") return [key, value];
            const match = value.match(/^\$\{\{([\s\S]*?)\}\}$/);
            if (!match) return [key, interpolate(value, callerContext)];
            const evaluated = expression(match[1], callerContext);
            if (
              ![data.Kind.String, data.Kind.Boolean, data.Kind.Number].includes(
                evaluated.kind,
              )
            )
              throw new Error(`unresolved reusable input ${key}`);
            return [key, evaluated.value];
          }),
        );
        if (event.name !== "workflow_dispatch" && inputs.diagnostic === true)
          throw new Error(
            "automatic reusable caller cannot opt into diagnostics",
          );
        const nested = resolve(
          job.uses.split("/").at(-1),
          { ...event, inputs },
          policy,
          [...stack, file],
        );
        rows.push(
          ...nested.map((row) => ({
            ...row,
            enabled: enabled && row.enabled,
            macos: enabled && row.macos,
          })),
        );
      }
      continue;
    }
    for (const cell of matrix(job)) {
      const ctx = { ...context, matrix: cell };
      const runner = interpolate(job["runs-on"], ctx);
      if (!/^(ubuntu|macos|windows)-[A-Za-z0-9.-]+$/.test(runner))
        throw new Error(`unresolved runner ${file}:${id}: ${runner}`);
      rows.push({
        workflow: file,
        event: event.name,
        job: id,
        name: interpolate(job.name ?? id, ctx),
        runner,
        target:
          cell.target ??
          job.steps
            ?.flatMap((step) =>
              [
                ...(step.run ?? "").matchAll(
                  /just build-release ([a-z0-9_-]+)/g,
                ),
              ].map((match) => match[1]),
            )
            .join(",") ??
          "",
        enabled,
        macos: enabled && runner.startsWith("macos-"),
      });
    }
  }
  return rows;
}
export function digest() {
  const hash = createHash("sha256");
  for (const dir of ["workflows", "scripts", "tests", "tooling"]) {
    const visit = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (entry.name === "node_modules") continue;
        const next = `${path}/${entry.name}`;
        if (entry.isDirectory()) visit(next);
        else hash.update(next.slice(root.length)).update(readFileSync(next));
      }
    };
    visit(`${root}${dir}`);
  }
  for (const name of [
    "macos-policy.mjs",
    "semantic-release.py",
    "required-result.mjs",
    "macos-graph.mjs",
    "macos-budget.mjs",
    "macos-telemetry.mjs",
  ])
    hash.update(name).update(readFileSync(`${root}${name}`));
  for (const name of [
    "release-plz.toml",
    "justfile",
    "scripts/stage-npm-package.mjs",
    "scripts/smoke-npm-package.sh",
    "scripts/set-npm-package-version.mjs",
    "scripts/release-version-pattern.txt",
  ])
    hash.update(name).update(readFileSync(`${root}../${name}`));
  return hash.digest("hex");
}
