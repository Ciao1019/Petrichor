package kb

import (
	"context"
	"testing"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
)

// 扫描件没有文本层，本地抽取失败是意料之中的事。只要还有整页图片可以交给
// 多模态，这一步就不能判定整份文档失败——线上真实踩过：pdf-inspector 挂掉后
// 扫描件直接 EXTRACT_FAILED，多模态阶段被级联取消，根本没机会跑。
func TestResolvePipelineTextFallsBackToImagesWhenExtractFails(t *testing.T) {
	svc := &Service{}
	doc := &ent.KBDocument{FileType: "pdf", ObjectKey: "uploads/1/scan.pdf"}

	for _, engine := range []string{ParseEngineAuto, ParseEngineLocal} {
		t.Run(engine, func(t *testing.T) {
			config := DocumentParseConfig{ParseEngine: engine}
			input := pipelineInput{PageImages: []documentPageImage{{PageNo: 1, ImageKey: "uploads/1/p1.jpg"}}}

			text, err := svc.resolvePipelineText(context.Background(), doc, config, input)
			if err != nil {
				t.Fatalf("有页面图片时不应判定失败：%v", err)
			}
			if text.Source != "scan" {
				t.Fatalf("应转交多模态，source 实际为 %q", text.Source)
			}
			if text.Warning == "" {
				t.Fatal("抽取器的错误必须留在 warning 里，否则时间线上看不出原因")
			}
		})
	}
}

// 没有图片兜底时，抽取失败仍然是致命错误——这时候确实什么内容都拿不到。
func TestResolvePipelineTextFailsWithoutImagesOrText(t *testing.T) {
	svc := &Service{}
	doc := &ent.KBDocument{FileType: "pdf", ObjectKey: "uploads/1/scan.pdf"}

	_, err := svc.resolvePipelineText(context.Background(), doc,
		DocumentParseConfig{ParseEngine: ParseEngineAuto}, pipelineInput{})
	if err == nil {
		t.Fatal("既没有正文也没有图片时应当报错")
	}
}

// 浏览器抽到了正文就用它，同时把服务端抽取失败的原因记进 warning。
func TestResolvePipelineTextPrefersClientTextAndKeepsWarning(t *testing.T) {
	svc := &Service{}
	doc := &ent.KBDocument{FileType: "pdf", ObjectKey: "uploads/1/text.pdf"}

	text, err := svc.resolvePipelineText(context.Background(), doc,
		DocumentParseConfig{ParseEngine: ParseEngineAuto},
		pipelineInput{ClientText: "浏览器抽到的正文"})
	if err != nil {
		t.Fatalf("有浏览器正文时不应失败：%v", err)
	}
	if text.Source != "client" || text.Text != "浏览器抽到的正文" {
		t.Fatalf("应使用浏览器正文，实际 %#v", text)
	}
	if text.Warning == "" {
		t.Fatal("服务端抽取失败的原因应记进 warning")
	}
}
