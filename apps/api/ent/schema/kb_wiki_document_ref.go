package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBWikiDocumentRef 记录 Wiki 页面来自哪些文件和分片。
type KBWikiDocumentRef struct{ ent.Schema }

func (KBWikiDocumentRef) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "petrichor_kb_wiki_document_ref"}}
}

func (KBWikiDocumentRef) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").Positive().Immutable().Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("page_id"),
		field.Int64("document_id"),
		field.String("chunk_indexes_json").Optional().Nillable(),
		field.String("note").Optional().Nillable(),
		field.Time("created_at").Default(time.Now).Immutable(),
	}
}

func (KBWikiDocumentRef) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("page_id"),
		index.Fields("document_id"),
		index.Fields("page_id", "document_id").Unique(),
	}
}

func (KBWikiDocumentRef) Edges() []ent.Edge { return nil }
