package publicscope

import (
	"context"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"petrichor/api/internal/config"
)

// 只读事务 + CTE 测试数据，不建表、不读取或改动业务内容。
func TestPublicWikiVisibilityMatrixLive(t *testing.T) {
	if os.Getenv("PETRICHOR_PUBLIC_WIKI_LIVE_TEST") != "1" {
		t.Skip("设置 PETRICHOR_PUBLIC_WIKI_LIVE_TEST=1 运行 PostgreSQL 只读可见性测试")
	}
	cfg, err := config.Initialize()
	if err != nil {
		t.Fatal("无法加载本地数据库配置")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	connConfig, err := pgx.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		t.Fatal("数据库配置无效")
	}
	connConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	conn, err := pgx.ConnectConfig(ctx, connConfig)
	if err != nil {
		t.Fatal("无法连接数据库")
	}
	defer conn.Close(ctx)
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal("无法开启只读事务")
	}
	defer tx.Rollback(ctx)
	const fixtures = `WITH
	 petrichor_kb_article_share(article_id, enabled, revoked_at, password_hash, expires_at, share_code) AS (VALUES
	   (1::bigint, true, NULL::timestamptz, NULL::text, NULL::timestamptz, 'public'),
	   (2, true, NULL, NULL, now() + interval '1 day', 'public-2'),
	   (3, false, NULL, NULL, NULL, 'disabled'),
	   (4, true, now(), NULL, NULL, 'revoked'),
	   (5, true, NULL, 'password', NULL, 'locked'),
	   (6, true, NULL, NULL, now() - interval '1 second', 'expired'),
	   (7, true, NULL, NULL, NULL, ' ')
	 ), petrichor_kb_wiki_page(id, knowledge_base_id, kind, archived_at) AS (VALUES
	   (11::bigint, 1::bigint, 'source', NULL::timestamptz),
	   (12, 2, 'concept', NULL),
	   (13, 1, 'concept', NULL),
	   (14, 1, 'concept', NULL),
	   (15, 1, 'concept', NULL),
	   (16, 1, 'concept', NULL),
	   (17, 1, 'concept', NULL),
	   (18, 1, 'concept', NULL),
	   (19, 1, 'concept', NULL),
	   (20, 1, 'index', NULL),
	   (21, 1, 'log', NULL),
	   (22, 1, 'concept', now()),
	   (23, 1, 'entity', NULL)
	 ), petrichor_kb_wiki_source_ref(page_id, article_id) AS (VALUES
	   (11::bigint, 1::bigint), (12, 1), (12, 2),
	   (13, 1), (13, 99), (14, 3), (15, 4), (16, 5), (17, 6), (18, 7),
	   (20, 1), (21, 1), (22, 1), (23, 99)
	 ) `
	for _, test := range []struct {
		name string
		kbID any
		want []int64
	}{
		{"全站含跨库公开概念，排除混合来源和全部非公开状态", nil, []int64{11, 12}},
		{"可选知识库过滤", int64(2), []int64{12}},
		{"空范围", int64(99), []int64{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			rows, err := tx.Query(ctx, fixtures+safeWikiPageIDsQuery, test.kbID)
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			got := []int64{}
			for rows.Next() {
				var id int64
				if err := rows.Scan(&id); err != nil {
					t.Fatal(err)
				}
				got = append(got, id)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}
