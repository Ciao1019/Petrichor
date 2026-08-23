// import_vision.go 对照 import-handlers.ts 的多模态 OCR 部分（callVisionCompletion +
// fetchS3ObjectBytes + scheduleImportJobProcessing 后台循环）：
//
//   - RunVisionPageConversion：单页整图 → VISION 模型 → Markdown，接 VisionPageConverter；
//   - StartImportJobProcessing：后台任务池（并发 ≤ 2）逐页处理 PENDING 页，
//     全部成功后自动合并生成文章，语义对照 TS processImportJobInBackground。
//
// 模型调用经由本文件声明的 VisionChatInvoker 注入点：kb 包不能直接 import aicore
// （aicore.WireInvokers 反向依赖 kb 会构成环），由 internal/bootstrap 在启动时接线。
package kb

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"petrichor/api/internal/config"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/storage"
)

// VisionImageInput 待识别的页面图片。
type VisionImageInput struct {
	Data     []byte
	MIMEType string
}

// VisionChatInvoker 多模态补全注入点：按 VISION 用途解析模型（modelRefID 非空时优先钉定），
// 以 system + [图片, userPrompt] 单轮补全返回文本。nil 时页面转写报「AI 服务未就绪」。
var VisionChatInvoker func(ctx context.Context, userID int64, modelRefID *int64,
	systemPrompt, userPrompt string, image VisionImageInput) (string, error)

// 文档页转写提示词，逐条对照 vision-prompt.ts 的 DOCUMENT_VISION_SYSTEM_PROMPT。
const documentVisionSystemPrompt = `你是一个把文档页面图片转写为 Markdown 的引擎。
你会收到文档「某一页」的整页图片，请把该页全部可见内容忠实转写为 GitHub Flavored Markdown。

要求：
1. 严格保留原文语言、文字内容与阅读顺序，不要翻译、不要总结、不要补充原文没有的内容。
2. 还原结构：标题用 #/##/###，列表用 -/1.，引用用 >，代码用围栏代码块，表格用 Markdown 表格。
3. 数学公式用 LaTeX：行内用 $...$，独立公式用 $$...$$。
4. 页面里的照片、插图、图表、示意图等无法用文字表达的图像，用一行斜体说明代替，格式为 ` + "`*（图：简要描述）*`" + `。
   不要输出任何 Markdown 图片语法（不要写 ` + "`![...](...)`" + `），因为没有可引用的图片地址。
   图表中如果有可读的数据表，优先按 Markdown 表格转写出来，再补一行图说明。
5. 页眉、页脚、页码等与正文无关的边角信息可以忽略。
6. 不要输出任何解释性文字、不要用 ` + "```markdown" + ` 包裹整体，直接输出 Markdown 正文本身。
7. 如果该页为空白页，输出空字符串。`

const documentVisionUserPrompt = "请把这一页转写为 Markdown。"

// visionImportConcurrency 后台任务池固定并发度（任务要求 ≤ 2，避免压垮多模态配额）。
const visionImportConcurrency = 2

// s3DownloadClient 页面图片下载客户端；预签名 URL 本身带时效，超时只防悬挂。
var s3DownloadClient = &http.Client{Timeout: 120 * time.Second}

var mdFenceWrapRe = regexp.MustCompile("(?is)^```(?:markdown|md)?\\s*\\n([\\s\\S]*?)\\n```$")

// RunVisionPageConversion 单页转写：加载任务与页 → 拉取整图字节 → VISION 补全 → 规范化 Markdown。
// 对应 TS convertSinglePage 内联的 fetchS3ObjectBytes + callVisionCompletion。
func RunVisionPageConversion(ctx context.Context, userID, jobID, pageNo int64) (string, error) {
	if VisionChatInvoker == nil {
		return "", &httpx.HttpError{Status: 503, Message: "AI 服务未就绪"}
	}
	q := pool()
	job, err := loadJobOwned(q, userID, jobID)
	if err != nil {
		return "", err
	}
	page, err := loadJobPage(q, job.ID, pageNo)
	if err != nil {
		return "", err
	}
	if page.ExtractedBy != "vision" {
		return "", badReq("该页由 PDF 本地抽取，无需模型识别")
	}
	imageKey := derefStr(page.ImageKey)
	if imageKey == "" {
		return "", badReq("该页尚未上传整页图片")
	}

	data, mime, err := fetchObjectBytes(ctx, imageKey)
	if err != nil {
		return "", fmt.Errorf("读取页面图片失败：%w", err)
	}
	answer, cerr := VisionChatInvoker(ctx, userID, job.ModelConfigID,
		documentVisionSystemPrompt, documentVisionUserPrompt,
		VisionImageInput{Data: data, MIMEType: mime})
	if cerr != nil {
		return "", cerr
	}
	return normalizeVisionMarkdown(answer), nil
}

