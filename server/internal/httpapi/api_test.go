// SPDX-License-Identifier: GPL-3.0-or-later
package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/bmmmm/putzii/server/internal/config"
	"github.com/bmmmm/putzii/server/internal/dropcrypto"
	"github.com/bmmmm/putzii/server/internal/store"
	"github.com/bmmmm/putzii/server/internal/wire"
)

const (
	planID       = "AbC123xy"
	writeToken   = "writetokenwritetokenab"
	checkinToken = "checkintokencheckintok"
)

var t0 = time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC)

// The suite drives the handler in-process (NewRecorder, not NewServer): no
// listening socket, so it behaves the same in a sandbox and in CI.
type harness struct {
	handler http.Handler
	store   *store.Store
	api     *Server
	now     time.Time
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i*7 + 3)
	}
	st, err := store.New(t.TempDir(), planID, key, false)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.New()
	cfg.PlanID = planID
	cfg.EncKey = dropcrypto.B64urlEncode(key)
	cfg.Users["sina7"] = &config.User{
		ID: "sina7", Name: "Sina", Token: writeToken, CheckinToken: checkinToken,
	}
	h := &harness{store: st, now: t0}
	h.api = New(cfg, st, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.api.SetNow(func() time.Time { return h.now })
	h.handler = h.api.Handler()
	return h
}

func (h *harness) do(t *testing.T, method, path, token, body string, hdr map[string]string) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rdr)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	res := rec.Result()
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func decode(t *testing.T, res *http.Response) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return out
}

func samplePlan(events int) *wire.Plan {
	p := &wire.Plan{
		PlanID: planID, Name: "Haushalt", UpdatedAt: 1755600000,
		Areas: []wire.Area{
			{ID: "kche1", Name: "Küche", IntervalDays: 7},
			{ID: "bad22", Name: "Bad", IntervalDays: 14, DeletedAt: 1755100000},
		},
		People: []wire.Person{{ID: "sina7", Name: "Sina"}},
	}
	for i := 0; i < events; i++ {
		p.Events = append(p.Events, wire.Event{
			ID: wire.FormatCompactEventID("gsina7", int64(i+1)), AreaID: "kche1",
			PersonID: "sina7", TsMs: 1787047500000 + float64(i)*60000,
		})
	}
	return p
}

func payloadFor(t *testing.T, p *wire.Plan) string {
	t.Helper()
	raw, err := wire.ToWire(p)
	if err != nil {
		t.Fatal(err)
	}
	gz, err := dropcrypto.Gzip(raw)
	if err != nil {
		t.Fatal(err)
	}
	return dropcrypto.B64urlEncode(gz)
}

func putBody(t *testing.T, p *wire.Plan, nonce string, baseRev int64) string {
	t.Helper()
	b, err := json.Marshal(putStateReq{Nonce: nonce, BaseRev: baseRev, Payload: payloadFor(t, p)})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// ── auth ────────────────────────────────────────────────────────────────

// Invariant: authentication happens BEFORE any attacker-controlled payload
// is decoded. A deliberately poisonous payload with a bad token must be
// refused with 401, never with a decoding error.
func TestAuthRunsBeforePayloadDecode(t *testing.T) {
	h := newHarness(t)
	poison, _ := json.Marshal(putStateReq{Nonce: "aaaa2222", Payload: strings.Repeat("!", 4096)})
	res := h.do(t, "PUT", "/api/state/"+planID, "wrongtokenwrongtokenwr", string(poison), nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.StatusCode)
	}
	if got := decode(t, res)["error"]; got != "auth" {
		t.Fatalf("reason = %v, want auth (a decode error would mean the payload was parsed first)", got)
	}
}

func TestUnauthenticatedRequestsAreRefused(t *testing.T) {
	h := newHarness(t)
	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/state/" + planID, ""},
		{"GET", "/api/health/" + planID, ""},
		{"PUT", "/api/state/" + planID, `{"nonce":"aaaa2222","baseRev":0,"payload":"x"}`},
		{"POST", "/api/checkin", `{"planId":"` + planID + `","personId":"sina7","areaId":"kche1","nonce":"aaaa2222"}`},
	} {
		res := h.do(t, c.method, c.path, "", c.body, nil)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s: status = %d, want 401", c.method, c.path, res.StatusCode)
		}
	}
}

