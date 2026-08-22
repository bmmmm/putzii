// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"flag"
	"fmt"

	"github.com/bmmmm/putzii/server/internal/config"
)

// cmdButton renders check-in snippets for dumb devices. A plain HTTP POST is
// semantically correct because the SERVER mints the event — the caller needs
// no plan knowledge, no gzip, no JS. Every snippet uses the person's
// CHECK-IN token, so a button taped to a wall can never read the plan.
func cmdButton(args []string) error {
	if len(args) < 1 || args[0] != "new" {
		return fmt.Errorf("usage: putzii-server button new --kind curl|ha|shortcut|http --area <areaId> [--user <id>]")
	}
	fs := flag.NewFlagSet("button new", flag.ExitOnError)
	kind := fs.String("kind", "curl", "curl | ha | shortcut | http")
	area := fs.String("area", "", "areaId to check in")
	userID := fs.String("user", "", "acting user (default: the only configured one)")
	confPath := fs.String("config", config.DefaultPath(), "config file")
	fs.Parse(args[1:])
	if *area == "" {
		return fmt.Errorf("--area <areaId> required")
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
		return fmt.Errorf("user %s has no check-in token — a button must never carry the write token", u.ID)
	}
	url := c.cfg.AppBase + "/api/checkin"
	body := fmt.Sprintf(`{"planId":"%s","personId":"%s","areaId":"%s","nonce":"NONCE"}`,
		c.cfg.PlanID, u.ID, *area)

	// The nonce is an idempotency key: 4–64 chars of [A-Za-z0-9_-]. Pressing
	// twice with the SAME nonce is answered as a replay, which is exactly
	// what makes a retry over a flaky link safe.
	switch *kind {
	case "curl":
		fmt.Printf(`# check-in button for %s / area %s
# The nonce makes the press idempotent: a repeat with the same value is
# answered as a replay, so retrying a failed call can never double-count.
curl -sS -X POST \
  -H "Authorization: Bearer %s" \
  -H "Content-Type: application/json" \
  %s \
  -d "{\"planId\":\"%s\",\"personId\":\"%s\",\"areaId\":\"%s\",\"nonce\":\"$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')\"}"
`, u.Name, *area, u.CheckinToken, url, c.cfg.PlanID, u.ID, *area)
	case "ha":
		fmt.Printf(`# Home Assistant rest_command (configuration.yaml) — check-in %s / %s
# Trigger it from whatever you already have locally: an MQTT button, a
# zigbee remote, a presence automation. Only this one HTTPS call leaves
# the house.
rest_command:
  putzii_checkin_%s:
    url: "%s"
    method: POST
    headers:
      Authorization: "Bearer %s"
      Content-Type: "application/json"
    payload: >-
      {"planId":"%s","personId":"%s","areaId":"%s",
      "nonce":"{{ range(10000000, 99999999) | random }}"}
# The nonce may be any 4–64 chars of [A-Za-z0-9_-], so a plain random number
# is fine. Repeating one is answered as a replay, never counted twice.
`, u.Name, *area, *area, url, u.CheckinToken, c.cfg.PlanID, u.ID, *area)
	case "shortcut":
		fmt.Printf(`# Apple Shortcut — check-in %s / area %s
1. Aktion "Zufallszahl" zwischen 10000000 und 99999999 → das ist der Nonce.
2. Aktion "Inhalte von URL abrufen":
   URL:     %s
   Methode: POST
   Header:  Authorization = Bearer %s
   Anfragetext (JSON): %s
   (NONCE durch die Zufallszahl aus Schritt 1 ersetzen)
Zweimal derselbe Nonce = Replay, wird nie doppelt gezählt.
`, u.Name, *area, url, u.CheckinToken, body)
	case "http":
		fmt.Printf(`POST %s
Authorization: Bearer %s
Content-Type: application/json

%s
`, url, u.CheckinToken, body)
	default:
		return fmt.Errorf("unknown --kind %q", *kind)
	}
	return nil
}
