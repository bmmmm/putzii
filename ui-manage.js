// SPDX-License-Identifier: GPL-3.0-or-later
// Verwalten: areas/people CRUD + plan lifecycle. Config edits bump the
// record's updatedAt (LWW key) and the plan's updatedAt.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;
  const M = () => PZ.model;
  const S = () => PZ.store;

  function touch(plan) {
    plan.updatedAt = S().nowSec();
  }

  function saveAndRefresh(plan) {
    if (!S().savePlan(plan)) {
      H().showToast("Speichern fehlgeschlagen — Speicher voll?");
      return;
    }
    if (PZ.ui) PZ.ui.refresh();
  }

  function newRecordId(existing) {
    let id;
    do {
      id = H().randomId(4);
    } while (existing.some((r) => r.id === id));
    return id;
  }

  function addArea(plan, name, intervalDays) {
    const cleanName = H().normalizeName(name);
    if (!cleanName) return;
    const now = S().nowSec();
    plan.areas.push({
      id: newRecordId(plan.areas),
      name: cleanName,
      intervalDays: Math.min(365, Math.max(1, Math.round(intervalDays) || 7)),
      createdAt: now,
      updatedAt: now,
      deletedAt: 0,
    });
    touch(plan);
    saveAndRefresh(plan);
  }

  function addPerson(plan, name) {
    const cleanName = H().normalizeName(name);
    if (!cleanName) return null;
    const existing = plan.people.find(
      (p) => !p.deletedAt && p.name.toLowerCase() === cleanName.toLowerCase(),
    );
    if (existing) return existing;
    const now = S().nowSec();
    const person = {
      id: newRecordId(plan.people),
      name: cleanName,
      createdAt: now,
      updatedAt: now,
      deletedAt: 0,
    };
    plan.people.push(person);
    touch(plan);
    return person;
  }

  function softDelete(plan, record) {
    const now = S().nowSec();
    record.deletedAt = now;
    record.updatedAt = now;
    touch(plan);
    saveAndRefresh(plan);
  }

  function reactivate(plan, record) {
    const now = S().nowSec();
    record.deletedAt = 0;
    record.updatedAt = now;
    touch(plan);
  }

  function renderAreaList(plan) {
    const list = document.getElementById("area-list");
    list.textContent = "";
    for (const area of M().liveAreas(plan)) {
      const li = document.createElement("li");
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 40;
      nameInput.value = area.name;
      nameInput.className = "grow";
      nameInput.addEventListener("change", () => {
        const clean = H().normalizeName(nameInput.value);
        if (!clean || clean === area.name) {
          nameInput.value = area.name;
          return;
        }
        area.name = clean;
        area.updatedAt = S().nowSec();
        touch(plan);
        saveAndRefresh(plan);
      });
      const intervalInput = document.createElement("input");
      intervalInput.type = "number";
      intervalInput.min = "1";
      intervalInput.max = "365";
      intervalInput.value = String(area.intervalDays);
      intervalInput.title = "Intervall in Tagen";
      intervalInput.addEventListener("change", () => {
        const days = Math.min(365, Math.max(1, Math.round(Number(intervalInput.value)) || 0));
        if (!days || days === area.intervalDays) {
          intervalInput.value = String(area.intervalDays);
          return;
        }
        area.intervalDays = days;
        area.updatedAt = S().nowSec();
        touch(plan);
        saveAndRefresh(plan);
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-small btn-danger";
      del.textContent = "Löschen";
      del.addEventListener("click", () => softDelete(plan, area));
      li.appendChild(nameInput);
      li.appendChild(intervalInput);
      li.appendChild(document.createTextNode("Tage"));
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  function renderPeopleList(plan) {
    const list = document.getElementById("people-list");
    list.textContent = "";
    for (const person of M().livePeople(plan)) {
      const li = document.createElement("li");
      li.appendChild(Object.assign(document.createElement("span"), { className: "grow", textContent: person.name }));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-small btn-danger";
      del.textContent = "Entfernen";
      del.addEventListener("click", () => softDelete(plan, person));
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  function renderPlanSwitcher() {
    const wrap = document.getElementById("plan-switcher");
    const select = document.getElementById("plan-select");
    const idx = S().loadPlanIndex();
    wrap.hidden = idx.ids.length < 2;
    if (wrap.hidden) return;
    select.textContent = "";
    for (const id of idx.ids) {
      const p = S().loadPlan(id);
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = p ? p.name : id;
      select.appendChild(opt);
    }
    select.value = idx.active;
  }

  function render() {
    const plan = S().loadActivePlan();
    if (!plan) {
      // First run: create the initial plan lazily so Verwalten always works.
      const created = S().createPlan("Putzplan");
      if (!created) return;
      render();
      return;
    }
    document.getElementById("plan-name").value = plan.name;
    renderAreaList(plan);
    renderPeopleList(plan);
    renderPlanSwitcher();
    const warn = document.getElementById("clock-warning");
    if (M().hasFutureClock(plan, Date.now())) {
      warn.hidden = false;
      warn.textContent =
        "Achtung: Einträge mit Zeitstempel weit in der Zukunft gefunden — die Uhr eines Geräts geht falsch.";
    } else {
      warn.hidden = true;
    }
  }

  function init() {
    document.getElementById("btn-area-add").addEventListener("click", () => {
      const plan = S().loadActivePlan();
      if (!plan) return;
      const nameEl = document.getElementById("new-area-name");
      const intervalEl = document.getElementById("new-area-interval");
      addArea(plan, nameEl.value, Number(intervalEl.value));
      nameEl.value = "";
    });
    document.getElementById("btn-person-add").addEventListener("click", () => {
      const plan = S().loadActivePlan();
      if (!plan) return;
      const nameEl = document.getElementById("new-person-name");
      if (addPerson(plan, nameEl.value)) saveAndRefresh(plan);
      nameEl.value = "";
    });
    document.getElementById("btn-plan-rename").addEventListener("click", () => {
      const plan = S().loadActivePlan();
      if (!plan) return;
      const clean = H().normalizeName(document.getElementById("plan-name").value);
      if (!clean || clean === plan.name) return;
      plan.name = clean;
      touch(plan);
      saveAndRefresh(plan);
      H().showToast("Plan umbenannt ✓");
    });
    document.getElementById("btn-plan-create").addEventListener("click", () => {
      const created = S().createPlan("Neuer Putzplan");
      if (created) {
        if (PZ.ui) PZ.ui.refresh();
        H().showToast("Neuer Plan angelegt — Name oben vergeben.");
      }
    });
    document.getElementById("plan-select").addEventListener("change", (ev) => {
      S().setActivePlan(ev.target.value);
      if (PZ.ui) PZ.ui.refresh();
    });
  }

  PZ.uiManage = { render, init, addPerson, reactivate, touch };
})();