// The whole reason the check-in scope exists: a token from a fridge QR must
// not be able to read the plan or overwrite it.
func TestCheckinTokenCannotReachState(t *testing.T) {
	h := newHarness(t)
	h.seed(t, samplePlan(1))
	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/state/" + planID, ""},
		{"GET", "/api/health/" + planID, ""},
		{"PUT", "/api/state/" + planID, putBody(t, samplePlan(2), "bbbb3333", 1)},
	} {
		res := h.do(t, c.method, c.path, checkinToken, c.body, nil)
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s with a check-in token: status = %d, want 403", c.method, c.path, res.StatusCode)
		}
	}
	// …but it CAN check in.
	res := h.do(t, "POST", "/api/checkin", checkinToken,
		`{"planId":"`+planID+`","personId":"sina7","areaId":"kche1","nonce":"cccc4444"}`, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("check-in with a check-in token: status = %d, want 200", res.StatusCode)
	}
}

func (h *harness) seed(t *testing.T, p *wire.Plan) {
	t.Helper()
	res := h.do(t, "PUT", "/api/state/"+planID, writeToken, putBody(t, p, "seed2222", 0), nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("seed failed: %d %v", res.StatusCode, decode(t, res))
	}
	h.now = h.now.Add(time.Minute)
}

// ── state ───────────────────────────────────────────────────────────────

func TestPutThenGetState(t *testing.T) {
	h := newHarness(t)
	res := h.do(t, "PUT", "/api/state/"+planID, writeToken, putBody(t, samplePlan(2), "aaaa2222", 0), nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put: %d %v", res.StatusCode, decode(t, res))
	}
	body := decode(t, res)
	if body["rev"].(float64) != 1 || body["changed"] != true {
		t.Fatalf("put result: %v", body)
	}

	res = h.do(t, "GET", "/api/state/"+planID, writeToken, "", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("get: %d", res.StatusCode)
	}
	raw, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(raw), `"alg":"A256GCM"`) {
		t.Fatalf("GET must hand back the ciphertext document: %s", raw)
	}
	if strings.Contains(string(raw), "Küche") {
		t.Fatalf("plaintext leaked through GET")
	}
	// Nothing on the API path may be cached.
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", res.Header.Get("Cache-Control"))
	}
}

func TestGetStateBeforeAnyWrite(t *testing.T) {
	h := newHarness(t)
	res := h.do(t, "GET", "/api/state/"+planID, writeToken, "", nil)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
}

// The server is the single source of truth, so a stale writer is refused
// rather than silently clobbering. The answer carries the current rev so the
// client can pull, merge locally and retry without a probe request.
func TestPutRevConflict(t *testing.T) {
	h := newHarness(t)
	h.seed(t, samplePlan(1))
	res := h.do(t, "PUT", "/api/state/"+planID, writeToken, putBody(t, samplePlan(2), "bbbb3333", 0), nil)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", res.StatusCode)
	}
	body := decode(t, res)
	if body["error"] != "conflict" || body["rev"].(float64) != 1 {
		t.Fatalf("conflict body: %v", body)
	}
	// with the right baseRev it goes through
	res = h.do(t, "PUT", "/api/state/"+planID, writeToken, putBody(t, samplePlan(2), "cccc4444", 1), nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("retry: %d %v", res.StatusCode, decode(t, res))
	}
}

// Overwrite semantics are only safe while the log stays append-only: a push
// that lost history must be refused, not applied.
func TestPutRefusesTruncatedHistory(t *testing.T) {
	h := newHarness(t)
	h.seed(t, samplePlan(5))
	res := h.do(t, "PUT", "/api/state/"+planID, writeToken, putBody(t, samplePlan(3), "bbbb3333", 1), nil)
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", res.StatusCode)
	}
	if got := decode(t, res)["error"]; got != "events-dropped" {
		t.Fatalf("reason = %v, want events-dropped", got)
	}
	// the stored state is untouched
	plan, rev, err := h.store.Load()
	if err != nil || rev != 1 || len(plan.Events) != 5 {
		t.Fatalf("state changed despite refusal: rev %d, %d events, %v", rev, len(plan.Events), err)
	}
}

