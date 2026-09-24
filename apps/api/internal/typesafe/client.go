// Package typesafe 封装 Jev 的结构化判断协议；不记录正文、凭据或上游错误体。
package typesafe

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
)

var (
	ErrUnavailable = errors.New("智能推荐暂时不可用，请稍后重试或手动归档")
	ErrRateLimited = errors.New("智能推荐请求较多，请稍后重试或手动归档")
	ErrInvalid     = errors.New("智能推荐返回了无效结果，请重试或手动归档")
	ErrTooLarge    = errors.New("推荐内容超出处理范围，请手动归档")
)

type Question struct {
	Type         string            `json:"type"`
	Instructions any               `json:"instructions"`
	Criteria     map[string]string `json:"criteria,omitempty"`
}

type Answer struct {
	Type          string             `json:"type"`
	Choice        string             `json:"choice,omitempty"`
	Probabilities map[string]float64 `json:"probabilities,omitempty"`
	Confidence    *float64           `json:"confidence,omitempty"`
	Noul          *float64           `json:"noul,omitempty"`
}

type Usage struct {
	InputTokens  int64 `json:"input_tokens"`
	OutputTokens int64 `json:"output_tokens"`
}

type Result struct {
	Model   string            `json:"model"`
	Answers map[string]Answer `json:"answers"`
	Usage   Usage             `json:"usage"`
}

// WithinBudget 用 UTF-8 字节限制保守约束请求，给供应商的 token 化和协议开销留余量。
func WithinBudget(state any, questions map[string]Question) bool {
	s, err := json.Marshal(state)
	if err != nil {
		return false
	}
	all := len(s)
	for _, q := range questions {
		b, e := json.Marshal(q)
		if e != nil || len(s)+len(b) > 24000 {
			return false
		}
		all += len(b)
	}
	return all <= 48000
}

func Evaluate(ctx context.Context, baseURL, key, model string, state any, questions map[string]Question) (*Result, error) {
	if !WithinBudget(state, questions) {
		return nil, ErrTooLarge
	}
	payload, err := json.Marshal(struct {
		State     any                 `json:"state"`
		Model     string              `json:"model"`
		Questions map[string]Question `json:"questions"`
	}{state, model, questions})
	if err != nil {
		return nil, ErrInvalid
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/v1/systemone", bytes.NewReader(payload))
	if err != nil {
		return nil, ErrUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	// 禁止重定向携带凭据；收费请求不自动重试，结果未知时由用户决定是否重试。
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, ErrRateLimited
	}
	if resp.StatusCode != http.StatusOK {
		return nil, ErrUnavailable
	}
	const maxResponse = 512 << 10
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil || len(body) > maxResponse {
		return nil, ErrInvalid
	}
	var result Result
	if json.Unmarshal(body, &result) != nil || validate(result, questions) != nil {
		return nil, ErrInvalid
	}
	return &result, nil
}

func validProbability(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v <= 1 }

func validate(result Result, questions map[string]Question) error {
	if result.Model == "" || len(result.Model) > 120 || result.Usage.InputTokens < 0 || result.Usage.OutputTokens < 0 {
		return ErrInvalid
	}
	for id, q := range questions {
		a, ok := result.Answers[id]
		if !ok || a.Type != q.Type {
			return ErrInvalid
		}
		switch q.Type {
		case "noul":
			if a.Noul == nil || !validProbability(*a.Noul) {
				return ErrInvalid
			}
		case "choice":
			if _, ok := q.Criteria[a.Choice]; !ok || a.Confidence == nil || !validProbability(*a.Confidence) || len(a.Probabilities) != len(q.Criteria) {
				return ErrInvalid
			}
			sum := 0.0
			for key := range q.Criteria {
				p, ok := a.Probabilities[key]
				if !ok || !validProbability(p) || p > a.Probabilities[a.Choice]+0.001 {
					return ErrInvalid
				}
				sum += p
			}
			if math.Abs(sum-1) > 0.02 {
				return ErrInvalid
			}
		default:
			return ErrInvalid
		}
	}
	return nil
}
