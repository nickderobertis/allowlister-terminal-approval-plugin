// Private writer/reader contract for the offline workflow measurements.
export const schemaVersion = 1;
export function measurements(runs, lifecycles) {
  return {
    jobsPerRun: Math.max(
      ...runs.map((run) => run.rows.filter((row) => row.macos).length),
    ),
    runsPerChange: Math.max(
      ...lifecycles.map(
        (cycle) =>
          cycle.runs.filter((run) => run.rows.some((row) => row.macos)).length,
      ),
    ),
  };
}
export function validateTelemetry(value, sourceDigest) {
  if (value?.schemaVersion !== schemaVersion || value.digest !== sourceDigest)
    throw new Error("missing/stale macOS telemetry: run github-workflows:test");
  const list = (items, name) => {
    if (!Array.isArray(items) || !items.length)
      throw new Error(
        `invalid telemetry ${name}: expected nonempty array; rerun github-workflows:test`,
      );
  };
  const run = (value) => {
    if (
      !value ||
      typeof value.workflow !== "string" ||
      typeof value.event !== "string"
    )
      throw new Error(
        "invalid telemetry workflow run; rerun github-workflows:test",
      );
    list(value.rows, "job rows");
    for (const row of value.rows) {
      if (
        !row ||
        !["workflow", "event", "job", "name", "runner", "target"].every(
          (key) => typeof row[key] === "string",
        ) ||
        typeof row.enabled !== "boolean" ||
        typeof row.macos !== "boolean" ||
        !/^(ubuntu|macos|windows)-[A-Za-z0-9.-]+$/.test(row.runner) ||
        row.macos !== (row.enabled && row.runner.startsWith("macos-"))
      )
        throw new Error(
          "invalid telemetry job row; rerun github-workflows:test",
        );
    }
  };
  list(value.runs, "runs");
  value.runs.forEach(run);
  list(value.lifecycles, "lifecycles");
  for (const cycle of value.lifecycles) {
    list(cycle.runs, "lifecycle runs");
    cycle.runs.forEach(run);
  }
  // llmlint: ignore[boundary_inputs_validated] Scenarios are emitted by this repository's graph test, not an external producer. The digest ties the file to that producer, and only validated run/job data determines measurements; parsing each descriptive scenario adds no routing or budget proof.
  list(value.scenarios, "scenarios");
  const actual = measurements(value.runs, value.lifecycles);
  for (const key of Object.keys(actual))
    if (
      !Number.isFinite(value.measurements?.[key]) ||
      value.measurements[key] !== actual[key]
    )
      throw new Error(
        `invalid telemetry measurement ${key}; rerun github-workflows:test`,
      );
  return value;
}
