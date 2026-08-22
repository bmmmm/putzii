// SPDX-License-Identifier: GPL-3.0-or-later
package link

import (
	"errors"
	"strings"
	"testing"
)

func creds() *Credentials {
	return &Credentials{
		PlanID: "AbC123xy", PersonID: "sina7", PersonName: "Sina M.",
		Token: "writetokenwritetokenab", EncKey: strings.Repeat("A", 43),
	}
}

func TestCredentialRoundtrip(t *testing.T) {
	url, err := URL("https://putzii.example.de/", creds())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "https://putzii.example.de/#d2.") {
		t.Fatalf("unexpected URL: %s", url)
	}
	back, err := Parse(url)
	if err != nil {
		t.Fatal(err)
	}
	if *back != *creds() {
		t.Fatalf("roundtrip drift: %+v", back)
	}
	// bare fragment, with and without '#'
	frag, _ := Fragment(creds())
	if _, err := Parse(frag); err != nil {
		t.Fatalf("leading '#' must be optional: %v", err)
	}
	if _, err := Parse(strings.TrimPrefix(frag, "#")); err != nil {
		t.Fatalf("bare fragment: %v", err)
	}
}

// The whole point of v2: no PAT, no repo, no drop base. A link must stay
// short enough to be a printable QR and carry no third-party credential.
func TestCredentialLinkCarriesNoThirdPartySecret(t *testing.T) {
	url, err := URL("https://putzii.example.de", creds())
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"github", "api.github.com", "github_pat_"} {
		if strings.Contains(strings.ToLower(url), forbidden) {
			t.Fatalf("link still mentions %q: %s", forbidden, url)
		}
	}
}

func TestCredentialRejectsJunk(t *testing.T) {
	for _, bad := range []string{"#d2.!!!", "d2.", "#p1.abc", "#k2.abc", "nonsense"} {
		if _, err := Parse(bad); err == nil {
			t.Fatalf("Parse(%q) accepted", bad)
		}
	}
	// A v1 link must fail with a DISTINCT error so the UI can say "old link".
	if _, err := Parse("#d1.eyJ4IjoxfQ"); !errors.Is(err, ErrLegacy) {
		t.Fatalf("legacy d1 must map to ErrLegacy, got %v", err)
	}
	if _, err := ParseCheckin("#k1.eyJ4IjoxfQ"); !errors.Is(err, ErrLegacy) {
		t.Fatalf("legacy k1 must map to ErrLegacy, got %v", err)
	}
	// every field is mandatory
	c := creds()
	c.EncKey = ""
	if _, err := Fragment(c); err == nil {
		t.Fatalf("missing encKey accepted")
	}
}

func checkinCreds(n int) *CheckinCredentials {
	c := &CheckinCredentials{
		PlanID: "AbC123xy", PersonID: "sina7", PersonName: "Sina",
		Token: "checkintokencheckintoke",
	}
	for i := 0; i < n; i++ {
		c.Areas = append(c.Areas, CheckinArea{ID: "kche1", Label: "Küche"})
	}
	return c
}

func TestCheckinRoundtrip(t *testing.T) {
	c := checkinCreds(2)
	c.Areas[1] = CheckinArea{ID: "bad22", Label: ""}
	url, err := CheckinURL("https://putzii.example.de", c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(url, "/c.html#k2.") {
		t.Fatalf("confirm link must target c.html: %s", url)
	}
	back, err := ParseCheckin(url)
	if err != nil {
		t.Fatal(err)
	}
	if back.Token != c.Token || len(back.Areas) != 2 || back.Areas[0].Label != "Küche" {
		t.Fatalf("roundtrip drift: %+v", back)
	}
}

// A confirm link must NOT be able to carry read access. There is simply no
// slot for the key — this test pins that the shape stays that way.
func TestCheckinLinkHasNoEncKey(t *testing.T) {
	frag, err := CheckinFragment(checkinCreds(1))
	if err != nil {
		t.Fatal(err)
	}
	key := strings.Repeat("A", 43)
	if strings.Contains(frag, key[:20]) {
		t.Fatalf("a key leaked into the confirm link")
	}
	if _, err := ParseCheckin(frag); err != nil {
		t.Fatal(err)
	}
}

func TestCheckinAreaBounds(t *testing.T) {
	if _, err := CheckinFragment(checkinCreds(0)); err == nil {
		t.Fatalf("zero areas accepted")
	}
	if _, err := CheckinFragment(checkinCreds(MaxCheckinAreas)); err != nil {
		t.Fatalf("exactly MaxCheckinAreas must be allowed: %v", err)
	}
	if _, err := CheckinFragment(checkinCreds(MaxCheckinAreas + 1)); err == nil {
		t.Fatalf("too many areas accepted")
	}
	c := checkinCreds(1)
	c.Areas[0].ID = ""
	if _, err := CheckinFragment(c); err == nil {
		t.Fatalf("empty areaId accepted")
	}
}
