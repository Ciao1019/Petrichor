package kb

import (
	"context"
	"fmt"
)

// extractDocumentCandidatesWithAgent 把整篇文档作为可遍历工作区交给 Agent。
// Agent 必须实际覆盖全部内容分片并返回逐候选来源，未满足契约时由上层安全降级。
func extractDocumentCandidatesWithAgent(
	ctx context.Context,
	userID int64,
	profile compileProfile,
	articleTitle string,
	chunks []wfChunk,
	existingPages []existingKnowledgePage,
) (string, []knowledgeCandidate, []knowledgeRelation, error) {
	request := DocumentAgentRequest{
		UserID:            userID,
		KnowledgeBaseName: profile.KnowledgeBaseName,
		ArticleTitle:      articleTitle,
		CompileGuide:      normalizeGuideForPrompt(profile.Guide),
		MaxCandidates:     wikiItemLimit,
		Chunks:            make([]DocumentAgentChunk, 0, len(chunks)),
		ExistingPages:     make([]DocumentAgentExistingPage, 0, len(existingPages)),
		Progress: func(progress DocumentAgentProgress) {
			reportKnowledgeBuildStage(ctx, knowledgeBuildStageUpdate{
				ParentID: knowledgeBuildPhaseAnalyzing,
				ID:       knowledgeBuildStageAgent, Status: knowledgeBuildStageRunning,
				Message: progress.Message, Percent: progress.Percent,
				Completed: progress.Completed, Total: progress.Total,
			})
		},
		Activity: func(activity DocumentAgentActivity) {
			reportKnowledgeBuildAgentActivity(ctx, activity)
		},
	}
	for _, chunk := range chunks {
		request.Chunks = append(request.Chunks, DocumentAgentChunk{
			ChunkKey: chunk.chunkKey, HeadingPath: append([]string(nil), chunk.headingPath...), ContentMd: chunk.contentMd,
		})
	}
	for _, page := range existingPages {
		request.ExistingPages = append(request.ExistingPages, DocumentAgentExistingPage{
			PageKey: page.pageKey, Kind: page.kind, Title: page.title,
			Aliases: append([]string(nil), page.aliases...), Summary: page.summary,
		})
	}

	reportKnowledgeBuildStage(ctx, knowledgeBuildStageUpdate{
		ParentID: knowledgeBuildPhaseAnalyzing,
		ID:       knowledgeBuildStageAgent, Status: knowledgeBuildStageRunning,
		Message: "文档 Agent 正在准备隔离工作区", Percent: 0,
	})
	raw, err := DocumentAgentInvoker(ctx, request)
	if err != nil {
		return "", nil, nil, err
	}
	reportKnowledgeBuildAgentActivity(ctx, DocumentAgentActivity{
		ID: "adk-output-validation", Kind: "validation", Status: knowledgeBuildStageRunning,
		Title: "校验 Agent 抽取结果", Detail: "正在检查全文覆盖和知识来源",
	})
	parsed := extractJSONObjects(raw)
	if len(parsed) == 0 {
		reportKnowledgeBuildAgentActivity(ctx, DocumentAgentActivity{
			ID: "adk-output-validation", Status: knowledgeBuildStageFailed,
			Title: "Agent 输出格式校验未通过",
		})
		return "", nil, nil, fmt.Errorf("文档 Agent 输出不是有效 JSON: %w", errKnowledgeBuildInvalidJSON)
	}
	if err := validateDocumentAgentCoverage(parsed, chunks); err != nil {
		reportKnowledgeBuildAgentActivity(ctx, DocumentAgentActivity{
			ID: "adk-output-validation", Status: knowledgeBuildStageFailed,
			Title: "Agent 全文覆盖校验未通过",
		})
		return "", nil, nil, err
	}

	candidates := limitKnowledgeCandidates(
		normalizeKnowledgeCandidates(parsed["entities"], "entity"),
		normalizeKnowledgeCandidates(parsed["concepts"], "concept"),
		wikiItemLimit,
	)
	if err := validateDocumentAgentCandidateSources(parsed, candidates, chunks); err != nil {
		reportKnowledgeBuildAgentActivity(ctx, DocumentAgentActivity{
			ID: "adk-output-validation", Status: knowledgeBuildStageFailed,
			Title: "Agent 知识来源校验未通过",
		})
		return "", nil, nil, err
	}
	reportKnowledgeBuildAgentActivity(ctx, DocumentAgentActivity{
		ID: "adk-output-validation", Status: knowledgeBuildStageCompleted,
		Title:  "Agent 抽取结果校验通过",
		Detail: fmt.Sprintf("全文 %d 个切片均已覆盖，%d 个候选来源有效", len(chunks), len(candidates)),
	})
	candidates = attachKnowledgeCandidateSources(candidates, parsed, chunks)
	candidateKeys := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		candidateKeys[candidate.pageKey] = struct{}{}
	}
	relations := normalizeKnowledgeRelations(parsed["relations"], candidateKeys)

	summary := truncateRunes(trimSpace(optString(parsed["documentSummary"])), 800)
	if summary == "" {
		summary = localDocumentSummary(joinKnowledgeChunkContent(chunks))
	}
	reportKnowledgeBuildStage(ctx, knowledgeBuildStageUpdate{
		ParentID: knowledgeBuildPhaseAnalyzing,
		ID:       knowledgeBuildStageAgent, Status: knowledgeBuildStageCompleted,
		Message: fmt.Sprintf("全文抽取完成：%d 个知识候选、%d 条关系", len(candidates), len(relations)),
		Percent: 100, Completed: len(chunks), Total: len(chunks),
	})
	return summary, candidates, relations, nil
}

func validateDocumentAgentCoverage(parsed map[string]any, chunks []wfChunk) error {
	covered := make(map[string]struct{}, len(chunks))
	for _, key := range normalizeStringList(parsed["coveredChunkKeys"], -1) {
		covered[key] = struct{}{}
	}
	var missing []string
	for _, chunk := range chunks {
		if _, ok := covered[chunk.chunkKey]; !ok {
			missing = append(missing, chunk.chunkKey)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("文档 Agent 未确认覆盖 %d 个内容分片", len(missing))
	}
	return nil
}

func validateDocumentAgentCandidateSources(parsed map[string]any, candidates []knowledgeCandidate, chunks []wfChunk) error {
	validKeys := make(map[string]struct{}, len(chunks))
	for _, chunk := range chunks {
		validKeys[chunk.chunkKey] = struct{}{}
	}
	sourcesByPageKey := map[string]map[string]struct{}{}
	collect := func(raw any, kind string) {
		items, _ := raw.([]any)
		for _, item := range items {
			entry, _ := item.(map[string]any)
			name := trimSpace(optString(entry["name"]))
			if name == "" {
				continue
			}
			pageKey := normalizePageKeyForKind(optString(entry["pageKey"]), kind, name)
			for _, key := range normalizeStringList(entry["sourceChunkKeys"], -1) {
				if _, ok := validKeys[key]; !ok {
					continue
				}
				if sourcesByPageKey[pageKey] == nil {
					sourcesByPageKey[pageKey] = map[string]struct{}{}
				}
				sourcesByPageKey[pageKey][key] = struct{}{}
			}
		}
	}
	collect(parsed["entities"], "entity")
	collect(parsed["concepts"], "concept")
	for _, candidate := range candidates {
		if len(sourcesByPageKey[candidate.pageKey]) == 0 {
			return fmt.Errorf("文档 Agent 候选 %s 缺少有效来源分片", candidate.pageKey)
		}
	}
	return nil
}