func TestPutRefusesOverCaps(t *testing.T) {
	h := newHarness(t)
	res := h.do(t, "PUT", "/api/state/"+planID, writeToken,
		putBody(t, samplePlan(wire.MaxEvents+1), "aaaa2222", 0), nil)
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", res.StatusCode)
	}
	if got := decode(t, res)["error"]; got != "caps" {
		t.Fatalf("reason = %v, want caps", got)
	}
}

func TestPutRefusesForeignPlanID(t *testing.T) {
	h := newHarness(t)
	other := samplePlan(1)
	other.PlanID = "Zz9_-Pl0"
	// path says our plan, payload claims another one
	body, _ := json.Marshal(putStateReq{Nonce: "aaaa2222", BaseRev: 0, Payload: payloadFor(t, other)})
	res := h.do(t, "PUT", "/api/state/"+planID, writeToken, string(body), nil)
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", res.StatusCode)
	}
	if got := decode(t, res)["error"]; got != "planid-mismatch" {
		t.Fatalf("reason = %v", got)
	}
	// path names a plan this server does not host
	res = h.do(t, "GET", "/api/state/Zz9_-Pl0", writeToken, "", nil)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("foreign plan GET: %d", res.StatusCode)
	}
}

func TestPutMalformedPayloads(t *testing.T) {
	h := newHarness(t)
	cases := map[string]string{
		"payload-size":   "",
		"payload-b64":    "!!!not-base64!!!",
		"payload-gunzip": dropcrypto.B64urlEncode([]byte("not gzip at all")),
	}
	i := 0
	for wantReason, payload := range cases {
		body, _ := json.Marshal(putStateReq{Nonce: nonceN(i), BaseRev: 0, Payload: payload})
		i++
		res := h.do(t, "PUT", "/api/state/"+planID, writeToken, string(body), nil)
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422", wantReason, res.StatusCode)
			continue
		}
		if got := decode(t, res)["error"]; got != wantReason {
			t.Errorf("payload %q: reason = %v, want %v", payload, got, wantReason)
		}
	}
	// an unknown JSON field is a shape error, refused before auth even runs
	res := h.do(t, "PUT", "/api/state/"+planID, writeToken, `{"nonce":"aaaa2222","mode":"envelope"}`, nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("stale field: status = %d, want 400", res.StatusCode)
	}
}

// A nonce is an opaque idempotency key: bounded, but deliberately wide
// enough that a dumb webhook can use whatever random it already has.
func TestNonceShapeGuard(t *testing.T) {
	h := newHarness(t)
	for _, n := range []string{"", "abc", "has space", "semi;colon", strings.Repeat("a", 65)} {
		body, _ := json.Marshal(putStateReq{Nonce: n, BaseRev: 0, Payload: payloadFor(t, samplePlan(1))})
		res := h.do(t, "PUT", "/api/state/"+planID, writeToken, string(body), nil)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("nonce %q: status = %d, want 400", n, res.StatusCode)
		}
	}
	// what real clients send: the app's own alphabet, a plain random number,
	// a UUID from a Home-Assistant template
	for i, n := range []string{"aaaa2222", "48170399", "3f6b2c1e-9a4d-4f21-8f0e-77c3a1b25de9", "AbC-_123"} {
		plan := samplePlan(1)
		plan.Name = strings.Repeat("x", i+1) // vary the payload so each write differs
		body, _ := json.Marshal(putStateReq{Nonce: n, BaseRev: int64(i), Payload: payloadFor(t, plan)})
		res := h.do(t, "PUT", "/api/state/"+planID, writeToken, string(body), nil)
		if res.StatusCode != http.StatusOK {
			t.Errorf("nonce %q: status = %d, want 200 (%v)", n, res.StatusCode, decode(t, res))
		}
		h.now = h.now.Add(time.Minute)
	}
}

