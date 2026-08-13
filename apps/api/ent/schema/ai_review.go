package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AIReview 对应表 petrichor_ai_review。
type AIReview struct {
	ent.Schema
}

func (AIReview) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_ai_review"},
	}
}

func (AIReview) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.String("period").
			NotEmpty(),
		field.String("period_key").
			NotEmpty(),
		field.Time("period_start"),
		field.Time("period_end"),
		field.String("stats_json").
			NotEmpty(),
		field.String("narrative").
			NotEmpty(),
		field.Int64("model_config_id").
			Optional().
			Nillable(),
		field.Int("regenerate_count").
			Default(0),
		field.Time("last_regenerated_at").
			Optional().
			Nillable(),
		field.Time("generated_at").
			Default(time.Now),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (AIReview) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "period", "period_key").Unique(),
		index.Fields("user_id", "generated_at"),
	}
}

func (AIReview) Edges() []ent.Edge {
	return nil
}
