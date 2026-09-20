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
// ██  REPLACE BEFORE THIS WORKS  ██ — ProjectPath below is a
// placeholder ("REPLACE_WITH_YOUR_GITHUB_OWNER/REPLACE_WITH_YOUR_REPO_NAME").
// This file was written without knowing your actual GitHub repository
// path — set it to the real "owner/repo" once you have it (e.g.
// "oxidelab/oxis" if that's what the GitHub org/repo end up being).
//
// COMMIT-BASED CHECKING — WHAT THIS ACTUALLY NEEDS TO WORK, AND WHY IT
// CAN'T WORK ON ITS OWN YET:
//
//  1. BuildCommit (below) has to be set to the real commit SHA the
//     running binary was built FROM — it's empty by default, and an
//     empty BuildCommit means Check() always reports no update
//     available (never "0000..." looking newer than everything, and
//     never spuriously nagging about an update on every single launch
//     either). This means every build script needs a new step:
//     go build -ldflags "-X oxis/internal/update.BuildCommit=$(git rev-parse HEAD)" ...
//     (adjust the import path prefix — "oxis" — to match this
//     project's actual Go module name in go.mod if it differs).
//     Neither build-linux.sh nor the (to-be-written) GitHub Actions
//     workflow do this yet — see this package's own doc comment
//     wherever those files live for the matching TODO.
//
//  2. There is no meaningful download for an ARBITRARY commit — GitHub
//     doesn't build binaries for you. The intended design (this file
//     implements the CHECKING half only): CI builds and publishes to
//     a single, continuously-overwritten "latest" release/tag on
//     EVERY push to the default branch (not a new tag per commit —
//     one rolling tag, replaced each time), with that release's own
//     body/description recording which commit SHA it was built from.
//     Check() below reads that recorded SHA and compares it to
//     BuildCommit — if they differ, a newer build genuinely exists
//     and DownloadURL points at that same rolling release's asset.
//     Setting up that CI step is a real, separate piece of work this
//     file assumes already exists, not something Check() can do by
//     itself from the client side.
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
// ██ PLACEHOLDER — replace once the real GitHub repo exists. ██
const ProjectPath = "REPLACE_WITH_YOUR_GITHUB_OWNER/REPLACE_WITH_YOUR_REPO_NAME"

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

	info.Available = !strings.EqualFold(latestCommit, BuildCommit)
	return info
}
