# putzii-server

Der selbst gehostete Server für putzii — HTTP-API **und** Admin-CLI in einem
Binary, ohne Fremdabhängigkeiten. Er liefert dieselbe PWA aus, die auch
offline läuft; es gibt keine zweite Oberfläche.

Warum es ihn gibt und was am ursprünglichen Entwurf anders gebaut wurde:
[`docs/rebuild-plan.md`](../docs/rebuild-plan.md).

## Was er tut

- speichert **einen** Plan verschlüsselt (AES-256-GCM, frischer IV pro
  Schreibvorgang, AAD bindet an die planId)
- prüft Personen-Token selbst — mit zwei Stufen: `write` (voller Zugriff) und
  `checkin` (nur Erledigt-Meldungen, kein Lesen, kein Überschreiben)
- mintet Check-in-Events serverseitig, damit ein dummer Button, ein
  `curl`-Aufruf oder eine Home-Assistant-Automation ohne Plan-Kenntnis
  auslösen kann
- führt einen Audit-Tail (50 Einträge, **nur Zählwerte** — nie Namen, nie
  Payload) und wehrt Replays und Schreibfluten ab

Was er **nicht** tut: mergen. `mergePlans` läuft im Client, wo es immer lief.
Der Server lehnt einen veralteten Write ab (409 mit aktueller Revision), der
Client zieht, mergt lokal und pusht erneut.

## Einrichten

```bash
go build -o putzii-server ./cmd/putzii-server

./putzii-server plan init --app-base https://putzii.example.de
./putzii-server user add --name "Sina"           # druckt den #d2.-Link
./putzii-server plan import --file putzii-export.json
./putzii-server serve --app ..
```

`plan init` legt `putzii-server.conf` (0600) an: State-Schlüssel, planId,
Basis-URL. Die Datei **hält Geheimnisse** und ist gitignored — nur
`putzii-server.conf.example` ist eingecheckt.

Tokens stehen dort im Klartext. Das ist Absicht: dieselbe Datei enthält
ohnehin den AES-Schlüssel, Hashing würde für niemanden die Hürde erhöhen, der
sie lesen kann — und der Klartext ist, was `link user` später erlaubt, den
Zugangs-Link einer Person erneut zu drucken statt eine Rotation zu erzwingen.
Authentifiziert wird trotzdem nie im Klartext: der präsentierte Token wird
gehasht und konstantzeitig mit dem gespeicherten Hash verglichen.

## Kommandos

| Kommando | Zweck |
|---|---|
| `serve` | HTTP-Server (API + PWA) |
| `plan init \| import \| export \| show` | Plan-Zustand: anlegen, seeden, sichern, ansehen |
| `user add \| list \| revoke` | Zugriff verwalten (mintet beide Token) |
| `link user \| checkin` | `#d2.`- und `#k2.`-Links rendern |
| `qr --areas \| --user \| --sheet` | druckbare QR-Codes |
| `button new --kind curl\|ha\|shortcut\|http` | Webhook-Snippets (immer mit dem Check-in-Token) |
| `status` | Revision, Frische, Audit-Tail |
| `doctor` | Konfiguration, Dateirechte, State- und App-Sanity |
| `config path \| template` | Konfigurationspfad / Vorlage |

`user add --name X` gleicht den Namen gegen die **lebenden Personen im Plan**
ab und übernimmt eine vorhandene personId — so bleibt die Historie zugeordnet.
Eine wirklich neue Person wird direkt in den State geschrieben.

## API

Alles unter der Origin, die auch die App ausliefert. Auth per
`Authorization: Bearer <token>`.

```
GET  /api/state/:planId    → {v,alg,iv,ct,rev,at}   (Ciphertext; Client entschlüsselt)
PUT  /api/state/:planId    ← {nonce, baseRev, payload}
POST /api/checkin          ← {planId, personId, areaId, nonce}   JSON oder Formular
GET  /api/health/:planId   → {rev, at, tail:[…50]}
GET  /api/healthz          → {"ok":true}            (ohne Auth, fürs Monitoring)
```

`payload` ist `b64url(gzip(<wire envelope>))` — exakt das, was `sync.js`
erzeugt. Der Server sanitisiert es durch denselben Codec wie einen fremden
Link, prüft die Caps und verschlüsselt dann.

`POST /api/checkin` antwortet HTML statt JSON, wenn der Request `text/html`
akzeptiert — das ist der Pfad für ein Formular ohne JavaScript.

### Reihenfolge im Request

Die Reihenfolge **ist** das Sicherheitsdesign, übernommen aus dem alten
Runner: Body begrenzen und IDs auf Form prüfen → **authentifizieren** (Person
und Scope kommen aus dem Token) → erst dann den Payload dekodieren → Guards →
atomarer Write. Ein Check-in-Token erreicht `state` nie, und ein falscher
Token bekommt 401, bevor ein einziges Payload-Byte geparst wurde.

## Grenzen (Caps)

Eine Verletzung verwirft den **ganzen** Request, sie kürzt nie:
Payload ≤ 64 kB, Dekomprimiert ≤ 512 kB, Events ≤ 500, Areas/People ≤ 200,
Wochen ≤ 400. Die Rate-Bremse greift bei anhaltend > 1 Write/Minute.

Ein Haushalt, der an die 500 Events stößt, kann nicht mehr pushen — das ist
gewollt und war im Drop genauso. Der Ausweg ist Ausdünnen über
`plan export` → bearbeiten → `plan import --force`.

## Deploy

`Dockerfile` und `docker-compose.yml` liegen hier; der Build-Kontext ist das
**Repo-Root**, weil das Image Binary *und* App-Dateien bündelt. Das
Compose-File zielt auf `dockworker2` in bc101 (Traefik-Labels, externes
`traefik`-Netz) — dasselbe Muster wie die anderen Dienste dort.

```bash
docker build -f server/Dockerfile -t putzii-server .
```

Zu sichern ist genau ein Verzeichnis: `data/` (Konfiguration + verschlüsselter
State). `git_audit = true` committet zusätzlich jeden Write in ein
`data/.git`, falls dort eines liegt — ein fehlschlagender Commit kostet nie
einen Check-in.

## Entwickeln

```bash
go test ./...                                     # inkl. Node↔Go-Parität
node tools/selfcheck.mjs ..                       # App-Suite headless
node tools/gen-golden.mjs internal/wire/testdata/golden.json ..
```

Die Golden-Dateien werden in CI **aus dem Arbeitsbaum regeneriert**, nie von
Hand gepflegt: eine Wire-Änderung ohne Go-Pendant geht in demselben Push rot.
Alles läuft unter `TZ=Europe/Berlin` und `TZ=UTC` — die Divergenz ist real.
