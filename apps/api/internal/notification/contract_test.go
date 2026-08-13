package notification

import "testing"

func TestValidateNotificationInputsMatchesLegacy(t *testing.T) {
	input, err := validateListInput(map[string]any{
		"category": " SYSTEM ", "readStatus": "UNREAD", "pageNum": "2", "pageSize": float64(10),
	})
	if err != nil {
		t.Fatal(err)
	}
	if input.Category != "SYSTEM" || input.PageNum != 2 || input.PageSize != 10 {
		t.Fatalf("unexpected list input: %#v", input)
	}
	for _, raw := range []any{" 12 ", float64(12)} {
		id, err := validateNotificationID(raw)
		if err != nil || id != 12 {
			t.Fatalf("parse %#v: id=%d err=%v", raw, id, err)
		}
	}
}

func TestResolveNotificationOrderSupportsLegacyColumns(t *testing.T) {
	orders, err := resolveOrder("readAt,id", "ascending,descending")
	if err != nil || len(orders) != 2 {
		t.Fatalf("unexpected orders: %#v, %v", orders, err)
	}
	if _, err := resolveOrder("created_at;drop", "asc"); err == nil {
		t.Fatal("unsafe order was accepted")
	}
}
