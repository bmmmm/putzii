// SPDX-License-Identifier: GPL-3.0-or-later
package wire

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/bmmmm/putzii/server/internal/golden"
)

type goldenFile struct {
	V             int             `json:"v"`
	RawWire       json.RawMessage `json:"rawWire"`
	CanonicalWire json.RawMessage `json:"canonicalWire"`
	FileExport    json.RawMessage `json:"fileExport"`
	KnownSlots    int             `json:"knownSlots"`
	StatePayload  string          `json:"statePayload"`
	ServerCaps    *appCaps        `json:"serverCaps"`
}

// appCaps is share.js's SERVER_CAPS — the app's copy of the thresholds this
// package defines. A pointer in goldenFile so "absent" is distinguishable
// from "all zero" and cannot pass as agreement.
type appCaps struct {
	MaxPayloadChars int `json:"maxPayloadChars"`
	MaxEvents       int `json:"maxEvents"`
	MaxAreas        int `json:"maxAreas"`
	MaxPeople       int `json:"maxPeople"`
	MaxWeeks        int `json:"maxWeeks"`
}

// regenHint is the one command that rebuilds this fixture — printed by every
// skip and failure so the fix is a copy-paste away.
const regenHint = "node tools/gen-golden.mjs internal/wire/testdata/golden.json .."

func loadGolden(t *testing.T) *goldenFile {
	t.Helper()
	raw := golden.Load(t, filepath.Join("testdata", "golden.json"), regenHint)
	var g goldenFile
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	return &g
}

// normalize JSON for semantic comparison (number formatting etc.)
func norm(t *testing.T, data []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	return v
}

// sortEvents makes the comparison order-insensitive for the raw leg (Node's
// wireFromPlan sorts newest-first via selectShareEvents, Go keeps order).
func sortEvents(v any) {
	arr, ok := v.([]any)
	if !ok || len(arr) < 8 {
		return
	}
	events, ok := arr[7].([]any)
	if !ok {
		return
	}
	sort.Slice(events, func(i, j int) bool {
		a, _ := json.Marshal(events[i])
		b, _ := json.Marshal(events[j])
		return string(a) < string(b)
	})
}

// TestGoldenFixpoint: Go must reproduce Node's canonical envelope EXACTLY —
// FromWire(canonical) → ToWire == canonical (semantic JSON equality).
func TestGoldenFixpoint(t *testing.T) {
	g := loadGolden(t)
	p, _, err := FromWire(g.CanonicalWire)
	if err != nil {
		t.Fatalf("FromWire(canonical): %v", err)
	}
	out, err := ToWire(p)
	if err != nil {
		t.Fatalf("ToWire: %v", err)
	}
	got := norm(t, out)
	want := norm(t, g.CanonicalWire)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("fixpoint mismatch\n got: %s\nwant: %s", out, g.CanonicalWire)
	}
}

// TestGoldenSanitize: Go's sanitizer must agree with Node's on the DIRTY
// input (event order ignored — Node sorts, Go preserves).
func TestGoldenSanitize(t *testing.T) {
	g := loadGolden(t)
	p, _, err := FromWire(g.RawWire)
	if err != nil {
		t.Fatalf("FromWire(raw): %v", err)
	}
	out, err := ToWire(p)
	if err != nil {
		t.Fatalf("ToWire: %v", err)
	}
	got := norm(t, out)
	want := norm(t, g.CanonicalWire)
	sortEvents(got)
	sortEvents(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sanitize mismatch\n got: %s\nwant: %s", out, g.CanonicalWire)
	}
}

// TestGoldenFileExport: ParseFile(Node's serializeFile output) must yield
// the same canonical envelope.
func TestGoldenFileExport(t *testing.T) {
	g := loadGolden(t)
	p, err := ParseFile(g.FileExport)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}
	out, err := ToWire(p)
	if err != nil {
		t.Fatalf("ToWire: %v", err)
	}
	got := norm(t, out)
	want := norm(t, g.CanonicalWire)
	sortEvents(got)
	sortEvents(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("file export mismatch\n got: %s\nwant: %s", out, g.CanonicalWire)
	}
}

func TestNormalizeName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"  Sina  M.  ", "Sina M."},
		{"a\x00b\x1fc", "abc"},
		{"", ""},
		{"xy", "xy"},
	}
	for _, c := range cases {
		if got := NormalizeName(c.in); got != c.want {
			t.Errorf("NormalizeName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// 40 UTF-16 units, not runes: an emoji (surrogate pair) counts as 2
	broom := "\U0001F9F9"
	long := strings.Repeat(broom, 20) + "x" // 20 emoji = 40 units, then one more
	got := NormalizeName(long)
	if got != strings.Repeat(broom, 20) {
		t.Errorf("UTF-16 cap: got %q", got)
	}
}

func TestFileRoundtrip(t *testing.T) {
	p := &Plan{
		PlanID: "RtTest01", Name: "Roundtrip", UpdatedAt: 1755600000,
		Areas:  []Area{{ID: "a1", Name: "Küche", IntervalDays: 7, CreatedAt: 1, UpdatedAt: 2}},
		People: []Person{{ID: "p1", Name: "Sina", CreatedAt: 1, UpdatedAt: 1}},
		Events: []Event{{ID: "dev.1", AreaID: "a1", PersonID: "p1", TsMs: 1787047500000}},
		Weeks:  []Week{{ID: "2026-W34", Days: map[string][][2]string{"3": {{"a1", "p1"}}}, CreatedAt: 1, UpdatedAt: 2}},
	}
	data, err := SerializeFile(p)
	if err != nil {
		t.Fatal(err)
	}
	back, err := ParseFile(data)
	if err != nil {
		t.Fatal(err)
	}
	w1, _ := ToWire(p)
	w2, _ := ToWire(back)
	if !reflect.DeepEqual(norm(t, w1), norm(t, w2)) {
		t.Fatalf("file roundtrip drift:\n%s\n%s", w1, w2)
	}
}
