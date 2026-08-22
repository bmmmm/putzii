// SPDX-License-Identifier: GPL-3.0-or-later

// Package mint is the Go port of the retired runner/mint.mjs: the SERVER
// mints the check-in event, so a dumb curl / Home-Assistant rest_command /
// Shortcut / ESP button is semantically correct without JS, gzip or any
// knowledge of the plan. Mirrors store.js newEvent(): deviceKey "g"+personId,
// numeric seq, minute-quantized ts, 10-minute idempotency window.
//
// Deliberately free of ISO-week math: the week helpers in helpers.js carry
// DST and 53-week edge cases that must NOT be reimplemented — the check-in
// path never needs them.
package mint

import (
	"errors"

	"github.com/bmmmm/putzii/server/internal/wire"
)

// Windows mirror model.js. FutureClampMs is applied at READ time only: the
// log is never rewritten.
const (
	FutureClampMs = 12 * 3600 * 1000
	IdempotentMs  = 10 * 60 * 1000
)

// ErrUnknownArea is fatal for a check-in: the area does not exist (or was
// deleted). It is the one caller-visible reason a well-formed, authenticated
// request is still refused.
var ErrUnknownArea = errors.New("unknown-area")

// effTs clamps forward clock skew, like model.js effTs.
func effTs(tsMs, nowMs float64) float64 {
	if limit := nowMs + FutureClampMs; tsMs > limit {
		return limit
	}
	return tsMs
}

// ExistsRecent is model.js existsRecent: same area + same person inside the
// idempotency window. A double scan, a back-button resubmit and a retried
// webhook all land here instead of appending a duplicate.
func ExistsRecent(p *wire.Plan, areaID, personID string, nowMs float64) bool {
	for _, e := range p.Events {
		if e.AreaID != areaID || e.PersonID != personID {
			continue
		}
		if nowMs-e.TsMs >= -FutureClampMs && nowMs-effTs(e.TsMs, nowMs) <= IdempotentMs {
			return true
		}
	}
	return false
}

// Checkin mints the event for (areaId, personId) at nowMs.
//
// Returns (nil, nil) for the idempotent no-op — the caller still treats that
// as success: the intent IS recorded, just not twice.
func Checkin(p *wire.Plan, areaID, personID string, nowMs float64) (*wire.Event, error) {
	area := p.AreaByID(areaID)
	if area == nil || area.DeletedAt != 0 {
		return nil, ErrUnknownArea
	}
	if ExistsRecent(p, areaID, personID, nowMs) {
		return nil, nil
	}
	deviceKey := "g" + personID
	var maxSeq int64
	for _, e := range p.Events {
		if parsed := wire.ParseCompactEventID(e.ID); parsed != nil &&
			parsed.DeviceKey == deviceKey && parsed.Seq > maxSeq {
			maxSeq = parsed.Seq
		}
	}
	return &wire.Event{
		ID:       wire.FormatCompactEventID(deviceKey, maxSeq+1),
		AreaID:   areaID,
		PersonID: personID,
		TsMs:     float64(int64(nowMs/60000) * 60000),
	}, nil
}

// Append adds a minted event to the plan and restores the canonical event
// order. Union-by-id with first-seen-wins is preserved: a duplicate id is
// dropped rather than overwriting the existing payload.
func Append(p *wire.Plan, e *wire.Event) bool {
	if e == nil {
		return false
	}
	for _, existing := range p.Events {
		if existing.ID == e.ID {
			return false
		}
	}
	p.Events = append(p.Events, *e)
	wire.SortEvents(p.Events)
	return true
}
