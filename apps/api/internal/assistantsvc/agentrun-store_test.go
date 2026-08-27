package assistantsvc

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

func TestStoreTextMakesRuntimeEnumsEncodableByPGXExec(t *testing.T) {
	t.Parallel()

	values := []struct {
		name      string
		raw       any
		converted any
	}{
		{name: "complexity", raw: rt.ComplexitySimple, converted: storeText(rt.ComplexitySimple)},
		{name: "status", raw: rt.StatusCompleted, converted: storeText(rt.StatusCompleted)},
		{name: "stop reason", raw: rt.StopGoalCompleted, converted: storeText(rt.StopGoalCompleted)},
		{name: "evidence source", raw: rt.EvidenceKnowledge, converted: storeText(rt.EvidenceKnowledge)},
	}

	typeMap := pgtype.NewMap()
	for _, item := range values {
		item := item
		t.Run(item.name, func(t *testing.T) {
			var rawBuilder pgx.ExtendedQueryBuilder
			if err := rawBuilder.Build(typeMap, nil, []any{item.raw}); err == nil || !strings.Contains(err.Error(), "cannot use unregistered type") {
				t.Fatalf("test must reproduce QueryExecModeExec failure for raw %T, got %v", item.raw, err)
			}
			if _, ok := item.converted.(string); !ok {
				t.Fatalf("database argument must be a native string, got %T", item.converted)
			}
			var convertedBuilder pgx.ExtendedQueryBuilder
			if err := convertedBuilder.Build(typeMap, nil, []any{item.converted}); err != nil {
				t.Fatalf("pgx QueryExecModeExec cannot encode %T: %v", item.converted, err)
			}
		})
	}
}
