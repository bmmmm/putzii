// SPDX-License-Identifier: GPL-3.0-or-later
package mint

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/bmmmm/putzii/server/internal/golden"
	"github.com/bmmmm/putzii/server/internal/wire"
)

// The check-in path is the one place where Go reimplements app behaviour
// instead of running it. These cases are GENERATED from the app
// (tools/gen-mint-golden.mjs), so a change in model.js/helpers.js that the
// Go port does not follow turns the build red instead of quietly minting
// duplicate or mis-ordered events.

type mintGolden struct {
	V            int     `json:"v"`
	NowMs        float64 `json:"nowMs"`
	ExistsRecent []struct {
		Name        string  `json:"name"`
		TsMs        float64 `json:"tsMs"`
		HasEvent    bool    `json:"hasEvent"`
		Same        bool    `json:"same"`
		OtherPerson bool    `json:"otherPerson"`
		OtherArea   bool    `json:"otherArea"`
	} `json:"existsRecent"`
	EventIDs []struct {
		ID        string `json:"id"`
		OK        bool   `json:"ok"`
		DeviceKey string `json:"deviceKey"`
		Seq       int64  `json:"seq"`
	} `json:"eventIds"`
	CmpPairs []struct {
		A   string `json:"a"`
		B   string `json:"b"`
		Cmp int    `json:"cmp"`
	} `json:"cmpPairs"`
	Formatted []struct {
		Seq int64  `json:"seq"`
		ID  string `json:"id"`
	} `json:"formatted"`
}

func loadMintGolden(t *testing.T) *mintGolden {
	t.Helper()
	raw := golden.Load(t, filepath.Join("testdata", "mint-golden.json"),
		"node tools/gen-mint-golden.mjs internal/mint/testdata/mint-golden.json ..")
	var g mintGolden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("parse mint golden: %v", err)
	}
	return &g
}

func TestGoldenExistsRecent(t *testing.T) {
	g := loadMintGolden(t)
	for _, c := range g.ExistsRecent {
		t.Run(c.Name, func(t *testing.T) {
			p := &wire.Plan{
				PlanID: "MintPln1",
				Areas:  []wire.Area{{ID: "kche1", Name: "Küche", IntervalDays: 7}},
				People: []wire.Person{{ID: "sina7", Name: "Sina"}},
			}
			if c.HasEvent {
				p.Events = []wire.Event{{ID: "gsina7.1", AreaID: "kche1", PersonID: "sina7", TsMs: c.TsMs}}
			}
			if got := ExistsRecent(p, "kche1", "sina7", g.NowMs); got != c.Same {
				t.Errorf("same person: got %v, app says %v", got, c.Same)
			}
			if got := ExistsRecent(p, "kche1", "timo3", g.NowMs); got != c.OtherPerson {
				t.Errorf("other person: got %v, app says %v", got, c.OtherPerson)
			}
			if got := ExistsRecent(p, "bad22", "sina7", g.NowMs); got != c.OtherArea {
				t.Errorf("other area: got %v, app says %v", got, c.OtherArea)
			}
		})
	}
}

func TestGoldenEventIDs(t *testing.T) {
	g := loadMintGolden(t)
	for _, c := range g.EventIDs {
		got := wire.ParseCompactEventID(c.ID)
		if (got != nil) != c.OK {
			t.Errorf("ParseCompactEventID(%q) ok = %v, app says %v", c.ID, got != nil, c.OK)
			continue
		}
		if got != nil && (got.DeviceKey != c.DeviceKey || got.Seq != c.Seq) {
			t.Errorf("ParseCompactEventID(%q) = %+v, app says %s/%d", c.ID, got, c.DeviceKey, c.Seq)
		}
	}
	for _, c := range g.Formatted {
		if got := wire.FormatCompactEventID("gsina7", c.Seq); got != c.ID {
			t.Errorf("FormatCompactEventID(seq %d) = %q, app says %q", c.Seq, got, c.ID)
		}
	}
}

func TestGoldenEventIDOrdering(t *testing.T) {
	g := loadMintGolden(t)
	for _, c := range g.CmpPairs {
		got := wire.CmpEventID(c.A, c.B)
		if sign(got) != c.Cmp {
			t.Errorf("CmpEventID(%q, %q) = %d, app says %d", c.A, c.B, sign(got), c.Cmp)
		}
	}
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	}
	return 0
}
