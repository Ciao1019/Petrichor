package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AssistantConfirmation 对应表 petrichor_assistant_confirmation。
type AssistantConfirmation struct {
	ent.Schema
}

func (AssistantConfirmation) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_assistant_confirmation"},
	}
}

func (AssistantConfirmation) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.String("confirmation_key").
			NotEmpty(),
		field.Int64("thread_id"),
		field.Int64("user_id"),
		field.String("tool_name").
			NotEmpty(),
		field.String("input_json").
			NotEmpty(),
		field.String("status").
			Default("pending"),
		field.Time("consumed_at").
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

func (AssistantConfirmation) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("confirmation_key").Unique(),
		index.Fields("thread_id", "user_id", "status"),
	}
}

func (AssistantConfirmation) Edges() []ent.Edge {
	return nil
}
