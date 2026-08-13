package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBImportJob 对应表 petrichor_kb_import_job。
type KBImportJob struct {
	ent.Schema
}

func (KBImportJob) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_import_job"},
	}
}

func (KBImportJob) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id"),
		field.Int64("parent_node_id").
			Optional().
			Nillable(),
		field.String("source_type").
			NotEmpty(),
		field.String("file_name").
			NotEmpty(),
		field.String("source_key").
			Optional().
			Nillable(),
		field.String("title").
			NotEmpty(),
		field.Int("total_pages").
			Default(0),
		field.Int("processed_pages").
			Default(0),
		field.String("status").
			Default("pending"),
		field.Int64("model_config_id").
			Optional().
			Nillable(),
		field.Int64("article_id").
			Optional().
			Nillable(),
		field.String("error").
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

func (KBImportJob) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "created_at"),
		index.Fields("user_id", "knowledge_base_id"),
	}
}

func (KBImportJob) Edges() []ent.Edge {
	return nil
}
