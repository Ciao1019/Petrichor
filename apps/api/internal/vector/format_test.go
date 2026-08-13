package vector_test

import (
	"math"
	"testing"

	"github.com/Ciao1019/Petrichor/apps/api/internal/vector"
)

func TestFormatPGVector(t *testing.T) {
	got := vector.FormatPGVector([]float32{1, 2.5, -3.25})
	if got != "[1,2.5,-3.25]" {
		t.Fatalf("FormatPGVector() = %q", got)
	}
	if vector.FormatPGVector(nil) != "[]" {
		t.Fatal("空切片应格式化为 []")
	}
}

func TestParsePGVectorRoundTrip(t *testing.T) {
	original := []float32{0, 1.5, -2.75, 1024.001}
	parsed, err := vector.ParsePGVector(vector.FormatPGVector(original))
	if err != nil {
		t.Fatalf("ParsePGVector 失败: %v", err)
	}
	if len(parsed) != len(original) {
		t.Fatalf("长度不一致: got %d want %d", len(parsed), len(original))
	}
	for index := range original {
		if math.Abs(float64(parsed[index]-original[index])) > 1e-6 {
			t.Fatalf("分量 %d: got %v want %v", index, parsed[index], original[index])
		}
	}
}

func TestParsePGVectorInvalid(t *testing.T) {
	if _, err := vector.ParsePGVector("not-a-vector"); err == nil {
		t.Fatal("非法格式应返回错误")
	}
}
