package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AssistantThread 对应表 petrichor_assistant_thread。
type AssistantThread struct {
	ent.Schema
}

func (AssistantThread) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_assistant_thread"},
	}
}

func (AssistantThread) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.String("title").
			NotEmpty(),
		field.String("focus_json").
			Optional().
			Nillable(),
		field.String("context_summary_md").
			Optional().
			Nillable(),
		field.Int64("context_summary_until_message_id").
			Optional().
			Nillable(),
		field.Time("context_summary_updated_at").
			Optional().
			Nillable(),
		field.String("danger_allowlist_json").
			Optional().
			Nillable(),
		field.String("operator_memory_snapshot_json").
			Optional().
			Nillable(),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
		field.Time("deleted_at").
			Optional().
			Nillable(),
	}
}

func (AssistantThread) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "updated_at", "id"),
	}
}

func (AssistantThread) Edges() []ent.Edge {
	return nil
}
