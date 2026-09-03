package sitecontent

import "testing"

func TestBuildSiteFilingResponseDefaultsToHidden(t *testing.T) {
	response := BuildSiteFilingResponse(nil)
	if response["enabled"] != false {
		t.Fatalf("expected filing to be disabled, got %#v", response["enabled"])
	}
	if response["icpNumber"] != "" || response["publicSecurityNumber"] != "" {
		t.Fatalf("expected empty filing numbers, got %#v", response)
	}
}
