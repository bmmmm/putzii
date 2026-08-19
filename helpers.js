// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  // Single null-prototype namespace root: a "__proto__" key coming out of
  // JSON.parse must never be able to reach Object.prototype via our registries.
  const PZ = (window.PZ = window.PZ || Object.create(null));

  const STORAGE_PREFIX = "putzii:";
  // 32-char alphabet (no l/o/0/1): with exactly 32 symbols, `byte & 31` maps a
  // random byte uniformly — no modulo bias, no rejection loop.
  const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
  // Legitimate payloads are ~2-7 kB; anything near these caps is hostile.
  const MAX_HASH_CHARS = 512 * 1024;
  const MAX_GUNZIP_BYTES = 512 * 1024;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function randomBytes(len) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  function randomId(len) {
    const bytes = randomBytes(len);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += ID_ALPHABET[bytes[i] & 31];
    }
    return out;
  }

  function base64UrlFromBinary(binary) {
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  // 6 random bytes -> exactly 8 base64url chars (48 bits, not enumerable).
  function randomPlanId() {
    return base64UrlEncodeBytes(randomBytes(6));
  }

  function base64UrlEncodeBytes(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return base64UrlFromBinary(binary);
  }

  function base64UrlDecodeBytes(str) {
    const padLen = (4 - (str.length % 4)) % 4;
    const base = (str + "=".repeat(padLen)).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function utf8Encode(str) {
    return encoder.encode(str);
  }

  function utf8Decode(bytes) {
    return decoder.decode(bytes);
  }

  async function gzipCompress(bytes) {
    if (typeof CompressionStream === "undefined") {
      throw new Error("CompressionStream not available");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // Cap the decompressed size so a tiny crafted payload cannot inflate into a
  // multi-megabyte buffer and hang the tab (decompression bomb).
  async function gzipDecompress(bytes, maxBytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("DecompressionStream not available");
    }
    const limit = typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : MAX_GUNZIP_BYTES;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > limit) {
            try {
              await reader.cancel();
            } catch (e) {
              /* ignore */
            }
            throw new Error("Decompressed payload too large");
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (e) {
        /* ignore */
      }
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  function safeParse(raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function safeLocalStorageGetItem(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function safeLocalStorageSetItem(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function safeLocalStorageRemoveItem(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  function parseCompactEventId(id) {
    if (!id || typeof id !== "string") return null;
    const m = id.match(/^([A-Za-z0-9_-]+)\.([0-9a-z]+)$/);
    if (!m) return null;
    const deviceKey = m[1];
    const seq = parseInt(m[2], 36);
    if (!deviceKey || isNaN(seq) || seq <= 0 || seq > Number.MAX_SAFE_INTEGER) {
      return null;
    }
    return { deviceKey, seq };
  }

  function formatCompactEventId(deviceKey, seq) {
    return `${deviceKey}.${seq.toString(36)}`;
  }

  function cmpStr(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  // Compare deviceKey lexically but the sequence NUMERICALLY — a plain lexical
  // compare inverts order at every base36 width boundary (seq 36 = "10" sorts
  // before seq 35 = "z").
  function cmpEventId(a, b) {
    const idA = typeof a === "string" ? a : "";
    const idB = typeof b === "string" ? b : "";
    if (idA === idB) return 0;
    const pa = parseCompactEventId(idA);
    const pb = parseCompactEventId(idB);
    if (pa && pb) {
      if (pa.deviceKey !== pb.deviceKey) return cmpStr(pa.deviceKey, pb.deviceKey);
      return pa.seq - pb.seq;
    }
    return cmpStr(idA, idB);
  }

  function compareEventsByTime(a, b) {
    const aTs = a && Number.isFinite(a.ts) ? a.ts : 0;
    const bTs = b && Number.isFinite(b.ts) ? b.ts : 0;
    if (aTs !== bTs) return aTs - bTs;
    return cmpEventId(a && a.id, b && b.id);
  }

  // Trim, collapse whitespace, strip control chars, cap at 40. Returns "" when
  // nothing usable remains — the caller decides the fallback.
  function normalizeName(raw) {
    return String(raw || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  }

  const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  // "Di, 26.08."
  function formatDayShort(tsMs) {
    if (!Number.isFinite(tsMs) || tsMs <= 0) return "";
    const d = new Date(tsMs);
    return `${WEEKDAYS[d.getDay()]}, ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.`;
  }

  function formatDateTime(tsMs) {
    if (!Number.isFinite(tsMs) || tsMs <= 0) return "";
    const d = new Date(tsMs);
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // German relative time for PAST timestamps: "gerade eben", "vor 5 Min.", …
  function formatRelPast(tsMs, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const diff = now - tsMs;
    if (diff < 90 * 1000) return "gerade eben";
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `vor ${mins} Min.`;
    const hours = Math.round(diff / 3600000);
    if (hours < 24) return `vor ${hours} Std.`;
    const days = Math.round(diff / 86400000);
    if (days === 1) return "gestern";
    return `vor ${days} Tagen`;
  }

  // German phrasing for a DUE date: "heute fällig", "morgen fällig",
  // "fällig in 3 Tagen", "überfällig seit 2 Tagen".
  function formatDue(dueMs, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (now >= dueMs) {
      const days = Math.floor((now - dueMs) / 86400000);
      if (days < 1) return "heute fällig";
      if (days === 1) return "überfällig seit 1 Tag";
      return `überfällig seit ${days} Tagen`;
    }
    const days = Math.ceil((dueMs - now) / 86400000);
    if (days <= 1) return "morgen fällig";
    return `fällig in ${days} Tagen`;
  }

  // Renders a QR for `text` onto `canvas`. opts: { scale, maxPx, border, ecc }.
  // Throws if the QR library is missing or encodeText fails — callers catch.
  function drawQrToCanvas(canvas, text, opts) {
    if (!canvas) return;
    if (!window.qrcodegen || !window.qrcodegen.QrCode) {
      throw new Error("QR library missing");
    }
    const o = opts || {};
    const border = typeof o.border === "number" ? o.border : 4;
    // Default ECC Q (25%) — printed stickers get splashed. Callers with big
    // payloads (team-link QR) pass "low".
    const ecc =
      o.ecc === "low" ? window.qrcodegen.QrCode.Ecc.LOW : window.qrcodegen.QrCode.Ecc.QUARTILE;
    const qr = window.qrcodegen.QrCode.encodeText(String(text || ""), ecc);
    const size = qr.size;
    const modules = size + border * 2;
    let scale = typeof o.scale === "number" ? o.scale : 0;
    if (!scale && typeof o.maxPx === "number") {
      scale = Math.max(2, Math.floor(o.maxPx / modules));
    }
    if (!scale) scale = 2;
    const dim = modules * scale;
    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = "#000000";
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (qr.getModule(x, y)) {
          ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
        }
      }
    }
  }

  // --- ISO calendar weeks ---

  const ISO_DOW_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const ISO_DOW_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

  // Days since epoch for a LOCAL calendar date. Built via Date.UTC of the local
  // y/m/d triple, so a 23 h or 25 h DST day still counts as exactly one day —
  // differences between two day numbers are exact multiples of 1.
  function dayNumber(d) {
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  }

  function isoWeekday(d) {
    return d.getDay() || 7; // Mo=1 … So=7
  }

  function isoMonday(d) {
    const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    m.setDate(m.getDate() - (isoWeekday(m) - 1));
    return m;
  }

  // ISO-8601: the THURSDAY of the week decides the year; week 1 contains Jan 4.
  // Both Thursdays reduce to integer day numbers, so the /7 is exact.
  function isoWeekParts(d) {
    const thu = isoMonday(d);
    thu.setDate(thu.getDate() + 3);
    const year = thu.getFullYear();
    const firstThu = isoMonday(new Date(year, 0, 4));
    firstThu.setDate(firstThu.getDate() + 3);
    return { year, week: 1 + (dayNumber(thu) - dayNumber(firstThu)) / 7 };
  }

  // "2026-W34" — zero-padded week, so lexicographic order IS chronological
  // order across year boundaries. Load-bearing: share window and pruning are
  // plain string comparisons.
  function isoWeekKey(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return "";
    const parts = isoWeekParts(d);
    return `${parts.year}-W${pad2(parts.week)}`;
  }

  // Monday 00:00 local — or null for a malformed key OR a week that does not
  // exist (e.g. "2027-W53"; 2027 has only 52). The round-trip is the
  // validator: setDate would silently roll a bogus W53 into next year's W01.
  function weekStartDate(key) {
    const m = /^(\d{4})-W(\d{2})$/.exec(String(key || ""));
    if (!m) return null;
    const year = +m[1];
    const week = +m[2];
    if (year < 2000 || year > 2100 || week < 1 || week > 53) return null;
    const mon = isoMonday(new Date(year, 0, 4));
    mon.setDate(mon.getDate() + (week - 1) * 7);
    return isoWeekKey(mon) === key ? mon : null;
  }

  // 52/53→01 rollovers come free via setDate overflow — deliberately NO
  // weeksInYear() anywhere, that's how the year-boundary bug is avoided.
  function addWeeks(key, n) {
    const mon = weekStartDate(key);
    if (!mon) return "";
    mon.setDate(mon.getDate() + n * 7);
    return isoWeekKey(mon);
  }

  // "17.–23.08." / month-crossing "31.08.–06.09." (year lives in the KW label).
  function formatWeekRange(key) {
    const mon = weekStartDate(key);
    if (!mon) return "";
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    if (mon.getMonth() === sun.getMonth()) {
      return `${pad2(mon.getDate())}.–${pad2(sun.getDate())}.${pad2(sun.getMonth() + 1)}.`;
    }
    return `${pad2(mon.getDate())}.${pad2(mon.getMonth() + 1)}.–${pad2(sun.getDate())}.${pad2(sun.getMonth() + 1)}.`;
  }

  // "KW 34" — with "· 2027" appended once the key's ISO year differs from the
  // reference week's (the only confusing thing about an endless forward list).
  function formatWeekLabel(key, refKey) {
    const m = /^(\d{4})-W(\d{2})$/.exec(String(key || ""));
    if (!m) return "";
    const label = `KW ${Number(m[2])}`;
    const refYear = String(refKey || "").slice(0, 4);
    return refYear && m[1] !== refYear ? `${label} · ${m[1]}` : label;
  }

  let toastTimer = 0;

  // Toast with an optional action button ({label, onClick}). Lives here because
  // both pages use it and it has no other dependencies.
  function showToast(message, action, ms) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = "";
    const text = document.createElement("span");
    text.textContent = message;
    el.appendChild(text);
    if (action && action.label) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        el.hidden = true;
        action.onClick();
      });
      el.appendChild(btn);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, ms || (action ? 8000 : 3500));
  }

  PZ.helpers = {
    STORAGE_PREFIX,
    ID_ALPHABET,
    MAX_HASH_CHARS,
    MAX_GUNZIP_BYTES,
    randomId,
    randomPlanId,
    base64UrlEncodeBytes,
    base64UrlDecodeBytes,
    utf8Encode,
    utf8Decode,
    gzipCompress,
    gzipDecompress,
    safeParse,
    safeLocalStorageGetItem,
    safeLocalStorageSetItem,
    safeLocalStorageRemoveItem,
    parseCompactEventId,
    formatCompactEventId,
    cmpStr,
    cmpEventId,
    compareEventsByTime,
    normalizeName,
    formatDayShort,
    formatDateTime,
    formatRelPast,
    formatDue,
    ISO_DOW_SHORT,
    ISO_DOW_LONG,
    dayNumber,
    isoWeekday,
    isoMonday,
    isoWeekKey,
    weekStartDate,
    addWeeks,
    formatWeekRange,
    formatWeekLabel,
    drawQrToCanvas,
    showToast,
  };
})();
