package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
)

// AgentMemoryState 对应表 petrichor_agent_memory_state。
// 主键为 user_id，ent 侧映射为 id 字段。
type AgentMemoryState struct {
	ent.Schema
}

func (AgentMemoryState) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_agent_memory_state"},
	}
}

func (AgentMemoryState) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			StorageKey("user_id").
			Positive().
			Immutable(),
		field.Time("last_distilled_at").
			Optional().
			Nillable(),
		field.Int64("last_message_id").
			Default(0),
		field.Int64("last_assistant_message_id").
			Default(0),
		field.Int("distill_count").
			Default(0),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (AgentMemoryState) Indexes() []ent.Index {
	return nil
}

func (AgentMemoryState) Edges() []ent.Edge {
	return nil
}
