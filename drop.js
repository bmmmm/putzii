// SPDX-License-Identifier: GPL-3.0-or-later
// Server credentials: #d2. link parsing, per-plan credential storage, API URL
// builders. The d2 fragment is a positional b64url JSON array — NO gzip
// (high-entropy content):
//   [2, planId, personId, personName, token, encKey]
//
// #k2. is the pre-scoped CONFIRM link (Signal use case): same shape but
// WITHOUT the encKey and with a CHECK-IN SCOPED token — it can trigger
// server-minted check-ins for the listed activities and nothing else — plus
// that fixed activity list:
//   [2, planId, personId, personName, checkinToken, [[areaId, label], …]]
//
// What v2 dropped versus the retired GitHub drop's #d1./#k1.:
//   - no PAT: there is no third party to authenticate against any more.
//   - no repo / dropBase: the app is served BY the server it talks to, so the
//     API base is derived from location. That is what lets CSP stay
//     `connect-src 'self'` — see invariant 5.
//   - k2 no longer smuggles full write access, which #k1. did by design gap.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;
  const S = () => PZ.store;

  const D2_VERSION = 2;
  const K2_VERSION = 2;
  const K2_MAX_AREAS = 12;

  // A v1 link points at a GitHub drop that no longer exists. Recognising it
  // is what lets the UI say "alter Link" instead of "kaputter Link".
  function isLegacyFragment(frag) {
    return !!frag && (frag.startsWith("d1.") || frag.startsWith("k1."));
  }

  function decodeArray(frag, prefix, version, minLen) {
    if (!frag || !frag.startsWith(prefix)) return null;
    let arr;
    try {
      arr = JSON.parse(H().utf8Decode(H().base64UrlDecodeBytes(frag.slice(prefix.length))));
    } catch (e) {
      return null;
    }
    if (!Array.isArray(arr) || arr.length < minLen || arr[0] !== version) return null;
    return arr;
  }

  function validIds(planId, personId) {
    return /^[A-Za-z0-9_-]{1,32}$/.test(planId) && /^[A-Za-z0-9_-]{1,32}$/.test(personId);
  }

  // Parse a "d2.<payload>" fragment (without the leading "#").
  // Returns null on anything malformed — the caller decides the UI.
  function parseCredentialFragment(frag) {
    const arr = decodeArray(frag, "d2.", D2_VERSION, 6);
    if (!arr) return null;
    const [, planId, personId, personName, token, encKey] = arr;
    for (const v of [planId, personId, token, encKey]) {
      if (typeof v !== "string" || !v) return null;
    }
    if (!validIds(planId, personId)) return null;
    return {
      v: D2_VERSION,
      planId,
      personId,
      personName: H().normalizeName(personName) || "Unbekannt",
      token,
      encKey,
    };
  }

  // Parse a "k2.<payload>" confirm-link fragment (without the leading "#").
  function parseCheckinFragment(frag) {
    const arr = decodeArray(frag, "k2.", K2_VERSION, 6);
    if (!arr) return null;
    const [, planId, personId, personName, token, rawAreas] = arr;
    for (const v of [planId, personId, token]) {
      if (typeof v !== "string" || !v) return null;
    }
    if (!validIds(planId, personId)) return null;
    if (!Array.isArray(rawAreas) || !rawAreas.length || rawAreas.length > K2_MAX_AREAS) return null;
    const areas = [];
    for (const it of rawAreas) {
      if (!Array.isArray(it) || typeof it[0] !== "string") return null;
      if (!/^[a-z2-9]{1,16}$/.test(it[0])) return null;
      const label = H().normalizeName(typeof it[1] === "string" ? it[1] : "") || it[0];
      areas.push({ areaId: it[0], label });
    }
    return {
      v: K2_VERSION,
      planId,
      personId,
      personName: H().normalizeName(personName) || "Unbekannt",
      token,
      areas,
    };
  }

  function getCreds(planId) {
    const obj = H().safeParse(H().safeLocalStorageGetItem(S().K.drop(planId)));
    if (!obj || obj.v !== D2_VERSION || typeof obj.token !== "string") return null;
    return obj;
  }

  // Store the credentials for their plan. Returns false on storage failure.
  function acceptCredentials(creds) {
    const record = Object.assign({}, creds, { addedAt: Date.now() });
    return H().safeLocalStorageSetItem(S().K.drop(creds.planId), JSON.stringify(record));
  }

  // "Server trennen": forget credentials AND sync state — the plan stays.
  function disconnect(planId) {
    H().safeLocalStorageRemoveItem(S().K.drop(planId));
    H().safeLocalStorageRemoveItem(S().K.dropstate(planId));
  }

  // The API lives under the directory that served this page. Deriving it
  // instead of carrying it in the link is what keeps CSP at 'self': there is
  // no second origin the app could ever be pointed at.
  function apiBase() {
    return PZ.share.baseDirUrl() + "api";
  }

  function stateUrl(creds) {
    return `${apiBase()}/state/${creds.planId}`;
  }

  function healthUrl(creds) {
    return `${apiBase()}/health/${creds.planId}`;
  }

  function checkinUrl() {
    return `${apiBase()}/checkin`;
  }

  PZ.drop = {
    D2_VERSION,
    K2_VERSION,
    K2_MAX_AREAS,
    isLegacyFragment,
    parseCredentialFragment,
    parseCheckinFragment,
    getCreds,
    acceptCredentials,
    disconnect,
    apiBase,
    stateUrl,
    healthUrl,
    checkinUrl,
  };
})();
