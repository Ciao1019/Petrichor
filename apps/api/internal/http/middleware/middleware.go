package middleware

import (
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

func RequestLogger(log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		fields := []zap.Field{
			zap.String("method", c.Request.Method),
			zap.String("path", c.Request.URL.Path),
			zap.Int("status", c.Writer.Status()),
			zap.Duration("latency", time.Since(start)),
			zap.String("client_ip", c.ClientIP()),
		}
		if len(c.Errors) > 0 {
			fields = append(fields, zap.Strings("errors", c.Errors.Errors()))
		}
		if c.Writer.Status() >= 500 {
			log.Error("http", fields...)
			return
		}
		log.Info("http", fields...)
	}
}

func Recovery(log *zap.Logger) gin.HandlerFunc {
	return gin.CustomRecovery(func(c *gin.Context, recovered any) {
		log.Error("panic recovered", zap.Any("error", recovered), zap.String("path", c.Request.URL.Path))
		c.AbortWithStatusJSON(500, gin.H{
			"code": 500,
			"msg":  "系统异常，请稍后重试",
			"path": c.Request.URL.Path,
		})
	})
}
