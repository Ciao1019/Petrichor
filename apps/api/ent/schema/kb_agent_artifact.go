package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBAgentArtifact 对应表 petrichor_kb_agent_artifact。
type KBAgentArtifact struct {
	ent.Schema
}

func (KBAgentArtifact) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_agent_artifact"},
	}
}

func (KBAgentArtifact) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("thread_id"),
		field.Int64("run_id").
			Optional().
			Nillable(),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id").
			Optional().
			Nillable(),
		field.String("artifact_type").
			NotEmpty(),
		field.String("title").
			NotEmpty(),
		field.String("payload_json").
			Optional().
			Nillable(),
		field.String("content_md").
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

func (KBAgentArtifact) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("thread_id", "updated_at"),
		index.Fields("user_id", "knowledge_base_id", "artifact_type"),
	}
}

func (KBAgentArtifact) Edges() []ent.Edge {
	return nil
}
