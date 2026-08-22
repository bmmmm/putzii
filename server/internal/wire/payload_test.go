// SPDX-License-Identifier: GPL-3.0-or-later
package wire

import (
	"reflect"
	"testing"

	"github.com/bmmmm/putzii/server/internal/dropcrypto"
)

// The bytes sync.js actually PUTs must survive the server's decode chain
// unchanged: b64url → gunzip → FromWire → ToWire has to land back on the
// app's own canonical envelope. Everything in between is where a silent
// re-encoding difference would live.
func TestAppStatePayloadDecodes(t *testing.T) {
	g := loadGolden(t)
	payload := g.StatePayload
	if payload == "" {
		t.Skip("golden has no statePayload — regenerate it")
	}
	if len(payload) > MaxPayloadChars {
		t.Fatalf("a plain household plan already exceeds the payload cap: %d", len(payload))
	}
	gz, err := dropcrypto.B64urlDecode(payload)
	if err != nil {
		t.Fatalf("b64url: %v", err)
	}
	plain, err := dropcrypto.Gunzip(gz)
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	if got, want := SlotCount(plain), KnownSlots(); got > want {
		t.Fatalf("app emits %d slots, this build knows %d", got, want)
	}
	plan, _, err := FromWire(plain)
	if err != nil {
		t.Fatalf("FromWire: %v", err)
	}
	out, err := ToWire(plan)
	if err != nil {
		t.Fatalf("ToWire: %v", err)
	}
	if !reflect.DeepEqual(norm(t, out), norm(t, g.CanonicalWire)) {
		t.Fatalf("app payload did not round-trip\n got: %s\nwant: %s", out, g.CanonicalWire)
	}
	if err := plan.CheckCaps(); err != nil {
		t.Fatalf("golden plan violates caps: %v", err)
	}
}