// fetchObjectBytes 读取对象字节：本地存储直接读文件；S3 走 GET 预签名下载。
func fetchObjectBytes(ctx context.Context, objectKey string) ([]byte, string, error) {
	key := storage.StripS4KeyPrefix(objectKey)
	var data []byte
	var err error
	if storage.LocalEnabled() {
		data, err = storage.ReadLocalObject(key)
	} else {
		data, err = downloadPresignedObject(ctx, key)
	}
	if err != nil {
		return nil, "", err
	}
	return data, detectImageMIME(data, key), nil
}

func downloadPresignedObject(ctx context.Context, key string) ([]byte, error) {
	s3cfg := config.Get().S3
	if s3cfg == nil {
		return nil, fmt.Errorf("对象存储未配置")
	}
	url, err := storage.CreateS3PresignedUrl(s3cfg, "GET", key, s3cfg.DownloadExpireSecond, time.Now())
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s3DownloadClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("对象下载失败(HTTP %d)", resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("对象内容为空")
	}
	return data, nil
}

// detectImageMIME 优先按魔数嗅探，退化按扩展名，默认 PNG。
func detectImageMIME(data []byte, objectKey string) string {
	sniffed := http.DetectContentType(data)
	switch sniffed {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return sniffed
	}
	switch strings.ToLower(filepath.Ext(objectKey)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	}
	return "image/png"
}

// normalizeVisionMarkdown 去掉模型偶尔包裹整体的 ```markdown 围栏（对照 vision.ts normalizeMarkdown）。
func normalizeVisionMarkdown(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}
	if m := mdFenceWrapRe.FindStringSubmatch(text); m != nil {
		return strings.TrimSpace(m[1])
	}
	return text
}

// ===== 后台任务循环 =====

// StartImportJobProcessing 接线 kb.StartImportJob：detached goroutine 处理，
// 请求上下文取消不影响导入进度。
func StartImportJobProcessing(_ context.Context, jobID int64) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				failImportJob(jobID, fmt.Sprintf("导入任务后台处理异常：%v", r))
			}
		}()
		processImportJobBackground(context.Background(), jobID)
	}()
}

type importWorkItem struct {
	pageNo   int64
	imageKey string
}

// processImportJobBackground 对照 TS processImportJobInBackground：
// 只处理已拿到整图的 PENDING 页 → 任务池并发转写 → 收敛任务状态 / 自动成文。
func processImportJobBackground(ctx context.Context, jobID int64) {
	q := pool()
	job, err := loadJobByID(q, jobID)
	if err != nil || job.Status == "canceled" || job.ArticleID != nil {
		return
	}
	if _, err := q.Exec(ctx,
		`UPDATE petrichor_kb_import_job SET status = 'processing', error = NULL, updated_at = now()
		 WHERE id = $1`, job.ID); err != nil {
		failImportJob(jobID, err.Error())
		return
	}

	pages, err := loadPendingVisionPages(q, job.ID)
	if err != nil {
		failImportJob(jobID, err.Error())
		return
	}
	runImportWorkerPool(ctx, job, pages)

	job, err = loadJobByID(q, jobID)
	if err != nil || job.Status == "canceled" || job.ArticleID != nil {
		return
	}
	latestPages, err := loadJobPages(q, job.ID)
	if err != nil {
		failImportJob(jobID, err.Error())
		return
	}
	stats := buildPageStats(latestPages)
	switch {
	case stats.failedPages > 0:
		message := fmt.Sprintf("有 %d 页转 Markdown 失败，请在导入任务详情中重试。", stats.failedPages)
		_, _ = q.Exec(ctx,
			`UPDATE petrichor_kb_import_job SET status = 'failed', error = $1, updated_at = now() WHERE id = $2`,
			message, job.ID)
	case stats.pendingPages > 0:
		// 还有页没上传整图，保持 processing 等 attach 之后再次调度。
		_, _ = q.Exec(ctx,
			`UPDATE petrichor_kb_import_job SET status = 'processing', error = NULL, updated_at = now() WHERE id = $1`,
			job.ID)
	default:
		finalizeImportJobBackground(ctx, q, job)
	}
}

