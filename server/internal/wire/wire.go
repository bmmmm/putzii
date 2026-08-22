// SPDX-License-Identifier: GPL-3.0-or-later

// Package wire implements the putzii wire envelope (positional JSON array,
// APPEND-ONLY slots) with the same sanitizing semantics as share.js
// planFromWire/wireFromPlan. Golden tests against Node pin the parity.
package wire

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"
)

const (
	Version          = 1
	flagViewer       = 1
	maxWeeks         = 400
	maxDaySlots      = 20
	MinEventTsMs     = 1577836800000 // Date.UTC(2020,0,1)
	MaxFutureMs      = 30 * 86400000
	maxNameUTF16     = 40
	defaultPlanName  = "Putzplan"
	defaultAreaName  = "Bereich"
	defaultPersonNme = "Unbekannt"
)

// Caps mirror the CAPS block of the retired putzii-drop apply.mjs: a
// violation discards the WHOLE request, it never truncates. FromWire already
// clamps weeks and day slots structurally; CheckCaps is the explicit gate a
// caller runs before anything is written.
const (
	MaxPayloadChars = 64 * 1024
	MaxEvents       = 500
	MaxAreas        = 200
	MaxPeople       = 200
	MaxWeeks        = maxWeeks
)

// CheckCaps reports the FIRST cap a plan violates, or nil. The message is
// log-safe: counts only, never names or payload.
func (p *Plan) CheckCaps() error {
	switch {
	case len(p.Events) > MaxEvents:
		return fmt.Errorf("caps: events %d > %d", len(p.Events), MaxEvents)
	case len(p.Areas) > MaxAreas:
		return fmt.Errorf("caps: areas %d > %d", len(p.Areas), MaxAreas)
	case len(p.People) > MaxPeople:
		return fmt.Errorf("caps: people %d > %d", len(p.People), MaxPeople)
	case len(p.Weeks) > MaxWeeks:
		return fmt.Errorf("caps: weeks %d > %d", len(p.Weeks), MaxWeeks)
	}
	return nil
}

// KnownSlots is how many envelope slots THIS build emits. The envelope is
// append-only, so a payload with more slots comes from a NEWER app: it is
// refused as fatal, never re-encoded — re-encoding would silently strip the
// slots this build does not know. Fix = update the server binary.
func KnownSlots() int {
	raw, err := ToWire(&Plan{PlanID: "x"})
	if err != nil {
		return 0
	}
	return SlotCount(raw)
}

// SlotCount reports how many slots an encoded envelope carries (0 when the
// payload is not a JSON array at all).
func SlotCount(data []byte) int {
	var arr []json.RawMessage
	if json.Unmarshal(data, &arr) != nil {
		return 0
	}
	return len(arr)
}

type Area struct {
	ID           string
	Name         string
	IntervalDays float64
	CreatedAt    float64
	UpdatedAt    float64
	DeletedAt    float64
}

type Person struct {
	ID        string
	Name      string
	CreatedAt float64
	UpdatedAt float64
	DeletedAt float64
}

type Event struct {
	ID       string
	AreaID   string
	PersonID string
	TsMs     float64
}

type Week struct {
	ID        string
	Days      map[string][][2]string
	CreatedAt float64
	UpdatedAt float64
}

type Plan struct {
	PlanID    string
	Name      string
	UpdatedAt float64
	Areas     []Area
	People    []Person
	Events    []Event
	Weeks     []Week
}

var errBadShape = errors.New("bad wire shape")

