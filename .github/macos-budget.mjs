// Measurement only: comparisons belong to onebudgetspec, never this command.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { report } from "./tooling/node_modules/@onebudgetspec/sdk/dist/index.js";
import { digest } from "./macos-graph.mjs";
// --metric jobs-per-run|runs-per-change --telemetry PATH. Exit 0 emits JSON and
// SDK detail; exit 1 rejects invocation, unreadable/stale/malformed telemetry or
// reporting errors. This command never generates scenarios or reads thresholds.
import { validateTelemetry } from "./macos-telemetry.mjs";
const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  !args.includes("--metric") ||
  !args.includes("--telemetry") ||
  args.indexOf("--metric") === args.indexOf("--telemetry")
)
  throw new Error(
    "expected --metric jobs-per-run|runs-per-change --telemetry PATH",
  );
const metric = args[args.indexOf("--metric") + 1];
const path = args[args.indexOf("--telemetry") + 1];
if (
  !["jobs-per-run", "runs-per-change"].includes(metric) ||
  !path ||
  path.startsWith("--")
)
  throw new Error(
    "expected --metric jobs-per-run|runs-per-change --telemetry PATH",
  );
const telemetry = JSON.parse(
  readFileSync(
    path.startsWith(".github/")
      ? fileURLToPath(new URL(`../${path}`, import.meta.url))
      : path,
    "utf8",
  ),
);
validateTelemetry(telemetry, digest());
const value =
  metric === "jobs-per-run"
    ? telemetry.measurements.jobsPerRun
    : telemetry.measurements.runsPerChange;
const detail = JSON.stringify({
  scenarios: telemetry.scenarios,
  runs: telemetry.runs.filter((run) => run.rows.some((row) => row.macos)),
  lifecycles: telemetry.lifecycles.map((cycle) => ({
    ...cycle,
    runs: cycle.runs.filter((run) => run.rows.some((row) => row.macos)),
  })),
});
report(value, detail);
console.log(JSON.stringify({ metric, value }));
