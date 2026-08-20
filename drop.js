// SPDX-License-Identifier: GPL-3.0-or-later
// GitHub-drop credentials: #d1. link parsing, per-plan credential storage,
// URL builders. The d1 fragment is a positional b64url JSON array — NO gzip
// (high-entropy content):
//   [1, planId, personId, personName, token, encKey, pat, repo, dropBase]
// dropBase travels IN the link so a local dev loop or a foreign household
// can run its own drop with the same app.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;
  const S = () => PZ.store;

  const D1_VERSION = 1;

  // Parse a "d1.<payload>" fragment (without the leading "#").
  // Returns null on anything malformed — the caller decides the UI.
  function parseCredentialFragment(frag) {
    if (!frag || !frag.startsWith("d1.")) return null;
    let arr;
    try {
      arr = JSON.parse(H().utf8Decode(H().base64UrlDecodeBytes(frag.slice(3))));
    } catch (e) {
      return null;
    }
    if (!Array.isArray(arr) || arr.length < 9 || arr[0] !== D1_VERSION) return null;
    const [, planId, personId, personName, token, encKey, pat, repo, dropBase] = arr;
    for (const v of [planId, personId, token, encKey, pat, repo, dropBase]) {
      if (typeof v !== "string" || !v) return null;
    }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(planId)) return null;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(personId)) return null;
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
    if (!/^https:\/\//.test(dropBase)) return null;
    return {
      v: D1_VERSION,
      planId,
      personId,
      personName: H().normalizeName(personName) || "Unbekannt",
      token,
      encKey,
      pat,
      repo,
      dropBase: dropBase.replace(/\/+$/, ""),
    };
  }

  function getCreds(planId) {
    const obj = H().safeParse(H().safeLocalStorageGetItem(S().K.drop(planId)));
    if (!obj || obj.v !== D1_VERSION || typeof obj.token !== "string") return null;
    return obj;
  }

  // Store the credentials for their plan. Returns false on storage failure.
  function acceptCredentials(creds) {
    const record = Object.assign({}, creds, { addedAt: Date.now() });
    return H().safeLocalStorageSetItem(S().K.drop(creds.planId), JSON.stringify(record));
  }

  // "Drop trennen": forget credentials AND sync state — the plan stays.
  function disconnect(planId) {
    H().safeLocalStorageRemoveItem(S().K.drop(planId));
    H().safeLocalStorageRemoveItem(S().K.dropstate(planId));
  }

  function stateUrl(creds) {
    return `${creds.dropBase}/plans/${creds.planId}.json`;
  }

  function healthUrl(creds) {
    return `${creds.dropBase}/health.json`;
  }

  function dispatchUrl(creds) {
    return `https://api.github.com/repos/${creds.repo}/actions/workflows/apply.yml/dispatches`;
  }

  PZ.drop = {
    parseCredentialFragment,
    getCreds,
    acceptCredentials,
    disconnect,
    stateUrl,
    healthUrl,
    dispatchUrl,
  };
})();
