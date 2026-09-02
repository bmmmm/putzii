// SPDX-License-Identifier: GPL-3.0-or-later
package wire

import (
	"encoding/json"
	"testing"

	"github.com/bmmmm/putzii/server/internal/golden"
)

func planWith(areas, people, events, weeks int) *Plan {
	p := &Plan{PlanID: "CapPlan1", Name: "Caps"}
	for i := 0; i < areas; i++ {
		p.Areas = append(p.Areas, Area{ID: FormatCompactEventID("a", int64(i+1)), Name: "A", IntervalDays: 7})
	}
	for i := 0; i < people; i++ {
		p.People = append(p.People, Person{ID: FormatCompactEventID("p", int64(i+1)), Name: "P"})
	}
	for i := 0; i < events; i++ {
		p.Events = append(p.Events, Event{
			ID: FormatCompactEventID("dev", int64(i+1)), AreaID: "a1", PersonID: "p1", TsMs: 1787047500000,
		})
	}
	for i := 0; i < weeks; i++ {
		p.Weeks = append(p.Weeks, Week{ID: "2026-W34", Days: map[string][][2]string{}})
	}
	return p
}

// The caps are the ones a violation must DISCARD the whole request over —
// each boundary is tested at exactly N (ok) and N+1 (refused).
func TestCapsBoundaries(t *testing.T) {
	cases := []struct {
		name                         string
		areas, people, events, weeks int
		wantErr                      bool
	}{
		{"all at the limit", MaxAreas, MaxPeople, MaxEvents, MaxWeeks, false},
		{"events over", 1, 1, MaxEvents + 1, 0, true},
		{"areas over", MaxAreas + 1, 1, 1, 0, true},
		{"people over", 1, MaxPeople + 1, 1, 0, true},
		{"weeks over", 1, 1, 1, MaxWeeks + 1, true},
		{"empty", 0, 0, 0, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := planWith(c.areas, c.people, c.events, c.weeks).CheckCaps()
			if (err != nil) != c.wantErr {
				t.Fatalf("CheckCaps() = %v, wantErr %v", err, c.wantErr)
			}
		})
	}
}

// KnownSlots must agree with what the APP emits (pinned in the golden file).
// If they ever drift, one side could silently strip the other's slots.
func TestKnownSlotsMatchesApp(t *testing.T) {
	g := loadGolden(t)
	golden.RequireField(t, g.KnownSlots != 0, "knownSlots", regenHint)
	if got := KnownSlots(); got != g.KnownSlots {
		t.Fatalf("KnownSlots() = %d, app emits %d — the Go codec is out of step", got, g.KnownSlots)
	}
}

// The caps exist twice — here and as SERVER_CAPS in share.js, which the app
// checks BEFORE pushing so "too big" needs no round-trip. Two hand-kept
// copies drift, and the drift surfaces as a 422 nobody can explain: the app
// happily sends what the server refuses, or refuses locally what the server
// would have taken. Pinned per value, so the failure names which one moved.
func TestServerCapsMatchApp(t *testing.T) {
	g := loadGolden(t)
	golden.RequireField(t, g.ServerCaps != nil, "serverCaps", regenHint)
	for _, c := range []struct {
		name     string
		go_, app int
	}{
		{"maxPayloadChars", MaxPayloadChars, g.ServerCaps.MaxPayloadChars},
		{"maxEvents", MaxEvents, g.ServerCaps.MaxEvents},
		{"maxAreas", MaxAreas, g.ServerCaps.MaxAreas},
		{"maxPeople", MaxPeople, g.ServerCaps.MaxPeople},
		{"maxWeeks", MaxWeeks, g.ServerCaps.MaxWeeks},
	} {
		if c.go_ != c.app {
			t.Errorf("%s: Go %d, app %d — the two copies drifted", c.name, c.go_, c.app)
		}
	}
}

// An envelope from a NEWER app must be detectable, never re-encoded.
func TestSlotCount(t *testing.T) {
	future, _ := json.Marshal([]any{1, "p", "", 0, 0, []any{}, []any{}, []any{}, 0, []any{}, "future-slot"})
	if got := SlotCount(future); got != KnownSlots()+1 {
		t.Fatalf("SlotCount = %d, want %d", got, KnownSlots()+1)
	}
	if SlotCount([]byte(`{"not":"an array"}`)) != 0 {
		t.Fatalf("non-array must count 0")
	}
}

// The payload cap is a CHARACTER budget on the encoded envelope, checked
// before anything is decompressed — the value the client also budgets with.
func TestPayloadCapValue(t *testing.T) {
	if MaxPayloadChars != 64*1024 {
		t.Fatalf("payload cap drifted from the documented 64 kB: %d", MaxPayloadChars)
	}
}

func TestDroppedEventIDs(t *testing.T) {
	stored := []Event{{ID: "a.1"}, {ID: "a.2"}, {ID: "b.1"}}
	same := []Event{{ID: "b.1"}, {ID: "a.1"}, {ID: "a.2"}}
	if got := DroppedEventIDs(stored, same, 4); got != nil {
		t.Fatalf("reordering must not count as dropped: %v", got)
	}
	grown := append(append([]Event(nil), same...), Event{ID: "c.9"})
	if got := DroppedEventIDs(stored, grown, 4); got != nil {
		t.Fatalf("appending must not count as dropped: %v", got)
	}
	truncated := []Event{{ID: "a.1"}}
	got := DroppedEventIDs(stored, truncated, 4)
	if len(got) != 2 {
		t.Fatalf("want 2 dropped, got %v", got)
	}
	if got := DroppedEventIDs(nil, truncated, 4); got != nil {
		t.Fatalf("no stored events → nothing dropped, got %v", got)
	}
}
