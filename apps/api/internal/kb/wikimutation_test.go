package kb

import (
	"reflect"
	"testing"
)

func TestWikiLinkInputDefaultsToRelated(t *testing.T) {
	if got := (wikiLinkInput{ToPageKey: "a"}).linkType(); got != defaultWikiLinkType {
		t.Fatalf("linkType = %q，未指定时应与建表默认值一致", got)
	}
	if got := (wikiLinkInput{ToPageKey: "a", LinkType: "extracts"}).linkType(); got != "extracts" {
		t.Fatalf("linkType = %q", got)
	}
}

func TestWikiPageRefsOf(t *testing.T) {
	refs := wikiPageRefsOf([]WikiPageRow{
		{ID: 1, PageKey: "a"}, {ID: 2, PageKey: "b"},
	})
	want := []wikiPageRef{{ID: 1, PageKey: "a"}, {ID: 2, PageKey: "b"}}
	if !reflect.DeepEqual(refs, want) {
		t.Fatalf("refs = %#v", refs)
	}
	if got := wikiPageRefsOf(nil); len(got) != 0 {
		t.Fatalf("空输入应返回空切片，实际 %#v", got)
	}
}

// knowledgePageMetadataWithRelations 造一份带关系的页面 metadata。
func knowledgePageMetadataWithRelations(relations ...map[string]any) map[string]any {
	list := make([]any, 0, len(relations))
	for _, relation := range relations {
		list = append(list, relation)
	}
	return map[string]any{
		"contributions": map[string]any{
			"1": map[string]any{"relations": list},
		},
	}
}

func TestKnowledgePageOutLinksFiltersByOrigin(t *testing.T) {
	metadata := readKnowledgePageMetadata(marshalJSON(knowledgePageMetadataWithRelations(
		map[string]any{"fromPageKey": "a", "toPageKey": "b", "relationType": "实现"},
		map[string]any{"fromPageKey": "c", "toPageKey": "d", "relationType": "包含"},
	)))

	links := knowledgePageOutLinks("a", metadata, nil)
	if len(links) != 1 || links[0].ToPageKey != "b" || links[0].LinkType != "实现" {
		t.Fatalf("只应保留以本页为起点的关系，实际 %#v", links)
	}
	if got := knowledgePageOutLinks("zzz", metadata, nil); len(got) != 0 {
		t.Fatalf("没有以该页为起点的关系时应为空，实际 %#v", got)
	}
}

func TestKnowledgePageOutLinksDropsInactiveTargets(t *testing.T) {
	metadata := readKnowledgePageMetadata(marshalJSON(knowledgePageMetadataWithRelations(
		map[string]any{"fromPageKey": "a", "toPageKey": "alive", "relationType": "实现"},
		map[string]any{"fromPageKey": "a", "toPageKey": "deleted", "relationType": "包含"},
	)))

	// activePageKeys 为 nil 时不过滤，非 nil 时只保留仍然存在的目标页。
	if got := knowledgePageOutLinks("a", metadata, nil); len(got) != 2 {
		t.Fatalf("nil 时不应过滤，实际 %#v", got)
	}
	links := knowledgePageOutLinks("a", metadata, map[string]struct{}{"alive": {}})
	if len(links) != 1 || links[0].ToPageKey != "alive" {
		t.Fatalf("已删除的目标页不应重建成断链，实际 %#v", links)
	}
}
