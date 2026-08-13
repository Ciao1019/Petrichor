package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBDocumentChunkQuestion 是 AI 为某个分片生成的检索用问题。
//
// 每条问题单独向量化（embedding 列由迁移脚本维护，不进 ent），
// 命中后回指 chunk_id，把召回入口从"正文相似"扩展到"用户会怎么问"。
type KBDocumentChunkQuestion struct{ ent.Schema }

func (KBDocumentChunkQuestion) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "petrichor_kb_document_chunk_question"}}
}

func (KBDocumentChunkQuestion) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").Positive().Immutable().Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id"),
		field.Int64("document_id"),
		field.Int64("chunk_id"),
		field.String("question").NotEmpty(),
		field.Time("created_at").Default(time.Now).Immutable(),
	}
}

func (KBDocumentChunkQuestion) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("chunk_id"),
		index.Fields("document_id"),
	}
}

func (KBDocumentChunkQuestion) Edges() []ent.Edge { return nil }
