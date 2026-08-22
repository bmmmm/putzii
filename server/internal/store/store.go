// SPDX-License-Identifier: GPL-3.0-or-later

// Package store owns the encrypted plan state and the plaintext audit tail.
//
// On-disk layout is deliberately IDENTICAL to the retired putzii-drop's
// published site, so a migration is a plain file copy:
//
//	<data>/plans/<planId>.json   AES-256-GCM state, fresh 12-byte IV per
//	                             write, AAD = planId+"|1"; `rev`/`at` stay
//	                             plaintext so freshness needs no decrypt
//	<data>/health.json           PLAINTEXT {rev, at, tail:[…50]}
//
// Plaintext inside the state file is gzip(UNCAPPED wire envelope) and always
// comes back out through wire.FromWire — the same sanitizer a hostile link
// meets. Everything logged is COUNTS ONLY: no names, no payloads.
//
// One process, one writer: every mutation runs under a single lock, which is
// why no push-race handling from the GitHub-Actions era survives here.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/bmmmm/putzii/server/internal/dropcrypto"
	"github.com/bmmmm/putzii/server/internal/wire"
)

// TailMax bounds the audit tail. The rate guard is expressed in terms of it:
// ">60 pushes/h" is measured as "tail full AND its oldest entry younger than
// TailMax minutes" (a sustained >1 push/min). A household never gets near
// this; a leaked token does.
const TailMax = 50

const rateWindow = TailMax * time.Minute

var (
	// ErrConflict: the caller wrote against a rev that is no longer current.
	// The fix belongs on the client — pull, merge locally, push again.
	ErrConflict = errors.New("rev conflict")
	// ErrRate: sustained write rate above the guard. Fatal, never retried.
	ErrRate = errors.New("rate guard")
	// ErrUnknownSlots: state or payload carries envelope slots this build
	// does not know. Never strip them — fail loud and update the binary.
	ErrUnknownSlots = errors.New("unknown wire slots")
)

// TailEntry is one audit record. Counts only — never a name, never a payload.
type TailEntry struct {
	At     string         `json:"at"`
	By     string         `json:"by"`
	Nonce  string         `json:"nonce"`
	Kind   string         `json:"kind"`
	Rev    int64          `json:"rev"`
	Counts map[string]int `json:"counts"`
}

// Health is the plaintext freshness + audit document.
type Health struct {
	Rev  int64       `json:"rev"`
	At   string      `json:"at"`
	Tail []TailEntry `json:"tail"`
}

// WriteReq is the audit-side of a mutation: who, which nonce, what kind.
type WriteReq struct {
	By    string
	Nonce string
	Kind  string // "state" | "checkin" | "seed"
	Now   time.Time
}

// Result reports what a mutation did.
type Result struct {
	Rev     int64
	At      string
	Replay  bool // nonce already applied — green no-op, nothing written
	Changed bool // false = idempotent no-op (rev unchanged)
	Counts  map[string]int
}

type Store struct {
	dir      string
	planID   string
	key      []byte
	gitAudit bool
	mu       sync.Mutex
}

func New(dir, planID string, key []byte, gitAudit bool) (*Store, error) {
	if len(key) != 32 {
		return nil, errors.New("state key must be 32 bytes")
	}
	if planID == "" {
		return nil, errors.New("empty planId")
	}
	if err := os.MkdirAll(filepath.Join(dir, "plans"), 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir, planID: planID, key: key, gitAudit: gitAudit}, nil
}

func (s *Store) PlanID() string { return s.planID }

func (s *Store) statePath() string {
	return filepath.Join(s.dir, "plans", s.planID+".json")
}

func (s *Store) healthPath() string {
	return filepath.Join(s.dir, "health.json")
}

// StateFile returns the raw ciphertext document as it sits on disk — what
// GET /api/state hands to the client, which decrypts it itself.
func (s *Store) StateFile() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return os.ReadFile(s.statePath())
}

// Health returns the audit document (empty, not an error, when absent).
func (s *Store) Health() (*Health, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readHealth()
}

func (s *Store) readHealth() (*Health, error) {
	h := &Health{Tail: []TailEntry{}}
	raw, err := os.ReadFile(s.healthPath())
	if errors.Is(err, os.ErrNotExist) {
		return h, nil
	}
	if err != nil {
		return nil, err
	}
	// A corrupt health file must not brick writes: the state file is the
	// truth, the tail is rebuilt from scratch.
	if json.Unmarshal(raw, h) != nil || h.Tail == nil {
		return &Health{Tail: []TailEntry{}}, nil
	}
	return h, nil
}

