#!/usr/bin/env bash
# The CI chain (.github/workflows/ci.yml), locally, as ONE command. Same
# order, same environment variables, first failure stops it. Green here
# means green there — except the docker job, which needs a daemon and runs
# only with --docker.
#
# Usage:
#   scripts/check.sh                 # gofmt, vet, parity fixtures, go test
#                                    # (Berlin, UTC), Go→Node vectors, build,
#                                    # self-check (Berlin, UTC, each also
#                                    # with a seeded active plan), sw-version
#   scripts/check.sh --base <ref>    # sw-version against <ref>..HEAD instead
#                                    # of the staging area
#   scripts/check.sh --docker        # …plus the image build + version stamp
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

with_docker=0
base=""
while [ $# -gt 0 ]; do
  case "$1" in
    --docker) with_docker=1 ;;
    --base) base="${2:-}"; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "check.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

# Parity suites must not skip: a missing fixture is a failure, like in CI.
export PUTZII_REQUIRE_GOLDEN=1

done_steps=()
step() {
  printf '\n▶ %s\n' "$1"
  done_steps+=("$1")
}
tz_line() { printf '  TZ=%s → %s\n' "${TZ:-<unset>}" "$(date +'%Z %z')"; }

step "gofmt"
unformatted="$(gofmt -l server)"
if [ -n "$unformatted" ]; then
  echo "not gofmt'd:" >&2; echo "$unformatted" >&2; exit 1
fi

step "go vet"
(cd server && go vet ./...)

step "parity fixtures from the app (Node → Go)"
(cd server \
  && node tools/gen-vectors.mjs internal/dropcrypto/testdata/vectors.json \
  && node tools/gen-golden.mjs internal/wire/testdata/golden.json .. \
  && node tools/gen-mint-golden.mjs internal/mint/testdata/mint-golden.json ..)

# -count=1 on both runs: the go test cache does not see TZ (the time package
# reads it below the os package's test log), so a cached Berlin result would
# silently stand in for the UTC run.
step "go test (Europe/Berlin)"
(cd server && TZ=Europe/Berlin tz_line && TZ=Europe/Berlin go test -count=1 ./...)

step "Go-generated vectors open in Node (Go → Node)"
(cd server && node tools/check-vectors.mjs internal/dropcrypto/testdata/govectors.json)

step "go test (UTC)"
(cd server && TZ=UTC tz_line && TZ=UTC go test -count=1 ./...)

step "go build"
(cd server && go build ./...)

step "app self-check (Europe/Berlin)"
TZ=Europe/Berlin tz_line
TZ=Europe/Berlin node server/tools/selfcheck.mjs .

step "app self-check (UTC)"
TZ=UTC tz_line
TZ=UTC node server/tools/selfcheck.mjs .

# Same suite, but with a real active plan seeded first: the runner then also
# asserts that the device's own plan came back untouched. The unseeded runs
# above stay — only they exercise the empty-store branch of the sync section.
step "app self-check with a seeded active plan (Europe/Berlin)"
PUTZII_SEED_ACTIVE=1 TZ=Europe/Berlin node server/tools/selfcheck.mjs .

step "app self-check with a seeded active plan (UTC)"
PUTZII_SEED_ACTIVE=1 TZ=UTC node server/tools/selfcheck.mjs .

if [ -n "$base" ]; then
  step "service worker version ($base..HEAD)"
  bash scripts/check-sw-version.sh "$base"
else
  step "service worker version (staged changes)"
  bash scripts/check-sw-version.sh
fi

if [ "$with_docker" -eq 1 ]; then
  sha="$(git rev-parse HEAD)"
  step "docker build (VERSION=${sha:0:12}…)"
  docker build -f server/Dockerfile --build-arg "VERSION=$sha" -t putzii-server:local .
  step "image reports the commit as its version"
  docker run --rm putzii-server:local version | grep -F "$sha"
fi

printf '\n✔ all green — %d steps:\n' "${#done_steps[@]}"
for s in "${done_steps[@]}"; do printf '  ✓ %s\n' "$s"; done
[ "$with_docker" -eq 1 ] || echo "  (docker job not run — add --docker; CI always builds the image)"
