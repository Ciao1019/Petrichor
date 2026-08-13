package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBAgentMessage 对应表 petrichor_kb_agent_message。
type KBAgentMessage struct {
	ent.Schema
}

func (KBAgentMessage) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_agent_message"},
	}
}

func (KBAgentMessage) Fields() []ent.Field {
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
		field.String("role").
			NotEmpty(),
		field.String("content_text").
			Default(""),
		field.String("content_json").
			Optional().
			Nillable(),
		field.String("metadata_json").
			Optional().
			Nillable(),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
	}
}

func (KBAgentMessage) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("thread_id", "created_at"),
		index.Fields("thread_id", "created_at", "id"),
	}
}

func (KBAgentMessage) Edges() []ent.Edge {
	return nil
}
