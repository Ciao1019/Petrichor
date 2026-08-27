package aicore

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	bedrockdocument "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/document"
	bedrocktypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"

	httpx "petrichor/api/internal/httpx"
)

type bedrockHeaderHTTPClient struct {
	base    bedrockruntime.HTTPClient
	headers map[string]string
}

func (c *bedrockHeaderHTTPClient) Do(req *http.Request) (*http.Response, error) {
	for key, value := range c.headers {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "authorization", "host", "x-amz-date", "x-amz-security-token", "x-amz-content-sha256":
			// 这些字段属于 SigV4 签名边界，禁止自定义头破坏 SDK 已完成的签名。
			continue
		}
		req.Header.Set(key, value)
	}
	return c.base.Do(req)
}

func newBedrockClient(rt RuntimeConfig) (*bedrockruntime.Client, error) {
	region := strings.TrimSpace(rt.Extra["region"])
	accessKeyID := strings.TrimSpace(rt.Extra["accessKeyId"])
	secretAccessKey := strings.TrimSpace(rt.Extra["secretAccessKey"])
	sessionToken := strings.TrimSpace(rt.Extra["sessionToken"])
	if region == "" || accessKeyID == "" || secretAccessKey == "" {
		return nil, &httpx.HttpError{Status: http.StatusBadRequest, Message: "Amazon Bedrock 缺少 region、accessKeyId 或 secretAccessKey"}
	}
	provider := aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{
			AccessKeyID: accessKeyID, SecretAccessKey: secretAccessKey, SessionToken: sessionToken,
			Source: "Petrichor static configuration",
		}, nil
	})
	options := bedrockruntime.Options{
		Region:      region,
		Credentials: aws.NewCredentialsCache(provider),
		HTTPClient:  &bedrockHeaderHTTPClient{base: httpClient, headers: rt.Headers},
	}
	if baseURL := strings.TrimRight(strings.TrimSpace(rt.BaseURL), "/"); baseURL != "" {
		parsed, err := url.Parse(baseURL)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return nil, &httpx.HttpError{Status: http.StatusBadRequest, Message: "Amazon Bedrock BaseUrl 无效"}
		}
		options.BaseEndpoint = aws.String(baseURL)
	}
	return bedrockruntime.New(options), nil
}

func bedrockConversation(msgs []ChatMessage) ([]bedrocktypes.SystemContentBlock, []bedrocktypes.Message, error) {
	system := make([]bedrocktypes.SystemContentBlock, 0, 2)
	messages := make([]bedrocktypes.Message, 0, len(msgs))
	for _, message := range msgs {
		if message.Role == "system" {
			if strings.TrimSpace(message.Content) != "" {
				system = append(system, &bedrocktypes.SystemContentBlockMemberText{Value: message.Content})
			}
			continue
		}
		if message.Role == "tool" {
			content := bedrocktypes.ToolResultContentBlock(&bedrocktypes.ToolResultContentBlockMemberText{Value: message.Content})
			var parsed any
			if json.Unmarshal([]byte(message.Content), &parsed) == nil {
				content = &bedrocktypes.ToolResultContentBlockMemberJson{Value: bedrockdocument.NewLazyDocument(parsed)}
			}
			messages = append(messages, bedrocktypes.Message{
				Role: bedrocktypes.ConversationRoleUser,
				Content: []bedrocktypes.ContentBlock{&bedrocktypes.ContentBlockMemberToolResult{Value: bedrocktypes.ToolResultBlock{
					ToolUseId: aws.String(message.ToolCallID), Content: []bedrocktypes.ToolResultContentBlock{content},
				}}},
			})
			continue
		}

		role := bedrocktypes.ConversationRoleUser
		if message.Role == "assistant" {
			role = bedrocktypes.ConversationRoleAssistant
		}
		content := make([]bedrocktypes.ContentBlock, 0, len(message.Parts)+len(message.ToolCalls)+1)
		if len(message.Parts) == 0 {
			if message.Content != "" {
				content = append(content, &bedrocktypes.ContentBlockMemberText{Value: message.Content})
			}
		} else {
			for _, part := range message.Parts {
				block, err := bedrockMediaContent(role, part)
				if err != nil {
					return nil, nil, err
				}
				if block != nil {
					content = append(content, block)
				}
			}
		}
		for _, call := range message.ToolCalls {
			input := any(map[string]any{})
			if strings.TrimSpace(call.ArgsJSON) != "" {
				if err := json.Unmarshal([]byte(call.ArgsJSON), &input); err != nil {
					return nil, nil, fmt.Errorf("Bedrock 工具参数不是合法 JSON：%w", err)
				}
			}
			content = append(content, &bedrocktypes.ContentBlockMemberToolUse{Value: bedrocktypes.ToolUseBlock{
				ToolUseId: aws.String(call.ID), Name: aws.String(call.Name), Input: bedrockdocument.NewLazyDocument(input),
			}})
		}
		if len(content) == 0 {
			continue
		}
		messages = append(messages, bedrocktypes.Message{Role: role, Content: content})
	}
	return system, messages, nil
}

