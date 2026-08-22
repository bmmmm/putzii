// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"flag"
	"fmt"
	"path/filepath"

	"github.com/bmmmm/putzii/server/internal/config"
)

func cmdConfig(args []string) error {
	fs := flag.NewFlagSet("config", flag.ExitOnError)
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args)
	sub := ""
	if fs.NArg() > 0 {
		sub = fs.Arg(0)
	}
	switch sub {
	case "path":
		abs, err := filepath.Abs(*confPath)
		if err != nil {
			return err
		}
		fmt.Println(abs)
		return nil
	case "template":
		fmt.Print(config.Template())
		return nil
	default:
		return fmt.Errorf("usage: putzii-server config path|template")
	}
}
