package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KnowledgeBase 对应表 petrichor_kb_knowledge_base。
type KnowledgeBase struct {
	ent.Schema
}

func (KnowledgeBase) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_knowledge_base"},
	}
}

func (KnowledgeBase) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.String("name").
			NotEmpty(),
		field.String("description").
			Optional().
			Nillable(),
		field.String("chunk_strategy").
			Default("auto"),
		field.Int("chunk_size").
			Default(512),
		field.Int("chunk_overlap").
			Default(80),
		field.String("chunk_separators_json").
			Optional().
			Nillable(),
		// 父子分块：小子块用于向量匹配（命中更精准），大父块回填给 LLM（上下文更完整）。
		field.Bool("enable_parent_child").
			Default(false),
		// 0 表示用 chunker 的默认值（父块 4096 / 子块 384）。
		field.Int("parent_chunk_size").
			Default(0),
		field.Int("child_chunk_size").
			Default(0),
		field.Int64("chat_model_id").
			Optional().
			Nillable(),
		field.Int64("embedding_model_id").
			Optional().
			Nillable(),
		field.Int64("rerank_model_id").
			Optional().
			Nillable(),
		field.Bool("wiki_enabled").
			Default(false),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (KnowledgeBase) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id"),
		index.Fields("user_id", "updated_at"),
	}
}

func (KnowledgeBase) Edges() []ent.Edge {
	return nil
}
