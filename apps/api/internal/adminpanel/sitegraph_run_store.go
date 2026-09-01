package adminpanel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

func CreateRun(ctx context.Context, userID int64, mode string) (*runRecord, error) {
	return scanRunRow(db.Pool().QueryRow(ctx,
		`INSERT INTO petrichor_site_graph_run (user_id, mode, status, created_at, updated_at)
		 VALUES ($1,$2,'RUNNING',now(),now()) RETURNING `+runColumns, userID, mode))
}

type runRecord struct {
	ID             int64
	UserID         int64
	Status         string
	Mode           string
	ModelName      *string
	ArticleCount   int32
	NodeCount      int32
	EdgeCount      int32
	ValidationJSON *string
	WarningsJSON   *string
	ErrorMessage   *string
	StartedAt      time.Time
	FinishedAt     *time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

const runColumns = `id, user_id, status, mode, model_name, article_count, node_count, edge_count,
	validation_json, warnings_json, error_message, started_at, finished_at, created_at, updated_at`

func scanRunRow(scanner interface{ Scan(dest ...any) error }) (*runRecord, error) {
	var r runRecord
	err := scanner.Scan(&r.ID, &r.UserID, &r.Status, &r.Mode, &r.ModelName, &r.ArticleCount,
		&r.NodeCount, &r.EdgeCount, &r.ValidationJSON, &r.WarningsJSON, &r.ErrorMessage,
		&r.StartedAt, &r.FinishedAt, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// FinishRun 收尾一次运行记录。
func FinishRun(ctx context.Context, runID, userID int64, status string, modelName *string,
	articleCount, nodeCount, edgeCount int, validation *ValidationReport,
	warnings []string, errorMessage *string) error {
	now := time.Now()
	var validationArg any
	if validation != nil {
		raw, err := json.Marshal(validation)
		if err != nil {
			return err
		}
		validationArg = string(raw)
	}
	warningsRaw := warnings
	if warningsRaw == nil {
		warningsRaw = []string{}
	}
	warningsJSON, err := json.Marshal(warningsRaw)
	if err != nil {
		return err
	}
	_, err = db.Pool().Exec(ctx,
		`UPDATE petrichor_site_graph_run SET status=$1, model_name=$2, article_count=$3, node_count=$4,
		 edge_count=$5, validation_json=$6, warnings_json=$7, error_message=$8, finished_at=$9, updated_at=$9
		 WHERE id=$10 AND user_id=$11`,
		status, modelName, int32(articleCount), int32(nodeCount), int32(edgeCount), validationArg,
		string(warningsJSON), errorMessage, now, runID, userID)
	return err
}

func toRunSummary(r *runRecord) RunSummary {
	validation := json.RawMessage("null")
	if r.ValidationJSON != nil && strings.TrimSpace(*r.ValidationJSON) != "" {
		validation = json.RawMessage(*r.ValidationJSON)
	}
	warnings := []string{}
	if r.WarningsJSON != nil && strings.TrimSpace(*r.WarningsJSON) != "" {
		var parsed any
		if err := json.Unmarshal([]byte(*r.WarningsJSON), &parsed); err == nil {
			if arr, ok := parsed.([]any); ok {
				for _, item := range arr {
					warnings = append(warnings, toStringValue(item))
				}
			}
		}
	}
	var finishedAt *string
	if r.FinishedAt != nil {
		s := httpx.FormatISO(*r.FinishedAt)
		finishedAt = &s
	}
	return RunSummary{
		ID:           strconv.FormatInt(r.ID, 10),
		Status:       r.Status,
		Mode:         r.Mode,
		ModelName:    r.ModelName,
		ArticleCount: r.ArticleCount,
		NodeCount:    r.NodeCount,
		EdgeCount:    r.EdgeCount,
		Validation:   validation,
		Warnings:     warnings,
		ErrorMessage: r.ErrorMessage,
		StartedAt:    httpx.FormatISO(r.StartedAt),
		FinishedAt:   finishedAt,
	}
}

// ListRuns 最近 N 次运行记录。
func ListRuns(ctx context.Context, userID int64, limit int32) ([]RunSummary, error) {
	rows, err := db.Pool().Query(ctx,
		`SELECT `+runColumns+` FROM petrichor_site_graph_run WHERE user_id = $1
		 ORDER BY started_at DESC, id DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []RunSummary{}
	for rows.Next() {
		r, serr := scanRunRow(rows)
		if serr != nil {
			return nil, serr
		}
		list = append(list, toRunSummary(r))
	}
	return list, rows.Err()
}

// FailStaleRuns 把处于 RUNNING 且超时的历史记录标记失败。
func FailStaleRuns(ctx context.Context, userID int64) error {
	threshold := time.Now().Add(-time.Duration(StaleRunTimeoutMs) * time.Millisecond)
	rows, err := db.Pool().Query(ctx,
		`SELECT id, started_at FROM petrichor_site_graph_run
		 WHERE user_id=$1 AND status='RUNNING'`, userID)
	if err != nil {
		return err
	}
	staleIDs := []int64{}
	for rows.Next() {
		var id int64
		var startedAt time.Time
		if serr := rows.Scan(&id, &startedAt); serr != nil {
			rows.Close()
			return serr
		}
		if startedAt.Before(threshold) {
			staleIDs = append(staleIDs, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(staleIDs) == 0 {
		return nil
	}
	msg := "生成超时，已自动标记失败"
	_, err = db.Pool().Exec(ctx,
		`UPDATE petrichor_site_graph_run SET status='FAILED', error_message=$1, finished_at=now(), updated_at=now()
		 WHERE user_id=$2 AND id = ANY($3)`, msg, userID, staleIDs)
	return err
}

// ===== 实体对齐 =====

// LoadEntityRegistryEntries 把库里已有的概念/实体读成注册表条目。
func LoadEntityRegistryEntries(ctx context.Context, userID int64) ([]EntityRegistryEntry, error) {
	rows, err := db.Pool().Query(ctx,
		`SELECT node_key, name, kind, aliases_json, weight FROM petrichor_site_graph_node
		 WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []EntityRegistryEntry{}
	for rows.Next() {
		var row EntityRegistryEntry
		var aliasesJSON *string
		if serr := rows.Scan(&row.CanonicalKey, &row.Name, &row.Kind, &aliasesJSON, &row.Weight); serr != nil {
			return nil, serr
		}
		if !isAlignableKind(row.Kind) {
			continue
		}
		row.Aliases = parseAliasesFromJSON(aliasesJSON)
		entries = append(entries, row)
	}
	return entries, rows.Err()
}

// SaveMergeCandidates 写入本次运行发现的合并候选；已存在的对子保持原状态。
func SaveMergeCandidates(ctx context.Context, userID int64, candidates []*MergeCandidate) (int, error) {
	if len(candidates) == 0 {
		return 0, nil
	}
	pool := db.Pool()
	rows, err := pool.Query(ctx,
		`SELECT source_key, target_key FROM petrichor_site_graph_merge_candidate WHERE user_id = $1`, userID)
	if err != nil {
		return 0, err
	}
	existingPairs := map[string]struct{}{}
	for rows.Next() {
		var sourceKey, targetKey string
		if serr := rows.Scan(&sourceKey, &targetKey); serr != nil {
			rows.Close()
			return 0, serr
		}
		existingPairs[sourceKey+"|"+targetKey] = struct{}{}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	inserted := 0
	batch := &pgx.Batch{}
	for _, candidate := range candidates {
		pair := candidate.SourceKey + "|" + candidate.TargetKey
		if _, exists := existingPairs[pair]; exists {
			continue
		}
		existingPairs[pair] = struct{}{}
		inserted++
		detail := candidate.Detail
		batch.Queue(
			`INSERT INTO petrichor_site_graph_merge_candidate
			 (user_id, source_key, target_key, reason, score, detail, status, created_at, updated_at)
			 VALUES ($1,$2,$3,$4,$5,$6,'PENDING',now(),now())`,
			userID, candidate.SourceKey, candidate.TargetKey, candidate.Reason, int32(candidate.Score), detail)
	}
	if inserted > 0 {
		if err := pool.SendBatch(ctx, batch).Close(); err != nil {
			return 0, err
		}
	}
	return inserted, nil
}

// PruneStaleMergeCandidates 清理两端节点任一不存在的 PENDING 候选。
func PruneStaleMergeCandidates(ctx context.Context, userID int64) error {
	rows, err := db.Pool().Query(ctx,
		`SELECT id, source_key, target_key FROM petrichor_site_graph_merge_candidate
		 WHERE user_id=$1 AND status='PENDING'`, userID)
	if err != nil {
		return err
	}
	type candidateRow struct {
		id        int64
		sourceKey string
		targetKey string
	}
	candidates := []candidateRow{}
	for rows.Next() {
		var c candidateRow
		if serr := rows.Scan(&c.id, &c.sourceKey, &c.targetKey); serr != nil {
			rows.Close()
			return serr
		}
		candidates = append(candidates, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(candidates) == 0 {
		return nil
	}

	keyRows, err := db.Pool().Query(ctx,
		`SELECT node_key FROM petrichor_site_graph_node WHERE user_id = $1`, userID)
	if err != nil {
		return err
	}
	keys := map[string]struct{}{}
	for keyRows.Next() {
		var key string
		if serr := keyRows.Scan(&key); serr != nil {
			keyRows.Close()
			return serr
		}
		keys[key] = struct{}{}
	}
	keyRows.Close()
	if err := keyRows.Err(); err != nil {
		return err
	}

	staleIDs := []int64{}
	for _, c := range candidates {
		_, sourceOK := keys[c.sourceKey]
		_, targetOK := keys[c.targetKey]
		if sourceOK && targetOK {
			continue
		}
		staleIDs = append(staleIDs, c.id)
	}
	if len(staleIDs) == 0 {
		return nil
	}
	_, err = db.Pool().Exec(ctx,
		`DELETE FROM petrichor_site_graph_merge_candidate WHERE id = ANY($1)`, staleIDs)
	return err
}

// ListMergeCandidates 待确认合并候选列表。
func ListMergeCandidates(ctx context.Context, userID int64, limit int32) ([]MergeCandidateView, error) {
	pool := db.Pool()
	rows, err := pool.Query(ctx,
		`SELECT id, source_key, target_key, reason, score, detail, status, created_at
		 FROM petrichor_site_graph_merge_candidate
		 WHERE user_id=$1 AND status='PENDING'
		 ORDER BY score DESC, id DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	list := []MergeCandidateView{}
	for rows.Next() {
		var item MergeCandidateView
		var createdAt time.Time
		if serr := rows.Scan(&item.ID, &item.SourceKey, &item.TargetKey, &item.Reason,
			&item.Score, &item.Detail, &item.Status, &createdAt); serr != nil {
			rows.Close()
			return nil, serr
		}
		item.CreatedAt = httpx.FormatISO(createdAt)
		list = append(list, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	nodeRows, err := pool.Query(ctx,
		`SELECT id, node_key, name FROM petrichor_site_graph_node WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	type nodeLite struct {
		id      int64
		nodeKey string
		name    string
	}
	byKey := map[string]*nodeLite{}
	for nodeRows.Next() {
		n := &nodeLite{}
		if serr := nodeRows.Scan(&n.id, &n.nodeKey, &n.name); serr != nil {
			nodeRows.Close()
			return nil, serr
		}
		byKey[n.nodeKey] = n
	}
	nodeRows.Close()
	if err := nodeRows.Err(); err != nil {
		return nil, err
	}

	result := make([]MergeCandidateView, 0, len(list))
	for _, view := range list {
		if source := byKey[view.SourceKey]; source != nil {
			view.SourceName = source.name
			idStr := strconv.FormatInt(source.id, 10)
			view.SourceNodeID = &idStr
		} else {
			view.SourceName = "（已删除）"
		}
		if target := byKey[view.TargetKey]; target != nil {
			view.TargetName = target.name
			idStr := strconv.FormatInt(target.id, 10)
			view.TargetNodeID = &idStr
		} else {
			view.TargetName = "（已删除）"
		}
		result = append(result, view)
	}
	return result, nil
}

// IgnoreMergeCandidate 忽略合并候选。
func IgnoreMergeCandidate(ctx context.Context, userID, id int64) (map[string]any, error) {
	var updatedID int64
	err := db.Pool().QueryRow(ctx,
		`UPDATE petrichor_site_graph_merge_candidate SET status='IGNORED', updated_at=now()
		 WHERE id=$1 AND user_id=$2 RETURNING id`, id, userID).Scan(&updatedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("合并候选不存在")
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": strconv.FormatInt(updatedID, 10)}, nil
}

// MergeNodes 把 source 节点并入 target：别名/属性/权重归并，关系与子节点改挂，最后删 source。
func MergeNodes(ctx context.Context, userID, sourceNodeID, targetNodeID int64) (*MergeNodesResult, error) {
	if sourceNodeID == targetNodeID {
		return nil, httpx.BadRequest("不能把节点合并到它自己")
	}
	source, err := assertNodeOwned(ctx, userID, sourceNodeID)
	if err != nil {
		return nil, err
	}
	target, err := assertNodeOwned(ctx, userID, targetNodeID)
	if err != nil {
		return nil, err
	}

	looped, err := isDescendantOf(ctx, userID, targetNodeID, sourceNodeID)
	if err != nil {
		return nil, err
	}
	if looped {
		return nil, httpx.BadRequest("目标节点是来源节点的子孙，合并会破坏层级")
	}

	pool := db.Pool()
	sourceAttributes := parseAttributesFromJSON(source.AttributesJSON)
	targetAttributes := parseAttributesFromJSON(target.AttributesJSON)
	targetAttributeNames := map[string]string{}
	for _, item := range targetAttributes {
		targetAttributeNames[strings.ToLower(item.Name)] = item.Value
	}
	attributeConflicts := 0
	mergedAttributes := append([]Attribute{}, targetAttributes...)
	for _, attribute := range sourceAttributes {
		existingValue, exists := targetAttributeNames[strings.ToLower(attribute.Name)]
		if !exists {
			mergedAttributes = append(mergedAttributes, attribute)
			targetAttributeNames[strings.ToLower(attribute.Name)] = attribute.Value
			continue
		}
		if existingValue != attribute.Value {
			attributeConflicts++
		}
	}

	aliasRaw := make([]any, 0)
	for _, a := range parseAliasesFromJSON(target.AliasesJSON) {
		aliasRaw = append(aliasRaw, a)
	}
	for _, a := range parseAliasesFromJSON(source.AliasesJSON) {
		aliasRaw = append(aliasRaw, a)
	}
	aliasRaw = append(aliasRaw, source.Name)
	mergedAliases := normalizeAliases(aliasRaw)

	var summaryArg, routeArg any
	summary := ""
	if target.Summary != nil {
		summary = strings.TrimSpace(*target.Summary)
	}
	if summary != "" {
		summaryArg = summary
	} else if source.Summary != nil {
		summaryArg = *source.Summary
	}
	if target.Route != nil {
		routeArg = *target.Route
	} else if source.Route != nil {
		routeArg = *source.Route
	}

	confidence := target.Confidence
	if source.Confidence > confidence {
		confidence = source.Confidence
	}
	if _, err := pool.Exec(ctx,
		`UPDATE petrichor_site_graph_node SET attributes_json=$1, aliases_json=$2, weight=$3,
		 confidence=$4, summary=$5, route=$6, updated_at=now() WHERE id=$7`,
		marshalAttributes(normalizeAttributes(attributesToAny(mergedAttributes))),
		marshalStrings(mergedAliases),
		int32(ClampWeight(float64(target.Weight+source.Weight))), confidence,
		summaryArg, routeArg, target.ID); err != nil {
		return nil, err
	}

	// 关系改挂：撞到自环或已有同名三元组的直接删掉，避免违反唯一约束
	edges := []*edgeRecord{}
	edgeRows, err := pool.Query(ctx,
		`SELECT `+edgeColumns+` FROM petrichor_site_graph_edge WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	for edgeRows.Next() {
		e, serr := scanEdgeRow(edgeRows)
		if serr != nil {
			edgeRows.Close()
			return nil, serr
		}
		edges = append(edges, e)
	}
	edgeRows.Close()
	if err := edgeRows.Err(); err != nil {
		return nil, err
	}

	existingTriples := map[string]struct{}{}
	for _, e := range edges {
		if e.FromNodeID != source.ID && e.ToNodeID != source.ID {
			existingTriples[fmt.Sprintf("%d|%d|%s", e.FromNodeID, e.ToNodeID, e.Relation)] = struct{}{}
		}
	}

	movedEdges := 0
	droppedEdges := 0
	for _, e := range edges {
		if e.FromNodeID != source.ID && e.ToNodeID != source.ID {
			continue
		}
		nextFrom := e.FromNodeID
		if nextFrom == source.ID {
			nextFrom = target.ID
		}
		nextTo := e.ToNodeID
		if nextTo == source.ID {
			nextTo = target.ID
		}
		triple := fmt.Sprintf("%d|%d|%s", nextFrom, nextTo, e.Relation)

		if nextFrom == nextTo {
			if _, derr := pool.Exec(ctx, `DELETE FROM petrichor_site_graph_edge WHERE id=$1`, e.ID); derr != nil {
				return nil, derr
			}
			droppedEdges++
			continue
		}
		if _, dup := existingTriples[triple]; dup {
			if _, derr := pool.Exec(ctx, `DELETE FROM petrichor_site_graph_edge WHERE id=$1`, e.ID); derr != nil {
				return nil, derr
			}
			droppedEdges++
			continue
		}
		existingTriples[triple] = struct{}{}
		if _, uerr := pool.Exec(ctx,
			`UPDATE petrichor_site_graph_edge SET from_node_id=$1, to_node_id=$2, updated_at=now() WHERE id=$3`,
			nextFrom, nextTo, e.ID); uerr != nil {
			return nil, uerr
		}
		movedEdges++
	}

	var movedChildren int32
	if err := pool.QueryRow(ctx,
		`WITH moved AS (
			UPDATE petrichor_site_graph_node SET parent_id=$1, updated_at=now()
			WHERE user_id=$2 AND parent_id=$3 RETURNING id
		) SELECT count(*) FROM moved`, target.ID, userID, source.ID).Scan(&movedChildren); err != nil {
		return nil, err
	}

	if _, err := pool.Exec(ctx, `DELETE FROM petrichor_site_graph_node WHERE id=$1`, source.ID); err != nil {
		return nil, err
	}

	// 涉及来源键的候选都已了结
	if _, err := pool.Exec(ctx,
		`UPDATE petrichor_site_graph_merge_candidate SET status='MERGED', updated_at=now()
		 WHERE user_id=$1 AND source_key=$2`, userID, source.NodeKey); err != nil {
		return nil, err
	}

	return &MergeNodesResult{
		TargetKey:          target.NodeKey,
		AbsorbedAliases:    len(mergedAliases),
		MovedEdges:         movedEdges,
		DroppedEdges:       droppedEdges,
		MovedChildren:      int(movedChildren),
		AttributeConflicts: attributeConflicts,
	}, nil
}

// ListNodeOptions 后台节点下拉框用的精简列表。
func ListNodeOptions(ctx context.Context, userID int64) ([]map[string]any, error) {
	rows, err := db.Pool().Query(ctx,
		`SELECT id, node_key, name, kind FROM petrichor_site_graph_node WHERE user_id = $1
		 ORDER BY kind ASC, name ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []map[string]any{}
	for rows.Next() {
		var id int64
		var nodeKey, name, kind string
		if serr := rows.Scan(&id, &nodeKey, &name, &kind); serr != nil {
			return nil, serr
		}
		list = append(list, map[string]any{
			"id":      strconv.FormatInt(id, 10),
			"nodeKey": nodeKey,
			"name":    name,
			"kind":    kind,
		})
	}
	return list, rows.Err()
}
