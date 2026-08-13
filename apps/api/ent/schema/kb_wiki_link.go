package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBWikiLink 对应表 petrichor_kb_wiki_link。
type KBWikiLink struct {
	ent.Schema
}

func (KBWikiLink) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_wiki_link"},
	}
}

func (KBWikiLink) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id"),
		field.Int64("from_page_id"),
		field.String("to_page_key").
			NotEmpty(),
		field.String("link_type").
			Default("related"),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
	}
}

func (KBWikiLink) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("from_page_id"),
		index.Fields("user_id", "knowledge_base_id", "to_page_key"),
	}
}

func (KBWikiLink) Edges() []ent.Edge {
	return nil
}
