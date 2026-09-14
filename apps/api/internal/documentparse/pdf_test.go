package documentparse

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

const needsOCRJSON = `{"ok":false,"code":"needsOcr","pages":[1],"pageCount":1}`

type fakePDF struct {
	t         *testing.T
	pages     int
	info      string
	source    string
	page      int
	rendered  []int
	responses [][]byte
	split     func(string) error
	render    func(string) error
	deadline  time.Time
}

func (f *fakePDF) run(ctx context.Context, command, dir string, args []string, limit int) ([]byte, error) {
	f.t.Helper()
	deadline, ok := ctx.Deadline()
	if !ok {
		f.t.Fatal("子进程没有总 deadline")
	}
	if f.deadline.IsZero() {
		f.deadline = deadline
	} else if f.deadline != deadline {
		f.t.Fatal("不同子进程重置了总 deadline")
	}
	check := func(want []string, wantLimit int) {
		if !reflect.DeepEqual(args, want) || limit != wantLimit {
			f.t.Fatalf("%s args %v limit %d; want %v %d", command, args, limit, want, wantLimit)
		}
	}
	switch command {
	case "pdfinfo":
		f.source = filepath.Join(dir, "source.pdf")
		check([]string{f.source}, maxToolOutput)
		if f.info != "" {
			return []byte(f.info), nil
		}
		return []byte(fmt.Sprintf("Pages: %d\nEncrypted: no\n", f.pages)), nil
	case "pdfseparate":
		// unit 已重新建立且必须是空目录：上一页文件应在回调返回后立即清理。
		mustClean(f.t, dir)
		f.page++
		n := strconv.Itoa(f.page)
		check([]string{"-f", n, "-l", n, f.source, filepath.Join(dir, "page-%d.pdf")}, maxToolOutput)
		path := filepath.Join(dir, "page-"+n+".pdf")
		if f.split != nil {
			return nil, f.split(path)
		}
		return nil, os.WriteFile(path, []byte("single-page"), 0600)
	case "petrichor-doc-convert":
		path := filepath.Join(dir, fmt.Sprintf("page-%d.pdf", f.page))
		check([]string{"--input", path, "--format", "pdf"}, maxConverterOutput)
		if data, err := os.ReadFile(path); err != nil || string(data) != "single-page" {
			f.t.Fatalf("传入的不是单页 PDF: %q %v", data, err)
		}
		if len(f.responses) == 1 {
			return f.responses[0], nil
		}
		return f.responses[f.page-1], nil
	case "pdftoppm":
		n := strconv.Itoa(f.page)
		prefix := filepath.Join(dir, "rendered")
		check([]string{"-f", n, "-l", n, "-singlefile", "-png", "-scale-to", "2560", f.source, prefix}, maxToolOutput)
		f.rendered = append(f.rendered, f.page)
		if f.render != nil {
			return nil, f.render(prefix + ".png")
		}
		return nil, os.WriteFile(prefix+".png", pngBytes(f.t, 1, 1), 0600)
	default:
		f.t.Fatalf("意外命令 %s", command)
		return nil, nil
	}
}

func pngBytes(t *testing.T, width, height uint32) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	data := buf.Bytes()
	// 仅修改 IHDR 构造巨大尺寸，不在测试中分配巨大像素缓冲区。
	binary.BigEndian.PutUint32(data[16:20], width)
	binary.BigEndian.PutUint32(data[20:24], height)
	binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
	return data
}

