package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AssistantPlan 对应表 petrichor_assistant_plan。
type AssistantPlan struct {
	ent.Schema
}

func (AssistantPlan) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_assistant_plan"},
	}
}

func (AssistantPlan) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("thread_id"),
		field.Int64("user_id"),
		field.String("plan_key").
			NotEmpty(),
		field.String("title").
			NotEmpty(),
		field.String("description").
			Optional().
			Nillable(),
		field.String("todos_json").
			NotEmpty(),
		field.String("status").
			Default("active"),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (AssistantPlan) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("thread_id", "plan_key").Unique(),
		index.Fields("thread_id", "updated_at"),
	}
}

func (AssistantPlan) Edges() []ent.Edge {
	return nil
}
