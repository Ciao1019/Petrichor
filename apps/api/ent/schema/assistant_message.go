package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AssistantMessage 对应表 petrichor_assistant_message。
type AssistantMessage struct {
	ent.Schema
}

func (AssistantMessage) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_assistant_message"},
	}
}

func (AssistantMessage) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("thread_id"),
		field.String("role").
			NotEmpty(),
		field.String("content_json").
			Optional().
			Nillable(),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
	}
}

func (AssistantMessage) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("thread_id", "created_at", "id"),
	}
}

func (AssistantMessage) Edges() []ent.Edge {
	return nil
}
