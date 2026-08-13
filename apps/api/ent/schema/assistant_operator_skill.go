package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AssistantOperatorSkill 对应表 petrichor_assistant_operator_skill。
type AssistantOperatorSkill struct {
	ent.Schema
}

func (AssistantOperatorSkill) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_assistant_operator_skill"},
	}
}

func (AssistantOperatorSkill) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.String("name").
			NotEmpty(),
		field.String("description").
			NotEmpty(),
		field.String("body_md").
			NotEmpty(),
		field.Int("version").
			Default(1),
		field.String("status").
			Default("active"),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (AssistantOperatorSkill) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "name").Unique(),
		index.Fields("user_id", "status"),
	}
}

func (AssistantOperatorSkill) Edges() []ent.Edge {
	return nil
}
