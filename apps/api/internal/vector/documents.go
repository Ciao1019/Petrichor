package vector

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

const (
	DocumentEmbedBatchSize     = 64
	DocumentMaxEmbedPerRequest = 4000
	DocumentEmbedMaxChars      = 6000
)

// DocumentEmbeddingStatus 表示一个知识库中文件分片的向量化进度。
type DocumentEmbeddingStatus struct {
	Supported bool `json:"supported"`
	Total     int  `json:"total"`
	Embedded  int  `json:"embedded"`
	Pending   int  `json:"pending"`
}

// PendingDocumentChunkRow 是待向量化分片。
type PendingDocumentChunkRow struct {
	ID            int64
	Title         string
	Text          string
	ContextHeader string
}

// DocumentSemanticRow 是语义召回结果。
type DocumentSemanticRow struct {
	ChunkID  int64
	Distance float64
}

func BuildDocumentEmbedText(title, text string, contextHeader ...string) string {
	parts := []string{strings.TrimSpace(title)}
	if len(contextHeader) > 0 && strings.TrimSpace(contextHeader[0]) != "" {
		parts = append(parts, strings.TrimSpace(contextHeader[0]))
	}
	parts = append(parts, strings.TrimSpace(text))
	value := strings.TrimSpace(strings.Join(parts, "\n"))
	runes := []rune(value)
	if len(runes) > DocumentEmbedMaxChars {
		return string(runes[:DocumentEmbedMaxChars])
	}
	return value
}

func GetDocumentEmbeddingStatus(ctx context.Context, db *sql.DB, userID, knowledgeBaseID int64) (*DocumentEmbeddingStatus, error) {
	if db == nil {
		return &DocumentEmbeddingStatus{Supported: false}, nil
	}
	const q = `select count(*)::int, count(c.embedding)::int
		from petrichor_kb_document_chunk c
		join petrichor_kb_document d on d.id = c.document_id
		where c.user_id = $1 and c.knowledge_base_id = $2 and d.status in ('ready', 'partial')
		  and c.chunk_type <> 'parent_text'`
	var total, embedded int
	if err := db.QueryRowContext(ctx, q, userID, knowledgeBaseID).Scan(&total, &embedded); err != nil {
		return nil, err
	}
	return &DocumentEmbeddingStatus{Supported: true, Total: total, Embedded: embedded, Pending: max(total-embedded, 0)}, nil
}

