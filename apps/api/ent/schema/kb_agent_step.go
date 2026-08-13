package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBAgentStep 对应表 petrichor_kb_agent_step。
type KBAgentStep struct {
	ent.Schema
}

func (KBAgentStep) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_agent_step"},
	}
}

func (KBAgentStep) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("run_id"),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id").
			Optional().
			Nillable(),
		field.String("step_type").
			NotEmpty(),
		field.String("title").
			NotEmpty(),
		field.String("status").
			NotEmpty(),
		field.String("payload_json").
			Optional().
			Nillable(),
		field.Time("started_at").
			Optional().
			Nillable(),
		field.Time("finished_at").
			Optional().
			Nillable(),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
	}
}

func (KBAgentStep) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("run_id", "created_at"),
	}
}

func (KBAgentStep) Edges() []ent.Edge {
	return nil
}
