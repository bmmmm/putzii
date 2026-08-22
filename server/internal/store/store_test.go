// SPDX-License-Identifier: GPL-3.0-or-later
package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/bmmmm/putzii/server/internal/wire"
)

var t0 = time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC)

func newStore(t *testing.T) *Store {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i*13 + 7)
	}
	st, err := New(t.TempDir(), "AbC123xy", key, false)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func plan(events int) *wire.Plan {
	p := &wire.Plan{
		PlanID: "AbC123xy", Name: "Haushalt", UpdatedAt: 1755600000,
		Areas:  []wire.Area{{ID: "kche1", Name: "Küche", IntervalDays: 7}},
		People: []wire.Person{{ID: "sina7", Name: "Sina"}},
	}
	for i := 0; i < events; i++ {
		p.Events = append(p.Events, wire.Event{
			ID: wire.FormatCompactEventID("gsina7", int64(i+1)), AreaID: "kche1",
			PersonID: "sina7", TsMs: 1787047500000 + float64(i)*60000,
		})
	}
	return p
}

func put(t *testing.T, st *Store, p *wire.Plan, nonce string, at time.Time) Result {
	t.Helper()
	res, err := st.Apply(
		WriteReq{By: "sina7", Nonce: nonce, Kind: "state", Now: at},
		func(_ *wire.Plan, _ int64) (*wire.Plan, map[string]int, error) {
			return p, map[string]int{"events": len(p.Events)}, nil
		})
	if err != nil {
		t.Fatalf("apply %s: %v", nonce, err)
	}
	return res
}

func TestApplyWritesAndReloads(t *testing.T) {
	st := newStore(t)
	if p, rev, err := st.Load(); err != nil || p != nil || rev != 0 {
		t.Fatalf("empty store must load as (nil, 0, nil): %v %v %v", p, rev, err)
	}
	res := put(t, st, plan(2), "aaaa2222", t0)
	if res.Rev != 1 || !res.Changed {
		t.Fatalf("first write: %+v", res)
	}
	got, rev, err := st.Load()
	if err != nil || rev != 1 {
		t.Fatalf("reload: %v rev %d", err, rev)
	}
	if got.PlanID != "AbC123xy" || len(got.Events) != 2 || got.Areas[0].Name != "Küche" {
		t.Fatalf("reloaded plan drifted: %+v", got)
	}
	res = put(t, st, plan(3), "bbbb3333", t0.Add(time.Minute))
	if res.Rev != 2 {
		t.Fatalf("rev must increment, got %d", res.Rev)
	}
}

// Nothing readable may sit in the state file, and `rev`/`at` must stay
// plaintext so freshness never needs the key.
func TestStateFileIsEncryptedButRevIsReadable(t *testing.T) {
	st := newStore(t)
	put(t, st, plan(1), "aaaa2222", t0)
	raw, err := st.StateFile()
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	for _, secret := range []string{"Küche", "Sina", "Haushalt", "gsina7"} {
		if contains(body, secret) {
			t.Fatalf("plaintext %q leaked into the state file", secret)
		}
	}
	for _, want := range []string{`"rev":1`, `"alg":"A256GCM"`} {
		if !contains(body, want) {
			t.Fatalf("state file missing %s: %s", want, body)
		}
	}
}

// A fresh IV per write is the one crypto rule that silently breaks security
// if it regresses.
func TestFreshIVPerWrite(t *testing.T) {
	st := newStore(t)
	put(t, st, plan(1), "aaaa2222", t0)
	first, _ := st.StateFile()
	put(t, st, plan(1), "bbbb3333", t0.Add(time.Minute))
	second, _ := st.StateFile()
	if string(first) == string(second) {
		t.Fatalf("identical plaintext produced an identical state file — IV reuse")
	}
}

