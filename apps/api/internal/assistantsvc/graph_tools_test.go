package assistantsvc

import (
	"testing"

	"petrichor/api/internal/sitecontent"
)

func graphTestRoute(value string) *string { return &value }

func graphTestNode(id, kind, label string) sitecontent.PayloadNode {
	return sitecontent.PayloadNode{ID: id, Kind: kind, Label: label, Weight: 1}
}

func graphTestPayload() *sitecontent.SiteGraphPayload {
	nodes := []sitecontent.PayloadNode{
		graphTestNode("root", "root", "全站星图"),
		graphTestNode("section-concept", "section", "概念"),
		graphTestNode("article-1", "article", "向量检索入门"),
		graphTestNode("article-2", "article", "鉴权实践"),
		graphTestNode("concept-vector", "concept", "向量检索"),
		graphTestNode("entity-pgvector", "entity", "pgvector"),
		graphTestNode("concept-auth", "concept", "用户鉴权"),
	}
	nodes[2].Route = graphTestRoute("/p/article-1")
	nodes[3].Route = graphTestRoute("/p/article-2")
	nodes[4].Aliases = []string{"vector search"}
	nodes[4].Attributes = []sitecontent.Attribute{{Name: "类别", Value: "检索技术"}}
	return &sitecontent.SiteGraphPayload{
		Nodes: nodes,
		Links: []sitecontent.PayloadLink{
			{Source: "root", Target: "section-concept", Relation: "包含", Kind: "structure"},
			{Source: "root", Target: "article-1", Relation: "包含", Kind: "structure"},
			{Source: "root", Target: "article-2", Relation: "包含", Kind: "structure"},
			{Source: "section-concept", Target: "concept-vector", Relation: "包含", Kind: "structure"},
			{Source: "section-concept", Target: "entity-pgvector", Relation: "包含", Kind: "structure"},
			{Source: "section-concept", Target: "concept-auth", Relation: "包含", Kind: "structure"},
			{Source: "article-1", Target: "concept-vector", Relation: "阐述", Kind: "semantic"},
			{Source: "concept-vector", Target: "entity-pgvector", Relation: "依赖", Kind: "semantic"},
			{Source: "article-2", Target: "concept-auth", Relation: "阐述", Kind: "semantic"},
		},
	}
}

func TestRetrieveFromGraphMatchesTSBehavior(t *testing.T) {
	result := retrieveFromGraph(graphTestPayload(), "向量检索 和 pgvector 是什么关系？", 2, 5)
	if len(result.Matched) < 2 || result.Matched[0].ID != "concept-vector" {
		t.Fatalf("long query terms did not resolve deterministically: %#v", result.Matched)
	}
	matchedIDs := map[string]bool{}
	for _, match := range result.Matched {
		matchedIDs[match.ID] = true
	}
	if !matchedIDs["entity-pgvector"] {
		t.Fatalf("pgvector term was not matched: %#v", result.Matched)
	}
	for _, link := range result.Links {
		if link.Kind == "structure" {
			t.Fatalf("structural link leaked into semantic expansion: %#v", link)
		}
	}
	for _, node := range result.Nodes {
		if node.ID == "article-2" || node.ID == "concept-auth" {
			t.Fatalf("unrelated structural branch was recalled: %#v", result.Nodes)
		}
	}
}

func TestRetrieveFromGraphAliasPathAndHopLimit(t *testing.T) {
	alias := retrieveFromGraph(graphTestPayload(), "vector search", 2, 5)
	if len(alias.Matched) == 0 || alias.Matched[0].ID != "concept-vector" || alias.Matched[0].MatchedBy != "alias" {
		t.Fatalf("exact alias should rank first: %#v", alias.Matched)
	}

	oneHop := retrieveFromGraph(graphTestPayload(), "pgvector", 1, 5)
	for _, node := range oneHop.Nodes {
		if node.ID == "article-1" {
			t.Fatalf("one-hop expansion reached a two-hop article: %#v", oneHop.Nodes)
		}
	}

	twoHops := retrieveFromGraph(graphTestPayload(), "pgvector", 2, 5)
	foundPath := false
	for _, path := range twoHops.Paths {
		if path.Article != nil && path.Article.ArticleID != nil && *path.Article.ArticleID == "1" {
			foundPath = true
			if len(path.Relations) != len(path.Nodes)-1 {
				t.Fatalf("path relation count mismatch: %#v", path)
			}
		}
	}
	if !foundPath {
		t.Fatalf("two-hop path to article was not reconstructed: %#v", twoHops.Paths)
	}
}

func TestRetrieveFromGraphEmptyAndSkeletonRules(t *testing.T) {
	empty := retrieveFromGraph(graphTestPayload(), "量子纠缠", 2, 5)
	if len(empty.Matched) != 0 || empty.EmptyMessage == "" {
		t.Fatalf("empty retrieval contract changed: %#v", empty)
	}
	skeleton := retrieveFromGraph(graphTestPayload(), "概念", 2, 5)
	for _, match := range skeleton.Matched {
		if match.Kind == "root" || match.Kind == "section" {
			t.Fatalf("graph skeleton became a semantic entry: %#v", skeleton.Matched)
		}
	}
}
