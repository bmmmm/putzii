# putzii: eigener Server statt GitHub-Drop

Design-Dokument des Umbaus vom `putzii-drop`-Relay (GitHub Actions + Pages)
auf einen selbst gehosteten Go-Server im selben Repo. Festgehalten hier, weil
die Drop-Repos stillgelegt sind und ihre Begründungen sonst mit ihnen
verschwänden.

Stand: 2026-09-02. Der Server-Code liegt in [`server/`](../server/); die
offene Arbeit steht in [`todo-cutover.md`](todo-cutover.md).

## Warum überhaupt

Der Drop war ein validierendes Relay: die App schickte per
`workflow_dispatch` ein gzip-komprimiertes Wire-Envelope, ein GitHub-Actions-
Runner führte `mergePlans` aus dem gepinnten putzii-Commit aus und legte den
verschlüsselten Stand auf GitHub Pages ab. Das funktionierte — mit zwei
Schwachstellen, die im Betrieb sichtbar wurden:

1. **Öffentliche Sichtbarkeit.** Die State-Dateien lagen auf einer
   öffentlichen Pages-Site. Verschlüsselt, aber für jeden abrufbar: wer die
   URL kannte, konnte Ciphertext, Revisionszähler und den Audit-Tail
   mitlesen — also Zeitpunkte und Häufigkeit jeder Aktivität.
2. **Der PAT als physisches Bearer-Secret.** Jeder Zugangs- und Bestätigungs-
   Link trug einen fine-grained PAT mit `Actions: write`. Der landete damit in
   Kühlschrank-QR-Codes und Smart-Home-Configs. Und `#k1.`-Bestätigungslinks
   trugen zusätzlich den **vollen Schreib-Token** der Person — im Code als
   offener Punkt vermerkt, nie behoben.

Beides ist keine Frage besserer Hygiene, sondern der Architektur: ein Relay
ohne eigene Identitätsprüfung kann nicht weniger preisgeben. Also: eigener
Server, echte Token-Prüfung, State nicht mehr öffentlich.

## Getroffene Entscheidungen