func TestReplayGuard(t *testing.T) {
	st := newStore(t)
	put(t, st, plan(1), "aaaa2222", t0)
	res, err := st.Apply(
		WriteReq{By: "sina7", Nonce: "aaaa2222", Kind: "state", Now: t0.Add(time.Minute)},
		func(*wire.Plan, int64) (*wire.Plan, map[string]int, error) {
			t.Fatalf("build must not run for a replayed nonce")
			return nil, nil, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Replay || res.Rev != 1 {
		t.Fatalf("replay must be a green no-op at the current rev: %+v", res)
	}
}

// The tail is capped, and a full tail whose oldest entry is younger than the
// window means someone is hammering the endpoint.
func TestRateGuard(t *testing.T) {
	st := newStore(t)
	now := t0
	for i := 0; i < TailMax; i++ {
		put(t, st, plan(1), nonce(i), now)
		now = now.Add(time.Second) // a sustained burst, far above 1/min
	}
	h, err := st.Health()
	if err != nil {
		t.Fatal(err)
	}
	if len(h.Tail) != TailMax {
		t.Fatalf("tail must cap at %d, got %d", TailMax, len(h.Tail))
	}
	_, err = st.Apply(
		WriteReq{By: "sina7", Nonce: "zzzz9999", Kind: "state", Now: now},
		func(*wire.Plan, int64) (*wire.Plan, map[string]int, error) { return plan(1), nil, nil })
	if !errors.Is(err, ErrRate) {
		t.Fatalf("rate guard did not fire: %v", err)
	}
	// A slow household with the same full tail must NOT be rate-limited.
	_, err = st.Apply(
		WriteReq{By: "sina7", Nonce: "yyyy8888", Kind: "state", Now: now.Add(2 * rateWindow)},
		func(*wire.Plan, int64) (*wire.Plan, map[string]int, error) { return plan(1), nil, nil })
	if err != nil {
		t.Fatalf("a slow writer must pass the rate guard: %v", err)
	}
}

// An idempotent no-op still records the nonce (so a retry confirms) but must
// not bump the rev or rewrite the ciphertext.
func TestNoOpRecordsNonceWithoutRevBump(t *testing.T) {
	st := newStore(t)
	put(t, st, plan(1), "aaaa2222", t0)
	before, _ := st.StateFile()
	res, err := st.Apply(
		WriteReq{By: "sina7", Nonce: "cccc4444", Kind: "checkin", Now: t0.Add(time.Minute)},
		func(*wire.Plan, int64) (*wire.Plan, map[string]int, error) {
			return nil, map[string]int{"minted": 0}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed || res.Rev != 1 {
		t.Fatalf("no-op must keep rev: %+v", res)
	}
	after, _ := st.StateFile()
	if string(before) != string(after) {
		t.Fatalf("no-op rewrote the state file")
	}
	h, _ := st.Health()
	if h.Tail[0].Nonce != "cccc4444" {
		t.Fatalf("no-op must still be auditable: %+v", h.Tail[0])
	}
}

// Caps are enforced by the store itself, not only by the caller.
func TestApplyRefusesOverCaps(t *testing.T) {
	st := newStore(t)
	_, err := st.Apply(
		WriteReq{By: "sina7", Nonce: "aaaa2222", Kind: "state", Now: t0},
		func(*wire.Plan, int64) (*wire.Plan, map[string]int, error) {
			return plan(wire.MaxEvents + 1), nil, nil
		})
	if err == nil {
		t.Fatalf("over-cap plan written")
	}
	if _, err := os.Stat(filepath.Join(st.dir, "plans", "AbC123xy.json")); err == nil {
		t.Fatalf("a refused write must leave no state file behind")
	}
}

// AAD binds the ciphertext to the planId: a state file moved between plans
// must fail to open rather than decrypt into the wrong plan.
func TestAADBindsPlanID(t *testing.T) {
	st := newStore(t)
	put(t, st, plan(1), "aaaa2222", t0)
	raw, err := st.StateFile()
	if err != nil {
		t.Fatal(err)
	}
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i*13 + 7)
	}
	other, err := New(t.TempDir(), "Zz9_-Pl0", key, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(other.dir, "plans", "Zz9_-Pl0.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := other.Load(); err == nil {
		t.Fatalf("a swapped state file decrypted under another planId")
	}
}

// A corrupt health file must not brick writes — the state file is the truth.
func TestCorruptHealthRebuilds(t *testing.T) {
	st := newStore(t)
	put(t, st, plan(1), "aaaa2222", t0)
	if err := os.WriteFile(st.healthPath(), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	res := put(t, st, plan(2), "bbbb3333", t0.Add(time.Minute))
	if res.Rev != 2 {
		t.Fatalf("write after corrupt health: %+v", res)
	}
}

func nonce(i int) string {
	const alpha = "abcdefghijkmnpqrstuvwxyz23456789"
	out := []byte("nnnn0000")
	for p := 4; p < 8; p++ {
		out[p] = alpha[(i+p)%32]
		i /= 32
	}
	return string(out)
}

func contains(hay, needle string) bool {
	return len(needle) > 0 && len(hay) >= len(needle) && indexOf(hay, needle) >= 0
}

func indexOf(hay, needle string) int {
	for i := 0; i+len(needle) <= len(hay); i++ {
		if hay[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
