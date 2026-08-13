package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AuthSession 对应表 petrichor_auth_session。
type AuthSession struct {
	ent.Schema
}

func (AuthSession) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_auth_session"},
	}
}

func (AuthSession) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.String("token_hash").
			NotEmpty(),
		field.Int64("user_id"),
		field.String("device_info").
			Optional().
			Nillable(),
		field.String("ip").
			Optional().
			Nillable(),
		field.String("user_agent").
			Optional().
			Nillable(),
		field.Time("expires_at"),
		field.Time("last_seen_at").
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

func (AuthSession) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("token_hash").Unique(),
		index.Fields("user_id", "revoked_at"),
		index.Fields("expires_at"),
	}
}

func (AuthSession) Edges() []ent.Edge {
	return nil
}
