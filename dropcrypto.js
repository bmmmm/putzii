// SPDX-License-Identifier: GPL-3.0-or-later
// AES-256-GCM state-file crypto for the GitHub drop. The core
// (importStateKey/encryptState/decryptState) is kept line-identical with
// putzii-drop's runner/crypto.mjs — the three-way vector test in that repo's
// CI pins parity. AAD binds ciphertext to planId and format version
// ("<planId>|1"): no plan swap, no downgrade.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;

  const IV_BYTES = 12;
  const AAD_SUFFIX = "|1";

  function aadFor(planId) {
    return new TextEncoder().encode(planId + AAD_SUFFIX);
  }

  async function importStateKey(rawBytes) {
    if (!(rawBytes instanceof Uint8Array) || rawBytes.length !== 32) {
      throw new Error("state key must be 32 bytes");
    }
    return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  // Fresh random IV per write — NEVER reuse an IV under the same key.
  async function encryptState(key, planId, plainBytes) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(planId) },
        key,
        plainBytes,
      ),
    );
    return { iv, ct };
  }

  // Throws on tamper or AAD mismatch (wrong planId / format downgrade).
  async function decryptState(key, planId, ivBytes, ctBytes) {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: ivBytes, additionalData: aadFor(planId) },
        key,
        ctBytes,
      ),
    );
  }

  // --- state-file marshalling ({v, alg, iv, ct, rev, at}) ---

  function parseStateFile(text) {
    const obj = H().safeParse(text);
    if (!obj || obj.v !== 1 || obj.alg !== "A256GCM") return null;
    if (typeof obj.iv !== "string" || typeof obj.ct !== "string") return null;
    if (!Number.isFinite(obj.rev) || obj.rev < 1) return null;
    try {
      return {
        iv: H().base64UrlDecodeBytes(obj.iv),
        ct: H().base64UrlDecodeBytes(obj.ct),
        rev: obj.rev,
        at: typeof obj.at === "string" ? obj.at : "",
      };
    } catch (e) {
      return null;
    }
  }

  PZ.dropcrypto = { importStateKey, encryptState, decryptState, parseStateFile };
})();
