// SPDX-License-Identifier: GPL-3.0-or-later

// Package golden loads the Node-generated parity fixtures the Go suites
// assert against (crypto vectors, the wire envelope, check-in semantics).
//
// The fixtures are gitignored and regenerated from the working tree by
// tools/gen-*.mjs, so a fresh checkout has none. Locally that is a
// convenience: the parity suites skip and everything else still runs. In
// the gate it would be a hole — a skipped parity test proves nothing — so
// CI sets PUTZII_REQUIRE_GOLDEN and a missing fixture FAILS there.
package golden

import (
	"os"
	"testing"
)

// RequireEnv, when set to anything non-empty, turns "no fixture → skip"
// into "no fixture → fail". scripts/check.sh and the CI workflow set it.
const RequireEnv = "PUTZII_REQUIRE_GOLDEN"

// Load reads the fixture at path. hint is the generator command, printed in
// both the skip and the failure message so the fix is one copy-paste away.
func Load(t *testing.T, path, hint string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err == nil {
		return raw
	}
	if os.Getenv(RequireEnv) != "" {
		t.Fatalf("missing %s with %s set — run: %s (%v)", path, RequireEnv, hint, err)
	}
	t.Skipf("no %s — run: %s (%v)", path, hint, err)
	return nil
}

// RequireField is Load's counterpart for a fixture that exists but PREDATES
// the field a test needs — an older golden.json, regenerated before that key
// was added. Load only guards the file, so without this a stale fixture
// silently skips even under RequireEnv, and a skipped parity test proves
// nothing. Same two-tier rule: skip locally, fail in the gate.
func RequireField(t *testing.T, present bool, field, hint string) {
	t.Helper()
	if present {
		return
	}
	if os.Getenv(RequireEnv) != "" {
		t.Fatalf("golden has no %s with %s set — regenerate: %s", field, RequireEnv, hint)
	}
	t.Skipf("golden has no %s — regenerate: %s", field, hint)
}
