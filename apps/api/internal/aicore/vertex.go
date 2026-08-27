package aicore

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	httpx "petrichor/api/internal/httpx"
)

const (
	vertexOAuthScope    = "https://www.googleapis.com/auth/cloud-platform"
	vertexTokenURL      = "https://oauth2.googleapis.com/token"
	vertexDefaultMax    = int64(8192)
	vertexTokenLeeway   = time.Minute
	vertexTokenLifetime = time.Hour
)

type cachedVertexToken struct {
	value     string
	expiresAt time.Time
}

var vertexTokens = struct {
	sync.Mutex
	items map[[32]byte]cachedVertexToken
}{items: map[[32]byte]cachedVertexToken{}}

func vertexBaseURL(rt RuntimeConfig) (string, error) {
	project := strings.TrimSpace(rt.Extra["project"])
	location := strings.TrimSpace(rt.Extra["location"])
	if project == "" || location == "" {
		return "", &httpx.HttpError{Status: http.StatusBadRequest, Message: "Google Vertex 缺少 project 或 location"}
	}
	if custom := strings.TrimRight(strings.TrimSpace(rt.BaseURL), "/"); custom != "" {
		parsed, err := url.Parse(custom)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return "", &httpx.HttpError{Status: http.StatusBadRequest, Message: "Google Vertex BaseUrl 无效"}
		}
		return custom, nil
	}
	host := location + "-aiplatform.googleapis.com"
	switch location {
	case "global":
		host = "aiplatform.googleapis.com"
	case "eu", "us":
		host = "aiplatform." + location + ".rep.googleapis.com"
	}
	return "https://" + host + "/v1beta1/projects/" + url.PathEscape(project) + "/locations/" + url.PathEscape(location) + "/publishers/google", nil
}

func vertexModelEndpoint(rt RuntimeConfig, modelID string, stream bool) (string, error) {
	baseURL, err := vertexBaseURL(rt)
	if err != nil {
		return "", err
	}
	action := ":generateContent"
	if stream {
		action = ":streamGenerateContent?alt=sse"
	}
	return baseURL + "/models/" + url.PathEscape(modelID) + action, nil
}

func vertexAccessToken(ctx context.Context, rt RuntimeConfig) (string, error) {
	clientEmail := strings.TrimSpace(rt.Extra["clientEmail"])
	privateKey := strings.TrimSpace(rt.Extra["privateKey"])
	if clientEmail == "" || privateKey == "" {
		return "", &httpx.HttpError{Status: http.StatusBadRequest, Message: "Google Vertex 缺少 clientEmail 或 privateKey"}
	}
	tokenURL := strings.TrimSpace(rt.Extra["tokenURL"])
	if tokenURL == "" {
		tokenURL = vertexTokenURL
	}
	cacheKey := sha256.Sum256([]byte(clientEmail + "\x00" + privateKey + "\x00" + tokenURL))
	vertexTokens.Lock()
	cached, ok := vertexTokens.items[cacheKey]
	vertexTokens.Unlock()
	if ok && time.Until(cached.expiresAt) > vertexTokenLeeway {
		return cached.value, nil
	}

	assertion, err := signVertexJWT(clientEmail, privateKey, tokenURL, time.Now())
	if err != nil {
		return "", err
	}
	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
	form.Set("assertion", assertion)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return "", readErr
	}
	if resp.StatusCode >= 400 {
		return "", &httpx.HttpError{Status: http.StatusBadGateway, Message: fmt.Sprintf("Google OAuth 失败(%d)：%s", resp.StatusCode, truncate(string(data), 300))}
	}
	var payload struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", fmt.Errorf("Google OAuth 响应解析失败：%w", err)
	}
	if payload.AccessToken == "" {
		message := strings.TrimSpace(payload.Description)
		if message == "" {
			message = strings.TrimSpace(payload.Error)
		}
		if message == "" {
			message = "未返回 access_token"
		}
		return "", &httpx.HttpError{Status: http.StatusBadGateway, Message: "Google OAuth 失败：" + truncate(message, 300)}
	}
	expiresIn := time.Duration(payload.ExpiresIn) * time.Second
	if expiresIn <= 0 {
		expiresIn = vertexTokenLifetime
	}
	vertexTokens.Lock()
	vertexTokens.items[cacheKey] = cachedVertexToken{value: payload.AccessToken, expiresAt: time.Now().Add(expiresIn)}
	vertexTokens.Unlock()
	return payload.AccessToken, nil
}

