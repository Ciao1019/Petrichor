package documentparse

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestPDFTextAndImageCoexistAndCropAtTitle(t *testing.T) {
	response := []byte(`{"ok":true,"engine":"anydoc","markdown":"## Why this works 为什么这有效\n","visuals":{"width":100,"height":100,"fallback":false,"regions":[{"x":0,"y":20,"width":100,"height":80,"anchor":"Why this works 为什么这有效"}]}}`)
	f := &fakePDF{t: t, pages: 1, responses: [][]byte{response}}
	var assetPath string
	err := prepare(context.Background(), Config{}, "a.pdf", []byte("pdf"), t.TempDir(), nil, func(page Page) error {
		if page.Markdown == nil || len(page.Assets) != 1 || page.ImagePath == "" || page.Assets[0].Kind != "region" || page.Assets[0].Anchor != "Why this works 为什么这有效" {
			t.Fatalf("%+v", page)
		}
		assetPath = page.Assets[0].ImagePath
		return validateImage(assetPath)
	}, f)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(assetPath); !os.IsNotExist(err) {
		t.Fatal("区域临时图未清理")
	}
}

func TestPDFUncertainVisualsRetainWholePage(t *testing.T) {
	v, err := parsePDFVisuals([]byte(`{"width":100,"height":100,"fallback":true,"regions":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "original.png")
	assets, err := renderPDFAssets(context.Background(), path, filepath.Dir(path), v)
	if err != nil || len(assets) != 1 || assets[0].Kind != "page" || assets[0].ImagePath != path {
		t.Fatal(assets, err)
	}
	for _, raw := range []string{`{"width":0,"height":100}`, `{"width":100,"height":100,"regions":[{"x":-1,"y":0,"width":10,"height":10}]}`, `{"width":100,"height":100,"regions":[{"x":90,"y":0,"width":20,"height":10}]}`} {
		if _, err := parsePDFVisuals([]byte(raw)); err == nil {
			t.Fatal(raw)
		}
	}
}