// LoadPendingDocumentChunks 取出待向量化的分片。
//
// 这里刻意把 processing 也算进来：向量化是解析流水线中间的一步，
// 那时文档还没转成 ready，若沿用检索侧的状态过滤就会一条都取不到。
func LoadPendingDocumentChunks(ctx context.Context, db *sql.DB, userID, knowledgeBaseID int64, documentID *int64) ([]PendingDocumentChunkRow, error) {
	query := `select c.id, d.title, c.text, coalesce(c.context_header, '')
		from petrichor_kb_document_chunk c
		join petrichor_kb_document d on d.id = c.document_id
		where c.user_id = $1 and c.knowledge_base_id = $2 and c.embedding is null
		  and d.status in ('ready', 'partial', 'processing')
		  and c.chunk_type <> 'parent_text'`
	args := []any{userID, knowledgeBaseID}
	if documentID != nil && *documentID > 0 {
		query += " and c.document_id = $3"
		args = append(args, *documentID)
	}
	query += fmt.Sprintf(" order by c.document_id, c.chunk_index limit $%d", len(args)+1)
	args = append(args, DocumentMaxEmbedPerRequest)
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]PendingDocumentChunkRow, 0)
	for rows.Next() {
		var row PendingDocumentChunkRow
		if err := rows.Scan(&row.ID, &row.Title, &row.Text, &row.ContextHeader); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func UpdateDocumentChunkEmbedding(ctx context.Context, db *sql.DB, chunkID int64, vec []float32) error {
	_, err := db.ExecContext(ctx, "update petrichor_kb_document_chunk set embedding = $1::vector where id = $2", FormatPGVector(vec), chunkID)
	return err
}

func ClearDocumentEmbeddings(ctx context.Context, db *sql.DB, userID, knowledgeBaseID int64, documentID *int64) error {
	query := "update petrichor_kb_document_chunk set embedding = null where user_id = $1 and knowledge_base_id = $2"
	args := []any{userID, knowledgeBaseID}
	if documentID != nil && *documentID > 0 {
		query += " and document_id = $3"
		args = append(args, *documentID)
	}
	_, err := db.ExecContext(ctx, query, args...)
	return err
}

// PendingChunkQuestionRow 是待向量化的分片衍生问题。
type PendingChunkQuestionRow struct {
	ID       int64
	Title    string
	Question string
}

// QuestionSemanticRow 是问题向量的召回结果：命中的是问题，回指的是它所属的分片。
type QuestionSemanticRow struct {
	ChunkID  int64
	Question string
	Distance float64
}

// LoadPendingChunkQuestions 取出某文档下还没有向量的问题。
func LoadPendingChunkQuestions(ctx context.Context, db *sql.DB, userID, documentID int64) ([]PendingChunkQuestionRow, error) {
	const q = `select q.id, d.title, q.question
		from petrichor_kb_document_chunk_question q
		join petrichor_kb_document d on d.id = q.document_id
		where q.user_id = $1 and q.document_id = $2 and q.embedding is null
		order by q.id
		limit $3`
	rows, err := db.QueryContext(ctx, q, userID, documentID, DocumentMaxEmbedPerRequest)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]PendingChunkQuestionRow, 0)
	for rows.Next() {
		var row PendingChunkQuestionRow
		if err := rows.Scan(&row.ID, &row.Title, &row.Question); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func UpdateChunkQuestionEmbedding(ctx context.Context, db *sql.DB, questionID int64, vec []float32) error {
	_, err := db.ExecContext(ctx,
		"update petrichor_kb_document_chunk_question set embedding = $1::vector where id = $2",
		FormatPGVector(vec), questionID)
	return err
}

// SemanticSearchChunkQuestions 在问题向量上做召回。命中的问题只是入口，
// 真正返回给调用方的是它所属分片的 id。
func SemanticSearchChunkQuestions(
	ctx context.Context, db *sql.DB, userID int64, knowledgeBaseID *int64, queryVec []float32, limit int,
) ([]QuestionSemanticRow, error) {
	if limit <= 0 {
		limit = 12
	}
	query := `select q.chunk_id, q.question, (q.embedding <=> $1::vector) as distance
		from petrichor_kb_document_chunk_question q
		join petrichor_kb_document d on d.id = q.document_id
		where q.user_id = $2 and q.embedding is not null and d.status in ('ready', 'partial')`
	args := []any{FormatPGVector(queryVec), userID}
	if knowledgeBaseID != nil && *knowledgeBaseID > 0 {
		query += " and q.knowledge_base_id = $3"
		args = append(args, *knowledgeBaseID)
	}
	query += fmt.Sprintf(" order by q.embedding <=> $1::vector limit $%d", len(args)+1)
	args = append(args, limit)
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]QuestionSemanticRow, 0, limit)
	for rows.Next() {
		var row QuestionSemanticRow
		if err := rows.Scan(&row.ChunkID, &row.Question, &row.Distance); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func SemanticSearchDocumentChunks(ctx context.Context, db *sql.DB, userID int64, knowledgeBaseID *int64, queryVec []float32, limit int) ([]DocumentSemanticRow, error) {
	if limit <= 0 {
		limit = 12
	}
	query := `select c.id, (c.embedding <=> $1::vector) as distance
		from petrichor_kb_document_chunk c
		join petrichor_kb_document d on d.id = c.document_id
		where c.user_id = $2 and c.embedding is not null and d.status in ('ready', 'partial')
		  and c.chunk_type <> 'parent_text'`
	args := []any{FormatPGVector(queryVec), userID}
	if knowledgeBaseID != nil && *knowledgeBaseID > 0 {
		query += " and c.knowledge_base_id = $3"
		args = append(args, *knowledgeBaseID)
	}
	query += fmt.Sprintf(" order by c.embedding <=> $1::vector limit $%d", len(args)+1)
	args = append(args, limit)
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DocumentSemanticRow, 0, limit)
	for rows.Next() {
		var row DocumentSemanticRow
		if err := rows.Scan(&row.ChunkID, &row.Distance); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
