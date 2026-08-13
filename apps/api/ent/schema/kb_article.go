package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBArticle 对应表 petrichor_kb_article。
type KBArticle struct {
	ent.Schema
}

func (KBArticle) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_article"},
	}
}

func (KBArticle) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id"),
		field.Int64("node_id"),
		field.String("title").
			NotEmpty(),
		field.String("content_md").
			NotEmpty(),
		field.String("content_json").
			Optional().
			Nillable(),
		field.String("content_meta_json").
			Optional().
			Nillable(),
		field.String("public_excerpt").
			Optional().
			Nillable(),
		field.Int("reading_minutes").
			Optional().
			Nillable(),
		field.String("toc_json").
			Optional().
			Nillable(),
		field.String("public_content_hash").
			Optional().
			Nillable(),
		field.String("ai_summary").
			Optional().
			Nillable(),
		field.String("ai_summary_content_hash").
			Optional().
			Nillable(),
		field.Time("ai_summary_generated_at").
			Optional().
			Nillable(),
		field.String("mindmap_json").
			Optional().
			Nillable(),
		field.String("mindmap_content_hash").
			Optional().
			Nillable(),
		field.Time("mindmap_generated_at").
			Optional().
			Nillable(),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (KBArticle) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "knowledge_base_id"),
		index.Fields("updated_at", "id"),
		index.Fields("user_id", "created_at"),
		index.Fields("node_id").Unique(),
	}
}

func (KBArticle) Edges() []ent.Edge {
	return nil
}
