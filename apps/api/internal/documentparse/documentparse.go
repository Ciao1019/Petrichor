// Package documentparse 在 Worker 中执行有界的文档转换，不访问外部 URL。
package documentparse

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxSourceBytes   = 100 << 20
	maxMarkdownUnit  = 2 << 20
	maxMarkdownTotal = 16 << 20
	maxPDFPages      = 500
	maxImageBytes    = 20 << 20
	maxImagePixels   = 24_000_000
)

// Config 的 Command 只能是可执行文件名或绝对路径，不接受 shell 命令。
type Config struct {
	Command string
	Timeout time.Duration
}

func DefaultConfig() Config {
	return Config{Command: "petrichor-doc-convert", Timeout: 5 * time.Minute}
}

func (c Config) normalized() Config {
	if c.Command == "" {
		c.Command = DefaultConfig().Command
	}
	if c.Timeout <= 0 {
		c.Timeout = DefaultConfig().Timeout
	}
	return c
}

// Markdown 与图片独立存在。所有图片路径只在 emit 回调期间有效，必须立即上传。
type Page struct {
	PageNo    int
	Markdown  *string
	ImagePath string
	Assets    []Asset
}

type Asset struct {
	ImagePath string
	Anchor    string
	Kind      string     // region / page：区域原貌或无法定位时的原页
	Bounds    [4]float64 // 左上原点的归一化 x/y/width/height
}

// Error 只暴露稳定分类，不包含文件名、子进程输出或底层系统错误。
// 取消和超时使用 context.Canceled / context.DeadlineExceeded；emit 错误原样返回。
type Error struct {
	Code              string
	exitCode          int
	incorrectPassword bool
}

const (
	CodeMalformed          = "malformed"
	CodeEncrypted          = "encrypted"
	CodeUnsupported        = "unsupported"
	CodeResourceLimit      = "resourceLimit"
	CodeMissingPart        = "missingPart"
	CodeIO                 = "io"
	CodeRuntimeUnavailable = "runtimeUnavailable"
	CodeCommandFailed      = "commandFailed"
	CodeProtocol           = "protocol"
)

func (e *Error) Error() string { return "documentparse: " + e.Code }

func failure(code string) error { return &Error{Code: code} }

func IsPermanent(err error) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	switch e.Code {
	case CodeMalformed, CodeEncrypted, CodeUnsupported, CodeResourceLimit, CodeMissingPart:
		return true
	default:
		return false
	}
}

type commandRunner interface {
	run(context.Context, string, string, []string, int) ([]byte, error)
}

// Prepare 的总超时覆盖解析、渲染及回调，且不延长外层 deadline。
// 回调同步执行以保证临时图片的生命周期；回调内的网络 IO 必须使用调用方的 context。
// Go 无法强制中断用户回调，回调返回后还会检查总 deadline。
func Prepare(ctx context.Context, cfg Config, fileName string, source []byte, workDir string, onStage func(string), emit func(Page) error) error {
	return prepare(ctx, cfg, fileName, source, workDir, onStage, emit, execRunner{})
}

func prepare(ctx context.Context, cfg Config, fileName string, source []byte, workDir string, onStage func(string), emit func(Page) error, runner commandRunner) (result error) {
	cfg = cfg.normalized()
	ctx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(source) == 0 {
		return failure(CodeMalformed)
	}
	if len(source) > maxSourceBytes {
		return failure(CodeResourceLimit)
	}
	format := strings.ToLower(strings.TrimPrefix(filepath.Ext(strings.TrimRightFunc(fileName, unicode.IsSpace)), "."))
	if !supportedFormat(format) {
		return failure(CodeUnsupported)
	}
	if emit == nil {
		return failure(CodeIO)
	}
	p := preparation{ctx: ctx, cfg: cfg, runner: runner, onStage: onStage, emit: emit}
	if err := p.stage("parsing"); err != nil {
		return err
	}
	if format == "md" || format == "markdown" {
		if len(source) > maxMarkdownUnit {
			return failure(CodeResourceLimit)
		}
		if !utf8.Valid(source) {
			return failure(CodeMalformed)
		}
		text := string(source)
		return p.deliver(Page{PageNo: 1, Markdown: &text})
	}
	// 在调用方目录内建立私有子目录，不使用原始文件名构造任何路径。
	root, err := filepath.Abs(workDir)
	if err != nil || workDir == "" {
		return failure(CodeIO)
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() {
		return failure(CodeIO)
	}
	dir, err := os.MkdirTemp(root, "documentparse-")
	if err != nil {
		return failure(CodeIO)
	}
	defer func() {
		if err := os.RemoveAll(dir); err != nil && result == nil {
			result = failure(CodeIO)
		}
	}()
	// 拆页命令的 cwd 是 unit，但资源核算始终包含整个任务及原始输入。
	p.ctx = context.WithValue(ctx, taskDirectoryKey{}, dir)
	input := filepath.Join(dir, "source."+format)
	if err := os.WriteFile(input, source, 0600); err != nil {
		return failure(CodeIO)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if format == "pdf" {
		return p.pdf(input, dir)
	}
	converted, err := p.convert(input, format, dir)
	if err != nil {
		return err
	}
	if converted.needsOCR {
		// 非 PDF 没有受支持的物理页渲染入口，不能将转换错误降级成 OCR。
		return failure(CodeUnsupported)
	}
	return p.deliver(Page{PageNo: 1, Markdown: converted.markdown})
}

func supportedFormat(format string) bool {
	switch format {
	case "doc", "docx", "docm", "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm",
		"xls", "xlsx", "xlsm", "xlsb", "odt", "ods", "odp", "rtf", "epub", "csv", "pdf", "md", "markdown":
		return true
	default:
		return false
	}
}

type preparation struct {
	ctx           context.Context
	cfg           Config
	runner        commandRunner
	onStage       func(string)
	emit          func(Page) error
	markdownBytes int
}

func (p *preparation) stage(stage string) error {
	if err := p.ctx.Err(); err != nil {
		return err
	}
	if p.onStage != nil {
		p.onStage(stage)
	}
	return p.ctx.Err()
}

func (p *preparation) deliver(page Page) error {
	if err := p.ctx.Err(); err != nil {
		return err
	}
	if page.Markdown != nil {
		size := len(*page.Markdown)
		if size > maxMarkdownUnit || size > maxMarkdownTotal-p.markdownBytes {
			return failure(CodeResourceLimit)
		}
		if !utf8.ValidString(*page.Markdown) {
			return failure(CodeMalformed)
		}
		p.markdownBytes += size
	}
	err := p.emit(page)
	if ctxErr := p.ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	return err
}
