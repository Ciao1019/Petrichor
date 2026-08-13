package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBDocumentChunk 保存可检索的文件分片。
type KBDocumentChunk struct{ ent.Schema }

func (KBDocumentChunk) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "petrichor_kb_document_chunk"}}
}

func (KBDocumentChunk) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").Positive().Immutable().Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id"),
		field.Int64("document_id"),
		field.Int("chunk_index"),
		field.String("locator").Optional().Nillable(),
		field.Int("page").Optional().Nillable(),
		field.String("context_header").Optional().Nillable(),
		field.Int("start_offset").Optional().Nillable(),
		field.Int("end_offset").Optional().Nillable(),
		// chunk_type: "text" 是可召回的分片，"parent_text" 只用于命中后回填上下文，不做向量化。
		field.String("chunk_type").Default("text"),
		// parent_chunk_index 指向同一文档内父块的 chunk_index；无父块时为空。
		field.Int("parent_chunk_index").Optional().Nillable(),
		field.String("text").NotEmpty(),
		field.Int("char_count").Default(0),
		field.Int("token_estimate").Default(0),
		field.Time("created_at").Default(time.Now).Immutable(),
	}
}

func (KBDocumentChunk) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("document_id", "chunk_index").Unique(),
		index.Fields("knowledge_base_id"),
		// 向量化与检索只扫可召回的分片，父块靠这个索引被排除在外。
		index.Fields("knowledge_base_id", "chunk_type"),
	}
}

func (KBDocumentChunk) Edges() []ent.Edge { return nil }
