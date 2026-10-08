# AGENTS — npm carrier (npm-carrier)

- This is the published npm package; `files` in `package.json` is what ships.
  The per-platform packages beside it carry only a manifest and README — their
  `bin/` is staged at release time and never committed.
- The launcher and postinstall use Node built-ins only and must never fail an
  install: on any error, leave the JS launcher in place as the fallback.
- `test/` is the `npm-carrier:test` target (`node --test`), in the gate; the
  packed-install path is proven separately by CI's `install-smoke` job
  (`scripts/smoke-npm-package.sh`).
- `optionalDependencies` are injected at publish time by
  `scripts/set-npm-package-version.mjs`; keep them out of source so the root
  lockfile stays in sync.
