package server

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/oxis/oxis/internal/pty"
)

// The built frontend is embedded at compile time.
// Run `npm run build` inside frontend/ before building Go.
//
//go:embed all:dist
var frontendFS embed.FS

// FrontendFS returns the embedded frontend build (with the "dist/"
// prefix stripped). Two independent consumers mount it:
//   - internal/wailsapp.Run, as the native window's own
//     AssetServer.Assets (Wails' internal request interception, no
//     real TCP socket involved)
//   - Listen below, as a genuine http.FileServer on a real port, so
//     the app is also reachable by pointing an ordinary browser at
//     http://127.0.0.1:1420
//
// Both read the same embedded fs.FS; there's no conflict; either can
// run without the other.
func FrontendFS() (fs.FS, error) {
	return fs.Sub(frontendFS, "dist")
}

// CheckOrigin is deliberately permissive: Listen only ever binds to
// 127.0.0.1 (see below), so the attack this normally guards against —
// a remote page opening a cross-origin WebSocket to a server on the
// user's machine — already requires the attacker to be running code
// on localhost, at which point the Origin header buys nothing. The
// real reason to keep a CheckOrigin at all is that Wails' own window
// origin varies by platform and build (e.g. http://wails.localhost on
// Windows, an empty Origin in some embedded-webview configurations) —
// enumerating all of those is brittle, so this just allows any origin
// and relies on the 127.0.0.1-only bind for the actual boundary.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// isLocalhost gates /ws — the ONLY remaining check on it, since
// CheckOrigin above allows every origin unconditionally. Real,
// exploitable bug found here: this used to check
// strings.HasPrefix(host, "127.0.0.1") — a prefix match, not an exact
// one, meaning a Host header of "127.0.0.1.attacker.com" (or
// "127.0.0.1evil.com", or "localhost.attacker.com" for the other
// branch) would ALSO satisfy it, despite naming a completely
// different, attacker-controlled domain. This is exactly the shape
// of a DNS-rebinding attack against a local server: a page running
// in the browser on the SAME machine gets a domain it controls to
// resolve to 127.0.0.1, then sends a request that a browser is
// perfectly willing to make (same machine, real 127.0.0.1
// destination) carrying whatever Host header the attacker's domain
// produces — which this prefix check would have happily accepted.
// Fixed with an exact match against the actual hostname, with the
// port stripped first via net.SplitHostPort (r.Host normally
// includes it, e.g. "127.0.0.1:1420" — comparing that whole string
// against "127.0.0.1" would never match anything, which is why the
// prefix check existed in the first place; the fix is stripping the
// port properly, not relaxing the comparison back to a prefix).
func isLocalhost(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host // no port present (SplitHostPort fails on a bare host)
	}
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// Listen starts OXIS's local HTTP server: the PTY WebSocket at /ws,
// plus (unlike the PTY-only server this used to be) the built
// frontend itself at every other path, and starts serving in the
// background. Returns the bound port.
//
// WHY BOTH ON ONE SERVER: the native Wails window never depends on
// this for its own UI — it loads the frontend through Wails'
// AssetServer directly (see internal/wailsapp.Run), and only reaches
// this server for its private PTY connection, because Wails'
// AssetServer intercepts requests through the native webview's own
// request-handling API rather than a genuine net.Conn — there's no
// http.Hijacker available on that path, so a WebSocket upgrade (which
// gorilla/websocket performs via Hijack) can never succeed through it.
// Since this server needs a real TCP socket for that anyway, also
// serving the frontend on it is what lets a plain browser point at
// http://127.0.0.1:<port> and get the whole app, same-origin WebSocket
// included, independent of whether the native window is running.
//
// The frontend tells these two cases apart at runtime (see
// isNativeApp() in native.ts) — inside the native window it fetches
// this port from Go via App.GetPTYPort and connects to
// ws://127.0.0.1:<port>/ws explicitly (its own origin is Wails' asset
// server, not this one); in a plain browser it just uses
// `${location.host}/ws`, since browser and server share an origin here.
//
// HISTORY: earlier builds pointed the *native* window at this server
// too, via a bootstrap page that did location.replace to it. That
// full-page navigation away from Wails' own asset-served document was
// exactly what made the custom titlebar's traffic-light buttons and
// window-drag flaky — Wails only reliably binds window.go/window.runtime
// into documents it serves itself, and that pattern raced the
// re-injection on a second document, on every launch. The native
// window no longer touches this server for anything but the PTY
// socket; a plain browser still gets the full experience through it.
//
// Tries preferredPort first, then increments until one is free — so a
// second OXIS instance, or anything else already bound to the default
// port, doesn't stop this one from starting.
func Listen(preferredPort int) (port int, err error) {
	distFS, ferr := FrontendFS()
	if ferr != nil {
		return 0, ferr
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if !isLocalhost(r) {
			http.Error(w, "Forbidden", 403)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[oxis] ws upgrade: %v", err)
			return
		}
		go pty.HandleSession(conn)
	})
	mux.Handle("/", http.FileServer(http.FS(distFS)))

	var ln net.Listener
	for p := preferredPort; p < preferredPort+10; p++ {
		ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			port = p
			break
		}
	}
	if ln == nil {
		return 0, fmt.Errorf("no free port in range %d-%d: %w", preferredPort, preferredPort+9, err)
	}

	go func() {
		if serveErr := http.Serve(ln, mux); serveErr != nil {
			log.Printf("[oxis] local server stopped: %v", serveErr)
		}
	}()

	return port, nil
}
