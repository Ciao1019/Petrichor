package documentparse

import (
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const maxToolOutput = 64 << 10

func (p *preparation) pdf(input, dir string) error {
	data, err := p.runner.run(p.ctx, "pdfinfo", dir, []string{input}, maxToolOutput)
	if err != nil {
		return popplerError(err)
	}
	pages, err := parsePDFInfo(data)
	if err != nil {
		return err
	}
	for pageNo := 1; pageNo <= pages; pageNo++ {
		if err := p.ctx.Err(); err != nil {
			return err
		}
		if pageNo > 1 {
			if err := p.stage("parsing"); err != nil {
				return err
			}
		}
		if err := p.pdfPage(input, dir, pageNo); err != nil {
			return err
		}
	}
	return p.ctx.Err()
}

func parsePDFInfo(data []byte) (int, error) {
	if len(data) > maxToolOutput {
		return 0, failure(CodeResourceLimit)
	}
	var pageText, encryption string
	var foundPages, foundEncryption bool
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch key {
		case "Pages":
			if foundPages {
				return 0, failure(CodeProtocol)
			}
			pageText, foundPages = strings.TrimSpace(value), true
		case "Encrypted":
			if foundEncryption {
				return 0, failure(CodeProtocol)
			}
			encryption, foundEncryption = strings.TrimSpace(value), true
		}
	}
	if encryption == "yes" || strings.HasPrefix(encryption, "yes ") {
		return 0, failure(CodeEncrypted)
	}
	if !foundPages || !foundEncryption || encryption != "no" {
		return 0, failure(CodeProtocol)
	}
	pages, err := strconv.Atoi(pageText)
	if err != nil || pages <= 0 {
		return 0, failure(CodeMalformed)
	}
	if pages > maxPDFPages {
		return 0, failure(CodeResourceLimit)
	}
	return pages, nil
}

func (p *preparation) pdfPage(input, root string, pageNo int) (result error) {
	// 每页单独创建、销毁目录；下一页开始前不再持有上一页 PDF、图片或解析器临时文件。
	dir := filepath.Join(root, "unit")
	if err := os.Mkdir(dir, 0700); err != nil {
		return failure(CodeIO)
	}
	defer func() {
		if err := os.RemoveAll(dir); err != nil && result == nil {
			result = failure(CodeIO)
		}
	}()
	n := strconv.Itoa(pageNo)
	pattern := filepath.Join(dir, "page-%d.pdf")
	_, err := p.runner.run(p.ctx, "pdfseparate", dir, []string{"-f", n, "-l", n, input, pattern}, maxToolOutput)
	if err != nil {
		return popplerError(err)
	}
	singlePage := filepath.Join(dir, "page-"+n+".pdf")
	file, err := openRegular(singlePage, maxSourceBytes)
	if err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return failure(CodeIO)
	}
	converted, err := p.convert(singlePage, "pdf", dir)
	if err != nil {
		return err
	}
	if !converted.needsOCR && (converted.visuals == nil || (!converted.visuals.Fallback && len(converted.visuals.Regions) == 0)) {
		return p.deliver(Page{PageNo: pageNo, Markdown: converted.markdown})
	}
	if err := p.stage("rendering"); err != nil {
		return err
	}
	prefix := filepath.Join(dir, "rendered")
	_, err = p.runner.run(p.ctx, "pdftoppm", dir, []string{
		"-f", n, "-l", n, "-singlefile", "-png", "-scale-to", "2560", input, prefix,
	}, maxToolOutput)
	if err != nil {
		return popplerError(err)
	}
	imagePath := prefix + ".png"
	if err := validateImage(imagePath); err != nil {
		return err
	}
	page := Page{PageNo: pageNo, Markdown: converted.markdown, ImagePath: imagePath}
	if converted.needsOCR {
		page.Assets = []Asset{{ImagePath: imagePath, Kind: "page", Bounds: [4]float64{0, 0, 1, 1}}}
	} else {
		page.Assets, err = renderPDFAssets(p.ctx, imagePath, dir, converted.visuals)
		if err != nil {
			return err
		}
	}
	return p.deliver(page)
}

// openRegular 拒绝符号链接、管道、目录和超大文件，避免阻塞及文件替换竞态。
func openRegular(path string, maxBytes int64) (*os.File, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, failure(CodeIO)
	}
	if !before.Mode().IsRegular() || before.Size() == 0 {
		return nil, failure(CodeMalformed)
	}
	if before.Size() > maxBytes {
		return nil, failure(CodeResourceLimit)
	}
	file, err := openReadOnly(path)
	if err != nil {
		return nil, failure(CodeIO)
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) || after.Size() != before.Size() {
		file.Close()
		return nil, failure(CodeIO)
	}
	return file, nil
}

func validateImage(path string) error {
	file, err := openRegular(path, maxImageBytes)
	if err != nil {
		return err
	}
	defer file.Close()
	// 只读取图片头部获取真实格式和尺寸，绝不按不可信尺寸分配整幅像素缓冲区。
	cfg, _, err := image.DecodeConfig(io.LimitReader(file, maxImageBytes))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return failure(CodeMalformed)
	}
	if cfg.Width > maxImagePixels/cfg.Height {
		return failure(CodeResourceLimit)
	}
	return nil
}

func popplerError(err error) error {
	var e *Error
	if !errors.As(err, &e) || e.Code != CodeCommandFailed {
		return err
	}
	// Poppler 的公开退出码：1 输入打不开（也包括打开密码错误），2 输出打不开，3 权限。
	// 只对 LC_ALL=C 的固定密码诊断分类；其他 code 1 仍按已持有输入损坏处理。
	switch e.exitCode {
	case 1:
		if e.incorrectPassword {
			return failure(CodeEncrypted)
		}
		return failure(CodeMalformed)
	case 99:
		return failure(CodeMalformed)
	case 2:
		return failure(CodeIO)
	case 3:
		return failure(CodeEncrypted)
	default:
		return err
	}
}
