package cache

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type upstashClient struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

func newUpstash(baseURL, token string) *upstashClient {
	return &upstashClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		httpClient: &http.Client{
			Timeout: 3 * time.Second,
		},
	}
}

func (c *upstashClient) Get(ctx context.Context, key string) (string, bool, error) {
	var result *string
	if err := c.command(ctx, []any{"GET", key}, &result); err != nil {
		return "", false, nil // 失败降级
	}
	if result == nil {
		return "", false, nil
	}
	return *result, true, nil
}

func (c *upstashClient) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	args := []any{"SET", key, value}
	if ttl > 0 {
		args = append(args, "EX", int(ttl.Seconds()))
	}
	var ignored any
	_ = c.command(ctx, args, &ignored)
	return nil
}

func (c *upstashClient) Del(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	args := make([]any, 0, len(keys)+1)
	args = append(args, "DEL")
	for _, k := range keys {
		args = append(args, k)
	}
	var ignored any
	_ = c.command(ctx, args, &ignored)
	return nil
}

func (c *upstashClient) command(ctx context.Context, args []any, out any) error {
	body, err := json.Marshal(args)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("upstash status %d: %s", resp.StatusCode, string(raw))
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return err
	}
	if out == nil || len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		return nil
	}
	return json.Unmarshal(envelope.Result, out)
}
