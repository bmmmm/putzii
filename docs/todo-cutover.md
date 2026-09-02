# TODO: Cutover auf den eigenen Server

Der Code ist fertig und auf `main` (siehe [`rebuild-plan.md`](rebuild-plan.md)
für die Entscheidungen). Was hier steht, braucht echte Infrastruktur oder
Handgriffe am Haushalt — nichts davon lässt sich am Schreibtisch beweisen.

**Stand 2026-09-02 (abends).** Schritt 5 ist **erledigt** — vorgezogen, siehe
dort; Schritt **5b** ist am selben Tag dazugekommen: `putzii-drop-lab`, ein
zweiter, noch scharfer Drop, den bis dahin keine Liste kannte.
Schritt 1 ist **erledigt**: der Dienst läuft auf `dockworker2`, intern
bewiesen (Details dort). Schritt 2 (Zustandsübernahme) ist machbar, sobald
er gewollt ist. Schritt 3 und 4
sind **bewusst zurückgestellt**: entschieden ist Tailnet-only, also kein
Port-Forward, kein öffentlicher A-Record, kein Tunnel ins geteilte
bc101-Netz. Damit ist der Dienst intern beweisbar, aber ein Haushalts-Handy
im Mobilfunk erreicht ihn nicht — und genau daran hängen 3 und 4. Bis dahin
teilt der Haushalt weiter offline per `#p1.`.

Reihenfolge, wenn es weitergeht: 1 → 2, dann 3 → 4 **erst nach** einer
belegten Erreichbarkeit von außerhalb des Tailnets.

---

## 1. Deploy auf bc101 (`dockworker2`) — **erledigt am 2026-09-02**

Gelaufen auf Commit `23bf728`, Container `putzii`, Version im Start-Log
gestempelt. Bewiesen (alles von `dockworker2` aus, `healthz` zusätzlich vom
Mac über das Tailnet):

- [x] `curl -s https://putzii.bc101.de/api/healthz` → `{"ok":true}`
- [x] `https://putzii.bc101.de/` liefert die App (HTTP 200, 9784 Bytes,
      `<title>putzii – Putzplan</title>`, `service-worker.js` 200)
- [x] `/api/state/<planId>` **ohne** Token → `401 {"error":"auth"}`
- [x] Zertifikat gültig: `CN=putzii.bc101.de`, Let's Encrypt, bis 2026-12-01
- [x] `doctor` → **0 failed**, 2 Warnungen (keine Nutzer, kein Zustand —
      beides erwartet, kommt mit Schritt 2)
- [x] `serve` gegen ein **echtes Volume**, inklusive Neustart:
      `RestartCount=0`, `healthy`, Config nach dem Restart wiedergelesen —
      das war der einzige wirklich ungetestete Teil
- [x] Container läuft als `uid=10001(putzii)`, nicht root
- [x] Interner Pi-hole-Record `putzii.bc101.de` → `192.168.10.32` (+ IPv6,
      Muster der Nachbarn), über `~/servers/bc101/scripts/pihole-dns.sh add`
- [ ] `/api/healthz` in die bc101-Monitoring-Insel aufnehmen

**Noch kein Umzug, nur ein laufender Dienst.** `plan init` lief **ohne**
`--plan-id`, hat also einen frischen Plan angelegt (`users 0`, kein Zustand)
— der Haushalts-Plan ist nicht übernommen. Das ist Schritt 2, und ohne
Erreichbarkeit von außen wäre er ein Backup, kein Umzug. Wer ihn nachholt,
muss `plan init` mit der bestehenden `planId` wiederholen; es weigert sich,
eine vorhandene Konfiguration zu überschreiben, also vorher
`/data/putzii-server.conf` wegräumen.

**Zwei Fallen, beide beim ersten Durchlauf getroffen:**

1. **git kommt auf `dockworker2` nur über HTTP/1.1 durch.** `git clone`
   stirbt mit `could not read Username for 'https://github.com'` und
   `expected flush after ref listing`, obwohl `curl` auf denselben
   `info/refs`-Endpunkt 200 liefert und der POST auf `git-upload-pack`
   ebenfalls. Es liegt an HTTP/2, nicht an Auth:
   `git -c http.version=HTTP/1.1 clone …` geht sofort durch. Im Checkout
   danach `git config http.version HTTP/1.1` setzen, sonst bricht der nächste
   `git pull` wieder.
