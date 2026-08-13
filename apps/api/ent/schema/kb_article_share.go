package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBArticleShare 对应表 petrichor_kb_article_share。
type KBArticleShare struct {
	ent.Schema
}

func (KBArticleShare) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_article_share"},
	}
}

func (KBArticleShare) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("article_id"),
		field.String("share_code").
			NotEmpty(),
		field.Bool("enabled").
			Default(true),
		field.Time("expires_at").
			Optional().
			Nillable(),
		field.String("password_hash").
			Optional().
			Nillable(),
		field.Bool("is_repost").
			Default(false),
		field.String("original_url").
			Optional().
			Nillable(),
		field.String("original_author_name").
			Optional().
			Nillable(),
		field.String("internal_url").
			Optional().
			Nillable(),
		field.Int("pin_order").
			Optional().
			Nillable(),
		field.Time("revoked_at").
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

func (KBArticleShare) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("article_id").Unique(),
		index.Fields("share_code").Unique(),
		index.Fields("enabled", "revoked_at", "article_id"),
		index.Fields("user_id"),
		index.Fields("pin_order"),
	}
}

func (KBArticleShare) Edges() []ent.Edge {
	return nil
}
