// SPDX-License-Identifier: GPL-3.0-or-later

// Package png rasterizes a QR code into a PNG (stdlib image only).
package png

import (
	"bytes"
	"image"
	"image/color"
	stdpng "image/png"
	"os"

	"github.com/bmmmm/putzii/server/internal/qr"
)

// Render draws the QR with the given module scale and quiet-zone border
// (in modules; the spec minimum is 4).
func Render(q *qr.QrCode, scale, border int) image.Image {
	if scale < 1 {
		scale = 4
	}
	if border < 0 {
		border = 4
	}
	size := q.Size()
	dim := (size + 2*border) * scale
	img := image.NewGray(image.Rect(0, 0, dim, dim))
	for y := 0; y < dim; y++ {
		for x := 0; x < dim; x++ {
			img.SetGray(x, y, color.Gray{Y: 255})
		}
	}
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			if !q.Module(x, y) {
				continue
			}
			for dy := 0; dy < scale; dy++ {
				for dx := 0; dx < scale; dx++ {
					img.SetGray((x+border)*scale+dx, (y+border)*scale+dy, color.Gray{Y: 0})
				}
			}
		}
	}
	return img
}

// Encode returns the PNG bytes (for files and data: URIs alike).
func Encode(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := stdpng.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func WriteFile(path string, img image.Image) error {
	data, err := Encode(img)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
