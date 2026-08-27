package assistantsvc

import (
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

func TestStoreTextReturnsPGXEncodableStrings(t *testing.T) {
	t.Parallel()

	values := []struct {
		name      string
		converted any
	}{
		{name: "complexity", converted: storeText(rt.ComplexitySimple)},
		{name: "status", converted: storeText(rt.StatusCompleted)},
		{name: "stop reason", converted: storeText(rt.StopGoalCompleted)},
		{name: "evidence source", converted: storeText(rt.EvidenceKnowledge)},
	}

	typeMap := pgtype.NewMap()
	for _, item := range values {
		item := item
		t.Run(item.name, func(t *testing.T) {
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