// Load decrypts and sanitizes the current plan. Returns (nil, 0, nil) when
// no state exists yet — the first write creates it.
func (s *Store) Load() (*wire.Plan, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *Store) loadLocked() (*wire.Plan, int64, error) {
	raw, err := os.ReadFile(s.statePath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	rev, _, iv, ct, err := dropcrypto.ParseStateFile(raw)
	if err != nil {
		return nil, 0, err
	}
	// AAD binds ciphertext to planId — a swapped file fails right here.
	plainGz, err := dropcrypto.Decrypt(s.key, s.planID, iv, ct)
	if err != nil {
		return nil, 0, fmt.Errorf("decrypt state: %w", err)
	}
	plain, err := dropcrypto.Gunzip(plainGz)
	if err != nil {
		return nil, 0, err
	}
	// State written by a NEWER build, then the binary rolled back: refuse.
	if wire.SlotCount(plain) > wire.KnownSlots() {
		return nil, 0, ErrUnknownSlots
	}
	plan, _, err := wire.FromWire(plain)
	if err != nil {
		return nil, 0, err
	}
	return plan, rev, nil
}

// Apply is the ONE mutation path. Order is the security design:
//
//	(1) replay guard — nonce already in the tail → green no-op, no write
//	(2) rate guard   — sustained flood → fatal
//	(3) load + decrypt current state
//	(4) build the next plan (caller's rev check / mint / sanitize lives here)
//	(5) caps gate, re-encrypt with a FRESH IV, rev+1
//	(6) atomic write of state + health, best-effort git audit commit
//
// build returns (nil, counts, nil) for an idempotent no-op: the tail still
// records the nonce, the state file is left untouched.
func (s *Store) Apply(req WriteReq, build func(cur *wire.Plan, curRev int64) (*wire.Plan, map[string]int, error)) (Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	health, err := s.readHealth()
	if err != nil {
		return Result{}, err
	}
	for _, t := range health.Tail {
		if t.Nonce == req.Nonce {
			return Result{Rev: health.Rev, At: health.At, Replay: true}, nil
		}
	}
	if len(health.Tail) >= TailMax {
		oldest, perr := time.Parse(time.RFC3339Nano, health.Tail[len(health.Tail)-1].At)
		if perr == nil && req.Now.Sub(oldest) < rateWindow {
			return Result{}, ErrRate
		}
	}

	cur, curRev, err := s.loadLocked()
	if err != nil {
		return Result{}, err
	}
	next, counts, err := build(cur, curRev)
	if err != nil {
		return Result{}, err
	}
	if counts == nil {
		counts = map[string]int{}
	}
	atISO := req.Now.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	rev := curRev
	var stateText []byte
	if next != nil {
		if err := next.CheckCaps(); err != nil {
			return Result{}, err
		}
		raw, err := wire.ToWire(next)
		if err != nil {
			return Result{}, err
		}
		gz, err := dropcrypto.Gzip(raw)
		if err != nil {
			return Result{}, err
		}
		iv, ct, err := dropcrypto.Encrypt(s.key, s.planID, gz)
		if err != nil {
			return Result{}, err
		}
		rev = curRev + 1
		stateText, err = dropcrypto.SerializeStateFile(rev, atISO, iv, ct)
		if err != nil {
			return Result{}, err
		}
	}

	entry := TailEntry{At: atISO, By: req.By, Nonce: req.Nonce, Kind: req.Kind, Rev: rev, Counts: counts}
	health.Rev = rev
	health.At = atISO
	health.Tail = append([]TailEntry{entry}, health.Tail...)
	if len(health.Tail) > TailMax {
		health.Tail = health.Tail[:TailMax]
	}
	healthText, err := json.MarshalIndent(health, "", " ")
	if err != nil {
		return Result{}, err
	}

	if stateText != nil {
		if err := writeAtomic(s.statePath(), stateText, 0o600); err != nil {
			return Result{}, err
		}
	}
	if err := writeAtomic(s.healthPath(), healthText, 0o600); err != nil {
		return Result{}, err
	}
	s.gitCommit(req, rev)

	return Result{Rev: rev, At: atISO, Changed: stateText != nil, Counts: counts}, nil
}

// writeAtomic: temp file in the SAME directory, fsync, rename. A torn write
// can then never be observed by a reader — it sees old or new, never half.
func writeAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// gitCommit gives the data directory a free audit history when it happens to
// be a git repo. Best effort by design: a failing commit must never cost a
// user their check-in, so it is logged nowhere and never returned.
func (s *Store) gitCommit(req WriteReq, rev int64) {
	if !s.gitAudit {
		return
	}
	if _, err := os.Stat(filepath.Join(s.dir, ".git")); err != nil {
		return
	}
	msg := fmt.Sprintf("%s rev %d by %s", req.Kind, rev, req.By)
	_ = exec.Command("git", "-C", s.dir, "add", "-A").Run()
	_ = exec.Command("git", "-C", s.dir, "commit", "-q", "-m", msg).Run()
}

// SortedTail returns the tail newest-first (it is stored that way; this is
// the belt-and-braces for a hand-edited file).
func SortedTail(t []TailEntry) []TailEntry {
	out := append([]TailEntry(nil), t...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out
}
