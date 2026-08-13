package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBWikiPage 对应表 petrichor_kb_wiki_page。
type KBWikiPage struct {
	ent.Schema
}

func (KBWikiPage) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_wiki_page"},
	}
}

func (KBWikiPage) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id"),
		field.String("page_key").
			NotEmpty(),
		field.String("title").
			NotEmpty(),
		field.String("kind").
			NotEmpty(),
		field.String("content_md").
			NotEmpty(),
		field.String("frontmatter_json").
			Optional().
			Nillable(),
		field.String("summary").
			Optional().
			Nillable(),
		field.String("content_hash").
			NotEmpty(),
		// category_path_json 是页面在 Wiki 目录树中的层级路径（JSON 字符串数组，
		// 例如 ["软件","命令行工具"]）。空数组表示挂在根目录下。
		field.String("category_path_json").
			Optional().
			Nillable(),
		// sort_order 控制同级页面的排序，值相同时回退到标题排序。
		field.Int("sort_order").
			Default(0),
		field.Int("version").
			Default(1),
		field.Time("archived_at").
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

func (KBWikiPage) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "knowledge_base_id", "page_key").Unique(),
		index.Fields("user_id", "knowledge_base_id", "kind"),
		index.Fields("user_id", "knowledge_base_id", "updated_at"),
	}
}

func (KBWikiPage) Edges() []ent.Edge {
	return nil
}
