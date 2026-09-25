// Package update checks GitHub for a newer OXIS build.
//
// "Newer" means the tip of DefaultBranch differs from BuildCommit, the
// commit this binary was built from (set with
// -ldflags "-X github.com/oxis/oxis/internal/update.BuildCommit=<sha>"
// by scripts/build-go.js and build-linux.sh). A binary built without
// that flag never reports an update.
//
// The self-updater builds from source (see wailsapp.PerformUpdate), so
// availability doesn't depend on CI having published anything. The
// rolling "latest-build" release is only used for fallback download
// links.
package update

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// ProjectPath is this repo's "owner/repo" on github.com.
const ProjectPath = "oxlaboratory/oxis"

// DefaultBranch is the branch whose tip counts as "latest".
const DefaultBranch = "main"

// RollingReleaseTag is the release CI overwrites on every push to
// DefaultBranch. Only used for fallback download links.
const RollingReleaseTag = "latest-build"

// BuildCommit is set via -ldflags at build time (see package doc).
var BuildCommit = ""

// Info is what a check returns to the frontend.
type Info struct {
	Available     bool   `json:"available"`
	CurrentCommit string `json:"currentCommit"`
	LatestCommit  string `json:"latestCommit"`
	ReleaseURL    string `json:"releaseUrl"`
	DownloadURL   string `json:"downloadUrl"`  // installer (.msi / .deb) for manual download
	RawBinaryURL  string `json:"rawBinaryUrl"` // bare executable PerformUpdate can swap in
	Notes         string `json:"notes"`
}

type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type ghRelease struct {
	TagName string    `json:"tag_name"`
	Body    string    `json:"body"`
	HTMLURL string    `json:"html_url"`
	Assets  []ghAsset `json:"assets"`
}

var (
	httpClient = &http.Client{Timeout: 8 * time.Second}
	headClient = &http.Client{Timeout: 5 * time.Second}
)

type ghCommit struct {
	SHA string `json:"sha"`
}

// Check compares BuildCommit with the tip of DefaultBranch. Any failure
// (offline, rate limit, no BuildCommit) returns Available=false, never
// an error. goos picks the matching fallback assets.
func Check(goos string) Info {
	info := Info{CurrentCommit: BuildCommit}
	if BuildCommit == "" {
		return info
	}

	latestCommit := latestCommitOnDefaultBranch()
	if latestCommit == "" {
		return info
	}
	info.LatestCommit = latestCommit
	info.ReleaseURL = fmt.Sprintf("https://github.com/%s/commits/%s", ProjectPath, DefaultBranch)
	info.Available = !strings.EqualFold(latestCommit, BuildCommit)

	populateFallbackAssets(&info, goos)

	return info
}

// latestCommitOnDefaultBranch returns the branch tip SHA, or "".
func latestCommitOnDefaultBranch() string {
	endpoint := fmt.Sprintf("https://api.github.com/repos/%s/commits/%s", ProjectPath, DefaultBranch)
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var c ghCommit
	if err := json.NewDecoder(resp.Body).Decode(&c); err != nil {
		return ""
	}
	return c.SHA
}

// populateFallbackAssets fills the download fields from the rolling
// release when it exists. It never affects Available.
func populateFallbackAssets(info *Info, goos string) {
	endpoint := fmt.Sprintf("https://api.github.com/repos/%s/releases/tags/%s", ProjectPath, RollingReleaseTag)
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}

	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return
	}
	info.Notes = rel.Body

	// Only advertise links that actually resolve.
	if dl := pickAsset(rel.Assets, goos); dl != "" && artifactIsAccessible(dl) {
		info.DownloadURL = dl
	}
	if raw := pickRawBinary(rel.Assets, goos); raw != "" && artifactIsAccessible(raw) {
		info.RawBinaryURL = raw
	}
}

// pickAsset returns this OS's installer from the rolling release, which
// holds every platform's output.
func pickAsset(assets []ghAsset, goos string) string {
	var exts []string
	switch goos {
	case "windows":
		exts = []string{".msi", ".exe"}
	case "linux":
		exts = []string{".deb", ".tar.gz"}
	default:
		return "" // no macOS build is published
	}
	for _, ext := range exts {
		for _, a := range assets {
			if strings.HasSuffix(strings.ToLower(a.Name), ext) {
				return a.BrowserDownloadURL
			}
		}
	}
	return ""
}

// pickRawBinary returns the bare executable (oxis.exe / oxis) that
// PerformUpdate can rename over the running binary. Installers (.msi,
// .deb, .tar.gz) are never valid here.
func pickRawBinary(assets []ghAsset, goos string) string {
	switch goos {
	case "windows":
		for _, a := range assets {
			if strings.HasSuffix(strings.ToLower(a.Name), ".exe") {
				return a.BrowserDownloadURL
			}
		}
	case "linux":
		for _, a := range assets {
			if a.Name == "oxis" {
				return a.BrowserDownloadURL
			}
		}
	}
	return ""
}

// artifactIsAccessible HEAD-checks an asset URL.
func artifactIsAccessible(url string) bool {
	req, err := http.NewRequest(http.MethodHead, url, nil)
	if err != nil {
		return false
	}
	resp, err := headClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
