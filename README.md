# putzii

Minimaler Putzplan als Web-App — **kein Account, standardmäßig kein Server**.
Der komplette Plan lebt im Browser (localStorage) und wird als Link geteilt:
Der Zustand steckt gzip-komprimiert im URL-Fragment (`#p1.…`) und erreicht
nie einen Server. Check-in vor Ort per QR-Code am Putzbereich. Wer möchte,
stellt sich zusätzlich einen [eigenen kleinen Server](server/) hin, der
automatisch synchronisiert — ein Briefkasten, der nie schläft; der Plan liegt
dort AES-256-verschlüsselt.

**Live:** https://bmmmm.github.io/putzii/

## Wie es funktioniert

- **Bereiche + Intervalle**: Jeder Bereich (Küche, Bad, …) hat ein Putz-Intervall
  in Tagen. Fällig = letzter Check-in + Intervall. Ampel-Übersicht: grün / bald
  fällig / überfällig.
- **KW-Wochenplan**: Endlose Liste der Kalenderwochen (aktuelle oben), pro Woche
  ein Wochenstrahl Mo–So. Tag antippen = Putztag; pro Tag lassen sich Aufgaben
  als Bereich × Person zuordnen („Timo → Küche, Sina → Bad"). Die Übersicht
  zeigt, wer in der aktuellen KW was machen muss; Check-ins füllen die Zellen
  (✓ erledigt, „1/2" teilweise).
- **Check-in per QR**: Pro Bereich ein QR-Code zum Ausdrucken (Druckbogen in
  der App). Scannen → Name antippen → „Geputzt ✓". Doppel-Scans sind durch ein
  10-Minuten-Idempotenzfenster und eine 6-Stunden-Nachfrage abgesichert.
- **Teilen = Sync**: Nach dem Check-in „Update teilen" — der neue Link wandert
  per Share-Sheet/Messenger zum Team. Wer einen Link öffnet, **merged** ihn in
  seinen lokalen Stand (Einträge können nur dazukommen, nie umgeschrieben
  werden). Alternativ: Plan als JSON-Datei exportieren/importieren.
- **Nur-Ansicht-Link**: blendet die Verwaltung aus — reine UX-Hürde, kein
  Schutz (siehe unten).
- **Server-Sync (optional, v3)**: Ein persönlicher Zugangs-Link (`#d2.…`)
  verbindet das Gerät mit dem eigenen [putzii-server](server/): Check-ins und
  Plan-Änderungen wandern automatisch zu allen verbundenen Geräten. Der Server
  ist nur ein weiterer Peer, der nie schläft — `#p1.`-Links bleiben der
  vollwertige Offline-/Fallback-Weg, und zusammengeführt wird weiterhin im
  Browser (`mergePlans`), nicht auf dem Server.
- **Erledigt-Links und Buttons**: Ein `#k2.`-Link meldet fest vorgegebene
  Tätigkeiten als erledigt — er kann den Plan weder lesen noch überschreiben.
  Dasselbe kann ein `curl`, ein Shortcut oder eine Home-Assistant-Automation:
  `putzii-server button new` druckt den passenden Schnipsel.

## Sicherheit — ehrlich gesagt

**Wer den Link hat, hat den Plan.** Alle Bereiche, alle Namen, der geteilte
Verlauf — und kann Einträge hinzufügen und den Link weitergeben. Es gibt keine
Anmeldung, keinen Admin und keinen Widerruf; das geht ohne Server nicht.
Dafür gilt: Das Fragment (`#…`) wird nie an einen Server übertragen — auch
GitHub Pages sieht nur den Pfad, nie die Daten. Teile den Link nur mit Leuten,
die den Plan sehen dürfen.

**Der Zugangs-Link (`#d2.…`) ist ein Schlüssel.** Wer ihn hat, liest ALLES
inklusive Vergangenheit und schreibt unbegrenzt — unter jedem Namen,
nachvollziehbar im Klartext-Protokoll (health-Tail): eingetragen wird, wen
man auswählt, protokolliert wird, wer gedrückt hat. Widerruf:
`putzii-server user revoke` wirkt beim nächsten Request; was ein Gerät schon
heruntergeladen hat, bleibt dort lesbar — dafür braucht es einen neuen
Schlüssel und damit neue Links.

**Ein Erledigt-Link (`#k2.…`) ist bewusst weniger.** Er trägt einen eigenen,
nur fürs Check-in gültigen Token: er kann die aufgeführten Tätigkeiten melden
und sonst nichts — kein Lesen, kein Überschreiben. Genau deshalb darf so ein
Link an den Kühlschrank oder in eine Smart-Home-Config.

Ehrliche Restrisiken: der Serverprozess sieht den Plan im Klartext (er muss
Check-ins eintragen können) — die Verschlüsselung schützt Datenträger und
Backup, nicht vor dem Server selbst; und ein Zugangs-QR am Kühlschrank IST
der Schlüssel. Household-Trust-Werkzeug, kein Security-Produkt.

## Lokal ausprobieren

```bash
python3 -m http.server 8080          # App allein (Offline-/Link-Pfad)
# → http://localhost:8080/
```

Mit Server-Sync — der Server liefert die App gleich mit aus:

```bash
cd server && go build -o putzii-server ./cmd/putzii-server
./putzii-server plan init --app-base http://localhost:8080
./putzii-server serve --app .. --listen :8080
```

Test-Suite im Browser (DevTools-Konsole):

```js
await PZ.selfCheck.run()
```

Dieselbe Suite headless (das nutzt auch CI):

```bash
node server/tools/selfcheck.mjs .
```

## Grenzen (bewusste Entscheidungen)

- Ohne Server ist Sync manuell: Ohne „Update teilen" sieht das Team nichts.
  Der Badge „· N neu" erinnert daran (bei erreichbarem Server übernimmt der
  Server und der Zähler verschwindet).
- Server-Sync gibt es nur auf der App, die der eigene Server ausliefert — die
  Kopie auf GitHub Pages bleibt bewusst die reine Offline-Variante. Das ist
  der Preis dafür, dass die App per CSP mit genau einer Origin sprechen darf.
- Share-Links sind auf ~1.800 Zeichen budgetiert (Signal-Limit); bei großen
  Verläufen wird die geteilte Historie automatisch gekürzt — die App zeigt
  immer „Teilt X von Y Einträgen". Der Datei-Export enthält immer alles.
- iOS/Safari löscht localStorage nach 7 Tagen ohne Nutzung — als
  Home-Bildschirm-App installiert passiert das nicht, und jeder Team-Link
  stellt den Stand wieder her.
- „Rückgängig" wirkt nur lokal, solange der Eintrag noch nicht geteilt wurde.

<details>
<summary>Notizen für LLMs / Agents</summary>

- Einstieg: `CLAUDE.md` (Konventionen, Dev-Fallen), dann `share.js`
  (Wire-Codec + Merge — das Herzstück), `store.js`, `model.js`. Für den
  Server: `server/README.md` und `docs/rebuild-plan.md`.
- Invarianten: Events sind append-only, Dedup by id, first-seen-wins.
  Config-Merge ist LWW per striktem `updatedAt >`. IDs bleiben IDs (keine
  Indizes im Wire-Format). `ts` ist minutengenau quantisiert.
- Jede Änderung an einer APP_SHELL-Datei braucht einen VERSION-Bump in
  `service-worker.js` — CI (`sw-version`) erzwingt das.
- UI-Texte Deutsch, Code/Kommentare Englisch.

</details>

## Support

Wenn dir putzii nützt: [Ko-fi](https://ko-fi.com/bmabma).

## License

GPL-3.0-or-later — siehe [LICENSE](LICENSE). Gebündelte Drittsoftware:
[NOTICE](NOTICE) (QR-Generator von Project Nayuki, MIT).
