package kb

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/joho/godotenv"
	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikipage"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/db"
)

func TestRepairCurrentWikiTaxonomy(t *testing.T) {
	if os.Getenv("PETRICHOR_REPAIR_WIKI_TAXONOMY") != "1" {
		t.Skip("仅供本地目录修复")
	}
	for _, envFile := range []string{"../../.env", "../../.env.local"} {
		_ = godotenv.Load(envFile)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.Open(cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	kbRow, err := conn.Ent.KnowledgeBase.Get(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	modelCfg, err := ai.ResolveChatConfigByID(ctx, conn.Ent, kbRow.UserID, kbRow.ChatModelID)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := conn.Ent.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(kbRow.UserID),
		kbwikipage.KnowledgeBaseIDEQ(kbRow.ID),
		kbwikipage.ArchivedAtIsNil(),
		kbwikipage.KindIn("entity", "concept"),
	).All(ctx)
	if err != nil {
		t.Fatal(err)
	}
	items := make([]wikiTaxonomyItem, 0, len(rows))
	byKey := make(map[string]int64, len(rows))
	for _, row := range rows {
		about := ""
		if row.Summary != nil {
			about = *row.Summary
		}
		if about == "" {
			about = markdownToPlainText(row.ContentMd)
		}
		items = append(items, wikiTaxonomyItem{pageKey: row.PageKey, title: row.Title, kind: row.Kind, about: about})
		byKey[row.PageKey] = row.ID
	}
	log, err := zap.NewDevelopment()
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(conn.Ent, conn.SQL, log, cfg)
	planned, warnings := service.planWikiTaxonomyFromExisting(ctx, modelCfg, kbRow.ID, items, nil)
	if len(warnings) > 0 {
		t.Fatalf("新模型目录规划发生降级，保留原目录：%v", warnings)
	}
	if len(planned) != len(items) {
		t.Fatalf("新模型只规划了 %d/%d 页，保留原目录", len(planned), len(items))
	}

	tx, err := conn.Ent.Tx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	for key, path := range planned {
		if len(path) == 0 || isWikiTaxonomyFallbackPath(path) {
			t.Fatalf("页面 %s 没有有效目录，保留原目录", key)
		}
		raw, marshalErr := json.Marshal(path)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if _, updateErr := tx.KBWikiPage.UpdateOneID(byKey[key]).SetCategoryPathJSON(string(raw)).Save(ctx); updateErr != nil {
			t.Fatal(updateErr)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	t.Logf("model=%s replanned=%d", modelCfg.Model, len(planned))
}
