package kb

import "sync"

const knowledgeBuildWriteLockStripes = 64

var knowledgeBuildWriteLocks [knowledgeBuildWriteLockStripes]sync.Mutex

// withKnowledgeBuildWriteLock 串行化同一知识库的“读取全局目录 → 规划 → 落库”。
// Compose 只运行一个统一 Worker 进程；使用分片锁可让不同知识库继续并行，同时避免
// 多篇文章并发完成时各自看不到对方、重新生成一棵按文件隔离的目录树。
func withKnowledgeBuildWriteLock(knowledgeBaseID int64, run func() error) error {
	index := knowledgeBaseID % knowledgeBuildWriteLockStripes
	if index < 0 {
		index = -index
	}
	lock := &knowledgeBuildWriteLocks[index]
	lock.Lock()
	defer lock.Unlock()
	return run()
}
