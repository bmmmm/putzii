// SPDX-License-Identifier: GPL-3.0-or-later

// Package httpapi is the server's whole outside surface: four JSON endpoints
// plus the static PWA.
//
// ORDER IS THE SECURITY DESIGN, inherited from the retired apply.mjs:
//
//	(1) bound the body, then shape-guard the ids — no attacker payload parsed
//	(2) AUTH — hash the presented token, constant-time compare, derive person
//	    and scope from it; a checkin token can never reach state
//	(3) only NOW is the payload decoded (b64url → gunzip → sanitize → caps)
//	(4) the store's replay/rate guards and the atomic write
//	(5) responses and logs carry COUNTS ONLY — never names, never payload
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/bmmmm/putzii/server/internal/config"
	"github.com/bmmmm/putzii/server/internal/dropcrypto"
	"github.com/bmmmm/putzii/server/internal/mint"
	"github.com/bmmmm/putzii/server/internal/store"
	"github.com/bmmmm/putzii/server/internal/wire"
)

var (
	rePlanID   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
	rePersonID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
	reAreaID   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
	// A nonce is an opaque idempotency key, not a secret — the guard exists
	// to bound it, not to restrict its alphabet. Wider than the app's own
	// [a-z2-9]{8} on purpose: a Home-Assistant template, a Shortcut or a
	// shell one-liner can then use whatever random it already has, instead
	// of contorting itself into a hand-picked alphabet.
	reNonce = regexp.MustCompile(`^[A-Za-z0-9_-]{4,64}$`)
)

// maxBody leaves room for the 64 kB payload cap plus JSON/form framing.
const maxBody = wire.MaxPayloadChars + 8*1024

// errNoPlan: a check-in arrived before any state exists. Fixable by the
// household (import the plan), so it is a 422, not a server error.
var errNoPlan = errors.New("no-plan")

// Server wires config + store + the static app together.
type Server struct {
	cfg    *config.Config
	store  *store.Store
	appDir string
	log    *slog.Logger
	now    func() time.Time // test seam
}

func New(cfg *config.Config, st *store.Store, appDir string, log *slog.Logger) *Server {
	return &Server{cfg: cfg, store: st, appDir: appDir, log: log, now: time.Now}
}

// SetNow is a test seam — production always uses time.Now.
func (s *Server) SetNow(fn func() time.Time) { s.now = fn }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/healthz", s.handleHealthz)
	mux.HandleFunc("GET /api/state/{planId}", s.handleGetState)
	mux.HandleFunc("PUT /api/state/{planId}", s.handlePutState)
	mux.HandleFunc("GET /api/health/{planId}", s.handleGetHealth)
	mux.HandleFunc("POST /api/checkin", s.handleCheckin)
	if s.appDir != "" {
		mux.Handle("/", http.FileServer(http.Dir(s.appDir)))
	}
	return securityHeaders(mux)
}

// securityHeaders mirrors the app's own <meta> CSP as a real header —
// defence in depth, and the one place a browser honours `frame-ancestors`.
// connect-src stays 'self': the app talks ONLY to the origin that served it.
func securityHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; " +
		"base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// ── responses ───────────────────────────────────────────────────────────

type errBody struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// fail answers with a log-safe reason only. Reasons are bare identifiers so
// neither the response nor the log can carry a name or a payload byte.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, status int, reason string) {
	s.log.Info("refused", "path", r.URL.Path, "status", status, "reason", reason)
	writeJSON(w, status, errBody{Error: reason})
}

// ── auth ────────────────────────────────────────────────────────────────

// bearer extracts the token from the Authorization header. A body/form
// `token` field is the documented fallback for dumb webhook clients that
// cannot set headers (an HTML form post, some Shortcuts actions).
func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if after, ok := strings.CutPrefix(h, "Bearer "); ok {
		return strings.TrimSpace(after)
	}
	return ""
}

type principal struct {
	PersonID string
	Scope    string
}

func (s *Server) authenticate(token string) (principal, bool) {
	id, scope, ok := s.cfg.Authenticate(token)
	if !ok {
		return principal{}, false
	}
	return principal{PersonID: id, Scope: scope}, true
}

// ── GET /api/healthz ────────────────────────────────────────────────────

// Unauthenticated liveness for blackbox monitoring. Deliberately says
// nothing about the plan — not even whether one exists.
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── GET /api/state/{planId} ─────────────────────────────────────────────