// NormalizeName mirrors helpers.js normalizeName: strip control chars,
// collapse whitespace, trim, cap at 40 UTF-16 code units (JS slice
// semantics — exact parity matters for the user-add name match).
func NormalizeName(raw string) string {
	var b strings.Builder
	for _, r := range raw {
		if r <= 0x1f || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	s := strings.Join(strings.Fields(b.String()), " ")
	units := utf16.Encode([]rune(s))
	if len(units) > maxNameUTF16 {
		s = string(utf16.Decode(units[:maxNameUTF16]))
	}
	return s
}

var weekKeyRe = regexp.MustCompile(`^(\d{4})-W(\d{2})$`)

// ValidWeekKey checks shape only (year/week ranges) — the app additionally
// validates by round-trip; for envelope building shape is sufficient because
// the runner re-sanitizes everything through planFromWire anyway.
func ValidWeekKey(key string) bool {
	m := weekKeyRe.FindStringSubmatch(key)
	if m == nil {
		return false
	}
	var year, week int
	fmt.Sscanf(m[1], "%d", &year)
	fmt.Sscanf(m[2], "%d", &week)
	return year >= 2000 && year <= 2100 && week >= 1 && week <= 53
}

func num(raw json.RawMessage) float64 {
	var f float64
	if raw == nil || json.Unmarshal(raw, &f) != nil {
		return 0
	}
	return f
}

func str(raw json.RawMessage) (string, bool) {
	var s string
	if raw == nil || json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

func capStr(raw json.RawMessage, n int) string {
	s, _ := str(raw)
	if len(s) > n {
		return s[:n]
	}
	return s
}

// FromWire decodes and sanitizes a wire envelope — same rules as
// planFromWire (structural decode, name normalization, clamps).
func FromWire(data []byte) (*Plan, bool, error) {
	var arr []json.RawMessage
	if err := json.Unmarshal(data, &arr); err != nil {
		return nil, false, errBadShape
	}
	if len(arr) < 8 {
		return nil, false, errBadShape
	}
	if int(num(arr[0])) != Version {
		return nil, false, errors.New("unknown wire version")
	}
	planID, ok := str(arr[1])
	if !ok || planID == "" {
		return nil, false, errors.New("bad planId")
	}
	name, _ := str(arr[2])
	tBaseMin := num(arr[4])

	p := &Plan{
		PlanID:    planID,
		Name:      NormalizeName(name),
		UpdatedAt: num(arr[3]),
	}
	if p.Name == "" {
		p.Name = defaultPlanName
	}

	var areas, people, events [][]json.RawMessage
	if json.Unmarshal(arr[5], &areas) != nil || json.Unmarshal(arr[6], &people) != nil ||
		json.Unmarshal(arr[7], &events) != nil {
		return nil, false, errors.New("bad wire lists")
	}
	for _, r := range areas {
		if len(r) < 1 {
			continue
		}
		id, ok := str(r[0])
		if !ok || id == "" {
			continue
		}
		a := Area{ID: id}
		if len(r) > 1 {
			a.Name = NormalizeName(orEmpty(r, 1))
		}
		if a.Name == "" {
			a.Name = defaultAreaName
		}
		a.IntervalDays = clamp(numAt(r, 2, 7), 1, 365)
		a.CreatedAt = numAt(r, 3, 0)
		a.UpdatedAt = numAt(r, 4, 0)
		a.DeletedAt = numAt(r, 5, 0)
		p.Areas = append(p.Areas, a)
	}
	for _, r := range people {
		if len(r) < 1 {
			continue
		}
		id, ok := str(r[0])
		if !ok || id == "" {
			continue
		}
		pe := Person{ID: id, Name: NormalizeName(orEmpty(r, 1))}
		if pe.Name == "" {
			pe.Name = defaultPersonNme
		}
		pe.CreatedAt = numAt(r, 2, 0)
		pe.UpdatedAt = numAt(r, 3, 0)
		pe.DeletedAt = numAt(r, 4, 0)
		p.People = append(p.People, pe)
	}
	for _, r := range events {
		if len(r) < 1 {
			continue
		}
		id, ok := str(r[0])
		if !ok {
			continue
		}
		e := Event{ID: id}
		if len(r) > 1 {
			e.AreaID, _ = str(r[1])
		}
		if len(r) > 2 {
			e.PersonID, _ = str(r[2])
		}
		e.TsMs = (tBaseMin + numAt(r, 3, 0)) * 60000
		p.Events = append(p.Events, e)
	}

	// weeks (slot 9, absent on pre-v1.1 payloads)
	if len(arr) > 9 {
		var weeks [][]json.RawMessage
		if json.Unmarshal(arr[9], &weeks) == nil {
			for i, r := range weeks {
				if i >= maxWeeks {
					break
				}
				if len(r) < 1 {
					continue
				}
				id, ok := str(r[0])
				if !ok || !ValidWeekKey(id) {
					continue
				}
				w := Week{ID: id, Days: map[string][][2]string{}}
				if len(r) > 1 {
					decodeDays(r[1], w.Days)
				}
				w.CreatedAt = numAt(r, 2, 0)
				w.UpdatedAt = numAt(r, 3, 0)
				p.Weeks = append(p.Weeks, w)
			}
		}
	}

	viewer := false
	if len(arr) > 8 {
		viewer = int(num(arr[8]))&flagViewer != 0
	}
	return p, viewer, nil
}

func decodeDays(raw json.RawMessage, out map[string][][2]string) {
	var days map[string]json.RawMessage
	if json.Unmarshal(raw, &days) != nil {
		return
	}
	for d := 1; d <= 7; d++ {
		k := fmt.Sprintf("%d", d)
		rv, ok := days[k]
		if !ok {
			continue
		}
		var slots []json.RawMessage
		if json.Unmarshal(rv, &slots) != nil {
			continue
		}
		var clean [][2]string
		for i, s := range slots {
			if i >= maxDaySlots {
				break
			}
			var pair []json.RawMessage
			if json.Unmarshal(s, &pair) != nil {
				continue
			}
			var areaID, personID string
			if len(pair) > 0 {
				areaID = capStr(pair[0], 32)
			}
			if len(pair) > 1 {
				personID = capStr(pair[1], 32)
			}
			clean = append(clean, [2]string{areaID, personID})
		}
		if clean != nil {
			out[k] = clean
		}
	}
}

func orEmpty(r []json.RawMessage, i int) string {
	if i < len(r) {
		s, _ := str(r[i])
		return s
	}
	return ""
}

func numAt(r []json.RawMessage, i int, fallback float64) float64 {
	if i >= len(r) || r[i] == nil {
		return fallback
	}
	var f float64
	if json.Unmarshal(r[i], &f) != nil {
		return fallback
	}
	return f
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ToWire encodes the UNCAPPED envelope (all events, all weeks, viewer=0) —
// what the state file and plan-push want. Same slot layout as wireFromPlan.
func ToWire(p *Plan) ([]byte, error) {
	tBaseMin := 0.0
	if len(p.Events) > 0 {
		tBaseMin = floorMin(p.Events[0].TsMs)
		for _, e := range p.Events[1:] {
			if m := floorMin(e.TsMs); m < tBaseMin {
				tBaseMin = m
			}
		}
	}
	areas := make([][]any, 0, len(p.Areas))
	for _, a := range p.Areas {
		areas = append(areas, []any{a.ID, a.Name, a.IntervalDays, a.CreatedAt, a.UpdatedAt, a.DeletedAt})
	}
	people := make([][]any, 0, len(p.People))
	for _, pe := range p.People {
		people = append(people, []any{pe.ID, pe.Name, pe.CreatedAt, pe.UpdatedAt, pe.DeletedAt})
	}
	events := make([][]any, 0, len(p.Events))
	for _, e := range p.Events {
		events = append(events, []any{e.ID, e.AreaID, e.PersonID, floorMin(e.TsMs) - tBaseMin})
	}
	weeks := make([][]any, 0, len(p.Weeks))
	for _, w := range p.Weeks {
		weeks = append(weeks, []any{w.ID, w.Days, w.CreatedAt, w.UpdatedAt})
	}
	env := []any{Version, p.PlanID, p.Name, p.UpdatedAt, tBaseMin, areas, people, events, 0, weeks}
	return json.Marshal(env)
}

func floorMin(tsMs float64) float64 {
	m := tsMs / 60000
	f := float64(int64(m))
	if m < 0 && m != f {
		f--
	}
	return f
}
