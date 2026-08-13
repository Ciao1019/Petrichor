package assistant

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantmessage"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/vector"
)

const (
	contextRecallTopK       = 4
	contextRecallMinScore   = 0.25
	contextRecallExcerptMax = 500
	contextRecallEmbedBatch = 16
)

type recalledSnippet struct {
	MessageID string
	Score     float64
	Excerpt   string
}

type recallInput struct {
	UserID            int64
	ThreadID          int64
	Query             string
	ExcludeMessageIDs []int64
	Limit             int
}

type recallDeps struct {
	SQL *sql.DB
	Gen *ai.Generation
}

func sanitizeRecallExcerpt(text string) string {
	replacers := []*regexp.Regexp{
		regexp.MustCompile(`sk-[a-zA-Z0-9]{10,}`),
		regexp.MustCompile(`(?i)(api[_-]?key|token|secret|password|cookie)\s*[:=]\s*\S+`),
		regexp.MustCompile(`(?i)bearer\s+[a-zA-Z0-9._\-]+`),
		regexp.MustCompile(`(?i)executionOutcome[\s\S]{0,200}`),
	}
	next := text
	next = replacers[0].ReplaceAllString(next, "[redacted]")
	next = replacers[1].ReplaceAllString(next, "$1=[redacted]")
	next = replacers[2].ReplaceAllString(next, "Bearer [redacted]")
	next = replacers[3].ReplaceAllString(next, "[confirmation omitted]")
	next = regexp.MustCompile(`\s+`).ReplaceAllString(next, " ")
	next = strings.TrimSpace(next)
	if len([]rune(next)) <= contextRecallExcerptMax {
		return next
	}
	return string([]rune(next)[:contextRecallExcerptMax]) + "…"
}

func recallRelevantHistory(ctx context.Context, client *ent.Client, deps recallDeps, input recallInput) []recalledSnippet {
	query := strings.TrimSpace(input.Query)
	if query == "" || input.ThreadID <= 0 {
		return nil
	}
	limit := input.Limit
	if limit <= 0 {
		limit = contextRecallTopK
	}
	if deps.SQL != nil && deps.Gen != nil {
		if snippets := recallByVector(ctx, client, deps, input, limit); len(snippets) > 0 {
			return snippets
		}
	}
	return recallByFTS(ctx, client, input, limit)
}

func recallByVector(ctx context.Context, client *ent.Client, deps recallDeps, input recallInput, limit int) []recalledSnippet {
	ok, err := ai.HasEmbeddingConfig(ctx, client, input.UserID)
	if err != nil || !ok {
		return nil
	}
	go ensureThreadMessageEmbeddingsBestEffort(context.WithoutCancel(ctx), client, deps, input)

	modelCfg, err := ai.ResolveEmbeddingConfig(ctx, client, input.UserID, nil)
	if err != nil {
		return nil
	}
	q := input.Query
	if len([]rune(q)) > 4000 {
		q = string([]rune(q)[:4000])
	}
	vecs, err := deps.Gen.Embed(ctx, modelCfg, []string{q})
	if err != nil || len(vecs) == 0 || len(vecs[0]) == 0 {
		return nil
	}
	literal := vector.FormatPGVector(vecs[0])

	var rows *sql.Rows
	if len(input.ExcludeMessageIDs) > 0 {
		placeholders := make([]string, len(input.ExcludeMessageIDs))
		args := make([]any, 0, 4+len(input.ExcludeMessageIDs))
		args = append(args, input.ThreadID, input.UserID, literal)
		for i, id := range input.ExcludeMessageIDs {
			placeholders[i] = fmt.Sprintf("$%d", i+4)
			args = append(args, id)
		}
		args = append(args, limit)
		limitIdx := len(args)
		q := fmt.Sprintf(`
			select message_id, excerpt_md,
				(1 - (embedding <=> $3::vector))::float8 as score
			from petrichor_assistant_message_embedding
			where thread_id = $1 and user_id = $2
			  and embedding is not null
			  and message_id not in (%s)
			order by embedding <=> $3::vector
			limit $%d
		`, strings.Join(placeholders, ","), limitIdx)
		rows, err = deps.SQL.QueryContext(ctx, q, args...)
	} else {
		rows, err = deps.SQL.QueryContext(ctx, `
			select message_id, excerpt_md,
				(1 - (embedding <=> $3::vector))::float8 as score
			from petrichor_assistant_message_embedding
			where thread_id = $1 and user_id = $2
			  and embedding is not null
			order by embedding <=> $3::vector
			limit $4
		`, input.ThreadID, input.UserID, literal, limit)
	}
	if err != nil {
		return nil
	}
	defer rows.Close()

	out := make([]recalledSnippet, 0, limit)
	for rows.Next() {
		var messageID int64
		var excerpt string
		var score float64
		if err := rows.Scan(&messageID, &excerpt, &score); err != nil {
			continue
		}
		excerpt = strings.TrimSpace(excerpt)
		if excerpt == "" || score < contextRecallMinScore {
			continue
		}
		out = append(out, recalledSnippet{
			MessageID: fmt.Sprintf("%d", messageID),
			Score:     score,
			Excerpt:   excerpt,
		})
	}
	return out
}

