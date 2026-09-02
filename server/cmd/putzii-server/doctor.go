// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/bmmmm/putzii/server/internal/config"
	"github.com/bmmmm/putzii/server/internal/dropcrypto"
	"github.com/bmmmm/putzii/server/internal/wire"
)

// cmdDoctor checks the things that silently misbehave rather than crash:
// file permissions, a key that cannot open the state, tokens that would
// never authenticate, and an app directory the server cannot serve.
func cmdDoctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	appDir := fs.String("app", "..", "directory holding the PWA")
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)

	var fails, warns int
	check := func(ok bool, label, hint string) {
		switch {
		case ok:
			fmt.Printf("  ok    %s\n", label)
		default:
			fails++
			fmt.Printf("  FAIL  %s — %s\n", label, hint)
		}
	}
	warn := func(ok bool, label, hint string) {
		if ok {
			fmt.Printf("  ok    %s\n", label)
			return
		}
		warns++
		fmt.Printf("  warn  %s — %s\n", label, hint)
	}

	fmt.Println("config:")
	fi, err := os.Stat(*confPath)
	check(err == nil, "config file exists", "run `putzii-server plan init`")
	if err != nil {
		return fmt.Errorf("%d check(s) failed", fails)
	}
	check(fi.Mode().Perm()&0o077 == 0, "config is 0600", fmt.Sprintf("chmod 600 %s", *confPath))

	c, err := loadCtx(*confPath)
	if err != nil {
		fmt.Printf("  FAIL  config loads — %v\n", err)
		return fmt.Errorf("1 check failed")
	}
	fmt.Printf("  ok    config loads (plan %s, %d users)\n", c.cfg.PlanID, len(c.cfg.Users))
	check(strings.HasPrefix(c.cfg.AppBase, "https://") || strings.HasPrefix(c.cfg.AppBase, "http://localhost"),
		"app_base is an absolute URL", "links would be unusable — set app_base")
	warn(strings.HasPrefix(c.cfg.AppBase, "https://"), "app_base is https",
		"tokens travel in these links; plain http is only acceptable for local dev")

	key, kerr := dropcrypto.B64urlDecode(c.cfg.EncKey)
	check(kerr == nil && len(key) == 32, "enc_key is 32 bytes", "regenerate via a fresh `plan init` (this orphans existing state)")

	fmt.Println("\nusers:")
	if len(c.cfg.Users) == 0 {
		warns++
		fmt.Println("  warn  no users — nobody can sync; `putzii-server user add --name <name>`")
	}
	for _, id := range sortedUserIDs(c.cfg) {
		u := c.cfg.Users[id]
		switch {
		case u.Token == "" && u.CheckinToken == "":
			fmt.Printf("  ok    %s (%s) revoked\n", id, u.Name)
		case len(u.Token) > 0 && len(u.Token) < 16:
			fails++
			fmt.Printf("  FAIL  %s (%s) write token is short (%d chars) — rotate it\n", id, u.Name, len(u.Token))
		default:
			fmt.Printf("  ok    %s (%s)\n", id, u.Name)
		}
		if u.Token != "" && u.CheckinToken == "" {
			warns++
			fmt.Printf("  warn  %s has no check-in token — confirm links and buttons would need the write token\n", id)
		}
	}

	fmt.Println("\nstate:")
	dir := dataDir(c.cfg)
	if di, derr := os.Stat(dir); derr == nil {
		warn(di.Mode().Perm()&0o077 == 0, "data dir is not world/group readable", fmt.Sprintf("chmod 700 %s", dir))
	}
	plan, rev, lerr := c.store.Load()
	switch {
	case lerr != nil:
		fails++
		fmt.Printf("  FAIL  state decrypts — %v\n", lerr)
	case plan == nil:
		warns++
		fmt.Println("  warn  no state yet — `putzii-server plan import --file <export.json>`")
	default:
		fmt.Printf("  ok    state decrypts (rev %d, %d events)\n", rev, len(plan.Events))
		check(plan.PlanID == c.cfg.PlanID, "state planId matches config", "the state file belongs to another plan")
		if cerr := plan.CheckCaps(); cerr != nil {
			fails++
			fmt.Printf("  FAIL  state within caps — %v (no pruning exists yet; see docs/todo-cutover.md)\n", cerr)
		} else {
			fmt.Printf("  ok    state within caps (events %d/%d)\n", len(plan.Events), wire.MaxEvents)
		}
	}

	fmt.Println("\napp:")
	for _, f := range []string{"index.html", "c.html", "style.css", "sync.js", "drop.js"} {
		_, ferr := os.Stat(filepath.Join(*appDir, f))
		check(ferr == nil, "app/"+f, fmt.Sprintf("--app %s does not point at the putzii checkout", *appDir))
	}

	fmt.Printf("\n%d failed, %d warnings\n", fails, warns)
	if fails > 0 {
		return fmt.Errorf("%d check(s) failed", fails)
	}
	return nil
}