func TestPDFMixedDirectOCREmptyAndCleanup(t *testing.T) {
	dir := t.TempDir()
	f := &fakePDF{t: t, pages: 4, responses: [][]byte{successful("第一物理页"), []byte(needsOCRJSON), successful(""), successful("第四页")}}
	var emitted []Page
	var stages []string
	err := prepare(context.Background(), Config{}, "../untrusted.PDF  ", []byte("pdf"), dir, func(s string) { stages = append(stages, s) }, func(p Page) error {
		if p.PageNo != len(emitted)+1 {
			t.Fatalf("页序不连续: %+v", p)
		}
		if p.PageNo == 2 {
			if p.Markdown != nil || p.ImagePath == "" {
				t.Fatalf("OCR page: %+v", p)
			}
			if err := validateImage(p.ImagePath); err != nil {
				t.Fatalf("回调期间图片无效: %v", err)
			}
		} else if p.Markdown == nil || p.ImagePath != "" {
			t.Fatalf("直接转换 page: %+v", p)
		}
		if p.PageNo == 3 && *p.Markdown != "" {
			t.Fatal("空白页正文必须为空")
		}
		emitted = append(emitted, p)
		return nil
	}, f)
	if err != nil || len(emitted) != 4 || !reflect.DeepEqual(f.rendered, []int{2}) {
		t.Fatalf("result %v emitted %d rendered %v", err, len(emitted), f.rendered)
	}
	if !reflect.DeepEqual(stages, []string{"parsing", "parsing", "rendering", "parsing", "parsing"}) {
		t.Fatalf("阶段错误: %v", stages)
	}
	if _, err := os.Lstat(emitted[1].ImagePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("图片未及时删除: %v", err)
	}
	mustClean(t, dir)
}

func TestPDFOnlyExplicitNeedsOCR(t *testing.T) {
	for _, code := range []string{CodeMalformed, CodeEncrypted, CodeUnsupported, CodeResourceLimit, CodeMissingPart, CodeIO} {
		dir := t.TempDir()
		f := &fakePDF{t: t, pages: 2, responses: [][]byte{[]byte(`{"ok":false,"code":"` + code + `","pages":[1],"pageCount":1}`)}}
		err := prepare(context.Background(), Config{}, "a.pdf", []byte("pdf"), dir, nil, noEmit(t), f)
		mustCode(t, err, code)
		if len(f.rendered) != 0 || f.page != 1 {
			t.Fatalf("错误降级 OCR 或继续下一页: %+v", f)
		}
		mustClean(t, dir)
	}
}

func TestPDFInfoLimitsAndEncryption(t *testing.T) {
	for _, tc := range []struct{ info, code string }{
		{"Pages: 501\nEncrypted: no\n", CodeResourceLimit},
		{"Pages: 0\nEncrypted: no\n", CodeMalformed},
		{"Pages: -1\nEncrypted: no\n", CodeMalformed},
		{"Pages: abc\nEncrypted: no\n", CodeMalformed},
		{"Pages: 1\nEncrypted: yes (print:yes copy:yes)\n", CodeEncrypted},
		{"Pages: 1\n", CodeProtocol},
		{"Pages: 1\nEncrypted: unknown\n", CodeProtocol},
		{"Pages: 1\nPages: 2\nEncrypted: no\n", CodeProtocol},
		{"Pages: 1\nEncrypted: no\nEncrypted: yes\n", CodeProtocol},
		{strings.Repeat("x", maxToolOutput+1), CodeResourceLimit},
	} {
		dir := t.TempDir()
		f := &fakePDF{t: t, info: tc.info}
		err := prepare(context.Background(), Config{}, "a.pdf", []byte("pdf"), dir, nil, noEmit(t), f)
		mustCode(t, err, tc.code)
		if f.page != 0 {
			t.Fatal("探测失败后仍拆页")
		}
		mustClean(t, dir)
	}
	if pages, err := parsePDFInfo([]byte("Pages: 500\nEncrypted: no\n")); err != nil || pages != 500 {
		t.Fatalf("页数边界: %d %v", pages, err)
	}
}

func TestPDFTotalMarkdownLimit(t *testing.T) {
	dir := t.TempDir()
	f := &fakePDF{t: t, pages: 10, responses: [][]byte{successful(strings.Repeat("x", maxMarkdownUnit))}}
	emitted := 0
	err := prepare(context.Background(), Config{}, "a.pdf", []byte("pdf"), dir, nil, func(p Page) error { emitted++; return nil }, f)
	mustCode(t, err, CodeResourceLimit)
	if emitted != 8 || f.page != 9 {
		t.Fatalf("总量边界/停止: emitted %d parsed %d", emitted, f.page)
	}
	mustClean(t, dir)
}

