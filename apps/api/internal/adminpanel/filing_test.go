package adminpanel

import (
	"testing"
)

func TestBuildSiteFilingResponseDefaultsToHidden(t *testing.T) {
	response := BuildSiteFilingResponse(nil)
	if response["enabled"] != false {
		t.Fatalf("expected filing to be disabled, got %#v", response["enabled"])
	}
	if response["icpUrl"] != defaultICPURL {
		t.Fatalf("expected default ICP URL, got %#v", response["icpUrl"])
	}
}

func TestValidateSiteFilingInputRequiresNumberWhenEnabled(t *testing.T) {
	_, err := validateSiteFilingInput(map[string]any{"enabled": true})
	if err == nil {
		t.Fatal("expected validation error")
	}
}

func TestValidateSiteFilingInputNormalizesValues(t *testing.T) {
	record, err := validateSiteFilingInput(map[string]any{
		"enabled":              true,
		"icpNumber":            "  京 ICP 备 123 号\n",
		"icpUrl":               "",
		"publicSecurityNumber": " 京公网安备 110000000001 号 ",
		"publicSecurityUrl":    "https://www.beian.gov.cn/portal/registerSystemInfo?recordcode=110000000001",
	})
	if err != nil {
		t.Fatalf("validateSiteFilingInput returned error: %v", err)
	}
	if record.ICPNumber != "京 ICP 备 123 号" {
		t.Fatalf("unexpected normalized ICP number: %q", record.ICPNumber)
	}
	if record.ICPURL != defaultICPURL {
		t.Fatalf("unexpected ICP URL: %q", record.ICPURL)
	}
}

func TestValidateSiteFilingInputRejectsUnsafeURL(t *testing.T) {
	_, err := validateSiteFilingInput(map[string]any{
		"enabled":   true,
		"icpNumber": "京ICP备123号",
		"icpUrl":    "javascript:alert(1)",
	})
	if err == nil {
		t.Fatal("expected unsafe URL validation error")
	}
}