func signVertexJWT(clientEmail, privateKeyPEM, audience string, now time.Time) (string, error) {
	privateKeyPEM = strings.ReplaceAll(privateKeyPEM, `\n`, "\n")
	block, _ := pem.Decode([]byte(privateKeyPEM))
	if block == nil {
		return "", &httpx.HttpError{Status: http.StatusBadRequest, Message: "Google Vertex Private Key 不是有效 PEM"}
	}
	var key *rsa.PrivateKey
	if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		var ok bool
		key, ok = parsed.(*rsa.PrivateKey)
		if !ok {
			return "", &httpx.HttpError{Status: http.StatusBadRequest, Message: "Google Vertex Private Key 不是 RSA 密钥"}
		}
	} else if parsed, pkcs1Err := x509.ParsePKCS1PrivateKey(block.Bytes); pkcs1Err == nil {
		key = parsed
	} else {
		return "", &httpx.HttpError{Status: http.StatusBadRequest, Message: "Google Vertex Private Key 无法解析"}
	}
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"iss": clientEmail, "scope": vertexOAuthScope, "aud": audience,
		"iat": now.Unix(), "exp": now.Add(vertexTokenLifetime).Unix(),
	})
	encode := base64.RawURLEncoding.EncodeToString
	signingInput := encode(header) + "." + encode(claims)
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", fmt.Errorf("Google Vertex JWT 签名失败：%w", err)
	}
	return signingInput + "." + encode(signature), nil
}

func vertexHeaders(ctx context.Context, rt RuntimeConfig) (map[string]string, error) {
	token, err := vertexAccessToken(ctx, rt)
	if err != nil {
		return nil, err
	}
	headers := map[string]string{"Authorization": "Bearer " + token}
	for key, value := range rt.Headers {
		headers[key] = value
	}
	return headers, nil
}

