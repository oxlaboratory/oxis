package server

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"

	"github.com/gorilla/websocket"
	"github.com/oxis/oxis/internal/pty"
)

// The built frontend is embedded at compile time.
// Run `npm run build` inside frontend/ before building Go.
//
//go:embed all:dist
var frontendFS embed.FS

// FrontendFS returns the embedded frontend build. It is served both as
// the native window's assets (wailsapp.Run) and over HTTP by Listen.
func FrontendFS() (fs.FS, error) {
	return fs.Sub(frontendFS, "dist")
}

func isLoopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// isLocalhost rejects requests whose Host isn't loopback (DNS
// rebinding). The port is stripped first; the match is exact.
func isLocalhost(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}
	return isLoopbackHost(host)
}

// originAllowed decides who may open the PTY WebSocket. Any web page
// the user visits can point a WebSocket at 127.0.0.1, and the Host
// header will look local, so the Origin is what actually keeps other
// sites out. Allowed: the native window (wails:// on macOS/Linux,
// http://wails.localhost on Windows), this server's own origin, and
// clients that send no Origin at all (not browsers).
func originAllowed(r *http.Request, port int) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if u.Scheme == "wails" || host == "wails.localhost" {
		return true
	}
	return (u.Scheme == "http" || u.Scheme == "https") &&
		isLoopbackHost(host) && u.Port() == strconv.Itoa(port)
}

// Listen starts the local server on 127.0.0.1: the PTY WebSocket at /ws
// and the frontend everywhere else, so the app also works in a normal
// browser at http://127.0.0.1:<port>. The native window loads its UI
// from Wails' asset server and only uses this for /ws, since Wails'
// asset server can't upgrade WebSockets.
//
// preferredPort is tried first, then the next nine, so a second
// instance can still start. Returns the bound port.
func Listen(preferredPort int) (port int, err error) {
	distFS, ferr := FrontendFS()
	if ferr != nil {
		return 0, ferr
	}

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

	upgrader := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     func(r *http.Request) bool { return originAllowed(r, port) },
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if !isLocalhost(r) {
			http.Error(w, "Forbidden", http.StatusForbidden)
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

	go func() {
		if serveErr := http.Serve(ln, mux); serveErr != nil {
			log.Printf("[oxis] local server stopped: %v", serveErr)
		}
	}()

	return port, nil
}
