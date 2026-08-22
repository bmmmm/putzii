// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"time"

	"github.com/bmmmm/putzii/server/internal/config"
)

func cmdStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	tail := fs.Int("tail", 10, "audit entries to show")
	asJSON := fs.Bool("json", false, "machine-readable output")
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)
	c, err := loadCtx(*confPath)
	if err != nil {
		return err
	}
	h, err := c.store.Health()
	if err != nil {
		return err
	}
	if *asJSON {
		out, err := json.MarshalIndent(h, "", " ")
		if err != nil {
			return err
		}
		fmt.Println(string(out))
		return nil
	}
	fmt.Printf("plan %s  rev %d  at %s\n", c.cfg.PlanID, h.Rev, h.At)
	if h.At != "" {
		if t, perr := time.Parse(time.RFC3339Nano, h.At); perr == nil {
			fmt.Printf("last write %s ago\n", time.Since(t).Round(time.Second))
		}
	}
	if len(h.Tail) == 0 {
		fmt.Println("\nno writes yet")
		return nil
	}
	fmt.Printf("\naudit tail (%d of %d):\n", min(*tail, len(h.Tail)), len(h.Tail))
	for i, e := range h.Tail {
		if i >= *tail {
			break
		}
		counts, _ := json.Marshal(e.Counts)
		fmt.Printf("  %s  rev %-4d %-8s by %-8s %s\n", e.At, e.Rev, e.Kind, e.By, counts)
	}
	return nil
}