// runImportWorkerPool 固定并发度的任务池：cursor 经 channel 分发，worker 逐页转写。
func runImportWorkerPool(ctx context.Context, job *JobRow, pages []importWorkItem) {
	if len(pages) == 0 {
		return
	}
	queue := make(chan importWorkItem)
	var wg sync.WaitGroup
	for i := 0; i < visionImportConcurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range queue {
				latest, err := loadJobByID(pool(), job.ID)
				if err != nil || latest.Status == "canceled" || latest.ArticleID != nil {
					continue
				}
				transcribePageBackground(ctx, latest, item.pageNo, item.imageKey)
			}
		}()
	}
	for _, item := range pages {
		queue <- item
	}
	close(queue)
	wg.Wait()
}

// transcribePageBackground 后台版 convertSinglePage：DONE/FAILED 落库并刷新任务进度。
func transcribePageBackground(ctx context.Context, job *JobRow, pageNo int64, imageKey string) {
	q := pool()
	markdown, convErr := convertVisionPage(ctx, job, pageNo, imageKey)
	if convErr != nil {
		message := truncateRunes(convErr.Error(), 500)
		_, _ = q.Exec(ctx,
			`UPDATE petrichor_kb_import_job_page SET status = 'failed', error = $1, updated_at = now()
			 WHERE job_id = $2 AND page_no = $3`, message, job.ID, pageNo)
	} else {
		_, _ = q.Exec(ctx,
			`UPDATE petrichor_kb_import_job_page SET status = 'done', markdown = $1, error = NULL, updated_at = now()
			 WHERE job_id = $2 AND page_no = $3`, markdown, job.ID, pageNo)
	}
	_, _, _ = refreshJobProgress(q, job.ID)
}

// convertVisionPage 取图 + 调 VISION 模型（复用 RunVisionPageConversion 的取数与规范化逻辑，
// 但跳过归属/状态校验——调用方已保证页可用且持最新任务行）。
func convertVisionPage(ctx context.Context, job *JobRow, pageNo int64, imageKey string) (string, error) {
	if VisionChatInvoker == nil {
		return "", &httpx.HttpError{Status: 503, Message: "AI 服务未就绪"}
	}
	data, mime, err := fetchObjectBytes(ctx, imageKey)
	if err != nil {
		return "", fmt.Errorf("读取页面图片失败：%w", err)
	}
	answer, cerr := VisionChatInvoker(ctx, job.UserID, job.ModelConfigID,
		documentVisionSystemPrompt, documentVisionUserPrompt,
		VisionImageInput{Data: data, MIMEType: mime})
	if cerr != nil {
		return "", cerr
	}
	return normalizeVisionMarkdown(answer), nil
}