2. **`chown` vor `build` braucht ein `.dockerignore`.** Der Build-Kontext ist
   das Repo-Root, und `COPY server/ ./server/` zieht `server/data` mit. Nach
   dem `chown 10001:10001` kann der Build-Daemon (läuft als Deploy-User) das
   Verzeichnis nicht mehr lesen:
   `failed to solve: error from sender: open .../server/data: permission denied`.
   Seit `23bf728` liegt ein `.dockerignore` im Repo — es löst beides, denn
   ohne es landete `putzii-server.conf` (State-Key!) in einer Image-Schicht.

**Zertifikat ohne öffentliche Erreichbarkeit:** Traefik auf diesem Host nutzt
die **Cloudflare-DNS-01-Challenge** (`--certificatesresolvers.myresolver.acme
.dnschallenge.provider=cloudflare`), nicht HTTP-01. Let's Encrypt stellt
deshalb auch für einen nur intern erreichbaren Host aus — die Tailnet-only-
Entscheidung kostet kein Zertifikat.

<details>
<summary>Die ursprüngliche Anleitung (für einen zweiten Deploy)</summary>

**Vorher prüfen**

- [ ] DNS `putzii.bc101.de` — **zwei verschiedene Fragen, nicht eine**:
      *intern* (Pi-hole-Record über das etablierte
      `~/servers/bc101/scripts/pihole-dns.sh add`) reicht für den
      Tailnet-only-Betrieb; *öffentlich* (A-Record) ist eine eigene,
      zurückgestellte Entscheidung — s. Kopf
- [ ] Traefik läuft auf `dockworker2`, externes Netz `traefik` existiert
      (dasselbe Muster wie `git.bc101.de` / `cloud.bc101.de`)

**Was hier wirklich neu ist.** Das Image läuft bei jedem Push als Container
— der Job `docker` in `ci.yml` startet es für `putzii-server version`. Neu
und ungetestet ist ausschließlich `serve` **gegen ein echtes Volume**: Start
mit persistentem Datenverzeichnis, Volume-Rechte und Traefik.

```bash
# auf dockworker2, im Repo-Checkout
mkdir -p server/data
chmod 700 server/data
# Der Container läuft als uid 10001 (nicht root). Das betrifft NICHT nur
# `plan init`: store.New() legt `plans/` schon im Konstruktor an
# (store.go:104), den jedes Subkommando ruft — inklusive `serve`. Bei
# falschem Eigentümer kommt `serve` gar nicht hoch und läuft wegen
# `restart: unless-stopped` als Crash-Loop, während `docker compose up -d`
# brav Erfolg meldet.
sudo chown 10001:10001 server/data
# PUTZII_VERSION stempelt den Commit ins Binary (`putzii-server version`,
# Start-Log) — ohne die Variable steht dort "dev".
PUTZII_VERSION=$(git rev-parse --short HEAD) docker compose -f server/docker-compose.yml build
```

**Konfiguration anlegen** — hier hängt alles an der Entscheidung aus
Schritt 2, also erst dort weiterlesen, dann eines von beiden:

```bash
# Variante B (empfohlen, frischer Schlüssel):
docker compose -f server/docker-compose.yml run --rm putzii \
  plan init --config /data/putzii-server.conf \
            --app-base https://putzii.bc101.de \
            --plan-id <bestehende planId aus der App>

# Variante A (alten Schlüssel übernehmen): plan init wie oben, danach
# enc_key in /data/putzii-server.conf durch den Wert aus dropii.conf
# ersetzen. Sonst lässt sich der kopierte State nicht entschlüsseln.
```

`plan init` erzeugt **immer einen neuen** `enc_key` und weigert sich, eine
vorhandene Konfiguration zu überschreiben.

```bash
docker compose -f server/docker-compose.yml up -d
```

**Beweisen**

- [ ] `curl -s https://putzii.bc101.de/api/healthz` → `{"ok":true}`
- [ ] Zertifikat gültig, von außerhalb des bc101-Netzes erreichbar
- [ ] `curl -si https://putzii.bc101.de/api/state/<planId>` **ohne** Token
      → `401` mit `{"error":"auth"}`
