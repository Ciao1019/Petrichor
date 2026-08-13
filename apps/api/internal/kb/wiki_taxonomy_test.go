package kb

import (
	"reflect"
	"testing"
)

func TestCleanWikiCategoryPath(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{"常规两级路径", []string{"软件", "命令行工具"}, []string{"软件", "命令行工具"}},
		{"拆开内嵌分隔符", []string{"软件/命令行工具"}, []string{"软件", "命令行工具"}},
		{"全角分隔符归一", []string{"软件／命令行工具"}, []string{"软件", "命令行工具"}},
		{"去掉包裹引号和括号", []string{`"软件"`, "（命令行工具）"}, []string{"软件", "命令行工具"}},
		{"丢弃页面类型噪声", []string{"实体", "人物"}, []string{"人物"}},
		{"英文类型噪声同样丢弃", []string{"Concepts", "法律概念"}, []string{"法律概念"}},
		{"同名标签去重", []string{"软件", "软件"}, []string{"软件"}},
		{"截断到最大深度", []string{"a", "b", "c", "d"}, []string{"a", "b", "c"}},
		{"空白标签被丢弃", []string{"  ", "组织"}, []string{"组织"}},
		{"全部无效时返回空", []string{"实体", "  "}, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := cleanWikiCategoryPath(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("cleanWikiCategoryPath(%q) = %q, 期望 %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestDecodeWikiCategoryPath(t *testing.T) {
	valid := `["软件","命令行工具"]`
	if got := decodeWikiCategoryPath(&valid); !reflect.DeepEqual(got, []string{"软件", "命令行工具"}) {
		t.Fatalf("合法 JSON 解析失败: %q", got)
	}
	if got := decodeWikiCategoryPath(nil); got != nil {
		t.Fatalf("nil 应解析为 nil，实际 %q", got)
	}
	blank := "   "
	if got := decodeWikiCategoryPath(&blank); got != nil {
		t.Fatalf("空白应解析为 nil，实际 %q", got)
	}
	broken := `{not json`
	if got := decodeWikiCategoryPath(&broken); got != nil {
		t.Fatalf("非法 JSON 应解析为 nil，实际 %q", got)
	}
}

func TestFormatWikiTaxonomyTree(t *testing.T) {
	if got := formatWikiTaxonomyTree(nil); got != "" {
		t.Fatalf("空输入应返回空串，实际 %q", got)
	}
	got := formatWikiTaxonomyTree([][]string{
		{"软件", "命令行工具"},
		{"软件", "Shell"},
		{"组织"},
	})
	// 同一父目录下的子目录合并，且按字典序稳定输出。
	expected := "- 组织\n- 软件\n  - Shell\n  - 命令行工具"
	if got != expected {
		t.Fatalf("目录树渲染不符：\n实际：\n%s\n期望：\n%s", got, expected)
	}
}
