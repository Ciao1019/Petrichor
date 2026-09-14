package kb

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"
	"time"

	"petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
)

const importMultimodalTimeout = 90 * time.Second

type importOCRResult struct {
	Markdown string
	Method   string
}

type importRecognitionError struct {
	Code      string
	retryable bool
}

func (e *importRecognitionError) Error() string {
	return "多模态识别失败（" + e.Code + "），请检查模型配置或重试"
}
func (e *importRecognitionError) Unwrap() error {
	status := 400
	if e.retryable {
		status = 503
	}
	return &httpx.HttpError{Status: status, Message: e.Error()}
}

// 每次页级尝试只调用一次多模态模型；失败交给队列重试，不切换供应商。
func recognizeImportOCR(ctx context.Context, timeout time.Duration, allowNoText bool, invoke func(context.Context) (string, error)) (importOCRResult, error) {
	result := importOCRResult{Method: "ocr"}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	attemptCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	answer, err := invoke(attemptCtx)
	if err == nil {
		err = attemptCtx.Err()
	}
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	answer = normalizeVisionMarkdown(answer)
	if err == nil && answer == "" {
		err = &importRecognitionError{Code: "empty_result"}
	}
	if err == nil && len(answer) > maxImportPageMarkdownBytes {
		err = &importRecognitionError{Code: "result_too_large"}
	}
	if err != nil {
		code, retryable := safeImportOCRError(err)
		return result, &importRecognitionError{Code: code, retryable: retryable}
	}
	if allowNoText && answer == "[NO_VISIBLE_TEXT]" {
		answer = ""
	}
	return importOCRResult{Markdown: answer, Method: "multimodal"}, nil
}

// 只输出固定分类，不持久化上游 body、URL、密钥或模型错误详情。
func safeImportOCRError(err error) (string, bool) {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout", true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout", true
	}
	var recognitionErr *importRecognitionError
	if errors.As(err, &recognitionErr) {
		switch recognitionErr.Code {
		case "not_configured", "unauthorized", "quota_exceeded", "invalid_image", "result_too_large", "not_configured_or_invalid_request":
			return recognitionErr.Code, false
		case "rate_limited", "timeout", "network", "empty_result", "upstream_error":
			return recognitionErr.Code, true
		}
	}
	var httpErr *httpx.HttpError
	if errors.As(err, &httpErr) {
		status := httpErr.Status
		// 模型适配器会将上游 HTTP 错误包装成 502；只恢复固定状态/额度类型，不保存响应正文。
		if prefix, ok := strings.CutPrefix(httpErr.Message, "模型调用失败("); ok {
			if code, body, found := strings.Cut(prefix, ")："); found {
				if value, err := strconv.Atoi(code); err == nil && value >= 400 && value <= 599 {
					status = value
				}
				var payload struct {
					Error struct {
						Type string `json:"type"`
					} `json:"error"`
				}
				if json.Unmarshal([]byte(body), &payload) == nil && payload.Error.Type == "CreditsError" {
					return "quota_exceeded", false
				}
			}
		}
		switch status {
		case 401, 403:
			return "unauthorized", false
		case 402:
			return "quota_exceeded", false
		case 408, 504:
			return "timeout", true
		case 429:
			return "rate_limited", true
		}
		if status >= 400 && status < 500 {
			return "not_configured_or_invalid_request", false
		}
	}
	return "upstream_error", true
}

func convertImportPage(ctx context.Context, job *JobRow, imageKey string) (importOCRResult, error) {
	result := importOCRResult{Method: "ocr"}
	if job.ImagePolicy == taskqueue.ImagePolicyImagesOnly {
		return result, badReq("仅保留图片的任务无需 OCR")
	}
	textOnly := job.ImagePolicy == taskqueue.ImagePolicyTextOnly
	if err := validateImportObjectKey(job.UserID, imageKey); err != nil {
		return result, err
	}
	data, mime, err := fetchObjectBytes(ctx, imageKey)
	if err != nil {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		var inputErr *httpx.HttpError
		if errors.As(err, &inputErr) {
			return result, inputErr
		}
		return result, errors.New("读取页面图片失败，请检查对象存储或重新上传")
	}
	result, err = recognizeImportOCR(ctx, importMultimodalTimeout, textOnly, func(ctx context.Context) (string, error) {
		if VisionChatInvoker == nil {
			return "", &importRecognitionError{Code: "not_configured"}
		}
		// Invoker 复用 VISION 用途绑定/显式 ID，并按 LANGUAGE kind 校验模型。
		prompt := documentVisionSystemPrompt
		if textOnly {
			prompt = documentTextOnlySystemPrompt
		}
		answer, err := VisionChatInvoker(ctx, job.UserID, job.ModelConfigID,
			prompt, documentVisionUserPrompt, VisionImageInput{Data: data, MIMEType: mime})
		return answer, err
	})
	if textOnly {
		result.Markdown = importTextWithoutImages(result.Markdown)
	}
	return result, err
}

func applyImportOCRResult(page *JobPageRow, result importOCRResult) {
	page.ExtractedBy = result.Method
}
