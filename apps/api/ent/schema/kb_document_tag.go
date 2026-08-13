package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBDocumentTag 是知识库文档上的标签，上传时批量指定，文档列表按它筛选。
type KBDocumentTag struct{ ent.Schema }

func (KBDocumentTag) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "petrichor_kb_document_tag"}}
}

func (KBDocumentTag) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").Positive().Immutable().Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id"),
		field.Int64("document_id"),
		field.String("tag").NotEmpty(),
		field.Time("created_at").Default(time.Now).Immutable(),
	}
}

func (KBDocumentTag) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("document_id", "tag").Unique(),
		index.Fields("knowledge_base_id", "tag"),
	}
}

func (KBDocumentTag) Edges() []ent.Edge { return nil }
