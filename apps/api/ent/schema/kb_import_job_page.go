package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// KBImportJobPage 对应表 petrichor_kb_import_job_page。
type KBImportJobPage struct {
	ent.Schema
}

func (KBImportJobPage) Annotations() []schema.Annotation {
	return []schema.Annotation{
		entsql.Annotation{Table: "petrichor_kb_import_job_page"},
	}
}

func (KBImportJobPage) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id").
			Positive().
			Immutable().
			Annotations(entsql.Annotation{Incremental: boolPtr(true)}),
		field.Int64("job_id"),
		field.Int("page_no"),
		field.String("image_key").
			Optional().
			Nillable(),
		field.String("extracted_by").
			Default("vision"),
		field.String("status").
			Default("pending"),
		field.String("markdown").
			Optional().
			Nillable(),
		field.String("error").
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

func (KBImportJobPage) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("job_id", "page_no").Unique(),
		index.Fields("job_id"),
	}
}

func (KBImportJobPage) Edges() []ent.Edge {
	return nil
}
