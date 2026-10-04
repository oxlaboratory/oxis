package update

import (
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/oxis/oxis/internal/buildinfo"
)

// fakeGitHub answers the commit endpoint with status and body, and
// 404s the release lookup.
func fakeGitHub(t *testing.T, status int, body string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/commits/") {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	old := apiBase
	apiBase = srv.URL
	t.Cleanup(func() { apiBase = old })
}

func withBuildCommit(t *testing.T, sha string) {
	t.Helper()
	buildinfo.CommitSHA() // settle the vcs fallback before overriding
	old := buildinfo.Commit
	buildinfo.Commit = sha
	t.Cleanup(func() { buildinfo.Commit = old })
}

func TestCheck(t *testing.T) {
	cases := []struct {
		name          string
		build         string
		status        int
		body          string
		wantAvailable bool
		wantLatest    string
		wantErr       string
	}{
		{"newer build", "aaa111", 200, `{"sha":"bbb222"}`, true, "bbb222", ""},
		{"up to date", "bbb222", 200, `{"sha":"BBB222"}`, false, "BBB222", ""},
		{"unstamped build still learns the latest", "", 200, `{"sha":"bbb222"}`, false, "bbb222", ""},
		{"rate limited", "aaa111", 403, `{}`, false, "", "rate limit"},
		{"server error", "aaa111", 502, ``, false, "", "HTTP 502"},
		{"garbage", "aaa111", 200, `not json`, false, "", "unexpected response"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withBuildCommit(t, c.build)
			fakeGitHub(t, c.status, c.body)
			got := Check("windows")
			if got.Available != c.wantAvailable || got.LatestCommit != c.wantLatest {
				t.Errorf("Available=%v Latest=%q, want %v %q", got.Available, got.LatestCommit, c.wantAvailable, c.wantLatest)
			}
			if (c.wantErr == "") != (got.Error == "") || !strings.Contains(got.Error, c.wantErr) {
				t.Errorf("Error=%q, want it to mention %q", got.Error, c.wantErr)
			}
		})
	}
}

func TestCheckOffline(t *testing.T) {
	withBuildCommit(t, "aaa111")
	old := apiBase
	apiBase = "http://127.0.0.1:1" // nothing listens here
	t.Cleanup(func() { apiBase = old })
	if got := Check("linux"); got.Available || !strings.Contains(got.Error, "couldn't reach GitHub") {
		t.Errorf("offline check = %+v", got)
	}
}

func TestCheckCountsCommits(t *testing.T) {
	cases := []struct {
		name          string
		compare       string
		wantAvailable bool
		wantBehind    int
		wantAhead     int
	}{
		{"behind the branch", `{"status":"ahead","ahead_by":3,"behind_by":0}`, true, 3, 0},
		{"local work ahead of the branch", `{"status":"behind","ahead_by":0,"behind_by":2}`, false, 0, 2},
		{"diverged", `{"status":"diverged","ahead_by":4,"behind_by":1}`, true, 4, 1},
		// Newer commits that only touch docs, screenshots, the website or
		// tests: nothing new to install (and CI publishes no new build).
		{"only docs and the website", `{"status":"ahead","ahead_by":2,"behind_by":0,"files":[` +
			`{"filename":"README.md"},{"filename":"assets/screenshots/app-home.png"},` +
			`{"filename":"cloudflare/index.html"},{"filename":"internal/pty/pty_test.go"},` +
			`{"filename":"frontend/src/terminal/hints.test.ts"}]}`, false, 2, 0},
		{"docs and code", `{"status":"ahead","ahead_by":2,"behind_by":0,"files":[` +
			`{"filename":"README.md"},{"filename":"internal/pty/pty.go"}]}`, true, 2, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withBuildCommit(t, "aaa111")
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.Contains(r.URL.Path, "/commits/"):
					_, _ = w.Write([]byte(`{"sha":"bbb222"}`))
				case strings.HasSuffix(r.URL.Path, "/compare/aaa111...bbb222"):
					_, _ = w.Write([]byte(c.compare))
				default:
					http.NotFound(w, r)
				}
			}))
			t.Cleanup(srv.Close)
			old := apiBase
			apiBase = srv.URL
			t.Cleanup(func() { apiBase = old })

			got := Check("windows")
			if got.Available != c.wantAvailable || got.Behind != c.wantBehind || got.Ahead != c.wantAhead {
				t.Errorf("got Available=%v Behind=%d Ahead=%d, want %v %d %d", got.Available, got.Behind, got.Ahead, c.wantAvailable, c.wantBehind, c.wantAhead)
			}
		})
	}
}

func TestCheckUnpushedBuild(t *testing.T) {
	cases := []struct {
		name          string
		commitDate    string
		wantAvailable bool
	}{
		{"local work newer than main", "2026-09-27T10:00:00+09:30", false},
		{"old local build", "2026-09-20T10:00:00Z", true},
		{"unknown commit date", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withBuildCommit(t, "aaa111")
			oldDate := buildinfo.CommitDate
			buildinfo.CommitDate = c.commitDate
			t.Cleanup(func() { buildinfo.CommitDate = oldDate })
			// The tip is known; the build's commit isn't (404 on compare).
			fakeGitHub(t, 200, `{"sha":"bbb222","commit":{"committer":{"date":"2026-09-26T23:00:00Z"}}}`)
			got := Check("windows")
			if got.Available != c.wantAvailable || !got.Unpushed {
				t.Errorf("Available=%v Unpushed=%v, want %v true", got.Available, got.Unpushed, c.wantAvailable)
			}
		})
	}
}

func TestPickAssetMacOS(t *testing.T) {
	assets := []ghAsset{
		{Name: "oxis-1.2.1.msi", BrowserDownloadURL: "msi"},
		{Name: "oxis_1.2.1_amd64.deb", BrowserDownloadURL: "deb"},
		{Name: "oxis-1.2.1-macos-arm64.zip", BrowserDownloadURL: "mac-arm"},
		{Name: "oxis-1.2.1-macos-x64.zip", BrowserDownloadURL: "mac-x64"},
	}
	want := map[string]string{"arm64": "mac-arm", "amd64": "mac-x64"}[runtime.GOARCH]
	if want == "" {
		t.Skip("no macOS build for " + runtime.GOARCH)
	}
	if got := pickAsset(assets, "darwin"); got != want {
		t.Errorf("darwin: %q, want %q", got, want)
	}
	if got := pickRawBinary(assets, "darwin"); got != "" {
		t.Errorf("darwin has no bare binary to swap in, got %q", got)
	}
}
