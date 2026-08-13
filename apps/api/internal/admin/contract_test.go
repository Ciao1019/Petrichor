package admin

import (
	"testing"

	"github.com/Ciao1019/Petrichor/apps/api/ent/user"
)

func TestValidateAdminCreateInputMatchesLegacy(t *testing.T) {
	input, err := validateAdminCreateInput(map[string]any{
		"email": " admin@example.com ", "password": "123456", "name": " 管理员 ", "systemRole": "SUPER_ADMIN",
	})
	if err != nil {
		t.Fatal(err)
	}
	if input.Email != "admin@example.com" || input.Name != "管理员" || input.SystemRole != "SUPER_ADMIN" {
		t.Fatalf("unexpected input: %#v", input)
	}
	if _, err := validateAdminCreateInput(map[string]any{"email": "bad", "password": "123456", "name": "n"}); err == nil {
		t.Fatal("invalid email was accepted")
	}
}

func TestResolveAdminUserOrderSupportsMultipleColumns(t *testing.T) {
	orders, err := resolveAdminUserOrder("createdAt,id", "ascending,descending")
	if err != nil {
		t.Fatal(err)
	}
	if len(orders) != 2 || orders[0].Field != user.FieldCreatedAt || !orders[0].Ascending || orders[1].Field != user.FieldID || orders[1].Ascending {
		t.Fatalf("unexpected orders: %#v", orders)
	}
	defaults, err := resolveAdminUserOrder(nil, nil)
	if err != nil || len(defaults) != 2 || defaults[0].Ascending || defaults[1].Ascending {
		t.Fatalf("unexpected defaults: %#v, %v", defaults, err)
	}
}

func TestValidateAdminDeleteInputAcceptsStringAndNumber(t *testing.T) {
	for _, value := range []any{" 42 ", float64(42)} {
		id, err := validateAdminDeleteInput(value)
		if err != nil || id != 42 {
			t.Fatalf("parse %#v: id=%d err=%v", value, id, err)
		}
	}
	if _, err := validateAdminDeleteInput("abc"); err == nil {
		t.Fatal("invalid id was accepted")
	}
}