1. **Ein Repo.** `bmmmm/putzii` enthält App und Server. Damit entfällt der
   gepinnte Commit (`PUTZII_REF`) und mit ihm die ganze Drift-Mechanik —
   Parität ist jetzt eine Build-Eigenschaft (siehe „Parität" unten).

   Wie nötig das war, hat sich beim Aufräumen gezeigt: `putzii-drop-lab` hielt
   ein solches `PUTZII_REF` noch bis zum 2026-09-02 und testete damit täglich
   einen Commit, der 32 hinter `main` lag — grün, und ohne jede Aussage über
   den heutigen Code. Genau diese Klasse von Selbstberuhigung fällt mit einem
   Repo weg.
2. **Der Server ist alleinige Quelle der Wahrheit** für den Server-Pfad.
   `mergePlans` bleibt exakt dort, wo es schon lief: clientseitig in
   `share.js`. Der Server führt es nie aus.
3. **Go.** Die ISO-Wochen-Helfer in `helpers.js` (DST-Tage, 53-Wochen-Jahre,
   Jahreswechsel) werden bewusst **nicht** nach Go portiert — der Server
   braucht sie nicht. Portiert ist nur das Check-in-Minting, und dessen
   Semantik ist per Golden-Vektor an die App gebunden.
4. **Verschlüsselung bleibt** (AES-256-GCM at rest). Der Serverprozess hält
   den Schlüssel, weil er für das Check-in-Minting entschlüsseln muss — genau
   wie vorher die Actions-Runtime. Verschlüsselung schützt hier den
   Datenträger und das Backup, nicht vor dem Server selbst.
5. **Erreichbar über `putzii.bc101.de`** (Traefik + Let's Encrypt auf
   `dockworker2`). Was schützt, ist die Token-Prüfung im Server, nicht die
   Netzwerkposition — deshalb war *öffentlich* erreichbar geplant: Check-ins
   laufen über verteilte WiFi-/MQTT-Buttons und QR-Codes in einem Haushalt,
   der kein LAN mit bc101 teilt, und Tailscale auf jedem Button ist
   unrealistisch.

   **Revidiert am 2026-09-02: der Betrieb ist Tailnet-only.** Kein
   Port-Forward, kein öffentlicher A-Record, kein Tunnel ins geteilte
   bc101-Netz. Der Dienst ist damit intern beweisbar, aber ein Haushaltshandy
   im Mobilfunk erreicht ihn nicht. Das ist keine offene Aufgabe, sondern eine
   getroffene Entscheidung — und sie blockiert die Runbook-Schritte 3 und 4
   (Links/QRs neu ausgeben, Home Assistant anbinden). Bis sie fällt, teilt der
   Haushalt weiter offline per `#p1.`. Das Zertifikat kostet die Entscheidung
   nichts: Traefik nutzt dort die Cloudflare-DNS-01-Challenge, nicht HTTP-01.
6. **MQTT/Home Assistant: v1 nur der HTTP-Webhook.** HA und ein MQTT-Broker
   laufen zuhause bereits produktiv (`10.0.20.3`). Die Trigger-Logik bleibt
   dort; eine HA-Automation ruft `POST https://putzii.bc101.de/api/checkin`.
   Ein MQTT-Subscriber im Server selbst ist als Fast-Follow denkbar, aber
   nicht v1-kritisch: der Webhook deckt Buttons, WLAN-Geräte und QR ab.

## Was gegenüber dem ursprünglichen Plan anders gebaut wurde

Vier Stellen wurden während der Umsetzung anders entschieden — jeweils, weil
die einfachere Variante zusätzlich eine Invariante rettet.

**Der Link trägt keine Server-URL mehr.** Geplant war „Repo + DropBase → eine
Server-URL". Tatsächlich ist die URL überflüssig: der Server liefert die App
selbst aus, also ist die API-Basis `location.origin`. Das macht Links kürzer
(wichtig für QR-Codes), entfernt eine Rotationsbaustelle — und erlaubt CSP
`connect-src 'self'` statt einer Origin-Allowlist. Die App kann damit
konstruktiv nur noch mit dem Server sprechen, der sie ausgeliefert hat.
Konsequenz: die GitHub-Pages-Kopie der App bleibt die reine Offline-Variante
(`#p1.`-Links); Server-Sync gibt es nur auf der eigenen Instanz.

**Das Speicherlayout bleibt das des Drops.** Geplant war
`data/<planId>/state.json`; gebaut ist `data/plans/<planId>.json` +
`data/health.json` — identisch zur veröffentlichten Drop-Site. Die einmalige
Zustandsmigration ist dadurch ein Dateikopie, kein Konvertierungsschritt.

**PUT überschreibt, aber append-only.** Der Server merged nicht. Das ist nur
solange gefahrlos, wie das Event-Log wächst: ein Client, der weniger Events
schickt, als der Server hat, hat Historie verloren (gekappter Payload,
halb-gemergter Plan, alte App-Version). Der Server lehnt so einen Write mit
`events-dropped` ab, statt das Log zu löschen. Entsprechend kappt `sync.js`
den Push **nicht** mehr adaptiv — der 64-kB-Budget ist jetzt eine
Ablehnungsschwelle, kein Ziel.

**Konflikte löst der Client.** Ein PUT trägt `baseRev`; passt der nicht,
antwortet der Server 409 mit der aktuellen Revision. `sync.js` zieht dann neu
(was den fremden Stand lokal einmergt) und pusht erneut — konvergiert
innerhalb eines Ticks. Genau deshalb bleibt `mergePlans` im Client: der
Server muss nie versöhnen.

## Zielarchitektur

### Endpunkte

Alles unter der Origin, die auch die PWA ausliefert. Authentifizierung per
`Authorization: Bearer <token>`; `POST /api/checkin` akzeptiert den Token
zusätzlich als Formularfeld, damit ein HTML-Formular ohne JS funktioniert.

| Endpunkt | Scope | Zweck |
|---|---|---|
| `GET /api/state/:planId` | write | Ciphertext-Blob; der Client entschlüsselt selbst |
| `PUT /api/state/:planId` | write | Voller Plan als `b64url(gzip(wire))` + `baseRev` |
| `POST /api/checkin` | write **oder** checkin | Server-gemintetes Event (JSON oder Formular) |
| `GET /api/health/:planId` | write | Audit-Tail, gleiche JSON-Form wie vorher |
| `GET /api/healthz` | — | Liveness fürs Blackbox-Monitoring, sagt nichts über den Plan |
| `/` | — | die bestehende PWA (`http.FileServer`) |

### Reihenfolge im Request — das ist das Sicherheitsdesign

1. Body begrenzen, IDs auf Form prüfen (kein Angreifer-Payload geparst)
2. **AUTH**: Token hashen, konstantzeitig vergleichen, Person **und** Scope
   daraus ableiten. Ein Check-in-Token erreicht `state` nie.
3. Erst jetzt Payload dekodieren: b64url → gunzip (gedeckelt) → Slot-Check →
   `planFromWire`-Äquivalent → Caps
4. Replay-Guard (Nonce im Tail → grüner No-op), Rate-Guard, atomarer Write
5. Antworten und Logs tragen **nur Zählwerte** — nie Namen, nie Payload

### Zwei Token pro Person

`user.<id>.token` (voll, im `#d2.`-Link) und `user.<id>.checkin_token` (nur
Check-in, im `#k2.`-Link und in Buttons). Das schließt die dokumentierte
`#k1.`-Lücke: ein Link am Kühlschrank kann den Plan weder lesen noch
überschreiben.

### Linkformate

```
#d2.  [2, planId, personId, personName, token, encKey]
#k2.  [2, planId, personId, personName, checkinToken, [[areaId, label], …]]
```

v1-Links (`#d1.`/`#k1.`) werden **erkannt und benannt**, nicht bloß
abgelehnt — die App sagt „alter Link", nicht „kaputter Link".

## Parität statt Pin

Der Drop führte App-Code aus einem gepinnten Commit aus; Invariante 13 des
alten `CLAUDE.md` verlangte deshalb nach jeder Wire-Änderung ein
`dropii pin`, plus einen täglichen Driftcheck. Das entfällt vollständig.

Stattdessen: CI **regeneriert** in jedem Push aus dem Arbeitsbaum

- Krypto-Vektoren (Node → Go **und** Go → Node, drei Wege),
- das Wire-Golden inklusive des exakten Payloads, den `sync.js` PUTet,
- die Check-in-Semantik (`model.existsRecent`, Event-ID-Ordnung) als
  Golden-Fälle,

und prüft die Go-Implementierung dagegen. Eine Wire-Änderung ohne Go-Pendant
geht in demselben Push rot, in dem sie entsteht. Zusätzlich läuft alles unter
`TZ=Europe/Berlin` und `TZ=UTC` — die Divergenz ist real (Sonntag 22:30 UTC
ist in Berlin schon Montag, also die nächste ISO-Woche).

## Migration

Erledigt: dieses Dokument liegt im Repo; die Go-Bausteine (dropcrypto, wire,
config, link) sind übernommen und um Caps, Replay-/Rate-Guard, Check-in-Minting
und Paritäts-Tests ergänzt; der Client ist umgestellt (`sync.js`, `drop.js`,
CSP, `c.html`) und der Self-Check läuft headless.

Seither ebenfalls erledigt: der Deploy auf `dockworker2` (2026-09-02) und die
Stilllegung beider Drop-Repos — `putzii-drop` archiviert, `putzii-drop-lab`
entschärft und gelöscht.

Was bleibt — einmalige Zustandsübernahme, Link- und QR-Neuausgabe,
HA-Anbindung — steht **nur** in [`todo-cutover.md`](todo-cutover.md), mit
Reihenfolge, Kommandos und dem jeweiligen Blocker. Eine zweite Liste hier
würde bloß auseinanderlaufen.

## Verifikation

Was heute grün ist:

- Go-Suite (`go test ./...` in `server/`) unter Berlin **und** UTC: Auth vor
  Payload-Decode, Scope-Trennung, Replay, Rate-Guard, Rev-Konflikt,
  Append-only-Guard, Caps-Grenzfälle, AAD-Bindung, frischer IV pro Write,
  „Health enthält nur Zählwerte", Formular-Pfad ohne JS.
- Drei-Wege-Krypto-Parität Node ↔ Go.
- Wire-Golden: Go reproduziert das kanonische Envelope der App exakt,
  inklusive des Payloads, den `sync.js` tatsächlich sendet.
- Check-in-Parität gegen `model.existsRecent` und die Event-ID-Ordnung.
- App-Self-Check headless (`node server/tools/selfcheck.mjs .`), unter Berlin
  und UTC.
- CLI end-to-end gegen echten State: `plan init/import/export/show`,
  `user add` (Namens-Match behält die Attribution), `link user`,
  `link checkin`, `qr --sheet`, `button new`, `status`, `doctor`.

Was erst am Deploy beweisbar ist: Erreichbarkeit und Zertifikat von außen,
die HA-Kette Button → Heim-MQTT → Webhook → bc101, und ein Zugriff ohne
gültigen Token gegen die echte Instanz.

## Anhang: was das Lab gemessen hat (2026-08-20)

Diese Zahlen stammen aus `putzii-drop-lab`, einem Wegwerf-Repo mit sieben
Sonden gegen die echte GitHub-Actions-Plattform. Repo und Klon sind am
2026-09-02 gelöscht worden; die Messungen stehen hier, weil sie mehrere
heutige Design-Entscheidungen tragen — ohne sie liest sich der Code an diesen
Stellen wie Willkür.

- **V1 — eine Concurrency-Gruppe hat genau EINEN wartenden Slot.** Vier
  schnelle Dispatches: Lauf 2 und 3 wurden gecancelt, nur der erste und der
  letzte überlebten. *Trägt:* dass Mutationen nie über Concurrency-Gruppen
  serialisiert wurden. Für reine Deploys ist `cancel-in-progress: true`
  dagegen korrekt (der neueste Stand enthält alles).
- **V3 — das Input-Kliff von `workflow_dispatch` liegt bei 65.006 Zeichen**
  (65.535 → HTTP 422 „inputs are too large"), also *unterhalb* des
  dokumentierten Werts. Alle Payloads von 8 bis 65 kB kamen byte-verlustfrei
  an (sha256 im Runner-Log geprüft). *Trägt:* dass nie gechunkt wurde — das
  Envelope liegt bei 3–11 kB.
- **V4 — `workflow_run` feuert zuverlässig**, 10 von 10, Latenz ~1–2 s,
  Dispatch bis fertigen Follower 21–28 s. *Trägt:* das Zwei-Workflow-Muster
  (schreiben, dann deployen) statt eines Monolithen.
- **V5 — Query-Param-Cache-Busting auf GitHub Pages ist WIRKUNGSLOS.** Ein
  eindeutiges `?b=` wurde weiterhin mit `x-cache: HIT` aus demselben Objekt
  beantwortet: der Query-String ist nicht Teil des Cache-Keys. Ein Deploy
  purged die Edge dagegen sofort. *Trägt:* dass der Lesepfad der App
  `cache:"no-store"` benutzt und **keinen** Bust-Parameter — und dass es nie
  unveränderliche Rev-Pfade brauchte.
- **V7 — die App-Module laufen unverändert in Node** (`node:vm` mit nacktem
  `window`), inklusive Wire-Round-Trip, Merge-Idempotenz und gzip-Byte-Parität.
  Drei Details, die bis heute gelten:
  - **Die TZ-Divergenz ist real.** Sonntag 22:30 UTC ist in Berlin bereits
    Montag 00:30 — `isoWeekKey` sagt dann `2026-W34` (UTC) gegen `2026-W35`
    (Berlin). *Trägt:* `TZ=Europe/Berlin` im Dockerfile, in `ci.yml` und die
    doppelten Läufe unter beiden Zonen in `scripts/check.sh`.
  - **Cross-Realm-`instanceof`-Falle.** `isoWeekKey` prüft `d instanceof
    Date`; ein im Node-Realm gebautes `Date` fällt in der vm-Realm durch
    diese Prüfung. *Trägt:* dass `server/tools/loadapp.mjs` den `Date`-
    Konstruktor in die Sandbox hineinreicht — nicht entfernen.
  - 2026 hat **53 ISO-Wochen** (es beginnt an einem Donnerstag), `2026-W53`
    ist gültig.
- **V2/V6 — die PAT-Rechteproben.** Ein Dispatch mit absichtlich fehlenden
  Pflicht-Inputs liefert 422 und beweist damit `Actions: write`, ohne einen
  Lauf zu starten; Contents-Write und Secrets-Read kamen als 403 zurück.
  *Trägt:* die Erkenntnis, dass ein Relay-PAT ein physisches Bearer-Secret in
  Kühlschrank-QR-Codes ist — einer der zwei Gründe für den ganzen Umbau
  (siehe „Warum überhaupt").
