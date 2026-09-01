# TODO: Cutover auf den eigenen Server

Der Code ist fertig und auf `main` (siehe [`rebuild-plan.md`](rebuild-plan.md)
für die Entscheidungen). Was hier steht, braucht echte Infrastruktur oder
Handgriffe am Haushalt — nichts davon lässt sich am Schreibtisch beweisen.

Die Reihenfolge ist bindend: 1 → 2 → 3. Schritt 4 und 5 gehen danach in
beliebiger Reihenfolge, 5 erst, wenn 3 nachweislich funktioniert.

---

## 1. Deploy auf bc101 (`dockworker2`)

**Vorher prüfen**

- [ ] DNS `putzii.bc101.de` zeigt auf den bc101-Eingang
- [ ] Traefik läuft auf `dockworker2`, externes Netz `traefik` existiert
      (dasselbe Muster wie `git.bc101.de` / `cloud.bc101.de`)

**Achtung: das Image ist noch nie als Container gelaufen.** CI baut es bei
jedem Push (Job `docker` in `ci.yml`, inklusive der `COPY`-Zeile, die jede
App-Datei namentlich listet) — aber Start, Volume-Rechte und Traefik sind
hier der erste echte Test.

```bash
# auf dockworker2, im Repo-Checkout
mkdir -p server/data
chmod 700 server/data
# Der Container läuft als uid 10001 (nicht root) — ohne das schlägt schon
# `plan init` mit "permission denied" fehl.
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
3. [ ] `putzii-server status` zeigt `rev 1` und plausible Zählwerte

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

## 5. putzii-drop stilllegen

Erst, wenn Schritt 3 auf allen Geräten nachweislich läuft.

- [ ] Workflows im Drop-Repo deaktivieren (`apply.yml`, `pages.yml`,
      `selfcheck.yml`, `driftcheck.yml`)
- [ ] **PAT löschen** — er läuft sonst bis 2027-08-17 weiter und steckt noch
      in jedem alten Link
- [ ] Secrets löschen (`DROP_KEY_B64`, `DROP_TOKENS_SHA256`)
- [ ] Repo archivieren; die Löschung macht der Nutzer selbst
- [ ] `~/offline_coding/putzii-drop` lokal aufräumen, wenn nichts mehr
      gebraucht wird

---

## Danach, optional

- **MQTT direkt im Server** (Fast-Follow aus dem Plan): der Server abonniert
  `putzii/checkin/<areaId>` und ruft intern dieselbe Mint-Funktion. Nur
  sinnvoll, wenn Buttons **bei bc101** stehen — für zuhause ist der Weg über
  das Heim-HA kürzer und schon gebaut.
- **Mehrere Pläne pro Server.** Heute bewusst einer: Schlüssel und Token-Map
  sind global. Mehr braucht pro Plan eigene Schlüssel und eigene Token — eine
  eigene Arbeitseinheit, kein Nebenbei-Feature.
- **Historie ausdünnen.** Bei 500 Events lehnt der Server jeden Push ab (Cap,
  Absicht). Ausweg heute: `plan export` → bearbeiten → `plan import --force`.
  Ein `plan compact --keep-days N` wäre die bequemere Variante.
