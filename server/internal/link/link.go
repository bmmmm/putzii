// SPDX-License-Identifier: GPL-3.0-or-later

// Package link builds/parses the credential links a household hands out:
// a positional b64url-encoded JSON array in the URL FRAGMENT — no gzip, the
// content is high-entropy anyway, and a fragment never reaches a server.
//
//	#d2.  [2, planId, personId, personName, token, encKey]
//	#k2.  [2, planId, personId, personName, checkinToken, [[areaId, label], …]]
//
// What is NOT in here any more, compared with the retired GitHub-drop's
// #d1./#k1.:
//
//   - no PAT: there is no third party to authenticate against.
//   - no repo / dropBase: the app is served BY the server it talks to, so the
//     API base is `location.origin` — deriving it beats carrying it (shorter
//     links, no origin/CSP mismatch, one less thing to rotate).
//   - k2 carries a CHECK-IN SCOPED token, not the person's write token. A k2
//     holder can confirm the listed activities and nothing else; the old k1
//     embedded full write access and only documented the gap.
package link

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Version 2 = the self-hosted server format. A v1 link (GitHub drop) is
// refused with a distinct error so the app can say "old link" instead of
// "broken link" during the cutover.
const Version = 2

var ErrLegacy = errors.New("legacy GitHub-drop link (d1/k1) — issue a fresh one")

type Credentials struct {
	PlanID     string
	PersonID   string
	PersonName string
	Token      string
	EncKey     string // base64url state key
}

// Fragment renders the "#d2.<payload>" fragment (with leading '#').
func Fragment(c *Credentials) (string, error) {
	for name, v := range map[string]string{
		"planId": c.PlanID, "personId": c.PersonID, "token": c.Token, "encKey": c.EncKey,
	} {
		if v == "" {
			return "", fmt.Errorf("credential link: %s missing", name)
		}
	}
	arr := []any{Version, c.PlanID, c.PersonID, c.PersonName, c.Token, c.EncKey}
	raw, err := json.Marshal(arr)
	if err != nil {
		return "", err
	}
	return "#d2." + base64.RawURLEncoding.EncodeToString(raw), nil
}

// URL renders the full app URL for a credential link.
func URL(appBase string, c *Credentials) (string, error) {
	frag, err := Fragment(c)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(appBase, "/") + "/" + frag, nil
}

// Parse accepts a fragment with or without leading '#'/URL prefix.
func Parse(s string) (*Credentials, error) {
	body, err := fragmentBody(s, "d2.", "d1.")
	if err != nil {
		return nil, err
	}
	arr, err := decodeArray(body, 6, "d2")
	if err != nil {
		return nil, err
	}
	fields, err := strFields(arr, 1, 5, "d2")
	if err != nil {
		return nil, err
	}
	return &Credentials{
		PlanID: fields[0], PersonID: fields[1], PersonName: fields[2],
		Token: fields[3], EncKey: fields[4],
	}, nil
}

// ── #k2. confirm links ──────────────────────────────────────────────────

// MaxCheckinAreas mirrors the app's K2_MAX_AREAS in drop.js.
const MaxCheckinAreas = 12

// CheckinArea is one pre-scoped activity in a #k2. confirm link.
type CheckinArea struct {
	ID    string
	Label string
}

// CheckinCredentials is Credentials minus the encKey (no read access), with
// a check-in scoped token and the fixed activity list.
type CheckinCredentials struct {
	PlanID     string
	PersonID   string
	PersonName string
	Token      string // MUST be the check-in scoped token
	Areas      []CheckinArea
}

// CheckinFragment renders the "#k2.<payload>" fragment (with leading '#').
func CheckinFragment(c *CheckinCredentials) (string, error) {
	for name, v := range map[string]string{
		"planId": c.PlanID, "personId": c.PersonID, "token": c.Token,
	} {
		if v == "" {
			return "", fmt.Errorf("confirm link: %s missing", name)
		}
	}
	if len(c.Areas) == 0 || len(c.Areas) > MaxCheckinAreas {
		return "", fmt.Errorf("confirm link: need 1–%d areas, got %d", MaxCheckinAreas, len(c.Areas))
	}
	areas := make([][2]string, 0, len(c.Areas))
	for _, a := range c.Areas {
		if a.ID == "" {
			return "", errors.New("confirm link: empty areaId")
		}
		areas = append(areas, [2]string{a.ID, a.Label})
	}
	arr := []any{Version, c.PlanID, c.PersonID, c.PersonName, c.Token, areas}
	raw, err := json.Marshal(arr)
	if err != nil {
		return "", err
	}
	return "#k2." + base64.RawURLEncoding.EncodeToString(raw), nil
}

// CheckinURL renders the full confirm-page URL (c.html owns the k2 flow).
func CheckinURL(appBase string, c *CheckinCredentials) (string, error) {
	frag, err := CheckinFragment(c)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(appBase, "/") + "/c.html" + frag, nil
}

// ParseCheckin accepts a k2 fragment with or without leading '#'/URL prefix.
func ParseCheckin(s string) (*CheckinCredentials, error) {
	body, err := fragmentBody(s, "k2.", "k1.")
	if err != nil {
		return nil, err
	}
	arr, err := decodeArray(body, 6, "k2")
	if err != nil {
		return nil, err
	}
	fields, err := strFields(arr, 1, 4, "k2")
	if err != nil {
		return nil, err
	}
	var rawAreas [][2]string
	if json.Unmarshal(arr[5], &rawAreas) != nil || len(rawAreas) == 0 {
		return nil, errors.New("bad k2 areas")
	}
	areas := make([]CheckinArea, 0, len(rawAreas))
	for _, a := range rawAreas {
		areas = append(areas, CheckinArea{ID: a[0], Label: a[1]})
	}
	return &CheckinCredentials{
		PlanID: fields[0], PersonID: fields[1], PersonName: fields[2],
		Token: fields[3], Areas: areas,
	}, nil
}

// ── shared decoding ─────────────────────────────────────────────────────

func fragmentBody(s, prefix, legacyPrefix string) (string, error) {
	if i := strings.Index(s, "#"); i >= 0 {
		s = s[i+1:]
	}
	if strings.HasPrefix(s, legacyPrefix) {
		return "", ErrLegacy
	}
	if !strings.HasPrefix(s, prefix) {
		return "", fmt.Errorf("not a %s link", strings.TrimSuffix(prefix, "."))
	}
	return s[len(prefix):], nil
}

func decodeArray(body string, minLen int, kind string) ([]json.RawMessage, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(body, "="))
	if err != nil {
		return nil, err
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, err
	}
	if len(arr) < minLen {
		return nil, fmt.Errorf("short %s payload", kind)
	}
	var v int
	if json.Unmarshal(arr[0], &v) != nil || v != Version {
		return nil, fmt.Errorf("unknown %s version", kind)
	}
	return arr, nil
}

// strFields decodes arr[from…to] as strings (inclusive bounds).
func strFields(arr []json.RawMessage, from, to int, kind string) ([]string, error) {
	out := make([]string, 0, to-from+1)
	for i := from; i <= to; i++ {
		var s string
		if json.Unmarshal(arr[i], &s) != nil {
			return nil, fmt.Errorf("bad %s field", kind)
		}
		out = append(out, s)
	}
	return out, nil
}