// A retried write (flaky mobile connection) must confirm, not duplicate.
func TestPutReplayIsGreenNoOp(t *testing.T) {
	h := newHarness(t)
	body := putBody(t, samplePlan(2), "aaaa2222", 0)
	if res := h.do(t, "PUT", "/api/state/"+planID, writeToken, body, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("first put: %d", res.StatusCode)
	}
	res := h.do(t, "PUT", "/api/state/"+planID, writeToken, body, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("replay: status = %d, want 200", res.StatusCode)
	}
	got := decode(t, res)
	if got["replay"] != true || got["rev"].(float64) != 1 {
		t.Fatalf("replay body: %v", got)
	}
}

// ── check-in ────────────────────────────────────────────────────────────

func TestCheckinMintsAndIsIdempotent(t *testing.T) {
	h := newHarness(t)
	h.seed(t, samplePlan(0))
	body := `{"planId":"` + planID + `","personId":"sina7","areaId":"kche1","nonce":"cccc4444"}`
	res := h.do(t, "POST", "/api/checkin", writeToken, body, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("checkin: %d %v", res.StatusCode, decode(t, res))
	}
	if got := decode(t, res); got["minted"] != true || got["rev"].(float64) != 2 {
		t.Fatalf("checkin body: %v", got)
	}
	plan, _, err := h.store.Load()
	if err != nil || len(plan.Events) != 1 || plan.Events[0].ID != "gsina7.1" {
		t.Fatalf("minted event: %v %+v", err, plan.Events)
	}

	// A second check-in inside the window: fresh nonce, but nothing to add.
	h.now = h.now.Add(2 * time.Minute)
	body2 := `{"planId":"` + planID + `","personId":"sina7","areaId":"kche1","nonce":"dddd5555"}`
	res = h.do(t, "POST", "/api/checkin", writeToken, body2, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("second checkin: %d", res.StatusCode)
	}
	got := decode(t, res)
	if got["minted"] != false || got["rev"].(float64) != 2 {
		t.Fatalf("idempotent check-in must not bump the rev: %v", got)
	}
	plan, _, _ = h.store.Load()
	if len(plan.Events) != 1 {
		t.Fatalf("idempotent check-in duplicated the event: %d", len(plan.Events))
	}
}

func TestCheckinUnknownAndDeletedArea(t *testing.T) {
	h := newHarness(t)
	h.seed(t, samplePlan(0))
	for i, area := range []string{"nope1", "bad22"} {
		body := `{"planId":"` + planID + `","personId":"sina7","areaId":"` + area + `","nonce":"` + nonceN(i) + `"}`
		res := h.do(t, "POST", "/api/checkin", writeToken, body, nil)
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("area %s: status = %d, want 422", area, res.StatusCode)
			continue
		}
		if got := decode(t, res)["error"]; got != "unknown-area" {
			t.Errorf("area %s: reason = %v", area, got)
		}
	}
}

func TestCheckinBeforeAnyState(t *testing.T) {
	h := newHarness(t)
	body := `{"planId":"` + planID + `","personId":"sina7","areaId":"kche1","nonce":"cccc4444"}`
	res := h.do(t, "POST", "/api/checkin", writeToken, body, nil)
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", res.StatusCode)
	}
}

