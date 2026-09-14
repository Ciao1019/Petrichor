package documentparse

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

type pdfRegion struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Anchor string  `json:"anchor"`
}
type pdfVisuals struct {
	Width    float64     `json:"width"`
	Height   float64     `json:"height"`
	Fallback bool        `json:"fallback"`
	Regions  []pdfRegion `json:"regions"`
}

func parsePDFVisuals(raw []byte) (*pdfVisuals, error) {
	var v pdfVisuals
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&v) != nil || v.Width <= 0 || v.Height <= 0 || v.Width > 1e6 || v.Height > 1e6 || len(v.Regions) > 32 {
		return nil, failure(CodeProtocol)
	}
	for _, r := range v.Regions {
		if r.X < 0 || r.Y < 0 || r.Width <= 0 || r.Height <= 0 || r.X+r.Width > v.Width+0.01 || r.Y+r.Height > v.Height+0.01 || len(r.Anchor) > 8192 {
			return nil, failure(CodeProtocol)
		}
	}
	return &v, nil
}

// 从同一张有界原页裁切，复杂矢量和透明碎片按最终视觉效果保留，不逐碎片提取。
func renderPDFAssets(ctx context.Context, path, dir string, v *pdfVisuals) ([]Asset, error) {
	if v.Fallback {
		return []Asset{{ImagePath: path, Kind: "page", Bounds: [4]float64{0, 0, 1, 1}}}, nil
	}
	f, err := openRegular(path, maxImageBytes)
	if err != nil {
		return nil, err
	}
	im, _, err := image.Decode(f)
	f.Close()
	if err != nil {
		return nil, failure(CodeMalformed)
	}
	result := make([]Asset, 0, len(v.Regions))
	var outputBytes int64
	for i, r := range v.Regions {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		sx, sy := float64(im.Bounds().Dx())/v.Width, float64(im.Bounds().Dy())/v.Height
		rect := image.Rect(int(math.Floor(r.X*sx)), int(math.Floor(r.Y*sy)), int(math.Ceil((r.X+r.Width)*sx)), int(math.Ceil((r.Y+r.Height)*sy))).Intersect(im.Bounds())
		if rect.Empty() {
			return nil, failure(CodeProtocol)
		}
		crop := im.(interface {
			SubImage(image.Rectangle) image.Image
		}).SubImage(rect)
		out := filepath.Join(dir, fmt.Sprintf("region-%d.png", i+1))
		f, err := os.OpenFile(out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return nil, failure(CodeIO)
		}
		err = png.Encode(f, crop)
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			return nil, failure(CodeIO)
		}
		if err := validateImage(out); err != nil {
			return nil, err
		}
		info, err := os.Stat(out)
		if err != nil {
			return nil, failure(CodeIO)
		}
		outputBytes += info.Size()
		if outputBytes > 64<<20 {
			return nil, failure(CodeResourceLimit)
		}
		result = append(result, Asset{ImagePath: out, Anchor: r.Anchor, Kind: "region", Bounds: [4]float64{r.X / v.Width, r.Y / v.Height, r.Width / v.Width, r.Height / v.Height}})
	}
	return result, nil
}
