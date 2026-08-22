// SPDX-License-Identifier: GPL-3.0-or-later
package mint

import (
	"errors"
	"testing"

	"github.com/bmmmm/putzii/server/internal/wire"
)

const nowMs = float64(1787047500000) // 2026-08-14T…, minute-aligned

func base() *wire.Plan {
	return &wire.Plan{
		PlanID: "MintPln1",
		Areas: []wire.Area{
			{ID: "kche1", Name: "Küche", IntervalDays: 7},
			{ID: "bad22", Name: "Bad", IntervalDays: 14, DeletedAt: 1755100000},
		},
		People: []wire.Person{{ID: "sina7", Name: "Sina"}},
	}
}

func TestCheckinMintsFirstEvent(t *testing.T) {
	p := base()
	ev, err := Checkin(p, "kche1", "sina7", nowMs)
	if err != nil || ev == nil {
		t.Fatalf("Checkin() = %v, %v", ev, err)
	}
	if ev.ID != "gsina7.1" {
		t.Fatalf("device key must be \"g\"+personId with seq 1, got %q", ev.ID)
	}
	if ev.AreaID != "kche1" || ev.PersonID != "sina7" {
		t.Fatalf("event mis-attributed: %+v", ev)
	}
	// minute-quantized at creation — the wire round-trip is then lossless
	if int64(ev.TsMs)%60000 != 0 {
		t.Fatalf("ts not minute-quantized: %v", ev.TsMs)
	}
}

func TestCheckinSequenceContinues(t *testing.T) {
	p := base()
	p.Events = []wire.Event{
		{ID: "gsina7.z", AreaID: "kche1", PersonID: "sina7", TsMs: nowMs - 5*86400000},
		{ID: "other.9", AreaID: "kche1", PersonID: "timo3", TsMs: nowMs - 86400000},
	}
	ev, err := Checkin(p, "kche1", "sina7", nowMs)
	if err != nil {
		t.Fatal(err)
	}
	// "z" is 35 → the next id must be 36 = "10", not "z"+1 lexically
	if ev.ID != "gsina7.10" {
		t.Fatalf("seq must continue numerically, got %q", ev.ID)
	}
}

func TestCheckinUnknownAndDeletedArea(t *testing.T) {
	p := base()
	if _, err := Checkin(p, "nope1", "sina7", nowMs); !errors.Is(err, ErrUnknownArea) {
		t.Fatalf("unknown area: %v", err)
	}
	if _, err := Checkin(p, "bad22", "sina7", nowMs); !errors.Is(err, ErrUnknownArea) {
		t.Fatalf("deleted area must be refused: %v", err)
	}
}

// The idempotency window is what makes a retried webhook, a double scan and
// a back-button resubmit all safe.
func TestCheckinIdempotencyWindow(t *testing.T) {
	p := base()
	p.Events = []wire.Event{{ID: "gsina7.1", AreaID: "kche1", PersonID: "sina7", TsMs: nowMs - 60000}}
	ev, err := Checkin(p, "kche1", "sina7", nowMs)
	if err != nil || ev != nil {
		t.Fatalf("inside the window must be a no-op, got %v %v", ev, err)
	}
	// another person is NOT the same check-in
	if ev, err := Checkin(p, "kche1", "timo3", nowMs); err != nil || ev == nil {
		t.Fatalf("different person must still mint: %v %v", ev, err)
	}
	// just outside the window mints again
	p.Events[0].TsMs = nowMs - IdempotentMs - 60000
	if ev, err := Checkin(p, "kche1", "sina7", nowMs); err != nil || ev == nil {
		t.Fatalf("outside the window must mint: %v %v", ev, err)
	}
}

// Clock skew, both directions. A slightly-ahead device still lands inside
// the window; a device with a wildly wrong clock must NOT park a check-in in
// the future and thereby suppress every later one.
func TestExistsRecentUnderClockSkew(t *testing.T) {
	p := base()
	p.Events = []wire.Event{{ID: "gsina7.1", AreaID: "kche1", PersonID: "sina7", TsMs: nowMs + 5*60000}}
	if !ExistsRecent(p, "kche1", "sina7", nowMs) {
		t.Fatalf("a slightly-ahead clock must still count as recent")
	}
	p.Events[0].TsMs = nowMs + 48*3600*1000
	if ExistsRecent(p, "kche1", "sina7", nowMs) {
		t.Fatalf("an event beyond the future clamp must not block new check-ins")
	}
	p.Events[0].TsMs = nowMs - 30*86400000
	if ExistsRecent(p, "kche1", "sina7", nowMs) {
		t.Fatalf("an old event must not block a new check-in")
	}
}

func TestAppendKeepsOrderAndDedupes(t *testing.T) {
	p := base()
	p.Events = []wire.Event{{ID: "gsina7.2", AreaID: "kche1", PersonID: "sina7", TsMs: nowMs}}
	older := &wire.Event{ID: "gsina7.1", AreaID: "kche1", PersonID: "sina7", TsMs: nowMs - 86400000}
	if !Append(p, older) {
		t.Fatalf("append must succeed")
	}
	if p.Events[0].ID != "gsina7.1" {
		t.Fatalf("events must come back in canonical order: %+v", p.Events)
	}
	if Append(p, older) {
		t.Fatalf("first-seen-wins: a duplicate id must be refused")
	}
	if Append(p, nil) {
		t.Fatalf("nil append must be a no-op")
	}
}
