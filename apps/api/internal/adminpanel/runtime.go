package adminpanel

import (
	"github.com/gin-gonic/gin"

	"petrichor/api/internal/db"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
)

// AdminRuntimeMetrics GET /api/admin/runtime/metrics。
// 仅返回进程、连接池、Asynq 队列与 Redis 视觉导入状态聚合，不包含用户输入与敏感配置。
func AdminRuntimeMetrics(c *gin.Context) {
	knowledgeJobs, err := taskqueue.QueueStatusCounts(taskqueue.QueueKnowledgeBuild)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	importQueueJobs, err := taskqueue.QueueStatusCounts(taskqueue.QueueDocumentImport)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	store, err := taskqueue.DocumentImports()
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	importJobs, err := store.StatusCounts(c.Request.Context())
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	poolStats := db.Pool().Stat()
	httpx.OK(c, map[string]any{
		"http": httpx.SnapshotRequestMetrics(),
		"database": map[string]any{
			"maxConnections":          poolStats.MaxConns(),
			"totalConnections":        poolStats.TotalConns(),
			"acquiredConnections":     poolStats.AcquiredConns(),
			"idleConnections":         poolStats.IdleConns(),
			"constructingConnections": poolStats.ConstructingConns(),
			"acquireCount":            poolStats.AcquireCount(),
			"canceledAcquireCount":    poolStats.CanceledAcquireCount(),
			"emptyAcquireCount":       poolStats.EmptyAcquireCount(),
		},
		"workers": map[string]any{
			"knowledgeBuildJobs":       knowledgeJobs,
			"documentImportQueueJobs":  importQueueJobs,
			"documentImportDomainJobs": importJobs,
		},
	})
}
