// SPDX-License-Identifier: GPL-3.0-or-later
package config

import (
	"os"
	"path/filepath"
	"testing"
)

func writeConf(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), FileName)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

const minimal = `
plan_id = AbC123xy
enc_key = ` + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" + `
app_base = https://putzii.example.de
data_dir = data
listen = :8080

user.sina7.name = Sina
user.sina7.token = writetokenwritetokenab
user.sina7.checkin_token = checkintokencheckintoke
`

func TestLoadRoundtrip(t *testing.T) {
	cfg, err := Load(writeConf(t, minimal))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PlanID != "AbC123xy" || cfg.AppBase != "https://putzii.example.de" {
		t.Fatalf("bad load: %+v", cfg)
	}
	u := cfg.Users["sina7"]
	if u == nil || u.Name != "Sina" || u.Token == "" || u.CheckinToken == "" {
		t.Fatalf("user not parsed: %+v", u)
	}
	// save → load must be a fixpoint
	out := filepath.Join(t.TempDir(), FileName)
	if err := cfg.Save(out); err != nil {
		t.Fatal(err)
	}
	back, err := Load(out)
	if err != nil {
		t.Fatal(err)
	}
	if back.PlanID != cfg.PlanID || back.Users["sina7"].CheckinToken != u.CheckinToken {
		t.Fatalf("roundtrip drift")
	}
}

// The config holds the state key: a group/world-readable file is a finding,
// not a warning.
func TestLoadRefusesLoosePermissions(t *testing.T) {
	path := writeConf(t, minimal)
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatalf("0644 config accepted")
	}
}

func TestLoadRejectsUnknownKeys(t *testing.T) {
	if _, err := Load(writeConf(t, minimal+"\npat = github_pat_leftover\n")); err == nil {
		t.Fatalf("unknown key accepted — a stale GitHub-drop config must fail loudly")
	}
	if _, err := Load(writeConf(t, minimal+"\nuser.sina7.secret = x\n")); err == nil {
		t.Fatalf("unknown user field accepted")
	}
}

func TestValidateCatchesFootguns(t *testing.T) {
	same := `
plan_id = AbC123xy
enc_key = k
user.sina7.name = Sina
user.sina7.token = sametokensametokensame
user.sina7.checkin_token = sametokensametokensame
`
	if _, err := Load(writeConf(t, same)); err == nil {
		t.Fatalf("identical write/checkin token accepted — that defeats the scope")
	}
	if _, err := Load(writeConf(t, "enc_key = k\n")); err == nil {
		t.Fatalf("missing plan_id accepted")
	}
}

func TestAuthenticateScopes(t *testing.T) {
	cfg, err := Load(writeConf(t, minimal))
	if err != nil {
		t.Fatal(err)
	}
	id, scope, ok := cfg.Authenticate("writetokenwritetokenab")
	if !ok || id != "sina7" || scope != ScopeWrite {
		t.Fatalf("write token: %q %q %v", id, scope, ok)
	}
	id, scope, ok = cfg.Authenticate("checkintokencheckintoke")
	if !ok || id != "sina7" || scope != ScopeCheckin {
		t.Fatalf("checkin token: %q %q %v", id, scope, ok)
	}
	for _, bad := range []string{"", "short", "wrongtokenwrongtokenwr", "writetokenwritetokena"} {
		if _, _, ok := cfg.Authenticate(bad); ok {
			t.Fatalf("token %q accepted", bad)
		}
	}
}

// A revoked user has empty token fields. An empty presentation must never
// match them — that would turn revocation into open access.
func TestAuthenticateRevokedUser(t *testing.T) {
	cfg, err := Load(writeConf(t, "plan_id = p\nenc_key = k\nuser.gone1.name = Gone\nuser.gone1.token = \nuser.gone1.checkin_token = \n"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, ok := cfg.Authenticate(""); ok {
		t.Fatalf("empty token authenticated against a revoked user")
	}
	if _, _, ok := cfg.Authenticate("anythingatall12345"); ok {
		t.Fatalf("revoked user authenticated")
	}
}
