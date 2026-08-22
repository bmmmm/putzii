// SPDX-License-Identifier: GPL-3.0-or-later

// Package config reads/writes putzii-server.conf — a commented flat
// key=value file. The real file holds the state encryption key and the user
// tokens: it is written 0600, lives in .gitignore, and only the blank
// template is tracked.
//
// Tokens are stored in the CLEAR here on purpose. The same file already
// holds the AES key, so hashing them would not raise the bar for anyone who
// can read it — and keeping the plaintext is what lets `putzii-server link`
// re-render a person's access link later instead of forcing a rotation.
// Authentication itself never compares plaintext: Authenticate hashes what
// the caller presented and compares HASHES in constant time.
package config

import (
	"bufio"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const FileName = "putzii-server.conf"

// Token scopes. A checkin token may ONLY mint check-ins: it can never read
// state and never overwrite a plan. That closes the gap the old #k1. confirm
// links had, where the link carried the holder's FULL write token.
const (
	ScopeWrite   = "write"
	ScopeCheckin = "checkin"
)

type User struct {
	ID           string
	Name         string
	Token        string // full write access (#d2. link)
	CheckinToken string // check-in only (#k2. confirm link)
}

type Config struct {
	PlanID   string // the ONE plan this server hosts
	EncKey   string // base64url, 32 bytes
	AppBase  string // public base URL — used to RENDER links, never to call
	DataDir  string // state + health live here
	Listen   string // ":8080"
	GitAudit bool   // commit every state write into data/.git when it exists
	Users    map[string]*User
	Path     string // where this config was loaded from
}

func New() *Config {
	return &Config{Users: map[string]*User{}, DataDir: "data", Listen: ":8080"}
}

// DefaultPath: ./putzii-server.conf (convention: config next to the data).
func DefaultPath() string {
	return FileName
}

func Load(path string) (*Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if fi, err := f.Stat(); err == nil && fi.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s is group/world readable (%o) — chmod 600 it", path, fi.Mode().Perm())
	}
	cfg := New()
	cfg.Path = path
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("bad config line: %q", line)
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		switch {
		case key == "plan_id":
			cfg.PlanID = val
		case key == "enc_key":
			cfg.EncKey = val
		case key == "app_base":
			cfg.AppBase = strings.TrimRight(val, "/")
		case key == "data_dir":
			cfg.DataDir = val
		case key == "listen":
			cfg.Listen = val
		case key == "git_audit":
			cfg.GitAudit = val == "true" || val == "1" || val == "yes"
		case strings.HasPrefix(key, "user."):
			parts := strings.SplitN(key, ".", 3)
			if len(parts) != 3 {
				return nil, fmt.Errorf("bad user key: %q", key)
			}
			id, field := parts[1], parts[2]
			u := cfg.Users[id]
			if u == nil {
				u = &User{ID: id}
				cfg.Users[id] = u
			}
			switch field {
			case "name":
				u.Name = val
			case "token":
				u.Token = val
			case "checkin_token":
				u.CheckinToken = val
			default:
				return nil, fmt.Errorf("unknown user field: %q", key)
			}
		default:
			return nil, fmt.Errorf("unknown config key: %q", key)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return cfg, cfg.Validate()
}

// Validate catches the misconfigurations that would otherwise surface as a
// confusing 401 or a silent no-op at request time.
func (c *Config) Validate() error {
	if c.PlanID == "" {
		return errors.New("plan_id is empty — run `putzii-server plan init`")
	}
	if c.EncKey == "" {
		return errors.New("enc_key is empty — run `putzii-server plan init`")
	}
	if c.DataDir == "" {
		return errors.New("data_dir is empty")
	}
	for id, u := range c.Users {
		if u.Token != "" && u.Token == u.CheckinToken {
			return fmt.Errorf("user %s: write and checkin token are identical — that defeats the scope", id)
		}
	}
	return nil
}

// Authenticate identifies the caller BY the token they present: the token
// is the credential, so nothing else has to travel with it and there is no
// person id to enumerate. The presented token is hashed once and compared
// against every configured hash in constant time — every candidate is
// visited, so neither a wrong token nor an unknown person short-circuits.
//
// Returns the person the token belongs to and the scope it carries.
func (c *Config) Authenticate(token string) (personID, scope string, ok bool) {
	presented := sha256.Sum256([]byte(token))
	if len(token) < 8 || len(token) > 128 {
		return "", "", false
	}
	for id, u := range c.Users {
		if u.Token != "" {
			h := sha256.Sum256([]byte(u.Token))
			if subtle.ConstantTimeCompare(presented[:], h[:]) == 1 {
				personID, scope, ok = id, ScopeWrite, true
			}
		}
		if u.CheckinToken != "" {
			h := sha256.Sum256([]byte(u.CheckinToken))
			if subtle.ConstantTimeCompare(presented[:], h[:]) == 1 {
				personID, scope, ok = id, ScopeCheckin, true
			}
		}
	}
	return personID, scope, ok
}

// Save writes the config 0600, atomically (temp file + rename).
func (c *Config) Save(path string) error {
	if path == "" {
		return errors.New("no config path")
	}
	var b strings.Builder
	b.WriteString("# putzii-server.conf — HOLDS SECRETS (state key, user tokens).\n")
	b.WriteString("# Keep chmod 600. Never commit; this file is gitignored.\n\n")
	fmt.Fprintf(&b, "plan_id = %s\n", c.PlanID)
	fmt.Fprintf(&b, "enc_key = %s\n", c.EncKey)
	fmt.Fprintf(&b, "app_base = %s\n", c.AppBase)
	fmt.Fprintf(&b, "data_dir = %s\n", c.DataDir)
	fmt.Fprintf(&b, "listen = %s\n", c.Listen)
	fmt.Fprintf(&b, "git_audit = %t\n", c.GitAudit)
	ids := make([]string, 0, len(c.Users))
	for id := range c.Users {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		u := c.Users[id]
		b.WriteString("\n")
		fmt.Fprintf(&b, "user.%s.name = %s\n", id, u.Name)
		fmt.Fprintf(&b, "user.%s.token = %s\n", id, u.Token)
		fmt.Fprintf(&b, "user.%s.checkin_token = %s\n", id, u.CheckinToken)
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".putzii-conf-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(b.String()); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// Template is the tracked blank example (putzii-server.conf.example).
func Template() string {
	return `# putzii-server.conf — configuration for the putzii server.
# COPY to putzii-server.conf, chmod 600. The real file HOLDS SECRETS
# (state key, user tokens) and must never be committed.

# The ONE plan this server hosts (8 base64url chars, from the app's share
# link / export). 'putzii-server plan init' fills this in.
plan_id =

# AES-256 state key, base64url (43 chars). 'putzii-server plan init'
# generates this.
enc_key =

# Public base URL of the app THIS server serves — used only to RENDER
# links, never to make requests (no trailing slash).
app_base = https://putzii.example.de

# Where state + health live (relative paths resolve next to this file).
data_dir = data

# Listen address. Behind Traefik this stays container-internal.
listen = :8080

# Commit every state write into data/.git when that repo exists — free
# audit history. Never fatal: a failing commit only logs.
git_audit = false

# Users ('putzii-server user add' manages these):
# user.<personId>.name          = <display name>
# user.<personId>.token         = <write token — travels in the #d2. link>
# user.<personId>.checkin_token = <check-in only — travels in #k2./buttons>
`
}
