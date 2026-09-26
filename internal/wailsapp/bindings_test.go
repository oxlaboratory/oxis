package wailsapp

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Wails hands the page only a method's first result unless the second
// is an error, so a (bool, string) method reaches JavaScript as a bare
// bool. Every bound method must return nothing, one value, or a value
// and an error.
func TestBoundMethodsReturnShapes(t *testing.T) {
	errType := reflect.TypeOf((*error)(nil)).Elem()
	typ := reflect.TypeOf(&App{})
	for i := 0; i < typ.NumMethod(); i++ {
		m := typ.Method(i)
		switch n := m.Type.NumOut(); {
		case n > 2:
			t.Errorf("%s returns %d values; Wails passes at most a value and an error", m.Name, n)
		case n == 2 && !m.Type.Out(1).Implements(errType):
			t.Errorf("%s returns (%s, %s); the second result must be an error or the page only sees the first", m.Name, m.Type.Out(0), m.Type.Out(1))
		}
	}
}

func TestUpdateResultJSON(t *testing.T) {
	b, err := json.Marshal(UpdateResult{Installed: false, Error: "offline"})
	if err != nil || string(b) != `{"installed":false,"error":"offline"}` {
		t.Errorf("UpdateResult marshals as %s (%v); native.ts reads installed/error", b, err)
	}
}
