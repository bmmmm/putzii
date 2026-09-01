// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bmmmm/putzii/server/internal/config"
	"github.com/bmmmm/putzii/server/internal/httpapi"
)

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	confPath := fs.String("config", config.DefaultPath(), "config file")
	appDir := fs.String("app", "..", "directory holding the PWA (index.html, c.html, …)")
	listen := fs.String("listen", "", "override the configured listen address")
	fs.Parse(args)

	c, err := loadCtx(*confPath)
	if err != nil {
		return err
	}
	addr := c.cfg.Listen
	if *listen != "" {
		addr = *listen
	}
	if _, err := os.Stat(*appDir + "/index.html"); err != nil {
		return fmt.Errorf("--app %s does not look like the putzii checkout (no index.html)", *appDir)
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	api := httpapi.New(c.cfg, c.store, *appDir, log)

	srv := &http.Server{
		Addr:              addr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Counts only, never names: the startup line is the same discipline the
	// request log follows.
	log.Info("serving", "version", version, "addr", addr, "plan", c.cfg.PlanID, "users", len(c.cfg.Users), "app", *appDir)

	idle := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		ctxShut, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctxShut); err != nil {
			log.Error("shutdown", "err", err)
		}
		close(idle)
	}()

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-idle
	log.Info("stopped")
	return nil
}