func bedrockMediaContent(role bedrocktypes.ConversationRole, part MediaPart) (bedrocktypes.ContentBlock, error) {
	if part.Type != "image_url" {
		return &bedrocktypes.ContentBlockMemberText{Value: part.Text}, nil
	}
	if role != bedrocktypes.ConversationRoleUser {
		return &bedrocktypes.ContentBlockMemberText{Value: "[image omitted in assistant history]"}, nil
	}
	format := bedrockImageFormat(part.MIMEType, part.ImageURL)
	if len(part.Data) > 0 {
		return &bedrocktypes.ContentBlockMemberImage{Value: bedrocktypes.ImageBlock{
			Format: format, Source: &bedrocktypes.ImageSourceMemberBytes{Value: part.Data},
		}}, nil
	}
	if strings.HasPrefix(strings.ToLower(part.ImageURL), "s3://") {
		return &bedrocktypes.ContentBlockMemberImage{Value: bedrocktypes.ImageBlock{
			Format: format, Source: &bedrocktypes.ImageSourceMemberS3Location{Value: bedrocktypes.S3Location{Uri: aws.String(part.ImageURL)}},
		}}, nil
	}
	// Converse 不接收 HTTP 图片 URL；保留明确占位，避免悄悄把 URL 当成图片字节。
	return &bedrocktypes.ContentBlockMemberText{Value: "[image: " + part.ImageURL + "]"}, nil
}

func bedrockImageFormat(mimeType, source string) bedrocktypes.ImageFormat {
	value := strings.ToLower(mimeType + " " + source)
	switch {
	case strings.Contains(value, "webp"):
		return bedrocktypes.ImageFormatWebp
	case strings.Contains(value, "gif"):
		return bedrocktypes.ImageFormatGif
	case strings.Contains(value, "jpeg"), strings.Contains(value, "jpg"):
		return bedrocktypes.ImageFormatJpeg
	default:
		return bedrocktypes.ImageFormatPng
	}
}

func bedrockToolConfig(tools []ToolDefinition) (*bedrocktypes.ToolConfiguration, error) {
	if len(tools) == 0 {
		return nil, nil
	}
	definitions := make([]bedrocktypes.Tool, 0, len(tools))
	for _, tool := range tools {
		schema := any(map[string]any{"type": "object", "properties": map[string]any{}})
		if len(tool.Parameters) > 0 {
			if err := json.Unmarshal(tool.Parameters, &schema); err != nil {
				return nil, fmt.Errorf("Bedrock 工具 Schema 不是合法 JSON：%w", err)
			}
		}
		spec := bedrocktypes.ToolSpecification{
			Name: aws.String(tool.Name), InputSchema: &bedrocktypes.ToolInputSchemaMemberJson{Value: bedrockdocument.NewLazyDocument(schema)},
		}
		if tool.Description != "" {
			spec.Description = aws.String(tool.Description)
		}
		definitions = append(definitions, &bedrocktypes.ToolMemberToolSpec{Value: spec})
	}
	return &bedrocktypes.ToolConfiguration{Tools: definitions}, nil
}

func bedrockInferenceConfig(opts GenerationOptions) *bedrocktypes.InferenceConfiguration {
	config := &bedrocktypes.InferenceConfiguration{}
	if opts.MaxTokens != nil && *opts.MaxTokens > 0 {
		value := *opts.MaxTokens
		if value > math.MaxInt32 {
			value = math.MaxInt32
		}
		config.MaxTokens = aws.Int32(int32(value))
	}
	if opts.Temperature != nil {
		config.Temperature = aws.Float32(float32(*opts.Temperature))
	}
	if config.MaxTokens == nil && config.Temperature == nil {
		return nil
	}
	return config
}

