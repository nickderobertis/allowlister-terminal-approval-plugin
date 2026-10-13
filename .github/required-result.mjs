// POLICY_RESULT PROOF_RESULT plus MACOS_REQUIRED: exit 0 for a successful proof
// or a policy-authorized skip, and exit 1 for missing/failed/cancelled prerequisites.
// stdout distinguishes proof success from an authorized omission.
const [policy, proof] = process.argv.slice(2);
if (policy !== "success")
  throw new Error(`classification prerequisite ${policy ?? "missing"}`);
const required = process.env.MACOS_REQUIRED;
if (required !== "true" && required !== "false")
  throw new Error("missing classification output");
if (proof === "success") console.log("macOS proof passed");
else if (proof === "skipped" && required === "false")
  console.log("macOS proof intentionally omitted by release/event policy");
else throw new Error(`required macOS proof ${proof ?? "missing"}`);
