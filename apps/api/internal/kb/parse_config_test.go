package kb

import (
	"testing"
)

func TestNormalizeDocumentParseConfigDefaults(t *testing.T) {
	config := NormalizeDocumentParseConfig(nil)
	if config.ParseEngine != ParseEngineAuto {
		t.Fatalf("默认解析引擎应为 auto，实际 %q", config.ParseEngine)
	}
	if config.QuestionGeneration.Enabled {
		t.Fatal("默认不应开启 AI 问题生成")
	}
	if config.QuestionGeneration.QuestionCount != 3 {
		t.Fatalf("默认问题数量应为 3，实际 %d", config.QuestionGeneration.QuestionCount)
	}
	if config.Chunking.ChunkSize != nil {
		t.Fatal("默认不应覆盖分块大小，应沿用知识库配置")
	}
}

func TestNormalizeDocumentParseConfigClampsQuestionCount(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		input int
		want  int
	}{
		{"零回落默认值", 0, 3},
		{"负数回落默认值", -4, 3},
		{"超出上限夹到 10", 99, MaxQuestionsPerChunk},
		{"区间内保持原值", 7, 7},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			config := NormalizeDocumentParseConfig(&DocumentParseConfig{
				QuestionGeneration: QuestionGenerationConfig{Enabled: true, QuestionCount: testCase.input},
			})
			if config.QuestionGeneration.QuestionCount != testCase.want {
				t.Fatalf("问题数量 %d，期望 %d", config.QuestionGeneration.QuestionCount, testCase.want)
			}
		})
	}
}

// 按扫描件解析必然要调多模态，配置层面就要保持一致，
// 否则后台阶段会出现"引擎说要识别、图像处理却是关的"这种自相矛盾的状态。
func TestNormalizeDocumentParseConfigScanForcesMultimodal(t *testing.T) {
	config := NormalizeDocumentParseConfig(&DocumentParseConfig{
		ParseEngine: ParseEngineScan,
		Multimodal:  MultimodalConfig{Enabled: false},
	})
	if !config.Multimodal.Enabled {
		t.Fatal("按扫描件解析时必须自动开启多模态")
	}
}

func TestNormalizeDocumentTagsDedupesAndTrims(t *testing.T) {
	tags := normalizeDocumentTags([]string{" 合同 ", "合同", "", "  ", "年报"})
	if len(tags) != 2 || tags[0] != "合同" || tags[1] != "年报" {
		t.Fatalf("标签归一化结果异常：%#v", tags)
	}
}

func TestNormalizeDocumentParseConfigTruncatesInstructions(t *testing.T) {
	long := make([]rune, MaxQuestionInstructionsChars+50)
	for index := range long {
		long[index] = '客'
	}
	config := NormalizeDocumentParseConfig(&DocumentParseConfig{
		QuestionGeneration: QuestionGenerationConfig{Enabled: true, CustomInstructions: string(long)},
	})
	if got := len([]rune(config.QuestionGeneration.CustomInstructions)); got != MaxQuestionInstructionsChars {
		t.Fatalf("自定义要求应截断到 %d 字，实际 %d", MaxQuestionInstructionsChars, got)
	}
}

func TestDecodeDocumentParseConfigRoundTrip(t *testing.T) {
	size := 777
	original := NormalizeDocumentParseConfig(&DocumentParseConfig{
		Tags:               []string{"制度"},
		ParseEngine:        ParseEngineLocal,
		Chunking:           ChunkingOverride{ChunkSize: &size},
		QuestionGeneration: QuestionGenerationConfig{Enabled: true, QuestionCount: 5},
	})
	encoded := encodeDocumentParseConfig(original)
	if encoded == nil {
		t.Fatal("序列化解析配置失败")
	}
	decoded := decodeDocumentParseConfig(encoded)
	if decoded.ParseEngine != ParseEngineLocal {
		t.Fatalf("解析引擎丢失：%q", decoded.ParseEngine)
	}
	if decoded.Chunking.ChunkSize == nil || *decoded.Chunking.ChunkSize != size {
		t.Fatal("分块大小覆盖项丢失")
	}
	if decoded.QuestionGeneration.QuestionCount != 5 || len(decoded.Tags) != 1 {
		t.Fatalf("配置往返结果异常：%#v", decoded)
	}
}

// 损坏或缺失的配置不能让重新解析直接崩掉，必须回落到默认值。
func TestDecodeDocumentParseConfigFallsBackOnGarbage(t *testing.T) {
	garbage := "{not json"
	config := decodeDocumentParseConfig(&garbage)
	if config.ParseEngine != ParseEngineAuto {
		t.Fatalf("损坏配置应回落到默认值，实际 %q", config.ParseEngine)
	}
}

// 页面图片不是用户配的选项，而是浏览器栅格化的产物，必须随配置一起存库：
// 丢了它，扫描件重新解析时多模态就没有输入，只能跑出一个空文档。
func TestDocumentParseConfigKeepsPageImages(t *testing.T) {
	config := NormalizeDocumentParseConfig(&DocumentParseConfig{
		Multimodal: MultimodalConfig{Enabled: true},
		PageImages: []documentPageImage{
			{PageNo: 3, ImageKey: "uploads/1/p3.jpg"},
			{PageNo: 1, ImageKey: "uploads/1/p1.jpg"},
			{PageNo: 0, ImageKey: "ignored"},
			{PageNo: 2, ImageKey: "  "},
		},
	})
	if len(config.PageImages) != 2 {
		t.Fatalf("非法页应被丢弃，实际 %#v", config.PageImages)
	}
	if config.PageImages[0].PageNo != 1 || config.PageImages[1].PageNo != 3 {
		t.Fatalf("页面图片应按页号升序，实际 %#v", config.PageImages)
	}
	decoded := decodeDocumentParseConfig(encodeDocumentParseConfig(config))
	if len(decoded.PageImages) != 2 || decoded.PageImages[0].ImageKey != "uploads/1/p1.jpg" {
		t.Fatalf("页面图片没有随配置往返，实际 %#v", decoded.PageImages)
	}
}
