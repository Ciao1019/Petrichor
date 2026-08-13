package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AIModelConfig 对应表 petrichor_ai_model_config，供 Assistant/Agent 取模型。
type AIModelConfig struct {
	ent.Schema
}

func (AIModelConfig) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_ai_model_config"},
	}
}

func (AIModelConfig) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.String("config_type").
			NotEmpty(),
		field.String("protocol").
			NotEmpty(),
		field.String("name").
			NotEmpty(),
		field.String("base_url").
			Optional().
			Nillable(),
		field.String("api_key_enc").
			Optional().
			Nillable(),
		field.String("model").
			NotEmpty(),
		field.Bool("enabled").
			Default(true),
		field.Bool("is_default").
			Default(false),
		field.String("extra_json").
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

func (AIModelConfig) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "config_type"),
		index.Fields("user_id", "config_type", "name").Unique(),
	}
}

func (AIModelConfig) Edges() []ent.Edge {
	return nil
}