func (s *Server) handleGetState(w http.ResponseWriter, r *http.Request) {
	planID := r.PathValue("planId")
	if !rePlanID.MatchString(planID) {
		s.fail(w, r, http.StatusBadRequest, "planid-shape")
		return
	}
	p, ok := s.authenticate(bearer(r))
	if !ok {
		s.fail(w, r, http.StatusUnauthorized, "auth")
		return
	}
	if p.Scope != config.ScopeWrite {
		s.fail(w, r, http.StatusForbidden, "scope")
		return
	}
	if planID != s.store.PlanID() {
		s.fail(w, r, http.StatusNotFound, "unknown-plan")
		return
	}
	raw, err := s.store.StateFile()
	if err != nil {
		s.fail(w, r, http.StatusNotFound, "no-state")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(raw)
}

// ── GET /api/health/{planId} ────────────────────────────────────────────

func (s *Server) handleGetHealth(w http.ResponseWriter, r *http.Request) {
	planID := r.PathValue("planId")
	if !rePlanID.MatchString(planID) {
		s.fail(w, r, http.StatusBadRequest, "planid-shape")
		return
	}
	p, ok := s.authenticate(bearer(r))
	if !ok {
		s.fail(w, r, http.StatusUnauthorized, "auth")
		return
	}
	if p.Scope != config.ScopeWrite {
		s.fail(w, r, http.StatusForbidden, "scope")
		return
	}
	if planID != s.store.PlanID() {
		s.fail(w, r, http.StatusNotFound, "unknown-plan")
		return
	}
	h, err := s.store.Health()
	if err != nil {
		s.fail(w, r, http.StatusInternalServerError, "health-read")
		return
	}
	writeJSON(w, http.StatusOK, h)
}

// ── PUT /api/state/{planId} ─────────────────────────────────────────────

type putStateReq struct {
	Token   string `json:"token"`
	Nonce   string `json:"nonce"`
	BaseRev int64  `json:"baseRev"`
	Payload string `json:"payload"` // b64url(gzip(wire envelope)) — OPAQUE until auth
}

type putStateResp struct {
	Rev     int64          `json:"rev"`
	At      string         `json:"at"`
	Replay  bool           `json:"replay"`
	Changed bool           `json:"changed"`
	Counts  map[string]int `json:"counts"`
}

func (s *Server) handlePutState(w http.ResponseWriter, r *http.Request) {
	planID := r.PathValue("planId")
	if !rePlanID.MatchString(planID) {
		s.fail(w, r, http.StatusBadRequest, "planid-shape")
		return
	}
	var req putStateReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if !reNonce.MatchString(req.Nonce) {
		s.fail(w, r, http.StatusBadRequest, "nonce-shape")
		return
	}

	token := bearer(r)
	if token == "" {
		token = req.Token
	}
	p, ok := s.authenticate(token)
	if !ok {
		s.fail(w, r, http.StatusUnauthorized, "auth")
		return
	}
	if p.Scope != config.ScopeWrite {
		s.fail(w, r, http.StatusForbidden, "scope")
		return
	}
	if planID != s.store.PlanID() {
		s.fail(w, r, http.StatusNotFound, "unknown-plan")
		return
	}

	var reason string
	res, err := s.store.Apply(
		store.WriteReq{By: p.PersonID, Nonce: req.Nonce, Kind: "state", Now: s.now()},
		func(cur *wire.Plan, curRev int64) (*wire.Plan, map[string]int, error) {
			if req.BaseRev != curRev {
				return nil, nil, store.ErrConflict
			}
			next, r2, derr := decodePayload(req.Payload, planID)
			if derr != nil {
				reason = r2
				return nil, nil, derr
			}
			// Overwrite is only safe while the log stays append-only.
			if cur != nil {
				if dropped := wire.DroppedEventIDs(cur.Events, next.Events, 1); len(dropped) > 0 {
					reason = "events-dropped"
					return nil, nil, errors.New(reason)
				}
			}
			return next, map[string]int{
				"areas": len(next.Areas), "people": len(next.People),
				"events": len(next.Events), "weeks": len(next.Weeks),
			}, nil
		})
	if err != nil {
		s.writeApplyError(w, r, err, reason)
		return
	}
	writeJSON(w, http.StatusOK, putStateResp{
		Rev: res.Rev, At: res.At, Replay: res.Replay, Changed: res.Changed, Counts: res.Counts,
	})
}

// decodePayload turns the opaque payload field into a sanitized plan. Every
// step is a cap or a gate: size → gunzip cap → append-only slot check →
// planFromWire (the same sanitizer hostile links meet) → plan caps.
func decodePayload(payload, planID string) (*wire.Plan, string, error) {
	if payload == "" || len(payload) > wire.MaxPayloadChars {
		return nil, "payload-size", errors.New("payload-size")
	}
	gz, err := dropcrypto.B64urlDecode(payload)
	if err != nil {
		return nil, "payload-b64", err
	}
	raw, err := dropcrypto.Gunzip(gz)
	if err != nil {
		return nil, "payload-gunzip", err
	}
	// The client app is NEWER than this binary — fail loud, never strip.
	if wire.SlotCount(raw) > wire.KnownSlots() {
		return nil, "wire-unknown-slots", store.ErrUnknownSlots
	}
	plan, _, err := wire.FromWire(raw)
	if err != nil {
		return nil, "wire", err
	}
	if plan.PlanID != planID {
		return nil, "planid-mismatch", errors.New("planid-mismatch")
	}
	if err := plan.CheckCaps(); err != nil {
		return nil, "caps", err
	}
	return plan, "", nil
}

// ── POST /api/checkin ───────────────────────────────────────────────────

type checkinReq struct {
	PlanID   string `json:"planId"`
	PersonID string `json:"personId"`
	Token    string `json:"token"`
	AreaID   string `json:"areaId"`
	Nonce    string `json:"nonce"`
}

type checkinResp struct {
	Rev    int64  `json:"rev"`
	At     string `json:"at"`
	Replay bool   `json:"replay"`
	Minted bool   `json:"minted"`
}

// handleCheckin is the endpoint every "dumb device" targets: the browser,
// an HTML form without JS, a Home-Assistant rest_command, a Shortcut, curl.
// JSON and form encodings are both accepted; the response follows the
// request's Accept header.
func (s *Server) handleCheckin(w http.ResponseWriter, r *http.Request) {
	wantsHTML := prefersHTML(r)
	var req checkinReq
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "application/x-www-form-urlencoded") || strings.HasPrefix(ct, "multipart/form-data") {
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		if err := r.ParseForm(); err != nil {
			s.checkinFail(w, r, http.StatusBadRequest, "form", wantsHTML)
			return
		}
		req = checkinReq{
			PlanID:   r.PostFormValue("planId"),
			PersonID: r.PostFormValue("personId"),
			Token:    r.PostFormValue("token"),
			AreaID:   r.PostFormValue("areaId"),
			Nonce:    r.PostFormValue("nonce"),
		}
	} else if !s.decodeJSON(w, r, &req) {
		return
	}

	switch {
	case !rePlanID.MatchString(req.PlanID):
		s.checkinFail(w, r, http.StatusBadRequest, "planid-shape", wantsHTML)
		return
	case !rePersonID.MatchString(req.PersonID):
		s.checkinFail(w, r, http.StatusBadRequest, "personid-shape", wantsHTML)
		return
	case !reAreaID.MatchString(req.AreaID):
		s.checkinFail(w, r, http.StatusBadRequest, "areaid-shape", wantsHTML)
		return
	case !reNonce.MatchString(req.Nonce):
		s.checkinFail(w, r, http.StatusBadRequest, "nonce-shape", wantsHTML)
		return
	}

	token := bearer(r)
	if token == "" {
		token = req.Token
	}
	p, ok := s.authenticate(token)
	if !ok {
		s.checkinFail(w, r, http.StatusUnauthorized, "auth", wantsHTML)
		return
	}
	if req.PlanID != s.store.PlanID() {
		s.checkinFail(w, r, http.StatusNotFound, "unknown-plan", wantsHTML)
		return
	}

	var minted bool
	res, err := s.store.Apply(
		// Attribution is auditable, not enforced (a phone in the hallway may
		// credit someone else): the EVENT names req.PersonID, the tail stamps
		// the authenticated pusher.
		store.WriteReq{By: p.PersonID, Nonce: req.Nonce, Kind: "checkin", Now: s.now()},
		func(cur *wire.Plan, _ int64) (*wire.Plan, map[string]int, error) {
			if cur == nil {
				return nil, nil, errNoPlan
			}
			ev, merr := mint.Checkin(cur, req.AreaID, req.PersonID, float64(s.now().UnixMilli()))
			if merr != nil {
				return nil, nil, merr
			}
			if ev == nil {
				// idempotent no-op: the nonce is still recorded, so a retried
				// webhook confirms instead of duplicating.
				return nil, map[string]int{"minted": 0}, nil
			}
			mint.Append(cur, ev)
			minted = true
			return cur, map[string]int{"minted": 1, "events": len(cur.Events)}, nil
		})
	if err != nil {
		status, reason := applyStatus(err, "")
		if errors.Is(err, mint.ErrUnknownArea) {
			status, reason = http.StatusUnprocessableEntity, "unknown-area"
		}
		s.checkinFail(w, r, status, reason, wantsHTML)
		return
	}
	if wantsHTML {
		s.checkinPage(w, http.StatusOK, "Eingetragen ✓", "Danke — der Check-in ist im Plan vermerkt.")
		return
	}
	writeJSON(w, http.StatusOK, checkinResp{Rev: res.Rev, At: res.At, Replay: res.Replay, Minted: minted})
}

