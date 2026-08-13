package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBArticleTag 对应表 petrichor_kb_article_tag。
type KBArticleTag struct {
	ent.Schema
}

func (KBArticleTag) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_article_tag"},
	}
}

func (KBArticleTag) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("article_id"),
		field.String("tag").
			NotEmpty(),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
	}
}

func (KBArticleTag) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("article_id", "tag").Unique(),
		index.Fields("article_id"),
	}
}

func (KBArticleTag) Edges() []ent.Edge {
	return nil
}
