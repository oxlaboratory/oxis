// Package update checks GitLab Releases for a newer OXIS build than the
// one currently running. It never tries to replace the running .exe
// itself — Windows won't let a process overwrite its own binary while
// it's executing, and OXIS ships as a plain single binary with no
// updater helper process. Instead this just tells the frontend "X is
// out, here's where to get it" so 'update can hand the user a
// download link (see App.CheckForUpdate / OpenURL in
// internal/wailsapp/app.go).
package update

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ProjectPath is this repo's path on gitlab.com — see the "This
// project deploys straight from..." comment in cloudflare/wrangler.toml
// for the canonical repo URL (gitlab.com/oxidelab/oxis).
const ProjectPath = "oxidelab/oxis"

// Info is what a check returns to the frontend.
type Info struct {
	Available   bool   `json:"available"`
	Current     string `json:"current"`
	Latest      string `json:"latest"`
	ReleaseURL  string `json:"releaseUrl"`
	DownloadURL string `json:"downloadUrl"` // first .exe/.msi release asset found, if any
	Notes       string `json:"notes"`
}

type glRelease struct {
	TagName     string `json:"tag_name"`
	Description string `json:"description"`
	Assets      struct {
		Links []struct {
			Name           string `json:"name"`
			DirectAssetURL string `json:"direct_asset_url"`
			URL            string `json:"url"`
		} `json:"links"`
	} `json:"assets"`
}

var httpClient = &http.Client{Timeout: 8 * time.Second}

// Check fetches ProjectPath's latest GitLab release and compares its
// tag against currentVersion ("1.2.1" — a leading "v" on either side
// is ignored). A network failure, a project with no releases yet, or
// an unparsable tag all come back as a plain Available:false rather
// than an error — nothing about checking for an update should ever be
// able to break app startup or nag the user with a false positive.
func Check(currentVersion string) Info {
	info := Info{Current: currentVersion}

	endpoint := fmt.Sprintf("https://gitlab.com/api/v4/projects/%s/releases/permalink/latest",
		url.PathEscape(ProjectPath))
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return info
	}
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return info
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return info // includes 404 — no releases published yet
	}

	var rel glRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return info
	}

	latest := strings.TrimPrefix(strings.TrimSpace(rel.TagName), "v")
	info.Latest = latest
	info.Notes = rel.Description
	info.ReleaseURL = fmt.Sprintf("https://gitlab.com/%s/-/releases/%s", ProjectPath, url.PathEscape(rel.TagName))

	for _, l := range rel.Assets.Links {
		n := strings.ToLower(l.Name)
		if strings.HasSuffix(n, ".exe") || strings.HasSuffix(n, ".msi") {
			info.DownloadURL = l.DirectAssetURL
			if info.DownloadURL == "" {
				info.DownloadURL = l.URL
			}
			break
		}
	}

	info.Available = isNewer(latest, strings.TrimPrefix(strings.TrimSpace(currentVersion), "v"))
	return info
}

// isNewer reports whether dotted-numeric version a is greater than b
// ("1.3.0" > "1.2.1"), comparing major/minor/patch in turn. A latest
// tag that doesn't parse as X.Y.Z never counts as newer — a malformed
// or non-version release tag on GitLab should never trigger an update
// prompt.
func isNewer(a, b string) bool {
	ap, aok := parts(a)
	if !aok {
		return false
	}
	bp, _ := parts(b) // an unparsable *current* version treats as 0.0.0, so any real tag looks newer

	for i := 0; i < 3; i++ {
		if ap[i] != bp[i] {
			return ap[i] > bp[i]
		}
	}
	return false
}

func parts(v string) ([3]int, bool) {
	var out [3]int
	if v == "" {
		return out, false
	}
	fields := strings.SplitN(v, ".", 3)
	for i, f := range fields {
		n, err := strconv.Atoi(strings.TrimSpace(f))
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}