func vertexChat(ctx context.Context, rt RuntimeConfig, modelID string, msgs []ChatMessage, opts GenerationOptions, tools []ToolDefinition, stream bool, onDelta func(string) error) (*ChatResult, error) {
	endpoint, err := vertexModelEndpoint(rt, modelID, stream)
	if err != nil {
		return nil, err
	}
	headers, err := vertexHeaders(ctx, rt)
	if err != nil {
		return nil, err
	}
	generation := map[string]any{"maxOutputTokens": pickMax(opts.MaxTokens, vertexDefaultMax)}
	if opts.Temperature != nil {
		generation["temperature"] = *opts.Temperature
	}
	var body map[string]any
	if len(tools) > 0 {
		system, contents := toGoogleToolContents(msgs)
		body = map[string]any{
			"contents": contents, "tools": googleToolDeclarations(tools), "generationConfig": generation,
		}
		if system != "" {
			body["systemInstruction"] = map[string]any{"parts": []map[string]string{{"text": system}}}
		}
	} else {
		system, contents := toGoogleContents(msgs)
		body = map[string]any{"contents": contents, "generationConfig": generation}
		if system != "" {
			body["systemInstruction"] = map[string]any{"parts": []gPart{{Text: system}}}
		}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if len(tools) > 0 {
		return executeGoogleToolProtocol(ctx, endpoint, headers, raw, stream, onDelta)
	}
	return executeProtocol(ctx, protocolRequest{URL: endpoint, Body: raw, Headers: headers}, stream, onDelta, parseGoogleResponse, googleSSEDelta)
}

func toGoogleContents(msgs []ChatMessage) (string, []gContent) {
	systemParts := make([]string, 0, 2)
	contents := make([]gContent, 0, len(msgs))
	for _, message := range msgs {
		if message.Role == "system" {
			if strings.TrimSpace(message.Content) != "" {
				systemParts = append(systemParts, message.Content)
			}
			continue
		}
		role := "user"
		if message.Role == "assistant" {
			role = "model"
		}
		if len(message.Parts) == 0 {
			contents = append(contents, gContent{Role: role, Parts: []gPart{{Text: message.Content}}})
			continue
		}
		parts := make([]gPart, 0, len(message.Parts))
		for _, part := range message.Parts {
			if part.Type == "image_url" && len(part.Data) > 0 && part.ImageURL == "" {
				mime := part.MIMEType
				if mime == "" {
					mime = "image/png"
				}
				parts = append(parts, gPart{InlineData: &gInlineMedia{MIMEType: mime, Data: b64(part.Data)}})
			} else if part.Type == "image_url" {
				parts = append(parts, gPart{Text: "[image: " + part.ImageURL + "]"})
			} else {
				parts = append(parts, gPart{Text: part.Text})
			}
		}
		contents = append(contents, gContent{Role: role, Parts: parts})
	}
	return strings.Join(systemParts, "\n\n"), contents
}

func executeGoogleToolProtocol(ctx context.Context, endpoint string, headers map[string]string, raw []byte, stream bool, onDelta func(string) error) (*ChatResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(resp.Body)
		return nil, &httpx.HttpError{Status: http.StatusBadGateway, Message: fmt.Sprintf("模型调用失败(%d)：%s", resp.StatusCode, truncate(string(data), 300))}
	}
	if stream {
		return readGoogleToolStream(resp.Body, onDelta)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return parseGoogleToolResponse(data, 0)
}

func vertexEmbeddings(ctx context.Context, rt RuntimeConfig, modelID string, texts []string) ([][]float32, error) {
	baseURL, err := vertexBaseURL(rt)
	if err != nil {
		return nil, err
	}
	headers, err := vertexHeaders(ctx, rt)
	if err != nil {
		return nil, err
	}
	if modelID == "gemini-embedding-2" || modelID == "gemini-embedding-2-preview" {
		out := make([][]float32, len(texts))
		for index, text := range texts {
			var response struct {
				Embedding struct {
					Values []float32 `json:"values"`
				} `json:"embedding"`
			}
			body := map[string]any{"content": map[string]any{"parts": []map[string]string{{"text": text}}}}
			if err := vertexPostJSON(ctx, baseURL+"/models/"+url.PathEscape(modelID)+":embedContent", headers, body, &response); err != nil {
				return nil, err
			}
			out[index] = response.Embedding.Values
		}
		return out, nil
	}
	body := map[string]any{
		"instances": func() []map[string]string {
			instances := make([]map[string]string, 0, len(texts))
			for _, text := range texts {
				instances = append(instances, map[string]string{"content": text})
			}
			return instances
		}(),
		"parameters": map[string]any{},
	}
	var response struct {
		Predictions []struct {
			Embeddings struct {
				Values []float32 `json:"values"`
			} `json:"embeddings"`
		} `json:"predictions"`
	}
	if err := vertexPostJSON(ctx, baseURL+"/models/"+url.PathEscape(modelID)+":predict", headers, body, &response); err != nil {
		return nil, err
	}
	out := make([][]float32, len(response.Predictions))
	for index, prediction := range response.Predictions {
		out[index] = prediction.Embeddings.Values
	}
	return out, nil
}

func vertexPostJSON(ctx context.Context, endpoint string, headers map[string]string, body any, output any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return readErr
	}
	if resp.StatusCode >= 400 {
		return &httpx.HttpError{Status: http.StatusBadGateway, Message: fmt.Sprintf("Vertex 调用失败(%d)：%s", resp.StatusCode, truncate(string(data), 300))}
	}
	if err := json.Unmarshal(data, output); err != nil {
		return fmt.Errorf("Vertex 响应解析失败：%w", err)
	}
	return nil
}
