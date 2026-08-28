package satokenstore

import (
	"bytes"
	"reflect"
	"testing"
)

func TestValueRoundTrip(t *testing.T) {
	tests := []struct {
		name  string
		value any
	}{
		{name: "string", value: `{"loginId":"1"}`},
		{name: "bytes", value: []byte(`{"loginId":"1"}`)},
		{name: "json", value: map[string]any{"enabled": true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, valueType, err := encodeValue(tt.value)
			if err != nil {
				t.Fatal(err)
			}
			got, err := decodeValue(data, valueType)
			if err != nil {
				t.Fatal(err)
			}
			switch want := tt.value.(type) {
			case []byte:
				if !bytes.Equal(got.([]byte), want) {
					t.Fatalf("bytes round trip = %q, want %q", got, want)
				}
			default:
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("round trip = %#v, want %#v", got, want)
				}
			}
		})
	}
}

func TestLikePatternEscapesSQLWildcards(t *testing.T) {
	if got, want := likePattern(`petrichor:account:1:*`), `petrichor:account:1:%`; got != want {
		t.Fatalf("likePattern() = %q, want %q", got, want)
	}
	if got, want := likePattern(`a_b%`), `a\_b\%`; got != want {
		t.Fatalf("likePattern() escaped = %q, want %q", got, want)
	}
}
