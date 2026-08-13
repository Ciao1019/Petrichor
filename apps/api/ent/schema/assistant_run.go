package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AssistantRun 对应表 petrichor_assistant_run。
type AssistantRun struct {
	ent.Schema
}

func (AssistantRun) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_assistant_run"},
	}
}

func (AssistantRun) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("thread_id"),
		field.String("status").
			Default("RUNNING"),
		field.Int64("model_config_id").
			Optional().
			Nillable(),
		field.String("intent_domains_json").
			Optional().
			Nillable(),
		field.String("error_code").
			Optional().
			Nillable(),
		field.Time("started_at").
			Default(time.Now).
			Immutable(),
		field.Time("finished_at").
			Optional().
			Nillable(),
	}
}

func (AssistantRun) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("thread_id", "started_at"),
	}
}

func (AssistantRun) Edges() []ent.Edge {
	return nil
}
