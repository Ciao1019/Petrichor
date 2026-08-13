package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// User 对应表 petrichor_user。
type User struct {
	ent.Schema
}

func (User) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_user"},
	}
}

func (User) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}).
			Comment("主键，由 Postgres identity 生成"),
		field.String("email").
			NotEmpty(),
		field.String("password_hash").
			Default(""),
		field.String("system_role").
			Default("USER"),
		field.String("user_type").
			Default("LOCAL"),
		field.String("linux_do_account_id").
			Optional().
			Nillable().
			StorageKey("linuxdo_account_id"),
		field.String("linux_do_username").
			Optional().
			Nillable().
			StorageKey("linuxdo_username"),
		field.String("linux_do_email").
			Optional().
			Nillable().
			StorageKey("linuxdo_email"),
		field.String("username").
			Optional().
			Nillable(),
		field.String("nickname").
			Optional().
			Nillable(),
		field.String("avatar").
			Optional().
			Nillable(),
		field.String("signature").
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

func (User) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("email").Unique(),
		index.Fields("linux_do_account_id").Unique(),
	}
}

func (User) Edges() []ent.Edge {
	return nil
}
