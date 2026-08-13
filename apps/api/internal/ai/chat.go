package ai

import (
	"context"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

// ResolveChatConfig 解析用户默认 CHAT 模型配置。
func ResolveChatConfig(ctx context.Context, client *ent.Client, userID int64) (*ent.AIModelConfig, error) {
	return ResolveChatConfigByID(ctx, client, userID, nil)
}

// ResolveChatConfigByID 优先使用知识库绑定的对话模型，否则回退到用户默认模型。
func ResolveChatConfigByID(ctx context.Context, client *ent.Client, userID int64, configID *int64) (*ent.AIModelConfig, error) {
	if configID != nil && *configID > 0 {
		row, err := client.AIModelConfig.Query().Where(
			aimodelconfig.IDEQ(*configID),
			aimodelconfig.UserIDEQ(userID),
			aimodelconfig.ConfigTypeEQ("CHAT"),
			aimodelconfig.EnabledEQ(true),
		).Only(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				return nil, response.BadRequest("知识库绑定的 CHAT 模型不可用")
			}
			return nil, err
		}
		return row, nil
	}
	row, err := client.AIModelConfig.Query().
		Where(
			aimodelconfig.UserIDEQ(userID),
			aimodelconfig.ConfigTypeEQ("CHAT"),
			aimodelconfig.IsDefaultEQ(true),
			aimodelconfig.EnabledEQ(true),
		).
		Order(ent.Asc(aimodelconfig.FieldID)).
		First(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.BadRequest("未找到可用的默认配置：CHAT")
		}
		return nil, err
	}
	return row, nil
}
