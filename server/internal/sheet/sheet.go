// SPDX-License-Identifier: GPL-3.0-or-later

// Package sheet renders a printable HTML page of labeled QR codes (QRs as
// PNG data URIs). HTML instead of PNG on purpose: text labels with umlauts
// need no font vendoring, and the browser's print dialog handles paper.
package sheet

import (
	"encoding/base64"
	"fmt"
	"html"
	"strings"
)

type Item struct {
	Label    string
	Sublabel string
	PNG      []byte
}

func Render(title string, items []Item) string {
	var b strings.Builder
	b.WriteString("<!doctype html>\n<meta charset=\"utf-8\">\n<title>")
	b.WriteString(html.EscapeString(title))
	b.WriteString(`</title>
<style>
 body { font-family: -apple-system, system-ui, sans-serif; margin: 1.5em; }
 h1 { font-size: 1.2em; }
 .grid { display: flex; flex-wrap: wrap; gap: 1.5em; }
 .card { text-align: center; border: 1px solid #ccc; border-radius: 8px;
         padding: 1em; width: 240px; page-break-inside: avoid; }
 .card img { width: 200px; height: 200px; image-rendering: pixelated; }
 .label { font-weight: 600; margin-top: .5em; }
 .sub { color: #555; font-size: .85em; }
 @media print { .card { border-color: #000; } }
</style>
`)
	fmt.Fprintf(&b, "<h1>%s</h1>\n<div class=\"grid\">\n", html.EscapeString(title))
	for _, it := range items {
		b.WriteString("<div class=\"card\">")
		fmt.Fprintf(&b, "<img src=\"data:image/png;base64,%s\" alt=\"QR\">", base64.StdEncoding.EncodeToString(it.PNG))
		fmt.Fprintf(&b, "<div class=\"label\">%s</div>", html.EscapeString(it.Label))
		if it.Sublabel != "" {
			fmt.Fprintf(&b, "<div class=\"sub\">%s</div>", html.EscapeString(it.Sublabel))
		}
		b.WriteString("</div>\n")
	}
	b.WriteString("</div>\n")
	return b.String()
}
