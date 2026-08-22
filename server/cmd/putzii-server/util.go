// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"crypto/rand"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/bmmmm/putzii/server/internal/config"
	"github.com/bmmmm/putzii/server/internal/link"
	"github.com/bmmmm/putzii/server/internal/wire"
)

// idAlphabet mirrors helpers.js ID_ALPHABET: 32 symbols without l/o/0/1, so
// `byte & 31` maps a random byte uniformly — no modulo bias, no reject loop.
const idAlphabet = "abcdefghijkmnpqrstuvwxyz23456789"

func randomID(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	out := make([]byte, n)
	for i, b := range buf {
		out[i] = idAlphabet[b&31]
	}
	return string(out)
}

// randomPlanID: 6 random bytes → exactly 8 base64url chars, like the app's
// helpers.randomPlanId (48 bits, not enumerable).
func randomPlanID() string {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	var sb strings.Builder
	for i := 0; i < 6; i += 3 {
		v := uint32(buf[i])<<16 | uint32(buf[i+1])<<8 | uint32(buf[i+2])
		sb.WriteByte(b64[(v>>18)&63])
		sb.WriteByte(b64[(v>>12)&63])
		sb.WriteByte(b64[(v>>6)&63])
		sb.WriteByte(b64[v&63])
	}
	return sb.String()
}

// dataDir resolves a relative data_dir NEXT TO the config file, so running
// the CLI from another directory still finds the same state.
func dataDir(cfg *config.Config) string {
	if filepath.IsAbs(cfg.DataDir) || cfg.Path == "" {
		return cfg.DataDir
	}
	return filepath.Join(filepath.Dir(cfg.Path), cfg.DataDir)
}

func sortedUserIDs(cfg *config.Config) []string {
	ids := make([]string, 0, len(cfg.Users))
	for id := range cfg.Users {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// pickUser resolves --user, defaulting to the only configured user when
// there is exactly one (the common household case).
func pickUser(cfg *config.Config, userID string) (*config.User, error) {
	if userID != "" {
		u := cfg.Users[userID]
		if u == nil {
			return nil, fmt.Errorf("unknown user %q — `putzii-server user list`", userID)
		}
		return u, nil
	}
	ids := sortedUserIDs(cfg)
	if len(ids) == 1 {
		return cfg.Users[ids[0]], nil
	}
	return nil, fmt.Errorf("--user <personId> required (%d configured) — `putzii-server user list`", len(ids))
}

// resolveAreas matches each token against live areas by id first, then by
// normalized name — the caller thinks in names, links carry ids. The same
// area named twice (once by id, once by name) collapses into one button:
// `--areas "Küche,kche1"` must not print the same activity twice.
func resolveAreas(plan *wire.Plan, tokens []string) ([]link.CheckinArea, error) {
	var out []link.CheckinArea
	seen := map[string]bool{}
	for _, tok := range tokens {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		var found *wire.Area
		for i := range plan.Areas {
			a := &plan.Areas[i]
			if a.DeletedAt != 0 {
				continue
			}
			if a.ID == tok || strings.EqualFold(wire.NormalizeName(a.Name), wire.NormalizeName(tok)) {
				found = a
				break
			}
		}
		if found == nil {
			var live []string
			for _, a := range plan.Areas {
				if a.DeletedAt == 0 {
					live = append(live, fmt.Sprintf("%s (%s)", a.Name, a.ID))
				}
			}
			return nil, fmt.Errorf("area %q not found — live areas: %s", tok, strings.Join(live, ", "))
		}
		if seen[found.ID] {
			continue
		}
		seen[found.ID] = true
		out = append(out, link.CheckinArea{ID: found.ID, Label: found.Name})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no areas resolved")
	}
	return out, nil
}