func ensureThreadMessageEmbeddingsBestEffort(ctx context.Context, client *ent.Client, deps recallDeps, input recallInput) {
	if deps.SQL == nil || deps.Gen == nil {
		return
	}
	ok, err := ai.HasEmbeddingConfig(ctx, client, input.UserID)
	if err != nil || !ok {
		return
	}
	modelCfg, err := ai.ResolveEmbeddingConfig(ctx, client, input.UserID, nil)
	if err != nil {
		return
	}
	exclude := map[int64]struct{}{}
	for _, id := range input.ExcludeMessageIDs {
		exclude[id] = struct{}{}
	}
	rows, err := client.AssistantMessage.Query().
		Where(assistantmessage.ThreadIDEQ(input.ThreadID)).
		Order(ent.Asc(assistantmessage.FieldCreatedAt), ent.Asc(assistantmessage.FieldID)).
		Limit(200).
		All(ctx)
	if err != nil {
		return
	}
	type candidate struct {
		ID      int64
		Excerpt string
	}
	pending := make([]candidate, 0, 32)
	for _, row := range rows {
		if _, skip := exclude[row.ID]; skip {
			continue
		}
		var exists bool
		_ = deps.SQL.QueryRowContext(ctx, `
			select exists(
				select 1 from petrichor_assistant_message_embedding
				where message_id = $1 and embedding is not null
			)
		`, row.ID).Scan(&exists)
		if exists {
			continue
		}
		text := extractPlainFromContentJSON(row.ContentJSON)
		excerpt := sanitizeRecallExcerpt(text)
		if excerpt == "" {
			continue
		}
		pending = append(pending, candidate{ID: row.ID, Excerpt: excerpt})
		if len(pending) >= contextRecallEmbedBatch {
			break
		}
	}
	if len(pending) == 0 {
		return
	}
	texts := make([]string, len(pending))
	for i, c := range pending {
		texts[i] = c.Excerpt
	}
	vecs, err := deps.Gen.Embed(ctx, modelCfg, texts)
	if err != nil || len(vecs) != len(pending) {
		return
	}
	for i, c := range pending {
		if len(vecs[i]) == 0 {
			continue
		}
		literal := vector.FormatPGVector(vecs[i])
		_, _ = deps.SQL.ExecContext(ctx, `
			insert into petrichor_assistant_message_embedding (message_id, thread_id, user_id, excerpt_md, embedding)
			values ($1, $2, $3, $4, $5::vector)
			on conflict (message_id) do update
			set excerpt_md = excluded.excerpt_md,
			    embedding = excluded.embedding
		`, c.ID, input.ThreadID, input.UserID, c.Excerpt, literal)
	}
}

func recallByFTS(ctx context.Context, client *ent.Client, input recallInput, limit int) []recalledSnippet {
	q := client.AssistantMessage.Query().
		Where(assistantmessage.ThreadIDEQ(input.ThreadID)).
		Order(ent.Desc(assistantmessage.FieldCreatedAt), ent.Desc(assistantmessage.FieldID)).
		Limit(80)
	if len(input.ExcludeMessageIDs) > 0 {
		q = q.Where(assistantmessage.IDNotIn(input.ExcludeMessageIDs...))
	}
	rows, err := q.All(ctx)
	if err != nil {
		return nil
	}
	query := strings.ToLower(strings.TrimSpace(input.Query))
	terms := strings.Fields(query)
	if len(terms) == 0 {
		return nil
	}
	type scored struct {
		id      int64
		excerpt string
		score   float64
	}
	scoredRows := make([]scored, 0, limit)
	for _, row := range rows {
		text := extractPlainFromContentJSON(row.ContentJSON)
		if text == "" {
			continue
		}
		lower := strings.ToLower(text)
		hits := 0
		for _, term := range terms {
			if strings.Contains(lower, term) {
				hits++
			}
		}
		if hits == 0 {
			continue
		}
		score := float64(hits) / float64(len(terms))
		if score < contextRecallMinScore {
			continue
		}
		scoredRows = append(scoredRows, scored{
			id:      row.ID,
			excerpt: sanitizeRecallExcerpt(text),
			score:   score,
		})
	}
	for i := 0; i < len(scoredRows); i++ {
		for j := i + 1; j < len(scoredRows); j++ {
			if scoredRows[j].score > scoredRows[i].score {
				scoredRows[i], scoredRows[j] = scoredRows[j], scoredRows[i]
			}
		}
	}
	if len(scoredRows) > limit {
		scoredRows = scoredRows[:limit]
	}
	out := make([]recalledSnippet, 0, len(scoredRows))
	for _, row := range scoredRows {
		out = append(out, recalledSnippet{
			MessageID: fmt.Sprintf("%d", row.id),
			Score:     row.score,
			Excerpt:   row.excerpt,
		})
	}
	return out
}

func extractPlainFromContentJSON(raw *string) string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return ""
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(*raw), &obj); err == nil {
		if text, ok := obj["text"].(string); ok {
			return text
		}
	}
	return strings.TrimSpace(*raw)
}
