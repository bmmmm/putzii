// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"crypto/rand"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/bmmmm/putzii/server/internal/config"
	"github.com/bmmmm/putzii/server/internal/dropcrypto"
	"github.com/bmmmm/putzii/server/internal/store"
	"github.com/bmmmm/putzii/server/internal/wire"
)

func cmdPlan(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: putzii-server plan init|import|export|show [flags]")
	}
	switch args[0] {
	case "init":
		return planInit(args[1:])
	case "import":
		return planImport(args[1:])
	case "export":
		return planExport(args[1:])
	case "show":
		return planShow(args[1:])
	default:
		return fmt.Errorf("unknown plan subcommand %q", args[0])
	}
}

// planInit writes a fresh config: a new state key plus the plan id. It never
// overwrites an existing key — that would orphan every stored ciphertext.
func planInit(args []string) error {
	fs := flag.NewFlagSet("plan init", flag.ExitOnError)
	planID := fs.String("plan-id", "", "existing plan id (default: generate a new one)")
	appBase := fs.String("app-base", "", "public base URL of this server, e.g. https://putzii.example.de")
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)

	if _, err := os.Stat(*confPath); err == nil {
		return fmt.Errorf("%s already exists — refusing to overwrite an existing key", *confPath)
	}
	if *appBase == "" {
		return fmt.Errorf("--app-base <https://…> required (it is what links point at)")
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	cfg := config.New()
	cfg.Path = *confPath
	cfg.PlanID = *planID
	if cfg.PlanID == "" {
		cfg.PlanID = randomPlanID()
	}
	cfg.EncKey = dropcrypto.B64urlEncode(key)
	cfg.AppBase = *appBase
	if err := cfg.Save(*confPath); err != nil {
		return err
	}
	fmt.Printf("✓ %s written (chmod 600)\n", *confPath)
	fmt.Printf("  plan  %s\n", cfg.PlanID)
	fmt.Printf("  data  %s\n", dataDir(cfg))
	fmt.Println("\nnext: `putzii-server user add --name <name>`, then `putzii-server plan import --file <export.json>`")
	return nil
}

// planImport seeds the server from an app file export — the one-off state
// migration. It refuses to clobber existing state unless --force says so.
func planImport(args []string) error {
	fs := flag.NewFlagSet("plan import", flag.ExitOnError)
	file := fs.String("file", "", "putzii file export (.json)")
	force := fs.Bool("force", false, "replace existing state")
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)
	if *file == "" {
		return fmt.Errorf("--file <export.json> required")
	}
	c, err := loadCtx(*confPath)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(*file)
	if err != nil {
		return err
	}
	plan, err := wire.ParseFile(raw)
	if err != nil {
		return err
	}
	if plan.PlanID != c.cfg.PlanID {
		return fmt.Errorf("file is plan %s, config says %s — fix plan_id or export the right plan", plan.PlanID, c.cfg.PlanID)
	}
	if err := plan.CheckCaps(); err != nil {
		return err
	}
	cur, rev, err := c.store.Load()
	if err != nil {
		return err
	}
	if cur != nil && !*force {
		return fmt.Errorf("state already exists at rev %d — pass --force to replace it", rev)
	}
	res, err := c.store.Apply(
		store.WriteReq{By: "admin", Nonce: randomID(12), Kind: "seed", Now: time.Now()},
		func(_ *wire.Plan, _ int64) (*wire.Plan, map[string]int, error) {
			return plan, map[string]int{
				"areas": len(plan.Areas), "people": len(plan.People),
				"events": len(plan.Events), "weeks": len(plan.Weeks),
			}, nil
		})
	if err != nil {
		return err
	}
	fmt.Printf("✓ imported at rev %d — %d areas, %d people, %d events, %d weeks\n",
		res.Rev, len(plan.Areas), len(plan.People), len(plan.Events), len(plan.Weeks))
	return nil
}

// planExport writes the current state as an app-compatible file export —
// the backup path, and how a plan leaves the server again.
func planExport(args []string) error {
	fs := flag.NewFlagSet("plan export", flag.ExitOnError)
	file := fs.String("file", "", "output file (default: stdout)")
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)
	c, err := loadCtx(*confPath)
	if err != nil {
		return err
	}
	plan, rev, err := c.store.Load()
	if err != nil {
		return err
	}
	if plan == nil {
		return fmt.Errorf("no state yet")
	}
	data, err := wire.SerializeFile(plan)
	if err != nil {
		return err
	}
	if *file == "" {
		fmt.Println(string(data))
		return nil
	}
	if err := os.WriteFile(*file, data, 0o600); err != nil {
		return err
	}
	fmt.Printf("✓ %s (rev %d)\n", *file, rev)
	return nil
}

func planShow(args []string) error {
	fs := flag.NewFlagSet("plan show", flag.ExitOnError)
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)
	c, err := loadCtx(*confPath)
	if err != nil {
		return err
	}
	plan, rev, err := c.store.Load()
	if err != nil {
		return err
	}
	if plan == nil {
		fmt.Printf("plan %s — no state yet\n", c.cfg.PlanID)
		return nil
	}
	fmt.Printf("plan %s  rev %d  %q\n", plan.PlanID, rev, plan.Name)
	fmt.Printf("  areas  %d\n", len(plan.Areas))
	fmt.Printf("  people %d\n", len(plan.People))
	fmt.Printf("  events %d\n", len(plan.Events))
	fmt.Printf("  weeks  %d\n", len(plan.Weeks))
	fmt.Println("\nlive areas:")
	for _, a := range plan.Areas {
		if a.DeletedAt != 0 {
			continue
		}
		fmt.Printf("  %-8s %-24s alle %d Tage\n", a.ID, a.Name, int(a.IntervalDays))
	}
	fmt.Println("\nlive people:")
	for _, p := range plan.People {
		if p.DeletedAt != 0 {
			continue
		}
		access := "no token"
		if u := c.cfg.Users[p.ID]; u != nil && u.Token != "" {
			access = "write"
		}
		fmt.Printf("  %-8s %-24s %s\n", p.ID, p.Name, access)
	}
	return nil
}
