// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"flag"
	"fmt"
	"strings"

	"github.com/bmmmm/putzii/server/internal/config"
	"github.com/bmmmm/putzii/server/internal/link"
)

func cmdLink(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: putzii-server link user --user <id> | link checkin --user <id> --areas <id|name,...>")
	}
	switch args[0] {
	case "user":
		return linkUser(args[1:])
	case "checkin":
		return linkCheckin(args[1:])
	default:
		return fmt.Errorf("unknown link subcommand %q", args[0])
	}
}

func linkUser(args []string) error {
	fs := flag.NewFlagSet("link user", flag.ExitOnError)
	userID := fs.String("user", "", "person id")
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)
	c, err := loadCtx(*confPath)
	if err != nil {
		return err
	}
	u, err := pickUser(c.cfg, *userID)
	if err != nil {
		return err
	}
	printUserLink(c.cfg, u.ID)
	return nil
}

func printUserLink(cfg *config.Config, personID string) {
	u := cfg.Users[personID]
	if u == nil || u.Token == "" {
		fmt.Println("no write token for this person — nothing to render")
		return
	}
	url, err := link.URL(cfg.AppBase, &link.Credentials{
		PlanID: cfg.PlanID, PersonID: u.ID, PersonName: u.Name,
		Token: u.Token, EncKey: cfg.EncKey,
	})
	if err != nil {
		fmt.Println("link:", err)
		return
	}
	fmt.Printf("\npersonal link for %s (SECRET — full read+write, share only with them):\n%s\n", u.Name, url)
}

// linkCheckin renders the pre-scoped #k2. confirm link for the Signal flow:
// fixed person, fixed activities, CHECK-IN SCOPED token — the holder can
// confirm those activities and nothing else. That is the concrete fix for
// the old #k1., which embedded the person's full write token.
func linkCheckin(args []string) error {
	fs := flag.NewFlagSet("link checkin", flag.ExitOnError)
	userID := fs.String("user", "", "person id (default: the only configured one)")
	areasFlag := fs.String("areas", "", "comma-separated area ids or names")
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)
	if *areasFlag == "" {
		return fmt.Errorf("--areas <id-or-name,...> required")
	}
	c, err := loadCtx(*confPath)
	if err != nil {
		return err
	}
	u, err := pickUser(c.cfg, *userID)
	if err != nil {
		return err
	}
	if u.CheckinToken == "" {
		return fmt.Errorf("user %s has no check-in token — `putzii-server user add` mints one; revoked ones need a fresh add", u.ID)
	}
	plan, _, err := c.store.Load()
	if err != nil {
		return err
	}
	if plan == nil {
		return fmt.Errorf("no plan state yet — import it first")
	}
	areas, err := resolveAreas(plan, strings.Split(*areasFlag, ","))
	if err != nil {
		return err
	}
	url, err := link.CheckinURL(c.cfg.AppBase, &link.CheckinCredentials{
		PlanID: c.cfg.PlanID, PersonID: u.ID, PersonName: u.Name,
		Token: u.CheckinToken, Areas: areas,
	})
	if err != nil {
		return err
	}
	labels := make([]string, len(areas))
	for i, a := range areas {
		labels[i] = a.Label
	}
	fmt.Printf("\nconfirm link for %s — %s (check-in only: cannot read the plan, cannot overwrite it):\n%s\n",
		u.Name, strings.Join(labels, ", "), url)
	return nil
}
