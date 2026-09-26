package update

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
	old := BuildCommit
	BuildCommit = sha
	t.Cleanup(func() { BuildCommit = old })
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
