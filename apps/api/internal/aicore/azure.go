package aicore

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	httpx "petrichor/api/internal/httpx"
)

const defaultAzureAPIVersion = "v1"

// azureEndpoint 与当前 TS @ai-sdk/azure 的 URL 语义保持一致：
// Azure 官方域名使用 {base}/v1{path}?api-version=...，自定义网关直接使用 {base}{path}。
func azureEndpoint(rt RuntimeConfig, path string) (string, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(rt.BaseURL), "/")
	if baseURL == "" {
		resourceName := strings.TrimSpace(rt.Extra["resourceName"])
		if resourceName == "" {
			return "", &httpx.HttpError{Status: http.StatusBadRequest, Message: "Azure OpenAI 缺少 resourceName 或 BaseUrl"}
		}
		baseURL = "https://" + resourceName + ".openai.azure.com/openai"
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", &httpx.HttpError{Status: http.StatusBadRequest, Message: "Azure OpenAI BaseUrl 无效"}
	}
	isAzureEndpoint := strings.HasSuffix(strings.ToLower(parsed.Hostname()), ".openai.azure.com")
	if isAzureEndpoint {
		parsed.Path = strings.TrimRight(parsed.Path, "/") + "/v1" + path
		apiVersion := strings.TrimSpace(rt.Extra["apiVersion"])
		if apiVersion == "" {
			apiVersion = defaultAzureAPIVersion
		}
		query := parsed.Query()
		query.Set("api-version", apiVersion)
		parsed.RawQuery = query.Encode()
		return parsed.String(), nil
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + path
	return parsed.String(), nil
}

func applyAzureHeaders(req *http.Request, rt RuntimeConfig) {
	req.Header.Set("Content-Type", "application/json")
	if rt.APIKey != "" {
		req.Header.Set("api-key", rt.APIKey)
	}
	for key, value := range rt.Headers {
		req.Header.Set(key, value)
	}
}

func azureChat(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, tools []ToolDefinition, stream bool, onDelta func(string) error) (*ChatResult, error) {
	body := openAIChatRequest{
		Model:       modelID,
		Messages:    toOpenAIMessages(msgs),
		Temperature: opts.Temperature,
		MaxTokens:   opts.MaxTokens,
		Stream:      stream,
	}
	if len(tools) > 0 {
		body.Tools = openAIToolsPayload(tools)
	}
	applyQuirksToOpenAI(&body, rt, modelID, opts)
	endpoint, err := azureEndpoint(rt, "/chat/completions")
	if err != nil {
		return nil, err
	}
	if stream {
		return doSSEWithHeaders(ctx, endpoint, body, onDelta, func(req *http.Request) {
			applyAzureHeaders(req, rt)
		})
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	applyAzureHeaders(req, rt)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, readErr
	}
	if resp.StatusCode >= 400 {
		return nil, modelHTTPError(resp.StatusCode, data)
	}
	return parseOpenAIPayload(data)
}

func azureEmbeddings(ctx context.Context, rt RuntimeConfig, modelID string, texts []string) ([][]float32, error) {
	endpoint, err := azureEndpoint(rt, "/embeddings")
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(map[string]any{"model": modelID, "input": texts})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	applyAzureHeaders(req, rt)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, readErr
	}
	if resp.StatusCode >= 400 {
		return nil, &httpx.HttpError{Status: http.StatusBadGateway, Message: fmt.Sprintf("向量调用失败(%d)：%s", resp.StatusCode, truncate(string(data), 300))}
	}
	var parsed struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("Azure 向量响应解析失败：%w", err)
	}
	out := make([][]float32, len(parsed.Data))
	for _, item := range parsed.Data {
		if item.Index >= 0 && item.Index < len(out) {
			out[item.Index] = item.Embedding
		}
	}
	return out, nil
}