func (s *Server) checkinFail(w http.ResponseWriter, r *http.Request, status int, reason string, wantsHTML bool) {
	if !wantsHTML {
		s.fail(w, r, status, reason)
		return
	}
	s.log.Info("refused", "path", r.URL.Path, "status", status, "reason", reason)
	s.checkinPage(w, status, "Hat nicht geklappt", checkinMessage(reason))
}

// checkinMessage maps a log-safe reason to German copy for the no-JS page.
func checkinMessage(reason string) string {
	switch reason {
	case "auth":
		return "Zugang abgelehnt — dieser Link wurde vermutlich zurückgezogen."
	case "unknown-area":
		return "Diese Tätigkeit gibt es nicht mehr."
	case "no-plan":
		return "Für diesen Plan liegt noch nichts auf dem Server."
	case "rate":
		return "Zu viele Eintragungen in kurzer Zeit — bitte später nochmal."
	default:
		return "Der Check-in konnte nicht verarbeitet werden."
	}
}

// checkinPage is the no-JS answer: one self-contained page, styled by the
// app's own stylesheet so the form path looks like the rest of putzii.
func (s *Server) checkinPage(w http.ResponseWriter, status int, title, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>putzii – Check-in</title>
<link rel="stylesheet" href="/style.css"></head>
<body><header class="app-header"><h1><a href="/index.html#uebersicht" class="brand">putzii</a></h1></header>
<main><section><div class="checkin-card"><p class="result-check">%s</p><p>%s</p>
<a class="btn" href="/index.html#uebersicht">Zur Übersicht</a></div></section></main></body></html>
`, html.EscapeString(title), html.EscapeString(body))
}

func prefersHTML(r *http.Request) bool {
	accept := r.Header.Get("Accept")
	if strings.Contains(accept, "application/json") {
		return false
	}
	return strings.Contains(accept, "text/html")
}

// ── shared plumbing ─────────────────────────────────────────────────────

// decodeJSON bounds the body BEFORE any parsing and rejects unknown fields —
// the shape gate that runs ahead of authentication.
func (s *Server) decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		status := http.StatusBadRequest
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) || errors.Is(err, io.ErrUnexpectedEOF) {
			status = http.StatusRequestEntityTooLarge
		}
		s.fail(w, r, status, "body")
		return false
	}
	return true
}

// applyStatus maps a store/decoder error to (status, log-safe reason).
func applyStatus(err error, reason string) (int, string) {
	switch {
	case errors.Is(err, store.ErrConflict):
		return http.StatusConflict, "conflict"
	case errors.Is(err, store.ErrRate):
		return http.StatusTooManyRequests, "rate"
	case errors.Is(err, store.ErrUnknownSlots):
		return http.StatusUnprocessableEntity, "wire-unknown-slots"
	case errors.Is(err, mint.ErrUnknownArea):
		return http.StatusUnprocessableEntity, "unknown-area"
	case errors.Is(err, errNoPlan):
		return http.StatusUnprocessableEntity, "no-plan"
	}
	if reason != "" {
		return http.StatusUnprocessableEntity, reason
	}
	return http.StatusInternalServerError, "apply"
}

func (s *Server) writeApplyError(w http.ResponseWriter, r *http.Request, err error, reason string) {
	status, why := applyStatus(err, reason)
	if status == http.StatusConflict {
		// Hand back the current rev so the client can pull, merge, retry
		// without a second round trip.
		if h, herr := s.store.Health(); herr == nil {
			s.log.Info("refused", "path", r.URL.Path, "status", status, "reason", why)
			writeJSON(w, status, map[string]any{"error": why, "rev": h.Rev})
			return
		}
	}
	s.fail(w, r, status, why)
}
