package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
)

// SiteAppearance 对应表 petrichor_site_appearance。
// 主键为固定整型 id，非 Postgres identity。
type SiteAppearance struct {
	ent.Schema
}

func (SiteAppearance) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_site_appearance"},
	}
}

func (SiteAppearance) Fields() []ent.Field {
	return []ent.Field{
		field.Int("id").
			Positive().
			Immutable(),
		field.Bool("public_qa_enabled").
			Default(true),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (SiteAppearance) Indexes() []ent.Index {
	return nil
}

func (SiteAppearance) Edges() []ent.Edge {
	return nil
}
