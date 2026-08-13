package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBDocument 是知识库中的原始文件及解析状态。
type KBDocument struct{ ent.Schema }

func (KBDocument) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "petrichor_kb_document"}}
}

func (KBDocument) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").Positive().Immutable().Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id"),
		field.Int64("folder_id").Optional().Nillable(),
		field.String("file_name").NotEmpty(),
		field.String("title").NotEmpty(),
		field.String("file_type").NotEmpty(),
		field.String("content_type").Optional().Nillable(),
		field.String("object_key").NotEmpty(),
		field.Int64("size_bytes").Optional().Nillable(),
		field.Int("page_count").Optional().Nillable(),
		field.Int("char_count").Optional().Nillable(),
		field.Int("chunk_count").Default(0),
		field.String("status").Default("pending"),
		field.String("blocks_json").Optional().Nillable(),
		field.String("extracted_text").Optional().Nillable(),
		// segments_json 记录正文里页码/工作表的边界，重新分块时无需客户端再传一遍。
		field.String("segments_json").Optional().Nillable(),
		field.String("summary").Optional().Nillable(),
		field.String("error").Optional().Nillable(),
		// 本次解析用的配置快照（解析引擎 / 分块 / 图像处理 / AI 问题生成），重新解析时沿用。
		field.String("parse_config_json").Optional().Nillable(),
		// 解析尝试号，从 1 开始；span 按 attempt 分支保存，0 表示还没跑过流水线。
		field.Int("parse_attempt").Default(0),
		field.Time("created_at").Default(time.Now).Immutable(),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (KBDocument) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "knowledge_base_id"),
		index.Fields("knowledge_base_id", "folder_id"),
		index.Fields("user_id", "status"),
	}
}

func (KBDocument) Edges() []ent.Edge { return nil }
