package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AgentAPIKey 对应表 petrichor_agent_api_key。
type AgentAPIKey struct {
	ent.Schema
}

func (AgentAPIKey) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_agent_api_key"},
	}
}

func (AgentAPIKey) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.String("name").
			NotEmpty(),
		field.String("key_hash").
			NotEmpty(),
		field.String("key_prefix").
			NotEmpty(),
		field.String("scopes_json").
			Default("[]"),
		field.Time("expires_at").
			Optional().
			Nillable(),
		field.Time("last_used_at").
			Optional().
			Nillable(),
		field.Time("revoked_at").
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

func (AgentAPIKey) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("key_hash").Unique(),
		index.Fields("user_id", "revoked_at", "created_at"),
	}
}

func (AgentAPIKey) Edges() []ent.Edge {
	return nil
}
