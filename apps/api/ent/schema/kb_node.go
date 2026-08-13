package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBNode 对应表 petrichor_kb_node。
type KBNode struct {
	ent.Schema
}

func (KBNode) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_node"},
	}
}

func (KBNode) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id"),
		field.Int64("parent_id").
			Optional().
			Nillable(),
		field.String("type").
			NotEmpty(),
		field.String("name").
			NotEmpty(),
		field.Int("sort_order").
			Default(0),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (KBNode) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "knowledge_base_id"),
		index.Fields("knowledge_base_id", "parent_id", "sort_order"),
		index.Fields("user_id", "knowledge_base_id", "sort_order", "id"),
	}
}

func (KBNode) Edges() []ent.Edge {
	return nil
}
