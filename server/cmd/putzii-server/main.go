// SPDX-License-Identifier: GPL-3.0-or-later

// putzii-server — the self-hosted putzii server and its admin CLI in one
// binary. `serve` runs the HTTP service; every other subcommand is a local
// admin operation on the SAME config + data directory, which is why there is
// no remote admin API to secure.
package main

import (
	"fmt"
	"os"
	"runtime/debug"

	"github.com/bmmmm/putzii/server/internal/config"
	"github.com/bmmmm/putzii/server/internal/dropcrypto"
	"github.com/bmmmm/putzii/server/internal/store"
)

var version = "dev"

func main() {
	if version == "dev" {
		if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Version != "(devel)" && bi.Main.Version != "" {
			version = bi.Main.Version
		}
	}
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "serve":
		err = cmdServe(args)
	case "plan":
		err = cmdPlan(args)
	case "user":
		err = cmdUser(args)
	case "link":
		err = cmdLink(args)
	case "qr":
		err = cmdQr(args)
	case "button":
		err = cmdButton(args)
	case "status":
		err = cmdStatus(args)
	case "doctor":
		err = cmdDoctor(args)
	case "config":
		err = cmdConfig(args)
	case "version", "--version", "-v":
		fmt.Println("putzii-server", version)
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "putzii-server:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `putzii-server — self-hosted putzii server + admin CLI

usage: putzii-server <command> [flags]

  serve     run the HTTP server (API + the PWA)
  plan      init | import | export | show — plan state
  user      add | list | revoke — manage access
  link      user | checkin — render the #d2. / #k2. links
  qr        --areas | --user <id> | --sheet — printable QR codes
  button    new --kind curl|ha|shortcut|http --area <id> — webhook snippets
  status    rev, freshness and the audit tail
  doctor    config, permissions and state sanity checks
  config    path | template

Every command reads ./putzii-server.conf unless --config says otherwise.
`)
}

// ctx bundles what most admin commands need. The store is opened lazily:
// `config template` must work before any config exists.
type ctx struct {
	cfg   *config.Config
	store *store.Store
}

func loadCtx(confPath string) (*ctx, error) {
	if confPath == "" {
		confPath = config.DefaultPath()
	}
	cfg, err := config.Load(confPath)
	if err != nil {
		return nil, fmt.Errorf("config %s: %w (run `putzii-server plan init` or `putzii-server config template`)", confPath, err)
	}
	key, err := dropcrypto.B64urlDecode(cfg.EncKey)
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("config %s: enc_key must be 32 base64url bytes", confPath)
	}
	st, err := store.New(dataDir(cfg), cfg.PlanID, key, cfg.GitAudit)
	if err != nil {
		return nil, err
	}
	return &ctx{cfg: cfg, store: st}, nil
}
