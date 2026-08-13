package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
)

// AssistantOperatorProfile 对应表 petrichor_assistant_operator_profile。
// 主键为 user_id，ent 侧映射为 id 字段。
type AssistantOperatorProfile struct {
	ent.Schema
}

func (AssistantOperatorProfile) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_assistant_operator_profile"},
	}
}

func (AssistantOperatorProfile) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			StorageKey("user_id").
			Positive().
			Immutable(),
		field.String("user_profile_md").
			Default(""),
		field.String("agent_notes_md").
			Default(""),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (AssistantOperatorProfile) Indexes() []ent.Index {
	return nil
}

func (AssistantOperatorProfile) Edges() []ent.Edge {
	return nil
}
