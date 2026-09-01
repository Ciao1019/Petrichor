package adminpanel

import (
	"context"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/db"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/kb"
)

type jobStatusCount struct {
	Status string `json:"status"`
	Count  int64  `json:"count"`
}

// AdminRuntimeMetrics GET /api/admin/runtime/metrics。
// 仅返回进程、连接池、内存知识构建与持久视觉导入的聚合值，不包含用户输入与敏感配置。
func AdminRuntimeMetrics(c *gin.Context) {
	ctx := c.Request.Context()
	knowledgeJobs := kb.ArticleKnowledgeBuildStatusCounts()
	importJobs, err := loadJobStatusCounts(ctx, "petrichor_kb_import_job")
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
			"knowledgeBuildJobs": knowledgeJobs,
			"documentImportJobs": importJobs,
		},
	})
}

func loadJobStatusCounts(ctx context.Context, table string) ([]jobStatusCount, error) {
	// table 只能来自本文件内的常量调用，不接受 HTTP 输入。
	rows, err := db.Pool().Query(ctx, `SELECT status, count(*)::bigint FROM `+table+` GROUP BY status ORDER BY status`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := []jobStatusCount{}
	for rows.Next() {
		var item jobStatusCount
		if err := rows.Scan(&item.Status, &item.Count); err != nil {
			return nil, err
		}
		counts = append(counts, item)
	}
	return counts, rows.Err()
}
