package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBArticleBurnLink 对应表 petrichor_kb_article_burn_link（阅后即焚链接）。
type KBArticleBurnLink struct {
	ent.Schema
}

func (KBArticleBurnLink) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_article_burn_link"},
	}
}

func (KBArticleBurnLink) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("article_id"),
		field.String("link_code").
			NotEmpty(),
		field.Int("max_views").
			Default(1),
		field.Int("view_count").
			Default(0),
		field.String("password_hash").
			Optional().
			Nillable(),
		field.Time("expires_at").
			Optional().
			Nillable(),
		field.String("status").
			Default("ACTIVE"),
		field.Time("burned_at").
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

func (KBArticleBurnLink) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("link_code").Unique(),
		index.Fields("user_id", "article_id", "created_at"),
	}
}

func (KBArticleBurnLink) Edges() []ent.Edge {
	return nil
}