func bedrockChat(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, tools []ToolDefinition, stream bool, onDelta func(string) error) (*ChatResult, error) {
	client, err := newBedrockClient(rt)
	if err != nil {
		return nil, err
	}
	system, messages, err := bedrockConversation(msgs)
	if err != nil {
		return nil, err
	}
	toolConfig, err := bedrockToolConfig(tools)
	if err != nil {
		return nil, err
	}
	if !stream {
		output, err := client.Converse(ctx, &bedrockruntime.ConverseInput{
			ModelId: aws.String(modelID), Messages: messages, System: system,
			InferenceConfig: bedrockInferenceConfig(opts), ToolConfig: toolConfig,
		})
		if err != nil {
			return nil, fmt.Errorf("Bedrock Converse 调用失败：%w", err)
		}
		return parseBedrockConverseOutput(output)
	}
	output, err := client.ConverseStream(ctx, &bedrockruntime.ConverseStreamInput{
		ModelId: aws.String(modelID), Messages: messages, System: system,
		InferenceConfig: bedrockInferenceConfig(opts), ToolConfig: toolConfig,
	})
	if err != nil {
		return nil, fmt.Errorf("Bedrock ConverseStream 调用失败：%w", err)
	}
	return consumeBedrockStream(output.GetStream(), onDelta)
}

func parseBedrockConverseOutput(output *bedrockruntime.ConverseOutput) (*ChatResult, error) {
	if output == nil {
		return nil, &httpx.HttpError{Status: http.StatusBadGateway, Message: "Bedrock 返回空结果"}
	}
	result := &ChatResult{}
	if output.Usage != nil {
		result.InputTokens = int64(aws.ToInt32(output.Usage.InputTokens))
		result.OutputTokens = int64(aws.ToInt32(output.Usage.OutputTokens))
	}
	message, ok := output.Output.(*bedrocktypes.ConverseOutputMemberMessage)
	if !ok {
		return nil, &httpx.HttpError{Status: http.StatusBadGateway, Message: "Bedrock 返回未知输出类型"}
	}
	for _, block := range message.Value.Content {
		switch value := block.(type) {
		case *bedrocktypes.ContentBlockMemberText:
			result.Answer += value.Value
		case *bedrocktypes.ContentBlockMemberToolUse:
			input, err := bedrockDocumentValue(value.Value.Input)
			if err != nil {
				return nil, fmt.Errorf("Bedrock 工具参数解析失败：%w", err)
			}
			args, err := json.Marshal(input)
			if err != nil {
				return nil, fmt.Errorf("Bedrock 工具参数解析失败：%w", err)
			}
			result.ToolCalls = append(result.ToolCalls, ToolCall{
				ID: aws.ToString(value.Value.ToolUseId), Name: aws.ToString(value.Value.Name), ArgsJSON: string(args),
			})
		case *bedrocktypes.ContentBlockMemberReasoningContent:
			if reasoning, ok := value.Value.(*bedrocktypes.ReasoningContentBlockMemberReasoningText); ok {
				appendReasoning(result, aws.ToString(reasoning.Value.Text))
			}
		}
	}
	result.HasToolCalls = len(result.ToolCalls) > 0
	if result.Answer == "" && !result.HasToolCalls && result.Reasoning == nil {
		return nil, &httpx.HttpError{Status: http.StatusBadGateway, Message: "Bedrock 返回空结果"}
	}
	return result, nil
}

