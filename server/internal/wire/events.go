// SPDX-License-Identifier: GPL-3.0-or-later
package wire

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Event ids are "<deviceKey>.<seq-base36>". Parity target: helpers.js
// parseCompactEventId / formatCompactEventId / cmpEventId. The sequence is
// compared NUMERICALLY — a lexical compare inverts order at every base36
// width boundary (seq 36 = "10" sorts before seq 35 = "z").
var eventIDRe = regexp.MustCompile(`^([A-Za-z0-9_-]+)\.([0-9a-z]+)$`)

// maxSafeInteger mirrors JS Number.MAX_SAFE_INTEGER — the app rejects ids
// above it, so Go must too or the two would disagree about validity.
const maxSafeInteger = 1<<53 - 1

type EventID struct {
	DeviceKey string
	Seq       int64
}

// ParseCompactEventID returns nil for anything the app would also reject.
func ParseCompactEventID(id string) *EventID {
	m := eventIDRe.FindStringSubmatch(id)
	if m == nil {
		return nil
	}
	seq, err := strconv.ParseInt(m[2], 36, 64)
	if err != nil || seq <= 0 || seq > maxSafeInteger {
		return nil
	}
	return &EventID{DeviceKey: m[1], Seq: seq}
}

func FormatCompactEventID(deviceKey string, seq int64) string {
	return fmt.Sprintf("%s.%s", deviceKey, strconv.FormatInt(seq, 36))
}

// CmpEventID: deviceKey lexically, sequence numerically; unparsable ids fall
// back to a plain string compare (same as the app).
func CmpEventID(a, b string) int {
	if a == b {
		return 0
	}
	pa, pb := ParseCompactEventID(a), ParseCompactEventID(b)
	if pa != nil && pb != nil {
		if pa.DeviceKey != pb.DeviceKey {
			return strings.Compare(pa.DeviceKey, pb.DeviceKey)
		}
		switch {
		case pa.Seq < pb.Seq:
			return -1
		case pa.Seq > pb.Seq:
			return 1
		}
		return 0
	}
	return strings.Compare(a, b)
}

// CompareEventsByTime: ts first, event id as the tie-break — the exact order
// mergePlans leaves behind, so a server-written envelope is byte-comparable
// with what the app would have written.
func CompareEventsByTime(a, b Event) int {
	if a.TsMs != b.TsMs {
		if a.TsMs < b.TsMs {
			return -1
		}
		return 1
	}
	return CmpEventID(a.ID, b.ID)
}

// SortEvents orders a plan's events the way mergePlans does.
func SortEvents(events []Event) {
	sort.SliceStable(events, func(i, j int) bool {
		return CompareEventsByTime(events[i], events[j]) < 0
	})
}

// ValidEvent mirrors share.js validEvent — the gate mergePlans applies to
// every incoming event before it may join the log.
func ValidEvent(e Event, nowMs float64) bool {
	return ParseCompactEventID(e.ID) != nil &&
		e.AreaID != "" &&
		e.TsMs >= MinEventTsMs &&
		e.TsMs <= nowMs+MaxFutureMs
}

// DroppedEventIDs reports ids present in `stored` but missing from
// `incoming`, capped at `max` results.
//
// The server overwrites rather than merges, which is only safe while the
// event log stays append-only. A client that pushes fewer events than it
// was given has truncated history (an adaptive payload shrink, a partially
// merged plan, a downgraded app) — the write is refused instead of silently
// erasing the log. Legitimate pruning is an admin operation, not a push.
func DroppedEventIDs(stored, incoming []Event, max int) []string {
	if len(stored) == 0 {
		return nil
	}
	have := make(map[string]struct{}, len(incoming))
	for _, e := range incoming {
		have[e.ID] = struct{}{}
	}
	var out []string
	for _, e := range stored {
		if _, ok := have[e.ID]; ok {
			continue
		}
		out = append(out, e.ID)
		if len(out) >= max {
			break
		}
	}
	return out
}

// AreaByID returns the area with this id, or nil.
func (p *Plan) AreaByID(id string) *Area {
	for i := range p.Areas {
		if p.Areas[i].ID == id {
			return &p.Areas[i]
		}
	}
	return nil
}

// PersonByID returns the person with this id, or nil.
func (p *Plan) PersonByID(id string) *Person {
	for i := range p.People {
		if p.People[i].ID == id {
			return &p.People[i]
		}
	}
	return nil
}
