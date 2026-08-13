package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AgentCallLog 对应表 petrichor_agent_call_log。
type AgentCallLog struct {
	ent.Schema
}

func (AgentCallLog) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_agent_call_log"},
	}
}

func (AgentCallLog) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("api_key_id"),
		field.String("api_key_prefix").
			NotEmpty(),
		field.String("method").
			NotEmpty(),
		field.String("path").
			NotEmpty(),
		field.String("ip").
			Optional().
			Nillable(),
		field.String("user_agent").
			Optional().
			Nillable(),
		field.String("request_json").
			Optional().
			Nillable(),
		field.String("response_json").
			Optional().
			Nillable(),
		field.Int("status_code"),
		field.Int("duration_ms"),
		field.String("error_message").
			Optional().
			Nillable(),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
	}
}

func (AgentCallLog) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "created_at"),
		index.Fields("api_key_id", "created_at"),
	}
}

func (AgentCallLog) Edges() []ent.Edge {
	return nil
}
