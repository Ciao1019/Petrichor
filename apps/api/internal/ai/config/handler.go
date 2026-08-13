package aiconfig

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/crypto"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type Handler struct {
	client *ent.Client
	cfg    *config.Config
}

func NewHandler(client *ent.Client, cfg *config.Config) *Handler {
	return &Handler{client: client, cfg: cfg}
}

type DTO struct {
	ID           string  `json:"id"`
	ConfigType   string  `json:"configType"`
	Protocol     string  `json:"protocol"`
	Name         string  `json:"name"`
	BaseURL      *string `json:"baseUrl"`
	HasAPIKey    bool    `json:"hasApiKey"`
	APIKeyMasked *string `json:"apiKeyMasked"`
	Model        string  `json:"model"`
	Enabled      bool    `json:"enabled"`
	IsDefault    bool    `json:"isDefault"`
	ExtraJSON    *string `json:"extraJson"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

func (h *Handler) toDTO(row *ent.AIModelConfig) (DTO, error) {
	plainKey, err := h.decryptKey(row.APIKeyEnc)
	if err != nil {
		return DTO{}, err
	}
	var masked *string
	if plainKey != "" {
		value := maskAPIKey(plainKey)
		masked = &value
	}
	return DTO{
		ID:           strconv.FormatInt(row.ID, 10),
		ConfigType:   row.ConfigType,
		Protocol:     row.Protocol,
		Name:         row.Name,
		BaseURL:      row.BaseURL,
		HasAPIKey:    plainKey != "",
		APIKeyMasked: masked,
		Model:        row.Model,
		Enabled:      row.Enabled,
		IsDefault:    row.IsDefault,
		ExtraJSON:    row.ExtraJSON,
		CreatedAt:    row.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:    row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (h *Handler) encryptKey(plain string) (string, error) {
	plain = strings.TrimSpace(plain)
	if plain == "" {
		return "", nil
	}
	if strings.TrimSpace(h.cfg.EncryptKey) == "" || strings.TrimSpace(h.cfg.EncryptSalt) == "" {
		return "", fmt.Errorf("缺少 PETRICHOR_ENCRYPT_KEY/SALT，无法加密 API Key")
	}
	return crypto.EncryptText(h.cfg.EncryptKey, h.cfg.EncryptSalt, plain)
}

func (h *Handler) decryptKey(encoded *string) (string, error) {
	if encoded == nil || strings.TrimSpace(*encoded) == "" {
		return "", nil
	}
	raw := strings.TrimSpace(*encoded)
	// 兼容 Go 重构早期曾写入的明文；新写入的数据一律加密。
	if !looksLikeHexCipher(raw) {
		return raw, nil
	}
	if strings.TrimSpace(h.cfg.EncryptKey) == "" || strings.TrimSpace(h.cfg.EncryptSalt) == "" {
		return "", fmt.Errorf("缺少 PETRICHOR_ENCRYPT_KEY/SALT，无法解密 API Key")
	}
	return crypto.DecryptText(h.cfg.EncryptKey, h.cfg.EncryptSalt, raw)
}

func (h *Handler) List(c *gin.Context) {
	var req struct {
		PageNum    int    `json:"pageNum"`
		PageSize   int    `json:"pageSize"`
		ConfigType string `json:"configType"`
		Protocol   string `json:"protocol"`
		Enabled    *bool  `json:"enabled"`
		Keyword    string `json:"keyword"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	if req.PageNum <= 0 {
		req.PageNum = 1
	}
	if req.PageSize <= 0 {
		req.PageSize = 20
	}
	u := auth.MustUser(c)
	configType := parseConfigType(req.ConfigType)
	if configType == "" {
		configType = "CHAT"
	}
	query := h.client.AIModelConfig.Query().
		Where(aimodelconfig.UserIDEQ(u.ID), aimodelconfig.ConfigTypeEQ(configType))
	if protocol := parseProtocol(req.Protocol); protocol != "" {
		query = query.Where(aimodelconfig.ProtocolEQ(protocol))
	}
	if req.Enabled != nil {
		query = query.Where(aimodelconfig.EnabledEQ(*req.Enabled))
	}
	if keyword := strings.TrimSpace(req.Keyword); keyword != "" {
		query = query.Where(aimodelconfig.NameContainsFold(keyword))
	}
	total, err := query.Clone().Count(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	rows, err := query.
		Order(ent.Desc(aimodelconfig.FieldUpdatedAt), ent.Desc(aimodelconfig.FieldID)).
		Limit(req.PageSize).
		Offset((req.PageNum - 1) * req.PageSize).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]DTO, 0, len(rows))
	for _, row := range rows {
		item, err := h.toDTO(row)
		if err != nil {
			response.Fail(c, err)
			return
		}
		out = append(out, item)
	}
	response.TableData(c, out, total)
}

