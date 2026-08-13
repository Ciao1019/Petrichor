package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBWikiIngestJob 持久化 Wiki 构建任务，避免模型生成占用 HTTP 请求生命周期。
type KBWikiIngestJob struct{ ent.Schema }

func (KBWikiIngestJob) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "petrichor_kb_wiki_ingest_job"}}
}

func (KBWikiIngestJob) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").Positive().Immutable().Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("user_id"),
		field.Int64("knowledge_base_id"),
		// kind 区分任务类型："ingest" 从文档构建 Wiki；"cleanup" 在文档被删除后重整 Wiki。
		// 两者都会触发逐页 Reduce（含模型调用），必须走同一个后台队列而不是同步执行。
		field.String("kind").Default("ingest"),
		field.String("document_ids_json").Default("[]"),
		field.Bool("force_rebuild").Default(false),
		field.String("status").Default("pending"),
		field.Int("total_documents").Default(0),
		field.Int("processed_documents").Default(0),
		field.String("phase").Default("queued"),
		field.String("current_document").Optional().Nillable(),
		field.Int("total_pages").Default(0),
		field.Int("processed_pages").Default(0),
		field.String("warnings_json").Default("[]"),
		field.String("error").Optional().Nillable(),
		field.Time("available_at").Default(time.Now),
		field.Time("started_at").Optional().Nillable(),
		field.Time("finished_at").Optional().Nillable(),
		field.Time("created_at").Default(time.Now).Immutable(),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (KBWikiIngestJob) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("status", "available_at"),
		index.Fields("user_id", "knowledge_base_id", "created_at"),
	}
}

func (KBWikiIngestJob) Edges() []ent.Edge { return nil }
