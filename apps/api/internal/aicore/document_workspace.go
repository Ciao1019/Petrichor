package aicore

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
)

type documentReadRequest struct {
	FilePath string
	Offset   int
	Limit    int
}
type documentWriteRequest struct {
	FilePath string
	Content  string
}
type documentFileContent struct {
	Content string
	Lines   int
}

// documentMemoryBackend 只存放本次构建的虚拟文件，永远不访问宿主机文件系统。
type documentMemoryBackend struct {
	mu    sync.RWMutex
	files map[string]string
	size  int
}

func newDocumentMemoryBackend() *documentMemoryBackend {
	return &documentMemoryBackend{files: map[string]string{}}
}

func (b *documentMemoryBackend) Read(ctx context.Context, request *documentReadRequest) (*documentFileContent, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if request == nil || request.Offset < 0 || request.Limit < 0 {
		return nil, fmt.Errorf("读取范围无效")
	}
	b.mu.RLock()
	content, ok := b.files[normalizeDocumentAgentPath(request.FilePath)]
	b.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("工作区文件不存在")
	}
	lines := strings.Split(content, "\n")
	start := max(request.Offset-1, 0)
	if start >= len(lines) {
		return &documentFileContent{}, nil
	}
	end := len(lines)
	if request.Limit > 0 && request.Limit < end-start {
		end = start + request.Limit
	}
	return &documentFileContent{Content: strings.Join(lines[start:end], "\n"), Lines: end - start}, nil
}

func (b *documentMemoryBackend) Write(ctx context.Context, request *documentWriteRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if request == nil {
		return fmt.Errorf("缺少工作区文件")
	}
	path := normalizeDocumentAgentPath(request.FilePath)
	b.mu.Lock()
	defer b.mu.Unlock()
	size := b.size - len(b.files[path]) + len(request.Content)
	if len(request.Content) > 8*1024*1024 || size > 64*1024*1024 {
		return fmt.Errorf("工作区内容超过容量限制")
	}
	b.files[path] = request.Content
	b.size = size
	return nil
}

func (b *documentMemoryBackend) snapshot() map[string]string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	files := make(map[string]string, len(b.files))
	for path, content := range b.files {
		files[path] = content
	}
	return files
}

type trackedDocumentBackend struct {
	*documentMemoryBackend
	mu              sync.Mutex
	notifyMu        sync.Mutex
	expectedLines   map[string]int
	readLines       map[string]map[int]struct{}
	completedPaths  map[string]struct{}
	onPartCompleted func(completed, total int)
	onPartVerified  func(path string, completed, total int)
}

func newTrackedDocumentBackend(callbacks ...func(completed, total int)) *trackedDocumentBackend {
	var callback func(completed, total int)
	if len(callbacks) > 0 {
		callback = callbacks[0]
	}
	return &trackedDocumentBackend{
		documentMemoryBackend: newDocumentMemoryBackend(),
		expectedLines:         map[string]int{},
		readLines:             map[string]map[int]struct{}{},
		completedPaths:        map[string]struct{}{},
		onPartCompleted:       callback,
	}
}

func (b *trackedDocumentBackend) expect(path, content string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.expectedLines[normalizeDocumentAgentPath(path)] = strings.Count(content, "\n") + 1
}

func (b *trackedDocumentBackend) Read(ctx context.Context, req *documentReadRequest) (*documentFileContent, error) {
	content, err := b.documentMemoryBackend.Read(ctx, req)
	if err != nil {
		return nil, err
	}
	// 并行子任务的完成通知按已核验计数串行发出，避免进度倒退和回调并发。
	b.notifyMu.Lock()
	defer b.notifyMu.Unlock()
	path := normalizeDocumentAgentPath(req.FilePath)
	b.mu.Lock()
	completed, total := 0, len(b.expectedLines)
	shouldNotify := false
	if totalLines, ok := b.expectedLines[path]; ok && content.Lines > 0 {
		start := req.Offset
		if start < 1 {
			start = 1
		}
		readCount := content.Lines
		if b.readLines[path] == nil {
			b.readLines[path] = map[int]struct{}{}
		}
		for line := start; line < start+readCount && line <= totalLines; line++ {
			b.readLines[path][line] = struct{}{}
		}
		if len(b.readLines[path]) >= totalLines {
			if _, exists := b.completedPaths[path]; !exists {
				b.completedPaths[path] = struct{}{}
				shouldNotify = true
			}
		}
	}
	completed = len(b.completedPaths)
	callback := b.onPartCompleted
	verifiedCallback := b.onPartVerified
	b.mu.Unlock()
	if shouldNotify && callback != nil {
		callback(completed, total)
	}
	if shouldNotify && verifiedCallback != nil {
		verifiedCallback(path, completed, total)
	}
	return content, nil
}

func normalizeDocumentAgentPath(path string) string {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return filepath.Clean(path)
}

func (b *trackedDocumentBackend) unreadCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.expectedLines) - len(b.completedPaths)
}

func (b *trackedDocumentBackend) expectedCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.expectedLines)
}
