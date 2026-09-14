package storage

import (
	"net/url"
	"testing"
)

func TestLocalObjectURLPreservesObjectKey(t *testing.T) {
	key := "uploads/7/测试 空格+?#%.pdf"
	value, err := url.Parse(LocalObjectURL(key))
	if err != nil {
		t.Fatal(err)
	}
	if value.IsAbs() || value.Host != "" || value.RawQuery != "" || value.Fragment != "" {
		t.Fatalf("对象键改变了 URL 源站、查询或片段：%s", value)
	}
	if value.Path != "/api/upload/local/"+key {
		t.Fatalf("对象键未完整保留：%s", value.Path)
	}
}
