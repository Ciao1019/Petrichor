package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
)

// SiteAboutProfile 对应表 petrichor_site_about_profile。
// 主键为固定整型 id，非 Postgres identity。
type SiteAboutProfile struct {
	ent.Schema
}

func (SiteAboutProfile) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_site_about_profile"},
	}
}

func (SiteAboutProfile) Fields() []ent.Field {
	return []ent.Field{
		field.Int("id").
			Positive().
			Immutable(),
		field.String("display_name").
			Default("CiZai"),
		field.String("role_title").
			Default("Creative Dev & Visual Artist"),
		field.String("intro").
			Default("我是 CiZai，是一个普普通通的程序员。\n\n目前就职于金山办公\n\n我的兴趣主要在 Coding / AI 方向。\n\n我喜欢 Minecraft。"),
		field.String("expertise_json").
			Default("[\"Frontend Architecture\",\"AI 应用开发\",\"Knowledge Systems\",\"Creative Coding\"]"),
		field.String("toolkit_json").
			Default("[\"TypeScript\",\"React\",\"Next.js\",\"AI\",\"PostgreSQL\",\"Minecraft\"]"),
		field.String("quote").
			Default("Code is just another medium for painting dreams."),
		field.String("accents_json").
			Default(`[{"phrase":"CiZai","style":"red","note":"yep, that's me"},{"phrase":"程序员","style":"green","note":"just a dev"},{"phrase":"金山办公","style":"blue","note":"where I work"},{"phrase":"Coding / AI","style":"green","note":"my playground"},{"phrase":"Minecraft","style":"blue","note":"★ my comfort game"}]`),
		field.String("contact_text").
			Default("想聊点什么？随时"),
		field.String("contact_label").
			Default("message me"),
		field.String("contact_href").
			Default("mailto:zang@linux.do"),
		field.Time("created_at").
			Default(time.Now).
			Immutable(),
		field.Time("updated_at").
			Default(time.Now).
			UpdateDefault(time.Now),
	}
}

func (SiteAboutProfile) Indexes() []ent.Index {
	return nil
}

func (SiteAboutProfile) Edges() []ent.Edge {
	return nil
}
