// SPDX-License-Identifier: GPL-3.0-or-later

// Package dropcrypto implements the AES-256-GCM state-file crypto,
// byte-compatible with runner/crypto.mjs and the app's dropcrypto.js.
// AAD binds ciphertext to planId and format version ("<planId>|1"):
// no plan swap, no downgrade. The three-way vector test (Node<->Go<->Node)
// in CI pins parity.
package dropcrypto

import (
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	ivBytes   = 12
	aadSuffix = "|1"
	// Decompression cap mirrors the app's MAX_GUNZIP_BYTES.
	MaxGunzipBytes = 512 * 1024
)

func aadFor(planID string) []byte {
	return []byte(planID + aadSuffix)
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, errors.New("state key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Encrypt seals plaintext with a fresh random IV. Never reuse an IV under
// the same key.
func Encrypt(key []byte, planID string, plaintext []byte) (iv, ct []byte, err error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, nil, err
	}
	iv = make([]byte, ivBytes)
	if _, err := rand.Read(iv); err != nil {
		return nil, nil, err
	}
	ct = gcm.Seal(nil, iv, plaintext, aadFor(planID))
	return iv, ct, nil
}

// Decrypt opens ct; fails on tamper or AAD mismatch (wrong planId).
func Decrypt(key []byte, planID string, iv, ct []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	if len(iv) != ivBytes {
		return nil, errors.New("bad iv length")
	}
	return gcm.Open(nil, iv, ct, aadFor(planID))
}

// EncryptWithIV exists ONLY for the cross-implementation vector test —
// production writes always use Encrypt's fresh random IV.
func EncryptWithIV(key []byte, planID string, iv, plaintext []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	if len(iv) != ivBytes {
		return nil, errors.New("bad iv length")
	}
	return gcm.Seal(nil, iv, plaintext, aadFor(planID)), nil
}

// --- base64url (no padding), matching the app's helpers ---

func B64urlEncode(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func B64urlDecode(s string) ([]byte, error) {
	// tolerate padded input like Node's Buffer base64url decoder does
	for len(s) > 0 && s[len(s)-1] == '=' {
		s = s[:len(s)-1]
	}
	return base64.RawURLEncoding.DecodeString(s)
}

// --- gzip helpers ---

func Gzip(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(data); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func Gunzip(data []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	out, err := io.ReadAll(io.LimitReader(zr, MaxGunzipBytes+1))
	if err != nil {
		return nil, err
	}
	if len(out) > MaxGunzipBytes {
		return nil, errors.New("decompressed payload too large")
	}
	return out, nil
}

// --- state-file marshalling ({v, alg, iv, ct, rev, at}) ---

type StateFile struct {
	V   int    `json:"v"`
	Alg string `json:"alg"`
	IV  string `json:"iv"`
	CT  string `json:"ct"`
	Rev int64  `json:"rev"`
	At  string `json:"at"`
}

func SerializeStateFile(rev int64, atISO string, iv, ct []byte) ([]byte, error) {
	return json.Marshal(StateFile{
		V:   1,
		Alg: "A256GCM",
		IV:  B64urlEncode(iv),
		CT:  B64urlEncode(ct),
		Rev: rev,
		At:  atISO,
	})
}

func ParseStateFile(text []byte) (rev int64, atISO string, iv, ct []byte, err error) {
	var f StateFile
	if err := json.Unmarshal(text, &f); err != nil {
		return 0, "", nil, nil, fmt.Errorf("state file: %w", err)
	}
	if f.V != 1 || f.Alg != "A256GCM" || f.Rev < 1 {
		return 0, "", nil, nil, errors.New("state file: bad shape")
	}
	iv, err = B64urlDecode(f.IV)
	if err != nil {
		return 0, "", nil, nil, err
	}
	ct, err = B64urlDecode(f.CT)
	if err != nil {
		return 0, "", nil, nil, err
	}
	return f.Rev, f.At, iv, ct, nil
}
