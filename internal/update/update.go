// Package update checks GitHub for a newer OXIS BUILD than the one
// currently running — "newer" now means "a different, more recent
// commit on the default branch", not a tagged semver release. It
// never tries to replace the running .exe itself — Windows won't let
// a process overwrite its own binary while it's executing, and OXIS
// ships as a plain single binary with no updater helper process.
// Instead this just tells the frontend "a newer build is out, here's
// where to get it" so 'update can hand the user a download link (see
// App.CheckForUpdate / OpenURL in internal/wailsapp/app.go).
//
// Points at github.com/oxlaboratory/oxis (ProjectPath below).
//
// COMMIT-BASED CHECKING — HOW THE TWO HALVES OF THIS FIT TOGETHER:
//
//  1. BuildCommit (below) has to be set to the real commit SHA the
//     running binary was built FROM — it's empty by default, and an
//     empty BuildCommit means Check() always reports no update
//     available (never "0000..." looking newer than everything, and
//     never spuriously nagging about an update on every single launch
//     either). build-linux.sh sets this via
//     -ldflags "-X github.com/oxis/oxis/internal/update.BuildCommit=$(git rev-parse HEAD)"
//     and .github/workflows/build.yml's Linux job runs that same
//     script, so it's covered there too. Any OTHER build path (your
//     own local Windows build steps, say) needs the same ldflag or
//     this silently does nothing for builds made that way — there's
//     no way for Check() itself to detect a build that skipped it.
//
//  2. There is no meaningful download for an ARBITRARY commit — GitHub
//     doesn't build binaries for you. The actual design: CI builds
//     and publishes to a single, continuously-overwritten
//     "latest-build" release on EVERY push to the default branch (not
//     a new tag per commit — one rolling tag, replaced each time),
//     with that release's own body recording which commit SHA it was
//     built from. Check() below reads that recorded SHA and compares
//     it to BuildCommit — if they differ, a newer build genuinely
//     exists and DownloadURL points at that same rolling release's
//     asset. .github/workflows/build.yml's "Publish rolling
//     latest-build release" step is what actually does this —
//     written and present in this repo, but (like everything in this
//     session with no live account access to verify against) not yet
//     exercised against a real GitHub Actions run.
package update

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// ProjectPath is this repo's path on github.com — "owner/repo".
const ProjectPath = "oxlaboratory/oxis"

// RolloingReleaseTag is the single, continuously-overwritten release
// tag CI publishes to on every push to the default branch — see this
// package's own doc comment above for the full design. Not a real
// semver tag; just a fixed, stable name to always fetch the same
// release from.
const RollingReleaseTag = "latest-build"

// BuildCommit is the commit SHA this binary was actually built from —
// empty unless set via -ldflags at build time (see this package's own
// doc comment for the exact flag). Left as a var, not a const,
// specifically so -ldflags -X can override it; Go's linker can only
// do that to package-level string vars.
var BuildCommit = ""

// Info is what a check returns to the frontend.
type Info struct {
	Available     bool   `json:"available"`
	CurrentCommit string `json:"currentCommit"`
	LatestCommit  string `json:"latestCommit"`
	ReleaseURL    string `json:"releaseUrl"`
	DownloadURL   string `json:"downloadUrl"` // first .exe/.msi/.deb release asset found, if any
	Notes         string `json:"notes"`
}

type ghRelease struct {
	TagName string `json:"tag_name"`
	Body    string `json:"body"`
	HTMLURL string `json:"html_url"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

var httpClient = &http.Client{Timeout: 8 * time.Second}

// commitInBody pulls a 40-character git SHA out of a release body —
// the rolling release's description is expected to record it plainly
// (e.g. "Built from commit abc123...") since GitHub's release API has
// no dedicated "source commit" field of its own.
var commitInBody = regexp.MustCompile(`\b[0-9a-f]{40}\b`)

// Check fetches ProjectPath's rolling release (RollingReleaseTag) and
// compares the commit SHA recorded in its body against BuildCommit.
// A network failure, a project with no such release yet, an empty
// BuildCommit (this binary wasn't built with the ldflag set), or no
// parsable SHA in the release body all come back as a plain
// Available:false rather than an error or a false positive — nothing
// about checking for an update should ever be able to break app
// startup or nag the user incorrectly.
func Check(_ string) Info {
	info := Info{CurrentCommit: BuildCommit}
	if BuildCommit == "" {
		return info // this binary wasn't built with the commit ldflag set — nothing to compare against
	}
	if strings.HasPrefix(ProjectPath, "REPLACE_WITH_") {
		return info // placeholder never replaced — fail soft rather than hitting a URL that can't possibly exist
	}

	endpoint := fmt.Sprintf("https://api.github.com/repos/%s/releases/tags/%s", ProjectPath, RollingReleaseTag)
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return info
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return info
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return info // includes 404 — the rolling release doesn't exist yet (CI never published one)
	}

	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return info
	}

	latestCommit := commitInBody.FindString(rel.Body)
	if latestCommit == "" {
		return info // release exists but its body doesn't record a commit SHA in the expected format
	}
	info.LatestCommit = latestCommit
	info.Notes = rel.Body
	info.ReleaseURL = rel.HTMLURL

	for _, a := range rel.Assets {
		n := strings.ToLower(a.Name)
		if strings.HasSuffix(n, ".exe") || strings.HasSuffix(n, ".msi") || strings.HasSuffix(n, ".deb") {
			info.DownloadURL = a.BrowserDownloadURL
			break
		}
	}

	// "Never advertise an update before the actual downloadable
	// artifact exists and is accessible" — a real, explicit
	// requirement, not just a nice-to-have. The old version of this
	// function set Available purely from the commit SHA comparison,
	// which meant it could report an update as available even with an
	// EMPTY DownloadURL (no matching asset found at all in the
	// release), or with a URL that LOOKS present but is actually a
	// dead/expired link. Both are now checked before Available is
	// ever set true: a real HEAD request confirms the asset URL
	// actually resolves (200), not just that GitHub's release API
	// listed something with a plausible-looking filename.
	if info.DownloadURL == "" {
		return info // commits differ, but no usable asset — nothing to actually offer, so nothing to advertise
	}
	if !artifactIsAccessible(info.DownloadURL) {
		return info // asset listed, but the actual download link doesn't resolve — same reasoning
	}

	info.Available = !strings.EqualFold(latestCommit, BuildCommit)
	return info
}

// artifactIsAccessible does a real HEAD request against the asset
// URL — the actual verification the spec requires, not just trusting
// that GitHub's release API listed a filename that looks right. A
// short timeout of its own (separate from httpClient's general one)
// since this runs as an EXTRA round trip on every single update
// check, not something that should be allowed to noticeably slow one
// down even on a slow connection.
func artifactIsAccessible(url string) bool {
	req, err := http.NewRequest(http.MethodHead, url, nil)
	if err != nil {
		return false
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