// Attribution is auditable, not enforced: the EVENT may name someone else
// ("Timo scans, picks Sina"), the audit tail stamps who actually pushed.
func TestCheckinAttributionIsAuditable(t *testing.T) {
	h := newHarness(t)
	plan := samplePlan(0)
	plan.People = append(plan.People, wire.Person{ID: "timo3", Name: "Timo"})
	h.seed(t, plan)
	body := `{"planId":"` + planID + `","personId":"timo3","areaId":"kche1","nonce":"cccc4444"}`
	if res := h.do(t, "POST", "/api/checkin", checkinToken, body, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	stored, _, err := h.store.Load()
	if err != nil || len(stored.Events) != 1 || stored.Events[0].PersonID != "timo3" {
		t.Fatalf("event attribution: %v %+v", err, stored.Events)
	}
	health, err := h.store.Health()
	if err != nil || health.Tail[0].By != "sina7" {
		t.Fatalf("tail must stamp the authenticated pusher: %+v", health.Tail[0])
	}
}

// The no-JS path: an HTML form post, token in the body, HTML back.
func TestCheckinFormPostAnswersHTML(t *testing.T) {
	h := newHarness(t)
	h.seed(t, samplePlan(0))
	form := url.Values{
		"planId": {planID}, "personId": {"sina7"}, "areaId": {"kche1"},
		"nonce": {"cccc4444"}, "token": {checkinToken},
	}
	res := h.do(t, "POST", "/api/checkin", "", form.Encode(), map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
		"Accept":       "text/html,application/xhtml+xml",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", ct)
	}
	page, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(page), "Eingetragen") {
		t.Fatalf("confirmation page: %s", page)
	}
	// The failure path must stay HTML too, and must not echo a token back.
	form.Set("token", "wrongtokenwrongtokenwr")
	form.Set("nonce", "dddd5555")
	res = h.do(t, "POST", "/api/checkin", "", form.Encode(), map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
		"Accept":       "text/html",
	})
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad token: status = %d, want 401", res.StatusCode)
	}
	page, _ = io.ReadAll(res.Body)
	if strings.Contains(string(page), "wrongtoken") {
		t.Fatalf("the error page echoed the token back")
	}
}

// ── health + misc ───────────────────────────────────────────────────────

// The tail is the audit trail — and it must carry counts only.
func TestHealthTailCarriesCountsOnly(t *testing.T) {
	h := newHarness(t)
	h.seed(t, samplePlan(2))
	res := h.do(t, "GET", "/api/health/"+planID, writeToken, "", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	raw, _ := io.ReadAll(res.Body)
	for _, secret := range []string{"Küche", "Sina", "Haushalt", writeToken, checkinToken} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("health leaked %q: %s", secret, raw)
		}
	}
	var health store.Health
	if err := json.Unmarshal(raw, &health); err != nil {
		t.Fatal(err)
	}
	if health.Rev != 1 || len(health.Tail) != 1 || health.Tail[0].By != "sina7" {
		t.Fatalf("health: %+v", health)
	}
}

func TestHealthzNeedsNoAuthAndSaysNothing(t *testing.T) {
	h := newHarness(t)
	h.seed(t, samplePlan(3))
	res := h.do(t, "GET", "/api/healthz", "", "", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	raw, _ := io.ReadAll(res.Body)
	if strings.Contains(string(raw), "rev") || strings.Contains(string(raw), planID) {
		t.Fatalf("liveness must not describe the plan: %s", raw)
	}
}

// connect-src 'self' is the invariant that keeps the app talking to exactly
// one origin: the one that served it.
func TestSecurityHeaders(t *testing.T) {
	h := newHarness(t)
	res := h.do(t, "GET", "/api/healthz", "", "", nil)
	csp := res.Header.Get("Content-Security-Policy")
	for _, want := range []string{"connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP missing %q: %s", want, csp)
		}
	}
	if res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("missing nosniff")
	}
	if res.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("missing referrer policy")
	}
}

// A body far above the payload cap must be cut off by the reader, not
// buffered into memory first.
func TestOversizedBodyRefused(t *testing.T) {
	h := newHarness(t)
	huge := `{"nonce":"aaaa2222","baseRev":0,"payload":"` + strings.Repeat("A", maxBody+1024) + `"}`
	res := h.do(t, "PUT", "/api/state/"+planID, writeToken, huge, nil)
	if res.StatusCode != http.StatusRequestEntityTooLarge && res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 413/400", res.StatusCode)
	}
}

func nonceN(i int) string {
	const alpha = "abcdefghijkmnpqrstuvwxyz23456789"
	out := []byte("nnnn2222")
	out[7] = alpha[i%32]
	out[6] = alpha[(i/32)%32]
	return string(out)
}