// finalizeImportJobBackground 全部页 DONE 后自动合并生成文章（对照 finalizeJobToArticle 的 DB 部分；
// 与同步端点版本的差异仅在显式 ctx，SQL 保持一致）。
func finalizeImportJobBackground(ctx context.Context, q execQuerier, job *JobRow) {
	if job.ArticleID != nil {
		_, _ = q.Exec(ctx,
			`UPDATE petrichor_kb_import_job SET status = 'completed', error = NULL, updated_at = now() WHERE id = $1`,
			job.ID)
		return
	}
	pages, err := loadJobPages(q, job.ID)
	if err != nil {
		failImportJob(job.ID, err.Error())
		return
	}
	if len(pages) == 0 {
		failImportJob(job.ID, "任务没有可合并的页面")
		return
	}
	notDone := countNotDonePages(pages)
	if notDone > 0 {
		failImportJob(job.ID, fmt.Sprintf("仍有 %d 页未成功转换，请先重试失败页", notDone))
		return
	}
	if _, err := assertKnowledgeBaseOwner(q, job.UserID, job.KnowledgeBaseID); err != nil {
		failImportJob(job.ID, err.Error())
		return
	}
	if _, err := assertFolderParent(q, job.UserID, job.KnowledgeBaseID, job.ParentNodeID); err != nil {
		failImportJob(job.ID, err.Error())
		return
	}

	contentMd := mergePageMarkdown(pages)
	sortOrder, err := nextSortOrder(q, job.UserID, job.KnowledgeBaseID, job.ParentNodeID)
	if err != nil {
		failImportJob(job.ID, err.Error())
		return
	}
	var nodeID int64
	if err := q.QueryRow(ctx,
		`INSERT INTO petrichor_kb_node (user_id, knowledge_base_id, parent_id, type, name, sort_order)
		 VALUES ($1,$2,$3,'ARTICLE',$4,$5) RETURNING id`,
		job.UserID, job.KnowledgeBaseID, job.ParentNodeID, job.Title, sortOrder).Scan(&nodeID); err != nil {
		failImportJob(job.ID, err.Error())
		return
	}
	publicExcerpt, readingMinutes, tocJSON, contentHash := buildPublicArticleMetadata(contentMd)
	var articleID int64
	if err := q.QueryRow(ctx,
		`INSERT INTO petrichor_kb_article (user_id, knowledge_base_id, node_id, title, content_md,
		 public_excerpt, reading_minutes, toc_json, public_content_hash)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		job.UserID, job.KnowledgeBaseID, nodeID, job.Title, contentMd,
		publicExcerpt, readingMinutes, tocJSON, contentHash).Scan(&articleID); err != nil {
		failImportJob(job.ID, err.Error())
		return
	}
	if _, err := q.Exec(ctx,
		`UPDATE petrichor_kb_import_job SET article_id = $1, status = 'completed', error = NULL, updated_at = now()
		 WHERE id = $2`, articleID, job.ID); err != nil {
		failImportJob(job.ID, err.Error())
	}
}

// ===== 小工具 =====

func loadJobByID(q execQuerier, jobID int64) (*JobRow, error) {
	rows, err := q.Query(context.Background(),
		`SELECT `+jobColumns+` FROM petrichor_kb_import_job WHERE id = $1 LIMIT 1`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var r JobRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.ParentNodeID, &r.SourceType,
		&r.FileName, &r.SourceKey, &r.Title, &r.TotalPages, &r.ProcessedPages, &r.Status,
		&r.ModelConfigID, &r.ArticleID, &r.Error, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

// loadPendingVisionPages 已拿到整图的待识别页（对照 TS pending + imageKey is not null）。
func loadPendingVisionPages(q execQuerier, jobID int64) ([]importWorkItem, error) {
	rows, err := q.Query(context.Background(),
		`SELECT page_no, image_key FROM petrichor_kb_import_job_page
		 WHERE job_id = $1 AND status = 'pending' AND extracted_by = 'vision'
		   AND image_key IS NOT NULL AND btrim(image_key) <> ''
		 ORDER BY page_no ASC`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []importWorkItem{}
	for rows.Next() {
		var item importWorkItem
		if err := rows.Scan(&item.pageNo, &item.imageKey); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func countNotDonePages(pages []JobPageRow) int {
	count := 0
	for i := range pages {
		if pages[i].Status != "done" {
			count++
		}
	}
	return count
}

// failImportJob 兜底收敛：整个后台流程异常时把任务置 failed（信息截断 500 字）。
func failImportJob(jobID int64, message string) {
	_, _ = pool().Exec(context.Background(),
		`UPDATE petrichor_kb_import_job SET status = 'failed', error = $1, updated_at = now() WHERE id = $2`,
		truncateRunes(message, 500), jobID)
}
