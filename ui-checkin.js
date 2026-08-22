// SPDX-License-Identifier: GPL-3.0-or-later
// c.html: the check-in mini page. Deliberately self-contained (helpers, store,
// model, share only) — this is the one flow someone hits cold, on mobile data,
// in a hallway.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;
  const M = () => PZ.model;
  const S = () => PZ.store;

  const state = {
    planId: "",
    areaId: "",
    personId: "",
    override: false, // cooldown "Trotzdem eintragen" clicked
    shared: false,
    undoTimer: 0,
    cachedShareUrl: null,
  };

  function root() {
    return document.getElementById("checkin-root");
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function card(statusClass) {
    const c = el("div", `checkin-card${statusClass ? " " + statusClass : ""}`);
    root().textContent = "";
    root().appendChild(c);
    return c;
  }

  // Precompute the share URL so the button's click handler can call
  // navigator.share() SYNCHRONOUSLY (Safari drops the user activation on any
  // await before the call).
  function precomputeShare(plan) {
    state.cachedShareUrl = null;
    PZ.share.buildShareUrl(plan, { viewer: false }).then((entry) => {
      state.cachedShareUrl = entry;
    });
  }

  function shareUpdate() {
    const entry = state.cachedShareUrl;
    if (!entry) {
      H().showToast("Link wird noch berechnet — gleich nochmal tippen.");
      return;
    }
    if (entry.band === "red") {
      H().showToast("Plan zu groß für einen Link — auf der Hauptseite als Datei exportieren.");
      return;
    }
    const done = () => {
      state.shared = true;
      const plan = S().loadPlan(state.planId);
      if (plan) S().setLastSharedAt(plan.planId, Date.now());
      const undoBtn = document.getElementById("btn-undo");
      if (undoBtn) undoBtn.remove();
    };
    const payload = { title: "putzii", text: "Plan aktualisiert", url: entry.url };
    if (navigator.share && (!navigator.canShare || navigator.canShare(payload))) {
      navigator
        .share(payload)
        .then(done)
        .catch((e) => {
          if (!e || e.name !== "AbortError") {
            navigator.clipboard
              .writeText(entry.url)
              .then(() => {
                done();
                H().showToast("Link kopiert ✓");
              })
              .catch(() => H().showToast("Teilen fehlgeschlagen."));
          }
        });
    } else {
      navigator.clipboard
        .writeText(entry.url)
        .then(() => {
          done();
          H().showToast("Link kopiert ✓");
        })
        .catch(() => H().showToast("Teilen fehlgeschlagen — Link auf der Hauptseite kopieren."));
    }
  }

  function findOrCreatePerson(plan, rawName) {
    const clean = H().normalizeName(rawName);
    if (!clean) return null;
    const existing = plan.people.find(
      (p) => !p.deletedAt && p.name.toLowerCase() === clean.toLowerCase(),
    );
    if (existing) return existing;
    let id;
    do {
      id = H().randomId(4);
    } while (plan.people.some((p) => p.id === id));
    const now = S().nowSec();
    const person = { id, name: clean, createdAt: now, updatedAt: now, deletedAt: 0 };
    plan.people.push(person);
    plan.updatedAt = now;
    return person;
  }

  function renderError(message, hint) {
    const c = card();
    c.appendChild(el("h2", "", "Hmm."));
    c.appendChild(el("p", "", message));
    if (hint) c.appendChild(el("p", "muted", hint));
    const back = el("a", "btn", "Zur Übersicht");
    back.href = "index.html#uebersicht";
    c.appendChild(back);
  }

  function renderDeletedArea(plan, area) {
    const c = card();
    c.appendChild(el("h2", "", area.name));
    c.appendChild(el("p", "", "Dieser Bereich wurde gelöscht."));
    const btn = el("button", "btn btn-primary", "Wieder aktivieren");
    btn.type = "button";
    btn.addEventListener("click", () => {
      const now = S().nowSec();
      area.deletedAt = 0;
      area.updatedAt = now;
      plan.updatedAt = now;
      if (S().savePlan(plan)) renderContext(plan, area);
      else H().showToast("Speichern fehlgeschlagen — Speicher voll?");
    });
    c.appendChild(btn);
  }

  function renderPersonPicker(c, plan, area) {
    c.appendChild(el("p", "", "Wer hat geputzt?"));
    const grid = el("div", "person-grid");
    const creds = PZ.drop ? PZ.drop.getCreds(plan.planId) : null;
    const me = S().getMe(plan.planId) || (creds ? creds.personId : "");
    // Current-week duty for this area: that person sorts first with a
    // "geplant" hint — never auto-selected.
    const now = Date.now();
    const plannedTask = M()
      .weekTasks(plan, M().currentWeekKey(now), now)
      .find((t) => t.areaId === area.id && t.personId);
    const planned = plannedTask ? plannedTask.personId : "";
    const people = M().livePeople(plan).slice();
    const rank = (p) => (p.id === planned ? -2 : 0) + (p.id === me ? -1 : 0);
    people.sort((a, b) => rank(a) - rank(b));
    const confirmBtn = el("button", "btn btn-primary big-confirm", "Geputzt ✓");
    confirmBtn.type = "button";
    confirmBtn.disabled = true;

    function select(personId, name) {
      state.personId = personId;
      grid.querySelectorAll("button").forEach((b) => b.classList.remove("selected"));
      const btn = grid.querySelector(`button[data-person="${personId}"]`);
      if (btn) btn.classList.add("selected");
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Geputzt ✓ — als ${name}`;
    }

    for (const person of people) {
      const btn = el("button", "btn", person.id === planned ? `${person.name} · geplant` : person.name);
      btn.type = "button";
      btn.dataset.person = person.id;
      btn.addEventListener("click", () => {
        // Remember only on an explicit tap — the auto-preselect path below
        // must neither write nor toast.
        if (S().getMe(plan.planId) !== person.id) {
          S().setMe(plan.planId, person.id);
          H().showToast(`Als ${person.name} gemerkt — änderbar unter Verwalten.`);
        }
        select(person.id, person.name);
      });
      grid.appendChild(btn);
    }
    const other = el("button", "btn", "+ Anderer Name");
    other.type = "button";
    other.addEventListener("click", () => {
      other.remove();
      const row = el("div", "form-row");
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 40;
      input.placeholder = "Dein Name";
      input.addEventListener("input", () => {
        const clean = H().normalizeName(input.value);
        state.personId = "";
        state.newName = clean;
        confirmBtn.disabled = !clean;
        confirmBtn.textContent = clean ? `Geputzt ✓ — als ${clean}` : "Geputzt ✓";
      });
      row.appendChild(input);
      c.insertBefore(row, confirmBtn);
      input.focus();
    });
    grid.appendChild(other);
    c.appendChild(grid);

    confirmBtn.addEventListener("click", () => confirmCheckin(plan, area));
    c.appendChild(confirmBtn);

    // Known identity on this device (drop credential beats remembered
    // pick): pre-select — the grid stays visible so covering for someone
    // else is one tap away.
    const mine = S().resolveMe(plan, creds ? creds.personId : "");
    if (mine) select(mine.id, mine.name);
  }

  function confirmCheckin(plan, area) {
    const now = Date.now();
    let person = state.personId ? M().personById(plan, state.personId) : null;
    if (!person && state.newName) person = findOrCreatePerson(plan, state.newName);
    if (!person) return;
    // Idempotency: double-scan / back-button-resubmit within the window
    // appends nothing and shows the existing entry.
    if (M().existsRecent(plan, area.id, person.id, now)) {
      S().setMe(plan.planId, person.id);
      renderResult(plan, area, null, person, { already: true });
      return;
    }
    const ev = S().newEvent(plan, area.id, person.id, now);
    if (!S().appendEvents(plan, [ev])) {
      H().showToast("Speichern fehlgeschlagen — Speicher voll?");
      return;
    }
    // Server push AFTER the local write — the QR flow is the reason c.html
    // loads sync.js at all.
    if (PZ.sync && PZ.sync.connected(plan.planId)) PZ.sync.markDirty(plan.planId);
    S().setMe(plan.planId, person.id);
    const pending = S().getPending();
    if (pending && pending.planId === plan.planId && pending.areaId === area.id) {
      S().clearPending();
    }
    renderResult(plan, area, ev, person, {});
  }

  function renderResult(plan, area, ev, person, opts) {
    const c = card();
    c.appendChild(el("p", "result-check", `${area.name} ✓`));
    if (opts.already) {
      c.appendChild(el("p", "", `Schon eingetragen — ${person.name} ist bereits vermerkt.`));
    } else {
      c.appendChild(el("p", "", `Eingetragen von ${person.name} · gerade eben`));
    }
    const status = M().areaStatus(area, ev || M().lastCheckinByArea(plan, Date.now()).get(area.id), Date.now());
    c.appendChild(el("p", "muted", `Nächste Reinigung: ${H().formatDayShort(status.dueAt)}`));

    precomputeShare(plan);
    const shareBtn = el("button", "btn btn-primary big-confirm", "Update teilen");
    shareBtn.type = "button";
    shareBtn.addEventListener("click", shareUpdate);
    c.appendChild(shareBtn);

    if (ev && !opts.already) {
      let remaining = 60;
      const undoBtn = el("button", "btn big-confirm", `Rückgängig (${remaining})`);
      undoBtn.type = "button";
      undoBtn.id = "btn-undo";
      undoBtn.addEventListener("click", () => {
        clearInterval(state.undoTimer);
        if (S().removeEvent(plan, ev.id)) {
          H().showToast("Eintrag entfernt.");
          state.personId = "";
          state.newName = "";
          renderContext(plan, area);
        }
      });
      c.appendChild(undoBtn);
      clearInterval(state.undoTimer);
      state.undoTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0 || state.shared) {
          clearInterval(state.undoTimer);
          undoBtn.remove();
          return;
        }
        undoBtn.textContent = `Rückgängig (${remaining})`;
      }, 1000);
    }
    if (PZ.sync && PZ.sync.connected(plan.planId)) {
      const dropLine = el("p", "muted", "Server: wird gesendet…");
      dropLine.id = "checkin-drop-line";
      c.appendChild(dropLine);
      PZ.sync.onChanged = (st) => {
        const line = document.getElementById("checkin-drop-line");
        if (!line) return;
        if (st.state === "idle" && !st.dirty) line.textContent = "Server ✓ synchron — ist bei allen.";
        else if (st.state === "queued") line.textContent = "Server: wird nachgeholt, sobald online.";
        else if (st.state === "error") line.textContent = "Server nicht erreichbar — Eintrag ist lokal gesichert.";
      };
    } else {
      c.appendChild(el("p", "muted", "Ohne Teilen sehen die anderen den Eintrag nicht."));
    }
    const link = el("a", "", "Zur Übersicht");
    link.href = "index.html#uebersicht";
    c.appendChild(link);
  }

  function renderContext(plan, area) {
    const now = Date.now();
    const last = M().lastCheckinByArea(plan, now).get(area.id) || null;
    const status = M().areaStatus(area, last, now);
    const c = card(`status-${status.status}`);
    c.appendChild(el("h2", "", area.name));
    const lastText = last
      ? `Alle ${area.intervalDays} Tage · Zuletzt: ${M().personName(plan, last.personId)}, ${H().formatRelPast(M().effTs(last.ts, now), now)}`
      : `Alle ${area.intervalDays} Tage · Noch nie geputzt`;
    c.appendChild(el("p", "muted", lastText));
    c.appendChild(el("p", "due-line", H().formatDue(status.dueAt, now)));

    // Cooldown: someone already cleaned recently → one extra deliberate tap.
    const recent = M().recentByAnyone(plan, area.id, now);
    if (recent && !state.override) {
      c.appendChild(
        el(
          "p",
          "warn",
          `Bereits ${H().formatRelPast(M().effTs(recent.ts, now), now)} von ${M().personName(plan, recent.personId)} erledigt.`,
        ),
      );
      const anyway = el("button", "btn", "Trotzdem eintragen");
      anyway.type = "button";
      anyway.addEventListener("click", () => {
        state.override = true;
        renderContext(plan, area);
      });
      c.appendChild(anyway);
      return;
    }
    renderPersonPicker(c, plan, area);
  }

  // Cold path: scanned on a device that has never imported the plan. Import
  // can complete right here so the check-in continues without leaving the page.
  function renderColdPath() {
    const c = card();
    c.appendChild(el("h2", "", "Putzplan noch nicht auf diesem Gerät"));
    c.appendChild(
      el("p", "", "Der QR-Code gehört zu einem Plan, den dieses Gerät noch nicht kennt."),
    );
    c.appendChild(
      el("p", "", "① Öffne den Team-Link oder deinen persönlichen Zugangs-Link (z. B. aus eurem Chat) — oder füge ihn hier ein:"),
    );
    const row = el("div", "form-row");
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "https://…#p1.… oder …#d2.…";
    const openBtn = el("button", "btn btn-primary", "Öffnen");
    openBtn.type = "button";
    openBtn.addEventListener("click", () => importFromText(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") importFromText(input.value);
    });
    row.appendChild(input);
    row.appendChild(openBtn);
    c.appendChild(row);
    c.appendChild(el("p", "", "② Oder importiere eine putzii-Datei:"));
    const fileLabel = el("label", "btn file-label", "Datei importieren");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json,.json";
    fileInput.hidden = true;
    fileInput.addEventListener("change", () => {
      if (!fileInput.files || !fileInput.files[0]) return;
      fileInput.files[0]
        .text()
        .then((text) => {
          const imported = PZ.share.parseFile(text);
          if (!imported) {
            H().showToast("Keine gültige putzii-Datei.");
            return;
          }
          applyImported(imported);
        })
        .catch(() => H().showToast("Datei konnte nicht gelesen werden."));
    });
    fileLabel.appendChild(fileInput);
    c.appendChild(fileLabel);
    c.appendChild(el("p", "muted", "Dein Check-in wird danach fortgesetzt."));
  }

  function importFromText(raw) {
    const text = String(raw || "");
    if (/#(d1|k1)\./.test(text)) {
      H().showToast("Dieser Link gehört zur alten GitHub-Version — bitte einen neuen anfordern.");
      return;
    }
    // Personal access link: connect, pull the plan from the server, continue.
    const d = text.match(/#(d2\.[A-Za-z0-9_-]+)/);
    if (d) {
      const creds = PZ.drop.parseCredentialFragment(d[1]);
      if (!creds || !PZ.drop.acceptCredentials(creds)) {
        H().showToast("Zugangs-Link konnte nicht gelesen werden.");
        return;
      }
      S().registerPlan(creds.planId, true);
      S().setMe(creds.planId, creds.personId);
      H().showToast("Server verbunden — Plan wird geladen…");
      PZ.sync.tick("cold-path", { planId: creds.planId }).then((st) => {
        if (S().loadPlan(creds.planId)) boot();
        else if (st && st.state === "error") H().showToast("Server nicht erreichbar — später erneut versuchen.");
      });
      return;
    }
    const m = text.match(/#(p1u?\.[A-Za-z0-9_-]+)/);
    if (!m) {
      H().showToast("Kein putzii-Link erkannt.");
      return;
    }
    PZ.share
      .decodeShareFragment(m[1])
      .then(({ plan }) => applyImported(plan))
      .catch((e) => {
        H().showToast(
          e && e.code === "version"
            ? "Link stammt aus einer neueren putzii-Version."
            : "Link konnte nicht gelesen werden.",
        );
      });
  }

  function applyImported(remotePlan) {
    const local = S().loadPlan(remotePlan.planId);
    const { plan } = PZ.share.mergePlans(local, remotePlan, Date.now());
    if (!S().savePlan(plan)) {
      H().showToast("Speichern fehlgeschlagen — Speicher voll?");
      return;
    }
    S().registerPlan(plan.planId, true);
    if (plan.planId !== state.planId) {
      H().showToast("Importiert — aber der Link gehört zu einem anderen Plan als dieser QR-Code.");
      return;
    }
    H().showToast(`Plan „${plan.name}" übernommen ✓`);
    boot();
  }

  // #k2. confirm page: pre-scoped activities, one tap per confirmation. No
  // local plan, no storage — the link IS the context, the server mints the
  // event. The fragment stays in the URL: reopening from Signal must work,
  // and the server side is replay-safe (nonce + idempotency window).
  //
  // Each activity is a REAL form posting to /api/checkin. JS intercepts the
  // submit to answer in place, but if it never runs the browser posts the
  // form itself and the server replies with its own confirmation page. The
  // credentials can only come from the fragment, so JS has to build the
  // markup — but nothing beyond that build step is required to check in.
  function confirmError(kind) {
    if (kind === "authfail" || kind === "forbidden") {
      return "Zugang abgelehnt — dieser Link wurde vermutlich zurückgezogen.";
    }
    if (kind === "unknownarea") return "Diese Tätigkeit gibt es nicht mehr.";
    return "Nicht erreichbar — offline? Später nochmal versuchen.";
  }

  function hidden(form, name, value) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  function renderConfirm(creds) {
    const c = card();
    c.appendChild(el("h2", "", "Erledigt melden"));
    c.appendChild(el("p", "muted", `Als ${creds.personName} — antippen, was erledigt ist:`));
    for (const area of creds.areas) {
      const form = document.createElement("form");
      form.method = "post";
      form.action = PZ.drop.checkinUrl();
      hidden(form, "planId", creds.planId);
      hidden(form, "personId", creds.personId);
      hidden(form, "areaId", area.areaId);
      hidden(form, "token", creds.token);
      hidden(form, "nonce", H().randomId(8));
      const btn = el("button", "btn btn-primary big-confirm", `${area.label} ✓`);
      btn.type = "submit";
      form.appendChild(btn);
      const line = el("p", "muted", "");
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        btn.disabled = true;
        line.textContent = "Wird gesendet…";
        PZ.sync
          .checkinDispatch(creds, area.areaId)
          .then((res) => {
            line.textContent = res.minted
              ? "Bestätigt ✓ — ist im Plan vermerkt."
              : "Schon eingetragen ✓ — war eben erst vermerkt.";
          })
          .catch((e) => {
            btn.disabled = false;
            line.textContent = confirmError(e && e.kind);
          });
      });
      c.appendChild(form);
      c.appendChild(line);
    }
  }

  function boot() {
    S().ensureSchema();
    const c = PZ.router
      ? PZ.router.classifyHash(location.hash)
      : classifyLocal(location.hash);
    if (c.kind === "share") {
      // A share link opened on c.html — index.html owns that flow.
      location.replace(`index.html${location.hash}`);
      return;
    }
    if (c.kind === "legacy") {
      renderError(
        "Dieser Link gehört zur alten GitHub-Version.",
        "Bitte einen neuen Bestätigungs-Link anfordern — der alte Dienst existiert nicht mehr.",
      );
      return;
    }
    if (c.kind === "confirm") {
      const creds = PZ.drop.parseCheckinFragment(c.frag);
      if (!creds) {
        renderError("Dieser Bestätigungs-Link ist beschädigt.", "Link nochmal aus dem Chat öffnen.");
        return;
      }
      renderConfirm(creds);
      return;
    }
    if (c.kind !== "checkin") {
      renderError("Dieser Link ist kein Check-in-Link.", "QR-Code nochmal scannen oder die Übersicht öffnen.");
      return;
    }
    state.planId = c.planId;
    state.areaId = c.areaId;
    const plan = S().loadPlan(c.planId);
    if (!plan) {
      S().setPending(c.planId, c.areaId);
      renderColdPath();
      return;
    }
    S().registerPlan(c.planId, true);
    const area = plan.areas.find((a) => a.id === c.areaId);
    if (!area) {
      renderError("Dieser Bereich existiert nicht mehr.", "Der Aushang ist vermutlich veraltet.");
      return;
    }
    if (area.deletedAt) {
      renderDeletedArea(plan, area);
      return;
    }
    renderContext(plan, area);
  }

  // c.html does not load router.js — inline the tiny classifier subset.
  function classifyLocal(rawHash) {
    const frag = String(rawHash || "").replace(/^#/, "");
    if (!frag) return { kind: "empty" };
    if (frag.length > H().MAX_HASH_CHARS) return { kind: "unknown" };
    if (frag.startsWith("p1.") || frag.startsWith("p1u.")) return { kind: "share", frag };
    if (frag.startsWith("k2.")) return { kind: "confirm", frag };
    if (frag.startsWith("d1.") || frag.startsWith("k1.")) return { kind: "legacy", frag };
    const m = frag.match(/^c1\.([A-Za-z0-9_-]{1,32})\.([a-z2-9]{1,16})$/);
    if (m) return { kind: "checkin", planId: m[1], areaId: m[2] };
    return { kind: "unknown" };
  }

  PZ.uiCheckin = { boot };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
