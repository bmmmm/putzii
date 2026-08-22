// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"flag"
	"fmt"
	"time"

	"github.com/bmmmm/putzii/server/internal/config"
	"github.com/bmmmm/putzii/server/internal/store"
	"github.com/bmmmm/putzii/server/internal/wire"
)

func cmdUser(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: putzii-server user add|list|revoke [flags]")
	}
	switch args[0] {
	case "add":
		return userAdd(args[1:])
	case "list":
		return userList(args[1:])
	case "revoke":
		return userRevoke(args[1:])
	default:
		return fmt.Errorf("unknown user subcommand %q", args[0])
	}
}

// userAdd mints BOTH tokens for a person: the write token that travels in
// their #d2. link, and a separate check-in token for #k2. confirm links and
// physical buttons. Two tokens instead of one is the whole point — a link
// pinned to the fridge can no longer read or overwrite the plan.
//
// A name match against the live plan REUSES the existing personId so the
// history stays attributed. A new person is written straight into the state:
// the server is the source of truth, there is no dispatch to wait for.
func userAdd(args []string) error {
	fs := flag.NewFlagSet("user add", flag.ExitOnError)
	name := fs.String("name", "", "display name (matched against plan people)")
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)
	if *name == "" {
		return fmt.Errorf("--name required")
	}
	c, err := loadCtx(*confPath)
	if err != nil {
		return err
	}
	plan, _, err := c.store.Load()
	if err != nil {
		return err
	}
	norm := wire.NormalizeName(*name)
	if norm == "" {
		return fmt.Errorf("--name is empty after normalization")
	}

	var personID string
	if plan != nil {
		for _, p := range plan.People {
			if p.DeletedAt == 0 && wire.NormalizeName(p.Name) == norm {
				personID = p.ID
				break
			}
		}
	}
	isNew := personID == ""
	if isNew {
		for {
			personID = randomID(5)
			taken := c.cfg.Users[personID] != nil
			if plan != nil && !taken {
				taken = plan.PersonByID(personID) != nil
			}
			if !taken {
				break
			}
		}
	}
	if u := c.cfg.Users[personID]; u != nil && u.Token != "" {
		return fmt.Errorf("user %s (%s) already has a token — `putzii-server user revoke --user %s` first", personID, u.Name, personID)
	}

	c.cfg.Users[personID] = &config.User{
		ID: personID, Name: norm,
		Token:        randomID(22),
		CheckinToken: randomID(22),
	}
	if err := c.cfg.Save(c.cfg.Path); err != nil {
		return err
	}

	if isNew {
		if plan == nil {
			fmt.Printf("✓ %s (%s) authorized — no plan state yet, the person record lands on the first push\n", personID, norm)
		} else {
			now := float64(time.Now().Unix())
			if _, err := c.store.Apply(
				store.WriteReq{By: personID, Nonce: randomID(12), Kind: "state", Now: time.Now()},
				func(cur *wire.Plan, _ int64) (*wire.Plan, map[string]int, error) {
					cur.People = append(cur.People, wire.Person{
						ID: personID, Name: norm, CreatedAt: now, UpdatedAt: now,
					})
					cur.UpdatedAt = now
					return cur, map[string]int{"people": len(cur.People)}, nil
				}); err != nil {
				return err
			}
			fmt.Printf("✓ new person %s (%s) created and authorized\n", personID, norm)
		}
	} else {
		fmt.Printf("✓ matched existing person %s (%s) — history stays attributed\n", personID, norm)
	}
	printUserLink(c.cfg, personID)
	return nil
}

func userList(args []string) error {
	fs := flag.NewFlagSet("user list", flag.ExitOnError)
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)
	c, err := loadCtx(*confPath)
	if err != nil {
		return err
	}
	ids := sortedUserIDs(c.cfg)
	if len(ids) == 0 {
		fmt.Println("no users — `putzii-server user add --name <name>`")
		return nil
	}
	for _, id := range ids {
		u := c.cfg.Users[id]
		scopes := ""
		if u.Token != "" {
			scopes += "write "
		}
		if u.CheckinToken != "" {
			scopes += "checkin"
		}
		if scopes == "" {
			scopes = "REVOKED"
		}
		fmt.Printf("%-8s %-24s %s\n", id, u.Name, scopes)
	}
	return nil
}

// userRevoke kills access at the next request — the token is simply gone
// from the config. Already-issued links keep the ability to DECRYPT old
// copies a device already pulled; only a new enc_key cuts that, which means
// re-issuing every link.
func userRevoke(args []string) error {
	fs := flag.NewFlagSet("user revoke", flag.ExitOnError)
	userID := fs.String("user", "", "person id")
	checkinOnly := fs.Bool("checkin-only", false, "revoke only the check-in token (keep write access)")
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)
	if *userID == "" {
		return fmt.Errorf("--user <personId> required")
	}
	c, err := loadCtx(*confPath)
	if err != nil {
		return err
	}
	u := c.cfg.Users[*userID]
	if u == nil {
		return fmt.Errorf("unknown user %q", *userID)
	}
	u.CheckinToken = ""
	if !*checkinOnly {
		u.Token = ""
	}
	if err := c.cfg.Save(c.cfg.Path); err != nil {
		return err
	}
	if *checkinOnly {
		fmt.Printf("✓ %s (%s): confirm links and buttons are dead, write access unchanged\n", u.ID, u.Name)
		return nil
	}
	fmt.Printf("✓ %s (%s) has no access any more (effective on the next request)\n", u.ID, u.Name)
	fmt.Println("  a copy already pulled to their device stays readable — that needs a new enc_key")
	return nil
}