func bedrockDocumentValue(document bedrockdocument.Interface) (any, error) {
	if document == nil {
		return map[string]any{}, nil
	}
	raw, err := document.MarshalSmithyDocument()
	if err != nil {
		return nil, err
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return value, nil
}

type bedrockStreamToolCall struct {
	index int32
	id    string
	name  string
	args  strings.Builder
}

func consumeBedrockStream(stream *bedrockruntime.ConverseStreamEventStream, onDelta func(string) error) (*ChatResult, error) {
	result := &ChatResult{}
	if stream == nil {
		return nil, &httpx.HttpError{Status: http.StatusBadGateway, Message: "Bedrock 未返回事件流"}
	}
	defer stream.Close()
	toolCalls := map[int32]*bedrockStreamToolCall{}
	for event := range stream.Events() {
		switch value := event.(type) {
		case *bedrocktypes.ConverseStreamOutputMemberContentBlockStart:
			start, ok := value.Value.Start.(*bedrocktypes.ContentBlockStartMemberToolUse)
			if !ok {
				continue
			}
			index := aws.ToInt32(value.Value.ContentBlockIndex)
			toolCalls[index] = &bedrockStreamToolCall{
				index: index, id: aws.ToString(start.Value.ToolUseId), name: aws.ToString(start.Value.Name),
			}
		case *bedrocktypes.ConverseStreamOutputMemberContentBlockDelta:
			switch delta := value.Value.Delta.(type) {
			case *bedrocktypes.ContentBlockDeltaMemberText:
				if delta.Value == "" {
					continue
				}
				result.Answer += delta.Value
				if onDelta != nil {
					if err := onDelta(delta.Value); err != nil {
						return result, err
					}
				}
			case *bedrocktypes.ContentBlockDeltaMemberToolUse:
				index := aws.ToInt32(value.Value.ContentBlockIndex)
				call := toolCalls[index]
				if call == nil {
					call = &bedrockStreamToolCall{index: index}
					toolCalls[index] = call
				}
				call.args.WriteString(aws.ToString(delta.Value.Input))
			case *bedrocktypes.ContentBlockDeltaMemberReasoningContent:
				if reasoning, ok := delta.Value.(*bedrocktypes.ReasoningContentBlockDeltaMemberText); ok {
					appendReasoning(result, reasoning.Value)
				}
			}
		case *bedrocktypes.ConverseStreamOutputMemberMetadata:
			if value.Value.Usage != nil {
				result.InputTokens = int64(aws.ToInt32(value.Value.Usage.InputTokens))
				result.OutputTokens = int64(aws.ToInt32(value.Value.Usage.OutputTokens))
			}
		}
	}
	if err := stream.Err(); err != nil {
		return result, fmt.Errorf("Bedrock 事件流失败：%w", err)
	}
	indexes := make([]int, 0, len(toolCalls))
	for index := range toolCalls {
		indexes = append(indexes, int(index))
	}
	sort.Ints(indexes)
	for _, rawIndex := range indexes {
		call := toolCalls[int32(rawIndex)]
		args := call.args.String()
		if strings.TrimSpace(args) == "" {
			args = "{}"
		}
		result.ToolCalls = append(result.ToolCalls, ToolCall{ID: call.id, Name: call.name, ArgsJSON: args})
	}
	result.HasToolCalls = len(result.ToolCalls) > 0
	return result, nil
}

func bedrockEmbeddings(ctx context.Context, rt RuntimeConfig, modelID string, texts []string) ([][]float32, error) {
	client, err := newBedrockClient(rt)
	if err != nil {
		return nil, err
	}
	if strings.Contains(modelID, "cohere.embed-") {
		return bedrockEmbeddingBatch(ctx, client, modelID, map[string]any{
			"input_type": "search_query", "texts": texts,
		})
	}
	out := make([][]float32, len(texts))
	for index, text := range texts {
		body := map[string]any{"inputText": text}
		if strings.HasPrefix(modelID, "amazon.nova-") && strings.Contains(modelID, "embed") {
			body = map[string]any{
				"taskType": "SINGLE_EMBEDDING",
				"singleEmbeddingParams": map[string]any{
					"embeddingPurpose": "GENERIC_INDEX", "embeddingDimension": 1024,
					"text": map[string]any{"truncationMode": "END", "value": text},
				},
			}
		}
		embeddings, err := bedrockEmbeddingBatch(ctx, client, modelID, body)
		if err != nil {
			return nil, err
		}
		if len(embeddings) != 1 {
			return nil, &httpx.HttpError{Status: http.StatusBadGateway, Message: "Bedrock 向量模型返回数量异常"}
		}
		out[index] = embeddings[0]
	}
	return out, nil
}

func bedrockEmbeddingBatch(ctx context.Context, client *bedrockruntime.Client, modelID string, body any) ([][]float32, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	contentType := "application/json"
	output, err := client.InvokeModel(ctx, &bedrockruntime.InvokeModelInput{
		ModelId: aws.String(modelID), Body: raw, ContentType: &contentType, Accept: &contentType,
	})
	if err != nil {
		return nil, fmt.Errorf("Bedrock InvokeModel 调用失败：%w", err)
	}
	var payload struct {
		Embedding  []float32 `json:"embedding"`
		Embeddings any       `json:"embeddings"`
	}
	if err := json.Unmarshal(output.Body, &payload); err != nil {
		return nil, fmt.Errorf("Bedrock 向量响应解析失败：%w", err)
	}
	if len(payload.Embedding) > 0 {
		return [][]float32{payload.Embedding}, nil
	}
	if payload.Embeddings != nil {
		return parseBedrockEmbeddings(payload.Embeddings)
	}
	return nil, &httpx.HttpError{Status: http.StatusBadGateway, Message: "Bedrock 向量模型返回空结果"}
}

func parseBedrockEmbeddings(raw any) ([][]float32, error) {
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var direct [][]float32
	if json.Unmarshal(data, &direct) == nil && len(direct) > 0 {
		return direct, nil
	}
	var typed []struct {
		Embedding []float32 `json:"embedding"`
	}
	if json.Unmarshal(data, &typed) == nil && len(typed) > 0 {
		out := make([][]float32, len(typed))
		for index, item := range typed {
			out[index] = item.Embedding
		}
		return out, nil
	}
	var cohereV4 struct {
		Float [][]float32 `json:"float"`
	}
	if json.Unmarshal(data, &cohereV4) == nil && len(cohereV4.Float) > 0 {
		return cohereV4.Float, nil
	}
	return nil, &httpx.HttpError{Status: http.StatusBadGateway, Message: "Bedrock 向量响应结构不受支持"}
}
