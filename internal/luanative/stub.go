//go:build !cgo

package luanative

import (
	"encoding/json"

	"github.com/gorilla/websocket"
)

// Built without cgo (no C compiler): plugins run on fengari in the page.

const why = "this OXIS was built without a C compiler, so plugins run on fengari"

// Available reports that native Lua isn't in this build.
func Available() (bool, string) { return false, why }

// Version: none.
func Version() string { return "" }

// HandleSession tells the page native Lua isn't available.
func HandleSession(conn *websocket.Conn) {
	b, _ := json.Marshal(map[string]any{"t": "hello", "available": false, "error": why})
	_ = conn.WriteMessage(websocket.TextMessage, b)
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
