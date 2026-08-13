package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBDocumentFolder 是知识库内部的文件目录，不再依赖旧文档库。
type KBDocumentFolder struct{ ent.Schema }

func (KBDocumentFolder) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "petrichor_kb_document_folder"}}
}

func (KBDocumentFolder) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").Positive().Immutable().Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id"),
		field.Int64("parent_id").Optional().Nillable(),
		field.String("name").NotEmpty(),
		field.Int("sort_order").Default(0),
		field.Time("created_at").Default(time.Now).Immutable(),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (KBDocumentFolder) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "knowledge_base_id"),
		index.Fields("knowledge_base_id", "parent_id", "sort_order"),
	}
}

func (KBDocumentFolder) Edges() []ent.Edge { return nil }
