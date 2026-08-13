package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AssistantArtifact 对应表 petrichor_assistant_artifact。
type AssistantArtifact struct {
	ent.Schema
}

func (AssistantArtifact) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_assistant_artifact"},
	}
}

func (AssistantArtifact) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("thread_id"),
		field.Int64("run_id").
			Optional().
			Nillable(),
		field.String("kind").
			NotEmpty(),
		field.String("title").
			NotEmpty(),
		field.String("content_json").
			Optional().
			Nillable(),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
	}
}

func (AssistantArtifact) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("thread_id", "created_at"),
	}
}

func (AssistantArtifact) Edges() []ent.Edge {
	return nil
}
