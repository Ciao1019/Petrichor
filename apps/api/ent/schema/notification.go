package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Notification 对应表 petrichor_notification。
type Notification struct {
	ent.Schema
}

func (Notification) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_notification"},
	}
}

func (Notification) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.String("category").
			NotEmpty(),
		field.String("biz_type").
			NotEmpty(),
		field.Int64("biz_id"),
		field.String("title").
			NotEmpty(),
		field.String("content").
			NotEmpty(),
		field.String("payload_json").
			Optional().
			Nillable(),
		field.Time("read_at").
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

func (Notification) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "read_at"),
		index.Fields("user_id", "created_at"),
		index.Fields("user_id", "category"),
		index.Fields("user_id", "biz_type", "biz_id"),
	}
}

func (Notification) Edges() []ent.Edge {
	return nil
}
