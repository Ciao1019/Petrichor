package kb

import "testing"

func TestShallowTreeNodesPreservesLazyLoadHint(t *testing.T) {
	rootID := int64(1)
	folderID := int64(2)
	graph := &kbGraph{nodes: []NodeRow{
		{ID: rootID, Type: "FOLDER", Name: "根文件夹"},
		{ID: folderID, ParentID: &rootID, Type: "FOLDER", Name: "子文件夹"},
		{ID: 3, ParentID: &folderID, Type: "ARTICLE", Name: "文章"},
	}}
	index := indexGraph(graph)

	roots := shallowTreeNodes(buildTree(graph, index, nil, true))
	if len(roots) != 1 {
		t.Fatalf("根节点数量 = %d，期望 1", len(roots))
	}
	if !roots[0].HasChildren {
		t.Fatal("根文件夹清空 children 后必须保留 hasChildren=true")
	}
	if len(roots[0].Children) != 0 {
		t.Fatalf("根文件夹 children 数量 = %d，期望按需加载前为空", len(roots[0].Children))
	}

	children := shallowTreeNodes(buildTree(graph, index, &rootID, true))
	if len(children) != 1 {
		t.Fatalf("直接子节点数量 = %d，期望 1", len(children))
	}
	if !children[0].HasChildren {
		t.Fatal("深层文件夹清空 children 后必须保留 hasChildren=true")
	}
	if len(children[0].Children) != 0 {
		t.Fatalf("子文件夹 children 数量 = %d，期望按需加载前为空", len(children[0].Children))
	}

	responseChildren, ok := children[0].toMap()["children"].([]map[string]any)
	if !ok {
		t.Fatal("children 响应必须序列化为数组")
	}
	if len(responseChildren) != 0 {
		t.Fatalf("children 响应数量 = %d，期望 0", len(responseChildren))
	}
}
