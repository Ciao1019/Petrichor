package kb

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentchunk"
	"github.com/Ciao1019/Petrichor/apps/api/internal/chunker"
	"github.com/Ciao1019/Petrichor/apps/api/internal/docextract"
)

// kbTextSegmentInput 描述抽取文本里的一段区间归属，用来给分片补上页码/工作表名。
// 分块本身在服务端完成，客户端（以及后续的 Go 解析层）只需要给出边界，
// 而不是整套算好的分片。
type kbTextSegmentInput struct {
	StartOffset int     `json:"startOffset"`
	Page        *int    `json:"page"`
	Locator     *string `json:"locator"`
}

// kbChunkRow 是准备写库的一条分片。
type kbChunkRow struct {
	ChunkIndex       int
	ChunkType        string
	ParentChunkIndex *int
	Text             string
	ContextHeader    string
	StartOffset      int
	EndOffset        int
	Page             *int
	Locator          *string
}

// kbChunkingSettings 是知识库上与分块相关的配置。
type kbChunkingSettings struct {
	Strategy          string
	ChunkSize         int
	ChunkOverlap      int
	Separators        []string
	EnableParentChild bool
	ParentChunkSize   int
	ChildChunkSize    int
}

func chunkingSettingsFromKB(kb *ent.KnowledgeBase) kbChunkingSettings {
	settings := kbChunkingSettings{
		Strategy:          kb.ChunkStrategy,
		ChunkSize:         kb.ChunkSize,
		ChunkOverlap:      kb.ChunkOverlap,
		EnableParentChild: kb.EnableParentChild,
		ParentChunkSize:   kb.ParentChunkSize,
		ChildChunkSize:    kb.ChildChunkSize,
	}
	if kb.ChunkSeparatorsJSON != nil && strings.TrimSpace(*kb.ChunkSeparatorsJSON) != "" {
		var separators []string
		if err := json.Unmarshal([]byte(*kb.ChunkSeparatorsJSON), &separators); err == nil {
			settings.Separators = separators
		}
	}
	return settings
}

func (s kbChunkingSettings) splitterConfig() chunker.SplitterConfig {
	return chunker.NormalizeSplitterConfig(chunker.SplitterConfig{
		ChunkSize:    s.ChunkSize,
		ChunkOverlap: s.ChunkOverlap,
		Separators:   s.Separators,
		Strategy:     s.Strategy,
	})
}

// chunkDocumentText 在服务端把抽取出的正文切成待写库的分片。
//
// 单级模式下只产出 text 分片；开启父子分块时，子块（text）用于向量匹配，
// 父块（parent_text）只在命中后回填上下文、不做向量化。
//
// chunk_index 的排布：子块占 0..N-1（沿用既有语义，Wiki 证据引用和原文定位都按这个编号），
// 父块紧随其后占 N..N+P-1，子块通过 parent_chunk_index 指回去。
func chunkDocumentText(text string, settings kbChunkingSettings, segments []kbTextSegmentInput) []kbChunkRow {
	normalized := chunker.NormalizeLineEndings(text)
	if strings.TrimSpace(normalized) == "" {
		return nil
	}
	base := settings.splitterConfig()
	locate := newSegmentLocator(segments)

	if !settings.EnableParentChild {
		chunks := chunker.Split(normalized, base)
		rows := make([]kbChunkRow, 0, len(chunks))
		for _, chunk := range chunks {
			if strings.TrimSpace(chunk.Content) == "" {
				continue
			}
			row := kbChunkRow{
				ChunkIndex: len(rows), ChunkType: "text", Text: chunk.Content,
				ContextHeader: chunk.ContextHeader, StartOffset: chunk.Start, EndOffset: chunk.End,
			}
			locate(&row)
			rows = append(rows, row)
		}
		return rows
	}

	parentCfg, childCfg := chunker.DeriveParentChildConfigs(base, settings.ParentChunkSize, settings.ChildChunkSize)
	result := chunker.SplitParentChild(normalized, parentCfg, childCfg)

	children := make([]kbChunkRow, 0, len(result.Children))
	// 父块在本批里的下标 → 实际写库的 chunk_index，只有真正被引用到的父块才落库。
	parentUsed := map[int]struct{}{}
	for _, child := range result.Children {
		if strings.TrimSpace(child.Content) == "" {
			continue
		}
		row := kbChunkRow{
			ChunkIndex: len(children), ChunkType: "text", Text: child.Content,
			ContextHeader: child.ContextHeader, StartOffset: child.Start, EndOffset: child.End,
		}
		if child.ParentIndex >= 0 && child.ParentIndex < len(result.Parents) {
			parentUsed[child.ParentIndex] = struct{}{}
		}
		locate(&row)
		children = append(children, row)
	}

	// 父块编号接在子块之后，保证 (document_id, chunk_index) 唯一。
	parentIndexMap := make(map[int]int, len(parentUsed))
	ordered := make([]int, 0, len(parentUsed))
	for index := range parentUsed {
		ordered = append(ordered, index)
	}
	sort.Ints(ordered)
	parents := make([]kbChunkRow, 0, len(ordered))
	for _, original := range ordered {
		parent := result.Parents[original]
		chunkIndex := len(children) + len(parents)
		parentIndexMap[original] = chunkIndex
		row := kbChunkRow{
			ChunkIndex: chunkIndex, ChunkType: "parent_text", Text: parent.Content,
			ContextHeader: parent.ContextHeader, StartOffset: parent.Start, EndOffset: parent.End,
		}
		locate(&row)
		parents = append(parents, row)
	}

	// 回填子块指向父块的编号。
	cursor := 0
	for _, child := range result.Children {
		if strings.TrimSpace(child.Content) == "" {
			continue
		}
		if mapped, ok := parentIndexMap[child.ParentIndex]; ok {
			value := mapped
			children[cursor].ParentChunkIndex = &value
		}
		cursor++
	}
	return append(children, parents...)
}

