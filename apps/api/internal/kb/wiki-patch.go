// wiki-patch.go Wiki 补丁审批：待审清单、通过与驳回。
// 补丁是「Agent 提议改写某页，人来点头」的通道，落地一律走 wikimutation.go 的入口。
package kb

import (
	"context"
	"strconv"
	"time"
)

// ===== 补丁 =====

// WikiPatchList 待处理补丁清单（updated_at 倒序，最多 100 条）。
func WikiPatchList(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}
		rows, err := q.Query(c.Request.Context(),
			`SELECT `+wikiPatchColumns+` FROM petrichor_kb_wiki_patch
			 WHERE user_id = $1 AND knowledge_base_id = $2
			 ORDER BY updated_at DESC LIMIT 100`, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		patches := []map[string]any{}
		for rows.Next() {
			var r WikiPatchRow
			if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID,
				&r.PageKey, &r.Title, &r.Operation, &r.Status, &r.BeforeContentMd,
				&r.ProposedContentMd, &r.DiffText, &r.Reason, &r.AppliedAt,
				&r.CreatedAt, &r.UpdatedAt); err != nil {
				return nil, err
			}
			patches = append(patches, toWikiPatchResponse(&r))
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(kbID, 10),
			"patches":         patches,
		}, nil
	})
}

// loadPatch 加载归属补丁，404 语义与 TS 一致。
func loadPatch(ctx context.Context, q execQuerier, userID, knowledgeBaseID, patchID int64) (*WikiPatchRow, error) {
	rows, err := q.Query(ctx,
		`SELECT `+wikiPatchColumns+` FROM petrichor_kb_wiki_patch
		 WHERE id = $1 AND user_id = $2 AND knowledge_base_id = $3 LIMIT 1`,
		patchID, userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, notFoundErr("Wiki 补丁不存在")
	}
	var r WikiPatchRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID,
		&r.PageKey, &r.Title, &r.Operation, &r.Status, &r.BeforeContentMd,
		&r.ProposedContentMd, &r.DiffText, &r.Reason, &r.AppliedAt,
		&r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

// WikiPatchApply 审批通过：落地页面 + 标记 APPLIED + 重建索引 + 事件日志。
// 偏差说明：TS 版 applyWikiPatch 为纯 DB 操作（无 LLM 调用），故按真实逻辑实现而非注入桩。
func WikiPatchApply(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		patchID, err := reqID(raw["patchId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		kb, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		patch, err := loadPatch(c.Request.Context(), q, user.ID, kbID, patchID)
		if err != nil {
			return nil, err
		}
		if patch.Status != wikiPatchPending {
			return nil, badReq("只能处理待审批补丁")
		}

		kind := "concept"
		if patch.Operation == "CREATE" {
			kind = "answer"
		}
		now := time.Now()
		ctx := c.Request.Context()
		tx, err := q.Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(context.WithoutCancel(ctx))

		page, err := upsertWikiPage(ctx, tx, upsertWikiPageInput{
			UserID: user.ID, KnowledgeBaseID: kbID,
			PageKey: patch.PageKey, Title: patch.Title, Kind: kind,
			ContentMd: patch.ProposedContentMd,
			Summary:   strPtr(summarizePlainText(patch.ProposedContentMd, 180)),
			Frontmatter: map[string]any{
				"patchId": strconv.FormatInt(patch.ID, 10),
				"reason":  optString(patchReason(patch)),
			},
			SourceRefs: nil,
			Now:        now,
		})
		if err != nil {
			return nil, err
		}
		if err := setWikiPatchStatus(ctx, tx, user.ID, patch.ID, wikiPatchApplied, now); err != nil {
			return nil, err
		}
		indexPage, err := rebuildWikiIndex(ctx, tx, user.ID, kbID, kb.Name, now)
		if err != nil {
			return nil, err
		}
		_ = indexPage
		if err := logWikiEvent(ctx, tx, user.ID, kbID, "PATCH_APPLIED", &page.ID, map[string]any{
			"patchId": strconv.FormatInt(patch.ID, 10),
			"pageKey": patch.PageKey,
		}); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}

		updated, err := loadPatch(c.Request.Context(), q, user.ID, kbID, patchID)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"patch": toWikiPatchResponse(updated),
			"page":  toWikiPageResponse(page),
		}, nil
	})
}

func patchReason(p *WikiPatchRow) *string { return p.Reason }

func strPtr(s string) *string { return &s }

// WikiPatchReject 驳回补丁。
func WikiPatchReject(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		patchID, err := reqID(raw["patchId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}
		patch, err := loadPatch(c.Request.Context(), q, user.ID, kbID, patchID)
		if err != nil {
			return nil, err
		}
		if patch.Status != wikiPatchPending {
			return nil, badReq("只能处理待审批补丁")
		}
		now := time.Now()
		if err := setWikiPatchStatus(c.Request.Context(), q, user.ID, patch.ID, wikiPatchRejected, now); err != nil {
			return nil, err
		}
		if err := logWikiEvent(c.Request.Context(), q, user.ID, kbID, "PATCH_REJECTED", nil, map[string]any{
			"patchId": strconv.FormatInt(patch.ID, 10),
			"pageKey": patch.PageKey,
		}); err != nil {
			return nil, err
		}
		updated, err := loadPatch(c.Request.Context(), q, user.ID, kbID, patchID)
		if err != nil {
			return nil, err
		}
		return toWikiPatchResponse(updated), nil
	})
}