func TestPDFEmitFailureAndCancellationCleanup(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		dir := t.TempDir()
		ctx, cancel := context.WithCancel(context.Background())
		f := &fakePDF{t: t, pages: 3, responses: [][]byte{[]byte(needsOCRJSON)}}
		want := errors.New("upload failed")
		var imagePath string
		err := prepare(ctx, Config{}, "a.pdf", []byte("pdf"), dir, nil, func(p Page) error {
			imagePath = p.ImagePath
			if _, err := os.Stat(imagePath); err != nil {
				t.Fatal(err)
			}
			if canceled {
				cancel()
				return nil
			}
			return want
		}, f)
		cancel()
		if (!canceled && err != want) || (canceled && !errors.Is(err, context.Canceled)) || f.page != 1 || len(f.rendered) != 1 {
			t.Fatalf("未立即停止: %v, page %d", err, f.page)
		}
		if _, err := os.Stat(imagePath); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("emit 后图片未清理: %v", err)
		}
		mustClean(t, dir)
	}
}

func TestPDFGeneratedFileValidation(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		create     func(string) error
	}{
		{"missing", CodeIO, func(string) error { return nil }},
		{"empty", CodeMalformed, func(path string) error { return os.WriteFile(path, nil, 0600) }},
		{"directory", CodeMalformed, func(path string) error { return os.Mkdir(path, 0700) }},
		{"symlink", CodeMalformed, func(path string) error {
			return os.Symlink(filepath.Join(filepath.Dir(filepath.Dir(path)), "source.pdf"), path)
		}},
		{"oversized", CodeResourceLimit, func(path string) error {
			f, err := os.Create(path)
			if err != nil {
				return err
			}
			defer f.Close()
			return f.Truncate(maxSourceBytes + 1)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			f := &fakePDF{t: t, pages: 1, split: tc.create}
			err := prepare(context.Background(), Config{}, "a.pdf", []byte("pdf"), dir, nil, noEmit(t), f)
			mustCode(t, err, tc.code)
			mustClean(t, dir)
		})
	}
}

func TestRenderedImageLimits(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		create     func(string) error
	}{
		{"invalid", CodeMalformed, func(path string) error { return os.WriteFile(path, []byte("not an image"), 0600) }},
		{"pixels", CodeResourceLimit, func(path string) error { return os.WriteFile(path, pngBytes(t, 6000, 4001), 0600) }},
		{"zero", CodeMalformed, func(path string) error { return os.WriteFile(path, pngBytes(t, 0, 1), 0600) }},
		{"bytes", CodeResourceLimit, func(path string) error {
			if err := os.WriteFile(path, pngBytes(t, 1, 1), 0600); err != nil {
				return err
			}
			return os.Truncate(path, maxImageBytes+1)
		}},
		{"symlink", CodeMalformed, func(path string) error {
			return os.Symlink(filepath.Join(filepath.Dir(filepath.Dir(path)), "source.pdf"), path)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			f := &fakePDF{t: t, pages: 1, responses: [][]byte{[]byte(needsOCRJSON)}, render: tc.create}
			err := prepare(context.Background(), Config{}, "a.pdf", []byte("pdf"), dir, nil, noEmit(t), f)
			mustCode(t, err, tc.code)
			mustClean(t, dir)
		})
	}
	path := filepath.Join(t.TempDir(), "valid.png")
	if err := os.WriteFile(path, pngBytes(t, 6000, 4000), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateImage(path); err != nil {
		t.Fatalf("24MP 边界: %v", err)
	}
	var jpegData bytes.Buffer
	if err := jpeg.Encode(&jpegData, image.NewRGBA(image.Rect(0, 0, 1, 1)), nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, jpegData.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateImage(path); err != nil {
		t.Fatalf("按真实图片格式检测: %v", err)
	}
}

func TestPopplerErrorCodes(t *testing.T) {
	for _, tc := range []struct {
		exit int
		code string
	}{{1, CodeMalformed}, {2, CodeIO}, {3, CodeEncrypted}, {99, CodeMalformed}, {7, CodeCommandFailed}} {
		mustCode(t, popplerError(&Error{Code: CodeCommandFailed, exitCode: tc.exit}), tc.code)
	}
	if err := popplerError(context.Canceled); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	mustCode(t, popplerError(failure(CodeResourceLimit)), CodeResourceLimit)
}
