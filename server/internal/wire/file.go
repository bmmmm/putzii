// SPDX-License-Identifier: GPL-3.0-or-later
package wire

import (
	"encoding/json"
	"errors"
)

// The app's file export format (share.js serializeFile/parseFile):
// {format:"putzii-plan", v:1, plan:{…object form…}}.

const fileFormat = "putzii-plan"

type filePlan struct {
	PlanID    string       `json:"planId"`
	Name      string       `json:"name"`
	UpdatedAt float64      `json:"updatedAt"`
	Areas     []fileArea   `json:"areas"`
	People    []filePerson `json:"people"`
	Events    []fileEvent  `json:"events"`
	Weeks     []fileWeek   `json:"weeks"`
	V         int          `json:"v"`
	Seq       struct{}     `json:"seq"`
}

type fileArea struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	IntervalDays float64 `json:"intervalDays"`
	CreatedAt    float64 `json:"createdAt"`
	UpdatedAt    float64 `json:"updatedAt"`
	DeletedAt    float64 `json:"deletedAt"`
}

type filePerson struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	CreatedAt float64 `json:"createdAt"`
	UpdatedAt float64 `json:"updatedAt"`
	DeletedAt float64 `json:"deletedAt"`
}

type fileEvent struct {
	ID       string  `json:"id"`
	AreaID   string  `json:"areaId"`
	PersonID string  `json:"personId"`
	Ts       float64 `json:"ts"`
}

type fileWeek struct {
	ID        string                 `json:"id"`
	Days      map[string][][2]string `json:"days"`
	CreatedAt float64                `json:"createdAt"`
	UpdatedAt float64                `json:"updatedAt"`
}

type fileEnvelope struct {
	Format string          `json:"format"`
	V      int             `json:"v"`
	Plan   json.RawMessage `json:"plan"`
}

// ParseFile reads an app export. Sanitizing happens the same way the app
// does it: by round-tripping the plan through the wire codec.
func ParseFile(data []byte) (*Plan, error) {
	var env fileEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, err
	}
	if env.Format != fileFormat || len(env.Plan) == 0 {
		return nil, errors.New("not a putzii-plan file")
	}
	var fp filePlan
	if err := json.Unmarshal(env.Plan, &fp); err != nil {
		return nil, err
	}
	if fp.PlanID == "" {
		return nil, errors.New("missing planId")
	}
	p := &Plan{PlanID: fp.PlanID, Name: fp.Name, UpdatedAt: fp.UpdatedAt}
	for _, a := range fp.Areas {
		if a.ID == "" {
			continue
		}
		p.Areas = append(p.Areas, Area(a))
	}
	for _, pe := range fp.People {
		if pe.ID == "" {
			continue
		}
		p.People = append(p.People, Person(pe))
	}
	for _, e := range fp.Events {
		if e.ID == "" {
			continue
		}
		p.Events = append(p.Events, Event{ID: e.ID, AreaID: e.AreaID, PersonID: e.PersonID, TsMs: e.Ts})
	}
	for _, w := range fp.Weeks {
		if !ValidWeekKey(w.ID) {
			continue
		}
		if w.Days == nil {
			w.Days = map[string][][2]string{}
		}
		p.Weeks = append(p.Weeks, Week(w))
	}
	// round-trip through the wire codec = the shared sanitizer
	raw, err := ToWire(p)
	if err != nil {
		return nil, err
	}
	clean, _, err := FromWire(raw)
	return clean, err
}

// SerializeFile writes an app-compatible export.
func SerializeFile(p *Plan) ([]byte, error) {
	fp := filePlan{
		V:         1,
		PlanID:    p.PlanID,
		Name:      p.Name,
		UpdatedAt: p.UpdatedAt,
		Areas:     []fileArea{},
		People:    []filePerson{},
		Events:    []fileEvent{},
		Weeks:     []fileWeek{},
	}
	for _, a := range p.Areas {
		fp.Areas = append(fp.Areas, fileArea(a))
	}
	for _, pe := range p.People {
		fp.People = append(fp.People, filePerson(pe))
	}
	for _, e := range p.Events {
		fp.Events = append(fp.Events, fileEvent{ID: e.ID, AreaID: e.AreaID, PersonID: e.PersonID, Ts: e.TsMs})
	}
	for _, w := range p.Weeks {
		fp.Weeks = append(fp.Weeks, fileWeek(w))
	}
	planRaw, err := json.Marshal(fp)
	if err != nil {
		return nil, err
	}
	return json.Marshal(fileEnvelope{Format: fileFormat, V: 1, Plan: planRaw})
}