type createRequest struct {
	ConfigType string  `json:"configType"`
	Protocol   string  `json:"protocol"`
	Name       string  `json:"name"`
	BaseURL    *string `json:"baseUrl"`
	APIKey     *string `json:"apiKey"`
	Model      string  `json:"model"`
	Enabled    *bool   `json:"enabled"`
	IsDefault  bool    `json:"isDefault"`
	ExtraJSON  *string `json:"extraJson"`
}

func (h *Handler) Create(c *gin.Context) {
	var req createRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	configType := parseConfigType(req.ConfigType)
	if configType == "" {
		response.Fail(c, response.BadRequest("配置类型不能为空"))
		return
	}
	protocol := parseProtocol(req.Protocol)
	if protocol == "" {
		response.Fail(c, response.BadRequest("协议类型不能为空"))
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		response.Fail(c, response.BadRequest("配置名称不能为空"))
		return
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		response.Fail(c, response.BadRequest("模型名称不能为空"))
		return
	}
	baseURL := applyDefaultBaseURL(protocol, optionalString(req.BaseURL))
	if protocol == "OPENAI_COMPAT" && baseURL == nil {
		response.Fail(c, response.BadRequest("OPENAI_COMPAT 协议必须填写 BaseUrl"))
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	apiKey := optionalString(req.APIKey)
	if enabled && apiKey == nil {
		response.Fail(c, response.BadRequest("启用配置前必须填写 API Key"))
		return
	}
	u := auth.MustUser(c)
	if err := h.ensureUniqueName(c, u.ID, configType, name, 0); err != nil {
		response.Fail(c, err)
		return
	}
	builder := h.client.AIModelConfig.Create().
		SetUserID(u.ID).
		SetConfigType(configType).
		SetProtocol(protocol).
		SetName(name).
		SetModel(model).
		SetEnabled(enabled).
		SetIsDefault(req.IsDefault).
		SetNillableBaseURL(baseURL).
		SetNillableExtraJSON(optionalString(req.ExtraJSON))
	if apiKey != nil {
		encoded, err := h.encryptKey(*apiKey)
		if err != nil {
			response.Fail(c, err)
			return
		}
		builder.SetAPIKeyEnc(encoded)
	}
	row, err := builder.Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if row.IsDefault {
		if _, err := h.client.AIModelConfig.Update().
			Where(aimodelconfig.UserIDEQ(u.ID), aimodelconfig.ConfigTypeEQ(row.ConfigType), aimodelconfig.IDNEQ(row.ID)).
			SetIsDefault(false).
			Save(c.Request.Context()); err != nil {
			response.Fail(c, err)
			return
		}
	}
	out, err := h.toDTO(row)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, out)
}

func (h *Handler) Detail(c *gin.Context) {
	id, ok := bindID(c)
	if !ok {
		return
	}
	u := auth.MustUser(c)
	row, err := h.findOwned(c, u.ID, id)
	if err != nil {
		response.Fail(c, err)
		return
	}
	out, err := h.toDTO(row)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, out)
}

type updateRequest struct {
	ID         string  `json:"id"`
	ConfigType *string `json:"configType"`
	Protocol   *string `json:"protocol"`
	Name       *string `json:"name"`
	BaseURL    *string `json:"baseUrl"`
	APIKey     *string `json:"apiKey"`
	Model      *string `json:"model"`
	Enabled    *bool   `json:"enabled"`
	IsDefault  *bool   `json:"isDefault"`
	ExtraJSON  *string `json:"extraJson"`
}

