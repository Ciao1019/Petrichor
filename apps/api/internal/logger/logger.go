package logger

import (
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

func New(production bool) (*zap.Logger, error) {
	if production {
		return zap.NewProduction()
	}
	cfg := zap.NewDevelopmentConfig()
	cfg.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
	return cfg.Build()
}
