package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
)

// SiteProjectShowcase 对应表 petrichor_site_project_showcase。
// 主键为固定整型 id，非 Postgres identity。
type SiteProjectShowcase struct {
	ent.Schema
}

func (SiteProjectShowcase) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_site_project_showcase"},
	}
}

func (SiteProjectShowcase) Fields() []ent.Field {
	return []ent.Field{
		field.Int("id").
			Positive().
			Immutable(),
		field.String("heading").
			Default("开源项目"),
		field.String("intro").
			Default(""),
		field.String("items_json").
			Default(`[{"name":"Ech0 — self-hosted microblog","year":"2025","stack":["Go","Vue"],"stamp":"popular","stampColor":"red","blurb":"An open-source, self-hosted space for publishing and sharing your thoughts — your own little corner of the web.","repoUrl":"https://github.com/lin-snow/Ech0","siteUrl":"https://ech0.app"},{"name":"Dox — todos in terminal","year":"2026","stack":["Go","TypeScript"],"stamp":"new","stampColor":"blue","blurb":"More than a todo list: a terminal-first task manager. TUI by default, CLI for scripts — projects, an inbox, markdown notes, full-text search and multi-user invites, all from one container and a single SQLite file.","repoUrl":"https://github.com/lin-snow/dox"},{"name":"Kemate — a Vercel-like PaaS","year":"2026","stack":["Go"],"stamp":"WIP","stampColor":"green","blurb":"A platform-as-a-service taking aim at the likes of Vercel, built on a microservice architecture."}]`),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (SiteProjectShowcase) Indexes() []ent.Index {
	return nil
}

func (SiteProjectShowcase) Edges() []ent.Edge {
	return nil
}
