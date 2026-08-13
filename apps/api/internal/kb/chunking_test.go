package kb

import (
	"strings"
	"testing"
)

func baseSettings() kbChunkingSettings {
	return kbChunkingSettings{Strategy: "auto", ChunkSize: 512, ChunkOverlap: 80, Separators: []string{"\n\n", "\n", "。"}}
}

func longMarkdown() string {
	var buf strings.Builder
	buf.WriteString("# 手册\n\n导言。\n\n")
	for i := 0; i < 8; i++ {
		buf.WriteString("## 第")
		buf.WriteString(string(rune('0' + i)))
		buf.WriteString("章\n\n")
		buf.WriteString(strings.Repeat("正文内容。", 120))
		buf.WriteString("\n\n")
	}
	return buf.String()
}

func TestChunkDocumentTextSingleLevel(t *testing.T) {
	rows := chunkDocumentText(longMarkdown(), baseSettings(), nil)
	if len(rows) == 0 {
		t.Fatal("应产出分片")
	}
	for index, row := range rows {
		if row.ChunkType != "text" {
			t.Fatalf("单级模式不应出现 %q", row.ChunkType)
		}
		if row.ParentChunkIndex != nil {
			t.Fatal("单级模式不应有父块引用")
		}
		if row.ChunkIndex != index {
			t.Fatalf("chunk_index 应连续，第 %d 条是 %d", index, row.ChunkIndex)
		}
	}
	if countRetrievableChunks(rows) != len(rows) {
		t.Fatal("单级模式下所有分片都应可召回")
	}
}

func TestChunkDocumentTextParentChild(t *testing.T) {
	settings := baseSettings()
	settings.EnableParentChild = true
	rows := chunkDocumentText(longMarkdown(), settings, nil)

	var children, parents []kbChunkRow
	for _, row := range rows {
		switch row.ChunkType {
		case "text":
			children = append(children, row)
		case "parent_text":
			parents = append(parents, row)
		default:
			t.Fatalf("未知分片类型 %q", row.ChunkType)
		}
	}
	if len(children) == 0 || len(parents) == 0 {
		t.Fatalf("父子分块应同时产出两级，实际 children=%d parents=%d", len(children), len(parents))
	}
	// 子块应比父块小：小块用于精准匹配，大块用于回填上下文。
	if avgLen(children) >= avgLen(parents) {
		t.Fatalf("子块平均长度(%d)应小于父块(%d)", avgLen(children), avgLen(parents))
	}
	// 子块占前半段编号，父块紧随其后，保证 (document_id, chunk_index) 唯一。
	seen := map[int]struct{}{}
	for _, row := range rows {
		if _, dup := seen[row.ChunkIndex]; dup {
			t.Fatalf("chunk_index %d 重复", row.ChunkIndex)
		}
		seen[row.ChunkIndex] = struct{}{}
	}
	for index, child := range children {
		if child.ChunkIndex != index {
			t.Fatalf("子块编号应从 0 连续，第 %d 条是 %d", index, child.ChunkIndex)
		}
	}
	// 每个 parent_chunk_index 都必须指向真实存在的父块。
	parentByIndex := map[int]kbChunkRow{}
	for _, parent := range parents {
		parentByIndex[parent.ChunkIndex] = parent
	}
	linked := 0
	for _, child := range children {
		if child.ParentChunkIndex == nil {
			continue
		}
		parent, ok := parentByIndex[*child.ParentChunkIndex]
		if !ok {
			t.Fatalf("子块指向了不存在的父块 %d", *child.ParentChunkIndex)
		}
		if !strings.Contains(parent.Text, strings.TrimSpace(child.Text)) && !strings.Contains(parent.Text, child.Text) {
			// 子块可能被插入表头或面包屑，退化为检查区间包含。
			if child.StartOffset < parent.StartOffset || child.EndOffset > parent.EndOffset {
				t.Fatalf("子块区间 [%d,%d) 不在父块 [%d,%d) 内", child.StartOffset, child.EndOffset, parent.StartOffset, parent.EndOffset)
			}
		}
		linked++
	}
	if linked == 0 {
		t.Fatal("应至少有子块关联到父块")
	}
	// 父块不计入可召回数量。
	if countRetrievableChunks(rows) != len(children) {
		t.Fatalf("可召回分片数应等于子块数 %d，实际 %d", len(children), countRetrievableChunks(rows))
	}
}

func TestChunkDocumentTextAppliesSegments(t *testing.T) {
	text := strings.Repeat("第一页内容。", 120) + "\n\f\n" + strings.Repeat("第二页内容。", 120)
	firstPage, secondPage := 1, 2
	first, second := "p.1", "p.2"
	boundary := len([]rune(strings.Repeat("第一页内容。", 120))) + 3
	rows := chunkDocumentText(text, baseSettings(), []kbTextSegmentInput{
		{StartOffset: 0, Page: &firstPage, Locator: &first},
		{StartOffset: boundary, Page: &secondPage, Locator: &second},
	})

	sawFirst, sawSecond := false, false
	for _, row := range rows {
		if row.Page == nil {
			t.Fatal("给了分段边界后每个分片都应有页码")
		}
		if row.StartOffset < boundary && *row.Page != 1 {
			t.Fatalf("偏移 %d 应属于第 1 页，实际 %d", row.StartOffset, *row.Page)
		}
		if *row.Page == 1 {
			sawFirst = true
		}
		if *row.Page == 2 {
			sawSecond = true
		}
	}
	if !sawFirst || !sawSecond {
		t.Fatal("两页都应有分片")
	}
}

