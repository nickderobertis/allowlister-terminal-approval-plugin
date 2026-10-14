#!/usr/bin/env bash
# The measurement behind allowlister-terminal-approval-plugin-pool-maintenance-seconds
# (budgets.yaml): one steady-state pass of the declared pool maintenance
# (`just pool-maintenance`, as onevcs.toml names it), i.e. the pass after one
# ordinary run's worth of new superseded builds, never a first pass over history.
#
#   a. run the declared maintenance once, untimed, to clear any backlog;
#   b. build the test targets the way the gate does (tools/coverage/coverage.sh,
#      per crate) under an alternative profile (line-tables debuginfo) that gives
#      every crate new metadata hashes in the same profile directory, then
#      backdate exactly the entries that build created past the 2-day window;
#   c. run the ordinary gate build, so each unit's newest build is the ordinary one;
#   d. run the declared maintenance again: the timed pass. The pruner reports its
#      own wall-clock seconds and breakdown through ONEBUDGETSPEC_RESULT, which
#      only this pass sees.
#
# It then refuses a run whose timed pass removed nothing, or removed anything the
# alternative build did not create, or left any ordinary entry missing, so the
# figure it reports is always the workload the budget states. Real mtimes only
# (touch -d), and it prunes this checkout's own target dir. Linux only (GNU find,
# touch and date), where the hosts that run pool maintenance and the release-PR
# job that checks this budget run.
#
# Exit status: 0 the timed pass ran over the stated workload; 1 a step failed or
# the workload was not what the budget states (the message names which).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
cd "$ROOT"
readonly CRATES=(allowlister-terminal-approval-plugin terminal-approval-e2e)
readonly ALT_PROFILE_DEBUG=line-tables-only
# Past the 2-day window `pool-maintenance` keeps.
readonly BACKDATE_SECONDS=$((3 * 24 * 3600))

fail() {
  echo "measure: $*" >&2
  exit 1
}

# The entry lists each step leaves, kept as the run's evidence: alt (what the
# alternative build created), ordinary (every other entry before the timed pass),
# removed (what the timed pass removed) and the last build log. Not a profile
# directory, so the pruner never touches it.
work=target/pool-maintenance-measure
rm -rf "$work"
mkdir -p "$work"

# Every build entry the pruner selects from: <profile>/{deps,.fingerprint,build,incremental}/*
# under each profile directory (one holding .fingerprint/) in target/, one path per line.
entries() {
  [ -d target ] || return 0
  find target -type d -name .fingerprint -prune -printf '%h\n' | while IFS= read -r profile; do
    for kind in deps .fingerprint build incremental; do
      [ -d "$profile/$kind" ] && find "$profile/$kind" -mindepth 1 -maxdepth 1
    done
  done | LC_ALL=C sort
}

gate_build() {
  local crate
  for crate in "${CRATES[@]}"; do
    bash tools/coverage/coverage.sh test "$crate" >"$work/build.log" 2>&1 \
      || { cat "$work/build.log" >&2; fail "the gate's test build of $crate failed (above)"; }
  done
}

# Only the timed pass may report.
result="${ONEBUDGETSPEC_RESULT:-}"
unset ONEBUDGETSPEC_RESULT

# a. Clear the backlog, untimed.
started=$(date +%s.%N)
just pool-maintenance >&2 || fail "the untimed backlog pass failed (above)"
echo "measure: untimed backlog pass took $(awk -v a="$started" -v b="$(date +%s.%N)" 'BEGIN { printf "%.3f", b - a }') s (not the figure)" >&2

# b. The alternative build, backdated past the window. Its time sits below every
#    entry already present, so no ordinary build that step c leaves untouched can
#    look older than the build it supersedes.
entries >"$work/before"
CARGO_PROFILE_DEV_DEBUG="$ALT_PROFILE_DEBUG" gate_build
entries >"$work/after-alt"
LC_ALL=C comm -13 "$work/before" "$work/after-alt" >"$work/alt"
[ -s "$work/alt" ] || fail "the alternative build created no new build entries, so its builds are already here within the window (an interrupted run leaves them); remove target/llvm-cov-target, then re-run"
stamp=$(($(date +%s) - BACKDATE_SECONDS))
if [ -s "$work/before" ]; then
  oldest=$(xargs -d '\n' -a "$work/before" bash -c 'find "$@" -printf "%T@\n"' _ | sort -n | sed -n 1p)
  oldest=${oldest%.*}
  [ "$oldest" -gt "$stamp" ] || stamp=$((oldest - 3600))
fi
# shellcheck disable=SC2016 # $STAMP is the inner bash's to expand, from its environment.
STAMP="$stamp" xargs -d '\n' -a "$work/alt" bash -c 'find "$@" -exec touch -h -d "@$STAMP" {} +' _
echo "measure: backdated $(wc -l <"$work/alt") entries the alternative build created to $(date -u -d "@$stamp" +%FT%TZ)" >&2

# c. The ordinary gate build: each unit's newest build.
gate_build
entries >"$work/after-ordinary"
LC_ALL=C comm -23 "$work/after-ordinary" "$work/alt" >"$work/ordinary"

# d. The timed pass, the one that reports.
if [ -n "$result" ]; then
  ONEBUDGETSPEC_RESULT="$result" just pool-maintenance >&2 || fail "the timed pass failed (above)"
else
  just pool-maintenance >&2 || fail "the timed pass failed (above)"
fi
entries >"$work/after-prune"

LC_ALL=C comm -23 "$work/after-ordinary" "$work/after-prune" >"$work/removed"
LC_ALL=C comm -23 "$work/ordinary" "$work/after-prune" >"$work/ordinary-lost"
LC_ALL=C comm -23 "$work/removed" "$work/alt" >"$work/foreign"
if [ -s "$work/ordinary-lost" ] || [ -s "$work/foreign" ]; then
  cat "$work/ordinary-lost" "$work/foreign" >&2
  fail "the timed pass removed entries above that the alternative build did not create"
fi
[ -s "$work/removed" ] || fail "the timed pass removed none of the alternative build's entries"
echo "measure: timed pass removed $(wc -l <"$work/removed") entries, all from the alternative build; all $(wc -l <"$work/ordinary") ordinary entries remain (lists in $work)" >&2