- [ ] `https://putzii.bc101.de/` liefert die App
- [ ] `docker compose exec putzii putzii-server doctor --config /data/putzii-server.conf --app /app`
      → 0 failed
- [ ] `/api/healthz` in die bc101-Monitoring-Insel aufnehmen

</details>

---

## 2. Zustand einmalig übernehmen

Zwei Wege. **Variante B ist die empfohlene**, weil der alte Schlüssel in
Links steckt, die ohnehin sterben — ihn mitzunehmen verlängert die Lebenszeit
eines Geheimnisses ohne Gegenwert.

**Variante B — frischer Schlüssel, Export/Import**

1. [ ] In der App (Gerät mit dem vollständigsten Stand): Teilen → Datei
       exportieren
2. [ ] Datei auf `dockworker2` legen, dann:
       ```bash
       docker compose -f server/docker-compose.yml run --rm \
         -v /pfad/zum/export.json:/tmp/export.json:ro putzii \
         plan import --config /data/putzii-server.conf --file /tmp/export.json
       ```
3. [ ] `putzii-server status` zeigt `rev 1` und plausible Zählwerte.
       **Der Abgleich läuft über `status`, nicht über `plan show`**:
       `plan show` druckt Rohtotale **inklusive soft-deleted** Records
       (`plan.go:174-177`), die Listen darunter sind gefiltert — ein naiver
       Vergleich mit den sichtbaren Zahlen im Gerät geht daneben. `status`
       druckt den Audit-Tail mit `Kind` (`seed`/`state`/`checkin`) und den
       `Counts` pro Schreibvorgang.

**Variante A — alten Schlüssel übernehmen, Dateien kopieren**

Das Speicherlayout ist absichtlich identisch zum Drop, also reicht Kopieren:
`site/plans/<planId>.json` → `data/plans/<planId>.json` und
`site/health.json` → `data/health.json`. Voraussetzung: `enc_key` in
`putzii-server.conf` ist der aus `dropii.conf`, sonst schlägt jeder Zugriff
mit `decrypt state` fehl.

- [ ] `putzii-server plan show` listet Bereiche und Personen korrekt auf
- [ ] `putzii-server plan export --file /tmp/backup.json` als Sicherung
- [ ] Backup von `server/data/` einrichten — das ist das **einzige**
      zustandsbehaftete Verzeichnis

---

## 3. Harter Cutover: alle Links und Aushänge neu

> **Blockiert, nicht vergessen.** Voraussetzung ist, dass ein
> Haushalts-Handy den Dienst von außerhalb des Tailnets erreicht. Solange
> Tailnet-only gilt (s. Kopf), sind neu ausgegebene Links und QR-Codes
> unterwegs tot — sie ersetzen funktionierende Zettel durch kaputte.

