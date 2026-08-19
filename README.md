# putzii

Minimaler Putzplan als Web-App — **kein Backend, kein Server, kein Account**.
Der komplette Plan lebt im Browser (localStorage) und wird als Link geteilt:
Der Zustand steckt gzip-komprimiert im URL-Fragment (`#p1.…`) und erreicht
nie einen Server. Check-in vor Ort per QR-Code am Putzbereich.

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

## Sicherheit — ehrlich gesagt

**Wer den Link hat, hat den Plan.** Alle Bereiche, alle Namen, der geteilte
Verlauf — und kann Einträge hinzufügen und den Link weitergeben. Es gibt keine
Anmeldung, keinen Admin und keinen Widerruf; das geht ohne Server nicht.
Dafür gilt: Das Fragment (`#…`) wird nie an einen Server übertragen — auch
GitHub Pages sieht nur den Pfad, nie die Daten. Teile den Link nur mit Leuten,
die den Plan sehen dürfen.

## Lokal ausprobieren

```bash
python3 -m http.server 8080
# → http://localhost:8080/
```

Test-Suite im Browser (DevTools-Konsole):

```js
await PZ.selfCheck.run()
```

## Grenzen (bewusste Entscheidungen)

- Sync ist manuell: Ohne „Update teilen" sieht das Team nichts. Der Badge
  „· N neu" erinnert daran.
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
  (Wire-Codec + Merge — das Herzstück), `store.js`, `model.js`.
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
