package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBDocumentSpan 是一次文档解析里的一段执行记录。
//
// 词汇沿用可观测性系统的习惯：root 是一次尝试的根、stage 是主流程阶段、
// subspan 是阶段内的子任务、generation 是包了一次模型调用的子任务。
// 前端据此把一次解析画成甘特图。
type KBDocumentSpan struct{ ent.Schema }

func (KBDocumentSpan) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "petrichor_kb_document_span"}}
}

func (KBDocumentSpan) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").Positive().Immutable().Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("document_id"),
		// attempt 从 1 开始；重新解析递增，历史尝试保留可回看。
		field.Int("attempt").Default(1),
		field.String("span_id").NotEmpty(),
		field.String("parent_span_id").Optional().Nillable(),
		field.String("name").NotEmpty(),
		field.String("kind"),
		field.String("status"),
		field.String("input").Optional().Nillable().SchemaType(map[string]string{"postgres": "jsonb"}),
		field.String("output").Optional().Nillable().SchemaType(map[string]string{"postgres": "jsonb"}),
		field.String("error_code").Optional().Nillable(),
		field.String("error_message").Optional().Nillable(),
		field.Time("started_at").Optional().Nillable(),
		field.Time("finished_at").Optional().Nillable(),
		field.Int64("duration_ms").Default(0),
		field.Time("created_at").Default(time.Now).Immutable(),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (KBDocumentSpan) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("document_id", "attempt", "span_id").Unique(),
		index.Fields("document_id", "attempt"),
	}
}

func (KBDocumentSpan) Edges() []ent.Edge { return nil }
