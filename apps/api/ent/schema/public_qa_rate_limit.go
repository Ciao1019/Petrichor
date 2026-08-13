package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// PublicQARateLimit 对应表 petrichor_public_qa_rate_limit。
type PublicQARateLimit struct {
	ent.Schema
}

func (PublicQARateLimit) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_public_qa_rate_limit"},
	}
}

func (PublicQARateLimit) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.String("bucket_key").
			NotEmpty(),
		field.Int("count").
			Default(0),
		field.Time("window_started_at").
			Default(time.Now),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (PublicQARateLimit) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("bucket_key").Unique(),
	}
}

func (PublicQARateLimit) Edges() []ent.Edge {
	return nil
}
