// SPDX-License-Identifier: GPL-3.0-or-later
package wire

import "testing"

func TestParseCompactEventID(t *testing.T) {
	cases := []struct {
		in   string
		key  string
		seq  int64
		want bool
	}{
		{"abcde.1", "abcde", 1, true},
		{"gsina7.z", "gsina7", 35, true},
		{"gsina7.10", "gsina7", 36, true},
		{"dev-key_9.2f", "dev-key_9", 87, true},
		{"nodot", "", 0, false},
		{"bad.0", "", 0, false},  // seq must be > 0
		{"bad.-1", "", 0, false}, // '-' is not in the base36 charset here
		{"bad.ZZ", "", 0, false}, // uppercase seq is not what the app emits
		{".1", "", 0, false},
		{"", "", 0, false},
	}
	for _, c := range cases {
		got := ParseCompactEventID(c.in)
		if (got != nil) != c.want {
			t.Fatalf("ParseCompactEventID(%q) ok = %v, want %v", c.in, got != nil, c.want)
		}
		if got != nil && (got.DeviceKey != c.key || got.Seq != c.seq) {
			t.Fatalf("ParseCompactEventID(%q) = %+v, want %s/%d", c.in, got, c.key, c.seq)
		}
	}
}

// The base36 width boundary is the whole reason cmpEventId exists: a lexical
// compare puts seq 36 ("10") BEFORE seq 35 ("z").
func TestCmpEventIDNumericSeq(t *testing.T) {
	if CmpEventID("dev.z", "dev.10") >= 0 {
		t.Fatalf("seq 35 must sort before seq 36")
	}
	if CmpEventID("dev.10", "dev.z") <= 0 {
		t.Fatalf("compare must be antisymmetric")
	}
	if CmpEventID("dev.5", "dev.5") != 0 {
		t.Fatalf("equal ids must compare equal")
	}
	if CmpEventID("aaa.1", "bbb.1") >= 0 {
		t.Fatalf("deviceKey must sort lexically")
	}
	// Unparsable ids fall back to a plain string compare, like the app.
	if CmpEventID("zzz", "aaa") <= 0 {
		t.Fatalf("junk ids must still order deterministically")
	}
}

func TestSortEvents(t *testing.T) {
	events := []Event{
		{ID: "dev.10", TsMs: 1000},
		{ID: "dev.z", TsMs: 1000},
		{ID: "dev.1", TsMs: 500},
	}
	SortEvents(events)
	want := []string{"dev.1", "dev.z", "dev.10"}
	for i, id := range want {
		if events[i].ID != id {
			t.Fatalf("position %d = %s, want %s (%v)", i, events[i].ID, id, events)
		}
	}
}

func TestValidEvent(t *testing.T) {
	now := float64(1787047500000)
	ok := Event{ID: "dev.1", AreaID: "a1", TsMs: now - 60000}
	if !ValidEvent(ok, now) {
		t.Fatalf("plain event rejected")
	}
	for name, e := range map[string]Event{
		"bad id":     {ID: "nope", AreaID: "a1", TsMs: now},
		"no area":    {ID: "dev.1", AreaID: "", TsMs: now},
		"prehistory": {ID: "dev.1", AreaID: "a1", TsMs: MinEventTsMs - 1},
		"far future": {ID: "dev.1", AreaID: "a1", TsMs: now + MaxFutureMs + 1},
	} {
		if ValidEvent(e, now) {
			t.Fatalf("%s must be rejected", name)
		}
	}
}
