package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBAgentRun 对应表 petrichor_kb_agent_run。
type KBAgentRun struct {
	ent.Schema
}

func (KBAgentRun) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_agent_run"},
	}
}

func (KBAgentRun) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("thread_id"),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id").
			Optional().
			Nillable(),
		field.String("status").
			Default("RUNNING"),
		field.String("model_name").
			Optional().
			Nillable(),
		field.String("error_message").
			Optional().
			Nillable(),
		field.Time("started_at").
			Default(time.Now).
			Immutable(),
		field.Time("finished_at").
			Optional().
			Nillable(),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
	}
}

func (KBAgentRun) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("thread_id", "created_at"),
	}
}

func (KBAgentRun) Edges() []ent.Edge {
	return nil
}