// newSegmentLocator 按分片起点落在哪一段，给它补上页码与定位标签。
func newSegmentLocator(segments []kbTextSegmentInput) func(*kbChunkRow) {
	if len(segments) == 0 {
		return func(*kbChunkRow) {}
	}
	sorted := append([]kbTextSegmentInput(nil), segments...)
	sort.SliceStable(sorted, func(left, right int) bool { return sorted[left].StartOffset < sorted[right].StartOffset })
	return func(row *kbChunkRow) {
		index := sort.Search(len(sorted), func(i int) bool { return sorted[i].StartOffset > row.StartOffset }) - 1
		if index < 0 {
			index = 0
		}
		segment := sorted[index]
		if segment.Page != nil {
			page := *segment.Page
			row.Page = &page
		}
		if segment.Locator != nil && strings.TrimSpace(*segment.Locator) != "" {
			locator := strings.TrimSpace(*segment.Locator)
			row.Locator = &locator
		}
	}
}

// insertKBDocumentChunks 把分块结果写入分片表。
func insertKBDocumentChunks(ctx context.Context, tx *ent.Tx, userID, kbID, documentID int64, rows []kbChunkRow) error {
	for _, row := range rows {
		builder := tx.KBDocumentChunk.Create().SetUserID(userID).SetKnowledgeBaseID(kbID).
			SetDocumentID(documentID).SetChunkIndex(row.ChunkIndex).SetChunkType(row.ChunkType).
			SetText(row.Text).SetCharCount(len([]rune(row.Text))).SetTokenEstimate(estimateChunkTokens(row.Text)).
			SetStartOffset(row.StartOffset).SetEndOffset(row.EndOffset)
		if row.ParentChunkIndex != nil {
			builder.SetParentChunkIndex(*row.ParentChunkIndex)
		}
		if row.Page != nil {
			builder.SetPage(*row.Page)
		}
		if row.Locator != nil {
			builder.SetLocator(*row.Locator)
		}
		if strings.TrimSpace(row.ContextHeader) != "" {
			builder.SetContextHeader(row.ContextHeader)
		}
		if err := builder.Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}

// countRetrievableChunks 统计可召回的分片数量（不含只用于回填上下文的父块）。
func countRetrievableChunks(rows []kbChunkRow) int {
	total := 0
	for _, row := range rows {
		if row.ChunkType != "parent_text" {
			total++
		}
	}
	return total
}

// parentChunkKey 定位一个父块：同一文档内的 chunk_index。
type parentChunkKey struct {
	documentID int64
	chunkIndex int
}

// loadParentChunkTexts 批量取出候选子块各自的父块正文，避免逐条查询。
func (s *Service) loadParentChunkTexts(ctx context.Context, candidates []*documentCandidate) (map[parentChunkKey]string, error) {
	wanted := make(map[parentChunkKey]struct{})
	documentIDs := make(map[int64]struct{})
	indexes := make(map[int]struct{})
	for _, candidate := range candidates {
		if candidate.chunk.ParentChunkIndex == nil {
			continue
		}
		wanted[parentChunkKey{candidate.chunk.DocumentID, *candidate.chunk.ParentChunkIndex}] = struct{}{}
		documentIDs[candidate.chunk.DocumentID] = struct{}{}
		indexes[*candidate.chunk.ParentChunkIndex] = struct{}{}
	}
	if len(wanted) == 0 {
		return nil, nil
	}
	documentList := make([]int64, 0, len(documentIDs))
	for id := range documentIDs {
		documentList = append(documentList, id)
	}
	indexList := make([]int, 0, len(indexes))
	for index := range indexes {
		indexList = append(indexList, index)
	}
	// 先按 (文档, 下标) 的笛卡尔范围粗查，再用 wanted 精确过滤。
	rows, err := s.client.KBDocumentChunk.Query().Where(
		kbdocumentchunk.DocumentIDIn(documentList...),
		kbdocumentchunk.ChunkIndexIn(indexList...),
		kbdocumentchunk.ChunkTypeEQ("parent_text"),
	).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[parentChunkKey]string, len(wanted))
	for _, row := range rows {
		key := parentChunkKey{row.DocumentID, row.ChunkIndex}
		if _, ok := wanted[key]; ok {
			out[key] = row.Text
		}
	}
	return out, nil
}

