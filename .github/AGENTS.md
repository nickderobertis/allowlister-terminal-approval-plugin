# AGENTS — .github (ci-workflows)

- The fixed status-check contexts — `test (ubuntu-latest)`, `test
  (ubuntu-24.04-arm)`, `test (macos-latest)`, `install-smoke`, `pr-title`,
  `llmlint` — are a contract with branch protection: keep their job names, and
  never add an `if`, `needs` or path filter that could leave one unreported.
  `tests/workflow-contract.test.mjs` enforces it.
- Tier routing lives in `scripts/gate-tier.mjs` (release-plz's release PR: the
  full sweep; everything else: the affected tier from an explicit base). Change
  the routing there, with a test in `tests/gate-tier.test.mjs`.
- `notignored.yml` is a review artifact, not a gate: no contract job needs it.
