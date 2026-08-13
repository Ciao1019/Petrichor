package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AssistantStep 对应表 petrichor_assistant_step。
type AssistantStep struct {
	ent.Schema
}

func (AssistantStep) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_assistant_step"},
	}
}

func (AssistantStep) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("run_id"),
		field.Int("step_index"),
		field.String("tool_name").
			NotEmpty(),
		field.String("input_json").
			Optional().
			Nillable(),
		field.String("output_json").
			Optional().
			Nillable(),
		field.String("status").
			NotEmpty(),
		field.String("error_code").
			Optional().
			Nillable(),
		field.Int("duration_ms").
			Optional().
			Nillable(),
	}
}

func (AssistantStep) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("run_id", "step_index"),
	}
}

func (AssistantStep) Edges() []ent.Edge {
	return nil
}
