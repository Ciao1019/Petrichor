package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBAgentThread 对应表 petrichor_kb_agent_thread。
type KBAgentThread struct {
	ent.Schema
}

func (KBAgentThread) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_agent_thread"},
	}
}

func (KBAgentThread) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id").
			Optional().
			Nillable(),
		field.String("title").
			NotEmpty(),
		field.String("status").
			Default("ACTIVE"),
		field.Time("last_message_at").
			Optional().
			Nillable(),
		field.String("metadata_json").
			Optional().
			Nillable(),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (KBAgentThread) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "knowledge_base_id", "updated_at"),
		index.Fields("user_id", "updated_at"),
		index.Fields("user_id", "updated_at", "id"),
		index.Fields("user_id", "knowledge_base_id", "updated_at", "id"),
		index.Fields("user_id", "created_at"),
	}
}

func (KBAgentThread) Edges() []ent.Edge {
	return nil
}