// ChunkPreview 用当前（或临时覆盖的）分块配置试切一段文本，不写库。
// 分块规则在服务端，预览也必须走服务端，否则"测试分块效果"看到的
// 和真正入库的会是两套结果。
func (h *Handler) ChunkPreview(c *gin.Context) {
	var req struct {
		KnowledgeBaseID   string   `json:"knowledgeBaseId" binding:"required"`
		Text              string   `json:"text" binding:"required"`
		Strategy          *string  `json:"strategy"`
		ChunkSize         *int     `json:"chunkSize"`
		ChunkOverlap      *int     `json:"chunkOverlap"`
		Separators        []string `json:"separators"`
		EnableParentChild *bool    `json:"enableParentChild"`
		ParentChunkSize   *int     `json:"parentChunkSize"`
		ChildChunkSize    *int     `json:"childChunkSize"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parsePositiveID(req.KnowledgeBaseID, "knowledgeBaseId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	kbRow, err := h.svc.GetOwned(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if len([]rune(req.Text)) > 200000 {
		response.Fail(c, response.BadRequest("预览文本过长"))
		return
	}

	settings := chunkingSettingsFromKB(kbRow)
	// 面板上还没保存的改动通过覆盖项传进来，让预览反映当前正在调的参数。
	if req.Strategy != nil {
		settings.Strategy = *req.Strategy
	}
	if req.ChunkSize != nil {
		settings.ChunkSize = *req.ChunkSize
	}
	if req.ChunkOverlap != nil {
		settings.ChunkOverlap = *req.ChunkOverlap
	}
	if req.Separators != nil {
		settings.Separators = req.Separators
	}
	if req.EnableParentChild != nil {
		settings.EnableParentChild = *req.EnableParentChild
	}
	if req.ParentChunkSize != nil {
		settings.ParentChunkSize = *req.ParentChunkSize
	}
	if req.ChildChunkSize != nil {
		settings.ChildChunkSize = *req.ChildChunkSize
	}

	rows := chunkDocumentText(req.Text, settings, nil)
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		item := gin.H{
			"chunkIndex": row.ChunkIndex, "chunkType": row.ChunkType, "text": row.Text,
			"charCount": len([]rune(row.Text)), "tokenEstimate": estimateChunkTokens(row.Text),
			"startOffset": row.StartOffset, "endOffset": row.EndOffset,
			"contextHeader": row.ContextHeader, "parentChunkIndex": row.ParentChunkIndex,
		}
		items = append(items, item)
	}
	response.OK(c, gin.H{"chunks": items, "retrievableCount": countRetrievableChunks(rows)})
}

// clampChunkDimension 归一化父块/子块大小：0 表示沿用 chunker 默认值，
// 其余取值夹在合理区间内，避免把分块切成碎片或撑爆嵌入模型上限。
func clampChunkDimension(value int) int {
	if value <= 0 {
		return 0
	}
	return maxInt(64, minInt(value, 8192))
}

// toKBTextSegments 把解析层给出的分段转成写库/分块用的形式。
func toKBTextSegments(segments []docextract.Segment) []kbTextSegmentInput {
	if len(segments) == 0 {
		return nil
	}
	out := make([]kbTextSegmentInput, 0, len(segments))
	for _, segment := range segments {
		out = append(out, kbTextSegmentInput{StartOffset: segment.StartOffset, Page: segment.Page, Locator: segment.Locator})
	}
	return out
}
