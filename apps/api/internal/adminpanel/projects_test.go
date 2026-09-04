package adminpanel

import (
	"reflect"
	"testing"
)

func TestBuildProjectShowcaseResponseUsesDemoDefaults(t *testing.T) {
	response := BuildProjectShowcaseResponse(nil)
	if response["heading"] != "开源项目" {
		t.Fatalf("默认标题 = %#v", response["heading"])
	}
	if response["intro"] != defaultProjectIntro {
		t.Fatalf("默认副标题 = %#v", response["intro"])
	}

	items, ok := response["items"].([]ProjectItem)
	if !ok {
		t.Fatalf("默认项目类型 = %T", response["items"])
	}
	names := make([]string, 0, len(items))
	for _, item := range items {
		names = append(names, item.Name)
	}
	if want := []string{"Petrichor", "AgentX", "stream-query"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("默认项目 = %v，期望 %v", names, want)
	}
}