func (h *Handler) Update(c *gin.Context) {
	var req updateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parseID(req.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	existing, err := h.findOwned(c, u.ID, id)
	if err != nil {
		response.Fail(c, err)
		return
	}
	configType := existing.ConfigType
	if req.ConfigType != nil {
		configType = parseConfigType(*req.ConfigType)
	}
	if configType == "" {
		response.Fail(c, response.BadRequest("配置类型不能为空"))
		return
	}
	protocol := existing.Protocol
	if req.Protocol != nil {
		protocol = parseProtocol(*req.Protocol)
	}
	if protocol == "" {
		response.Fail(c, response.BadRequest("协议类型不能为空"))
		return
	}
	name := existing.Name
	if req.Name != nil {
		name = strings.TrimSpace(*req.Name)
	}
	if name == "" {
		response.Fail(c, response.BadRequest("配置名称不能为空"))
		return
	}
	model := existing.Model
	if req.Model != nil {
		model = strings.TrimSpace(*req.Model)
	}
	if model == "" {
		response.Fail(c, response.BadRequest("模型名称不能为空"))
		return
	}
	baseURL := existing.BaseURL
	if req.BaseURL != nil {
		baseURL = applyDefaultBaseURL(protocol, optionalString(req.BaseURL))
	}
	if protocol == "OPENAI_COMPAT" && baseURL == nil {
		response.Fail(c, response.BadRequest("OPENAI_COMPAT 协议必须填写 BaseUrl"))
		return
	}
	enabled := existing.Enabled
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	apiKeyEnc := existing.APIKeyEnc
	if req.APIKey != nil {
		plain := optionalString(req.APIKey)
		if plain == nil {
			apiKeyEnc = nil
		} else {
			encoded, err := h.encryptKey(*plain)
			if err != nil {
				response.Fail(c, err)
				return
			}
			apiKeyEnc = &encoded
		}
	}
	if enabled && (apiKeyEnc == nil || strings.TrimSpace(*apiKeyEnc) == "") {
		response.Fail(c, response.BadRequest("启用配置前必须填写 API Key"))
		return
	}
	if configType != existing.ConfigType || name != existing.Name {
		if err := h.ensureUniqueName(c, u.ID, configType, name, id); err != nil {
			response.Fail(c, err)
			return
		}
	}
	isDefault := existing.IsDefault
	if req.IsDefault != nil {
		isDefault = *req.IsDefault
	}
	extraJSON := existing.ExtraJSON
	if req.ExtraJSON != nil {
		extraJSON = optionalString(req.ExtraJSON)
	}
	if isDefault {
		if _, err := h.client.AIModelConfig.Update().
			Where(aimodelconfig.UserIDEQ(u.ID), aimodelconfig.ConfigTypeEQ(configType), aimodelconfig.IDNEQ(id)).
			SetIsDefault(false).
			Save(c.Request.Context()); err != nil {
			response.Fail(c, err)
			return
		}
	}
	updater := h.client.AIModelConfig.UpdateOne(existing).
		SetConfigType(configType).
		SetProtocol(protocol).
		SetName(name).
		SetModel(model).
		SetEnabled(enabled).
		SetIsDefault(isDefault)
	if baseURL == nil {
		updater.ClearBaseURL()
	} else {
		updater.SetBaseURL(*baseURL)
	}
	if apiKeyEnc == nil {
		updater.ClearAPIKeyEnc()
	} else {
		updater.SetAPIKeyEnc(*apiKeyEnc)
	}
	if extraJSON == nil {
		updater.ClearExtraJSON()
	} else {
		updater.SetExtraJSON(*extraJSON)
	}
	updated, err := updater.Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	out, err := h.toDTO(updated)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, out)
}