func TestChunkDocumentTextEmptyInput(t *testing.T) {
	if rows := chunkDocumentText("   \n  ", baseSettings(), nil); rows != nil {
		t.Fatalf("空白正文不应产出分片，实际 %d 条", len(rows))
	}
}

func avgLen(rows []kbChunkRow) int {
	if len(rows) == 0 {
		return 0
	}
	total := 0
	for _, row := range rows {
		total += len([]rune(row.Text))
	}
	return total / len(rows)
}

func TestWikiClaimPhase(t *testing.T) {
	// 重整任务不经过 Map 阶段，领取时直接标成汇总，避免进度条显示错误的阶段。
	if got := wikiClaimPhase("cleanup"); got != "reducing" {
		t.Fatalf("cleanup 任务初始阶段应为 reducing，实际 %q", got)
	}
	if got := wikiClaimPhase("ingest"); got != "mapping" {
		t.Fatalf("ingest 任务初始阶段应为 mapping，实际 %q", got)
	}
	if got := wikiClaimPhase(""); got != "mapping" {
		t.Fatalf("未标注类型应按 ingest 处理，实际 %q", got)
	}
}

func TestBuildDocumentSummaryDigest(t *testing.T) {
	t.Run("概述与正文拼接后填满卡片", func(t *testing.T) {
		got := buildDocumentSummaryDigest("本文档是 Fastfetch 的综合指南。", "# 项目简介\n\nFastfetch 是一个类似 Neofetch 的系统信息展示工具。")
		if !strings.HasPrefix(got, "本文档是 Fastfetch 的综合指南。") {
			t.Fatalf("应以一句话概述开头：%q", got)
		}
		if !strings.Contains(got, "Fastfetch 是一个类似 Neofetch") {
			t.Fatalf("应补上正文散文：%q", got)
		}
		if strings.Contains(got, "#") {
			t.Fatalf("不应残留 Markdown 标记：%q", got)
		}
	})

	t.Run("正文以概述开头时不重复", func(t *testing.T) {
		line := "这是一句概述。"
		got := buildDocumentSummaryDigest(line, line+"后续内容。")
		if strings.Count(got, line) != 1 {
			t.Fatalf("同一句话不应出现两遍：%q", got)
		}
	})

	t.Run("缺少概述时退回正文", func(t *testing.T) {
		if got := buildDocumentSummaryDigest("", "# 标题\n\n正文内容。"); got != "正文内容。" && !strings.Contains(got, "正文内容。") {
			t.Fatalf("应使用正文：%q", got)
		}
	})

	t.Run("两者都为空时返回空串", func(t *testing.T) {
		if got := buildDocumentSummaryDigest("  ", "  "); got != "" {
			t.Fatalf("应返回空串，实际 %q", got)
		}
	})

	t.Run("超长内容被截断", func(t *testing.T) {
		got := buildDocumentSummaryDigest("概述。", strings.Repeat("正文内容。", 200))
		if len([]rune(got)) > 301 {
			t.Fatalf("摘要过长：%d 字符", len([]rune(got)))
		}
	})
}

func TestStripWikiLinkMarkup(t *testing.T) {
	cases := []struct{ in, want string }{
		{"本文档介绍[[entity/fastfetch|Fastfetch]]工具。", "本文档介绍Fastfetch工具。"},
		{"参见 [[concept/void-resonance]] 一节。", "参见 void resonance 一节。"},
		{"[[a|A]] 与 [[b|B]]", "A 与 B"},
		{"没有双链的普通文本", "没有双链的普通文本"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := stripWikiLinkMarkup(tc.in); got != tc.want {
			t.Fatalf("stripWikiLinkMarkup(%q) = %q，期望 %q", tc.in, got, tc.want)
		}
	}
}

func TestBuildDocumentSummaryDigestStripsWikiLinks(t *testing.T) {
	// 回写到文件卡片的摘要必须是纯文本，不能带 [[...]] 标记。
	got := buildDocumentSummaryDigest(
		"本文档介绍[[entity/fastfetch|Fastfetch]]的用法。",
		"# 简介\n\n[[entity/fastfetch|Fastfetch]] 是一个系统信息工具。",
	)
	if strings.Contains(got, "[[") || strings.Contains(got, "]]") {
		t.Fatalf("摘要不应残留双链标记：%q", got)
	}
	if !strings.Contains(got, "Fastfetch") {
		t.Fatalf("应保留显示名：%q", got)
	}
}