Alte `#d1.`/`#k1.`-Links sind tot und sagen das auch („alter Link"). Alte
QR-Aushänge zeigen auf `bmmmm.github.io` und müssen ersetzt werden — die
`c1.`-QRs tragen die Basis-URL im Code.

- [ ] Pro Person: `putzii-server user add --name "<Name>"`
      (Namens-Match gegen den Plan übernimmt die vorhandene `personId` —
      damit bleibt die Historie zugeordnet; prüfen, dass „matched existing
      person" erscheint und nicht „new person")
- [ ] Zugangs-Links persönlich verteilen (Signal), einer pro Person:
      `putzii-server link user --user <id>`
- [ ] Bestätigungs-Links für die Signal-Nutzung:
      `putzii-server link checkin --user <id> --areas "Küche,Bad"`
- [ ] Aushänge neu drucken: `putzii-server qr --sheet --out /tmp` → im
      Browser drucken, alte Zettel abnehmen
- [ ] Auf mindestens **zwei** Geräten: Link öffnen, Plan erscheint, ein
      Check-in landet auf dem jeweils anderen Gerät
- [ ] Ein Gerät offline nehmen, Check-in machen, wieder online → wird
      nachgeholt (`queued` → `idle`)
- [ ] `#p1.`-Teilen funktioniert weiterhin (Offline-Fallback)

Die Kommandos, die Geheimnisse ausgeben (`user add`, `link user`,
`link checkin`, `qr --user`), gehören ins eigene Terminal — nicht in eine
Agent-Session.

---

## 4. Home Assistant zuhause anbinden

> **Blockiert.** HA läuft auf `10.0.20.3` — im homelab, und das steht in
> keiner bc101-ACL. Der eine HTTPS-Aufruf nach bc101 geht heute nicht durch.

Die Trigger-Logik bleibt, wo sie schon läuft (MQTT-Buttons, HA auf
`10.0.20.3`). Nach bc101 geht genau ein HTTPS-Aufruf.

- [ ] Snippet erzeugen:
      `putzii-server button new --kind ha --area <areaId> --user <id>`
- [ ] `rest_command` in die `configuration.yaml`, HA neu laden
- [ ] Automation: MQTT-Button → `rest_command.putzii_checkin_<area>`
- [ ] Kette einmal ganz durchspielen: Button drücken →
      `putzii-server status` zeigt den Eintrag mit `kind=checkin`
- [ ] Zweimal kurz hintereinander drücken → nur **ein** Event
      (10-Minuten-Idempotenzfenster), `status` zeigt `minted: 0` beim zweiten

Der eingebettete Token ist der **Check-in-Token**: er kann den Plan weder
lesen noch überschreiben. Genau deshalb darf er in eine Config-Datei.

---

## 5. putzii-drop stilllegen — **erledigt am 2026-09-02**

**Vorgezogen, entgegen der ursprünglichen Bedingung „erst, wenn Schritt 3
läuft".** Die Bedingung sollte eine Lücke verhindern; es gab keine zu
verhindern. Belegt: der `apply`-Workflow — der einzige, der Zustand schreibt
— hat 47 Läufe, **alle 47 `workflow_dispatch`**, alle zwischen 2026-08-19
23:37 und 2026-08-20 21:11 UTC. Kein einziger wurde je von einem Gerät
ausgelöst; letzter Commit im Drop 2026-08-20 22:06. Der Drop war seit dem
20. August tot, während ein öffentliches Repo samt lebendem PAT und sechs
aktiven Workflows weiterlief. Warten hätte nur die Exposition verlängert.

- [x] Fünf Workflows deaktiviert (`apply`, `ci`, `driftcheck`, `pages`,
      `selfcheck`). „Dependabot Updates" lässt sich nicht per API
      deaktivieren — im archivierten Repo laufen Actions ohnehin nicht mehr
- [x] Secrets gelöscht (`DROP_KEY_B64`, `DROP_TOKENS_SHA256`); Liste leer
- [x] Vulnerability-Alerts aus
- [x] GitHub Pages abgeschaltet — `https://bmmmm.github.io/putzii-drop/`
      antwortet `404`
- [x] Repo archiviert (weiterhin public; die Löschung macht der Nutzer)
- [ ] **PAT löschen** — läuft sonst bis 2027-08-17 weiter und steckt noch in
      jedem alten Link. Gehört ins Terminal des Nutzers; eine Agent-Session
      kann ihn weder lesen noch löschen
- [ ] `~/offline_coding/putzii-drop` lokal aufräumen, wenn nichts mehr
      gebraucht wird (Clone ist sauber, HEAD `5e33914`)

### 5b. `putzii-drop-lab` — der zweite Drop, **erledigt am 2026-09-02**

**Dieser Schritt fehlte hier bis zum 2026-09-02 vollständig.** Das Lab galt
als Wegwerf-Repo („No real data. Delete after putzii-drop phase 4", so seine
eigene README) und stand deshalb in keiner Checkliste. Gemessen war es das
Gegenteil eines toten Repos:

- öffentlich und **nicht** archiviert, während der Drop längst zu war
- **neun aktive Workflows**, darunter echte Kopien der Produktions-Workflows
  `apply`, `ci`, `pages`, `selfcheck` — angelegt von `dropii setup` direkt
  über die GitHub-API, weshalb sie nie im lokalen Klon auftauchten
- `pages` mit `cron: */15 * * * *`, `selfcheck` täglich um 03:23 — der
  letzte Lauf war **am Tag der Stilllegung selbst**
- `selfcheck` checkte täglich `bmmmm/putzii` beim gepinnten
  `PUTZII_REF=68f95ff8` aus — ein Commit vom 2026-08-19, **32 Commits vor
  HEAD**, also vor dem gesamten Server-Umbau. Ein grüner täglicher Gate, der
  einen zwei Wochen alten Schnappschuss prüfte: er beruhigte, statt zu messen
- **`DROP_KEY_B64` und `DROP_TOKENS_SHA256` noch installiert** — genau die
  beiden Secrets, deren Löschung oben für den Drop abgehakt ist
- Pages live, publizierte `site/plans/SetupGt1.json` (verschlüsselter Stand)
- Remote-`main` `73082b9`, **20 Commits vor dem lokalen Klon** `2cf6ea7`,
  dessen `git status` trotzdem „in sync" meldete (veralteter Tracking-Ref)

Reihenfolge war Absicht: erst entwaffnen, dann löschen — so ist die
Exposition auch dann weg, wenn die Löschung scheitert.

- [x] Beide Secrets gelöscht; `actions/secrets` → `total_count: 0`
- [x] Alle neun Workflows deaktiviert → `disabled_manually`, Crons gestoppt
- [x] Pages abgeschaltet (`has_pages: false`, `GET /pages` → 404)
- [x] Vollständige Historie als Bundle gesichert
      (`~/offline_coding/_archive/putzii-drop-lab-73082b9.bundle`,
      `git bundle verify` → „complete history"), dazu die einzige nirgends
      sonst existierende Datei `runner/test-v7.mjs`
- [x] Die lab-gemessenen Fakten (V1–V7) nach `rebuild-plan.md` gerettet —
      sie begründen Design-Entscheidungen, die sonst wie Willkür aussähen
- [ ] Repo löschen: `gh repo delete bmmmm/putzii-drop-lab --yes`
      (in der Agent-Session durch eine Schutzregel gesperrt)
- [ ] `~/offline_coding/putzii-drop-lab` lokal entfernen

**Die Lehre:** ein Repo, das „Wegwerf" heißt, aber Secrets, Crons und einen
Deploy-Pfad bekommt, ist Produktion. Es taucht in keiner Liste auf, gerade
weil sein Name sagt, es sei keine wert.

---

## Danach, optional

- **MQTT direkt im Server** (Fast-Follow aus dem Plan): der Server abonniert
  `putzii/checkin/<areaId>` und ruft intern dieselbe Mint-Funktion. Nur
  sinnvoll, wenn Buttons **bei bc101** stehen — für zuhause ist der Weg über
  das Heim-HA kürzer und schon gebaut.
- **Mehrere Pläne pro Server.** Heute bewusst einer: Schlüssel und Token-Map
  sind global. Mehr braucht pro Plan eigene Schlüssel und eigene Token — eine
  eigene Arbeitseinheit, kein Nebenbei-Feature.
- **Historie ausdünnen — es gibt heute keinen wirksamen Ausweg.** Bei 500
  Events lehnt der Server jeden Push ab (Cap, Absicht). Der früher hier
  dokumentierte Weg `plan export` → bearbeiten → `plan import --force`
  **wirkt nicht**: `--force` umgeht zwar den Append-only-Guard (der Mutator
  ignoriert `cur`, `plan.go:100-121`), aber das erste Gerät mit der alten
  Historie schreibt sie beim nächsten Push vollständig zurück — `tick()`
  pullt immer zuerst (`sync.js:259`), `mergePlans` ist rein additiv
  (union-by-id, `share.js:257-262`), der folgende Push ist damit eine
  Obermenge, und der Guard feuert nur bei *Verlust* (`api.go:276-282`).
  Ein wirksames `plan compact` bräuchte einen neuen Cursor neben `rev`, eine
  Änderung an `DroppedEventIDs` **und** eine Client-Änderung, damit
  `mergePlans` den lokalen Cache unterhalb des Cursors nicht mehr für
  autoritativ hält. Eigene, große Arbeitseinheit — erst sinnvoll, wenn der
  Cap tatsächlich näher rückt. Bis dahin: nichts hier befolgen, was so tut,
  als ginge es schon.
