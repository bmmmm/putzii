// SPDX-License-Identifier: GPL-3.0-or-later
package qr

import "testing"

// The vendored encoder ships without its upstream test suite; this smoke
// test pins the basics (real-scan verification happens in phase 4 on
// actual devices).
func TestEncodeSmoke(t *testing.T) {
	code, err := EncodeText("https://example.org/#d1.abcdef", Low)
	if err != nil {
		t.Fatal(err)
	}
	if code.Size() < 21 {
		t.Fatalf("size %d", code.Size())
	}
	dark := 0
	for y := 0; y < code.Size(); y++ {
		for x := 0; x < code.Size(); x++ {
			if code.Module(x, y) {
				dark++
			}
		}
	}
	total := code.Size() * code.Size()
	if dark < total/10 || dark > total*9/10 {
		t.Fatalf("implausible module distribution: %d/%d dark", dark, total)
	}
	// deterministic: same input, same matrix
	again, err := EncodeText("https://example.org/#d1.abcdef", Low)
	if err != nil {
		t.Fatal(err)
	}
	for y := 0; y < code.Size(); y++ {
		for x := 0; x < code.Size(); x++ {
			if code.Module(x, y) != again.Module(x, y) {
				t.Fatalf("non-deterministic at %d,%d", x, y)
			}
		}
	}
	// a ~440-char d1 payload must fit at LOW ecc
	long := "https://bmmmm.github.io/putzii/#d1." + string(make([]byte, 0))
	for len(long) < 440 {
		long += "AbCdEfGh123456-_"
	}
	if _, err := EncodeText(long, Low); err != nil {
		t.Fatalf("440-char payload does not fit: %v", err)
	}
}