func (h *Handler) Delete(c *gin.Context) {
	id, ok := bindID(c)
	if !ok {
		return
	}
	u := auth.MustUser(c)
	if _, err := h.findOwned(c, u.ID, id); err != nil {
		response.Fail(c, err)
		return
	}
	if _, err := h.client.AIModelConfig.Delete().
		Where(aimodelconfig.IDEQ(id), aimodelconfig.UserIDEQ(u.ID)).
		Exec(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	c.Status(http.StatusOK)
}

func (h *Handler) SetDefault(c *gin.Context) {
	id, ok := bindID(c)
	if !ok {
		return
	}
	u := auth.MustUser(c)
	existing, err := h.findOwned(c, u.ID, id)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if _, err := h.client.AIModelConfig.Update().
		Where(aimodelconfig.UserIDEQ(u.ID), aimodelconfig.ConfigTypeEQ(existing.ConfigType), aimodelconfig.IDNEQ(id)).
		SetIsDefault(false).
		Save(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	updated, err := h.client.AIModelConfig.UpdateOne(existing).SetIsDefault(true).Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	out, err := h.toDTO(updated)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, out)
}

func (h *Handler) findOwned(c *gin.Context, userID, id int64) (*ent.AIModelConfig, error) {
	row, err := h.client.AIModelConfig.Query().
		Where(aimodelconfig.IDEQ(id), aimodelconfig.UserIDEQ(userID)).
		Only(c.Request.Context())
	if ent.IsNotFound(err) {
		return nil, response.NotFound("配置不存在")
	}
	return row, err
}

func (h *Handler) ensureUniqueName(c *gin.Context, userID int64, configType, name string, excludeID int64) error {
	query := h.client.AIModelConfig.Query().Where(
		aimodelconfig.UserIDEQ(userID),
		aimodelconfig.ConfigTypeEQ(configType),
		aimodelconfig.NameEQ(name),
	)
	if excludeID > 0 {
		query = query.Where(aimodelconfig.IDNEQ(excludeID))
	}
	exists, err := query.Exist(c.Request.Context())
	if err != nil {
		return err
	}
	if exists {
		return response.BadRequest("同类型下已存在同名配置")
	}
	return nil
}

func bindID(c *gin.Context) (int64, bool) {
	var req struct {
		ID string `json:"id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return 0, false
	}
	id, err := parseID(req.ID)
	if err != nil {
		response.Fail(c, err)
		return 0, false
	}
	return id, true
}

func parseID(raw string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || id <= 0 {
		return 0, response.BadRequest("配置ID非法")
	}
	return id, nil
}

func parseConfigType(raw string) string {
	value := strings.ToUpper(strings.TrimSpace(raw))
	switch value {
	case "CHAT", "VISION", "EMBEDDING", "RERANK", "SPEECH":
		return value
	default:
		return ""
	}
}

func parseProtocol(raw string) string {
	value := strings.ToUpper(strings.TrimSpace(raw))
	switch value {
	case "OPENAI", "DEEPSEEK", "OPENAI_COMPAT", "SILICONFLOW", "GEMINI":
		return value
	default:
		return ""
	}
}

func applyDefaultBaseURL(protocol string, baseURL *string) *string {
	if baseURL != nil && strings.TrimSpace(*baseURL) != "" {
		value := strings.TrimRight(strings.TrimSpace(*baseURL), "/")
		return &value
	}
	defaults := map[string]string{
		"OPENAI":      "https://api.openai.com/v1",
		"DEEPSEEK":    "https://api.deepseek.com/v1",
		"SILICONFLOW": "https://api.siliconflow.cn/v1",
	}
	value, ok := defaults[protocol]
	if !ok {
		return nil
	}
	return &value
}

func optionalString(raw *string) *string {
	if raw == nil {
		return nil
	}
	value := strings.TrimSpace(*raw)
	if value == "" {
		return nil
	}
	return &value
}

func maskAPIKey(apiKey string) string {
	runes := []rune(strings.TrimSpace(apiKey))
	if len(runes) <= 8 {
		return "********"
	}
	return string(runes[:4]) + "********" + string(runes[len(runes)-4:])
}

func looksLikeHexCipher(value string) bool {
	if len(value) < 64 || len(value)%2 != 0 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') && (char < 'A' || char > 'F') {
			return false
		}
	}
	return true
}
