package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AgentMemory 对应表 petrichor_agent_memory。
// 注意：embedding 向量列通过迁移单独添加，走原生 SQL 读写，故意不在 ent schema 声明。
type AgentMemory struct {
	ent.Schema
}

func (AgentMemory) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_agent_memory"},
	}
}

func (AgentMemory) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.String("kind").
			NotEmpty(),
		field.String("content").
			NotEmpty(),
		field.Int("evidence_count").
			Default(1),
		field.Time("last_seen_at").
			Default(time.Now),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (AgentMemory) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "last_seen_at"),
	}
}

func (AgentMemory) Edges() []ent.Edge {
	return nil
}
