// Package update checks GitHub for a newer OXIS build.
//
// "Newer" means the tip of DefaultBranch has commits that the commit
// this binary was built from (buildinfo.CommitSHA) doesn't. A binary
// that doesn't know its commit can't tell whether it's out of date; it
// only reports the latest commit.
//
// The self-updater builds from source (see wailsapp.PerformUpdate), so
// availability doesn't depend on CI having published anything. The
// rolling "latest-build" release is only used for fallback download
// links.
package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/oxis/oxis/internal/buildinfo"
)

// ProjectPath is this repo's "owner/repo" on github.com.
const ProjectPath = "oxlaboratory/oxis"

// DefaultBranch is the branch whose tip counts as "latest".
const DefaultBranch = "main"

// RollingReleaseTag is the release CI overwrites on every push to
// DefaultBranch. Only used for fallback download links.
const RollingReleaseTag = "latest-build"

// Info is what a check returns to the frontend.
type Info struct {
	Available     bool   `json:"available"`
	CurrentCommit string `json:"currentCommit"`
	LatestCommit  string `json:"latestCommit"`
	ReleaseURL    string `json:"releaseUrl"`
	DownloadURL   string `json:"downloadUrl"`  // installer (.msi / .deb) for manual download
	RawBinaryURL  string `json:"rawBinaryUrl"` // bare executable PerformUpdate can swap in
	Notes         string `json:"notes"`
	// Behind is how many commits DefaultBranch has that this build
	// doesn't, Ahead how many this build has that DefaultBranch doesn't
	// (a local build of unpushed work). -1 when GitHub couldn't say.
	Behind int `json:"behind"`
	Ahead  int `json:"ahead"`
	// Unpushed: GitHub doesn't have this build's commit (a build of local
	// work), so Behind/Ahead are unknown.
	Unpushed bool `json:"unpushed"`
	// Error says why the latest build couldn't be found (offline, rate
	// limited); empty when the check worked.
	Error string `json:"error,omitempty"`
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
	// apiBase is GitHub's API root (replaced in tests).
	apiBase = "https://api.github.com"
)

type ghCommit struct {
	SHA    string `json:"sha"`
	Commit struct {
		Committer struct {
			Date time.Time `json:"date"`
		} `json:"committer"`
	} `json:"commit"`
}

// httpStatusError is a GitHub answer other than 200.
type httpStatusError int

func (e httpStatusError) Error() string {
	if e == http.StatusForbidden || e == http.StatusTooManyRequests {
		return "GitHub's API rate limit was reached; try again in a while"
	}
	return fmt.Sprintf("GitHub answered HTTP %d", int(e))
}

type ghCompare struct {
	AheadBy  int `json:"ahead_by"`
	BehindBy int `json:"behind_by"`
	Files    []struct {
		Filename string `json:"filename"`
	} `json:"files"`
}

// notAppFiles are files that don't go into OXIS: docs, screenshots, the
// website, the Market listing, the npm launcher and tests. Commits that
// only touch these aren't an update, and CI doesn't publish a build for
// them (.github/workflows/build.yml; keep the two patterns the same).
var notAppFiles = regexp.MustCompile(`^(README\.md|CHANGELOG\.md|CONTRIBUTING\.md|LICENSE|assets/|cloudflare/|market/|npm/|\.github/ISSUE_TEMPLATE/)|_test\.go$|\.test\.ts$|\.test-util\.ts$|/testdata/`)

// changesApp says whether a comparison touches the app. GitHub lists at
// most 300 files, and none for some comparisons: both count as a change.
func (c ghCompare) changesApp() bool {
	if len(c.Files) == 0 || len(c.Files) >= 300 {
		return true
	}
	for _, f := range c.Files {
		if !notAppFiles.MatchString(f.Filename) {
			return true
		}
	}
	return false
}

// Check compares this build's commit with the tip of DefaultBranch.
// When the tip can't be fetched, Error says why and Available is false.
// A build that doesn't know its commit gets LatestCommit but never
// Available. goos picks the matching fallback assets.
func Check(goos string) Info {
	current := buildinfo.CommitSHA()
	info := Info{CurrentCommit: current, Behind: -1, Ahead: -1}
	latest, err := latestCommitOnDefaultBranch()
	if err != nil {
		info.Error = err.Error()
		return info
	}
	latestCommit := latest.SHA
	info.LatestCommit = latestCommit
	info.ReleaseURL = fmt.Sprintf("https://github.com/%s/commits/%s", ProjectPath, DefaultBranch)
	if current == "" {
		return info
	}
	if strings.EqualFold(latestCommit, current) {
		info.Behind, info.Ahead = 0, 0
		return info
	}
	if c, err := compareCommits(current, latestCommit); err == nil {
		info.Behind, info.Ahead = c.AheadBy, c.BehindBy
		// Only newer commits on the branch count: a build that is just
		// ahead of it (local work) has nothing to update to, and nor
		// does one whose newer commits are only docs or the website.
		info.Available = c.AheadBy > 0 && c.changesApp()
		info.ReleaseURL = fmt.Sprintf("https://github.com/%s/compare/%s...%s", ProjectPath, shortSHA(current), shortSHA(latestCommit))
	} else {
		var status httpStatusError
		info.Unpushed = errors.As(err, &status) && status == http.StatusNotFound
		// How the two relate is unknown (GitHub doesn't have this
		// commit, or didn't answer): a build committed after the branch
		// tip is local work, not something to replace.
		built, perr := time.Parse(time.RFC3339, buildinfo.CommitDate)
		info.Available = perr != nil || latest.Commit.Committer.Date.IsZero() || built.Before(latest.Commit.Committer.Date)
	}
	if info.Available {
		populateFallbackAssets(&info, goos)
	}
	return info
}

func shortSHA(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}

// compareCommits asks GitHub how base and head relate: AheadBy counts
// head's commits that base lacks, BehindBy the reverse.
func compareCommits(base, head string) (ghCompare, error) {
	var c ghCompare
	err := getJSON(fmt.Sprintf("%s/repos/%s/compare/%s...%s", apiBase, ProjectPath, base, head), &c)
	return c, err
}

// getJSON GETs a GitHub API endpoint into v.
func getJSON(endpoint string, v any) error {
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("couldn't reach GitHub (offline?)")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return httpStatusError(resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		return fmt.Errorf("GitHub sent an unexpected response")
	}
	return nil
}

// latestCommitOnDefaultBranch returns the branch tip.
func latestCommitOnDefaultBranch() (ghCommit, error) {
	var c ghCommit
	if err := getJSON(fmt.Sprintf("%s/repos/%s/commits/%s", apiBase, ProjectPath, DefaultBranch), &c); err != nil {
		return c, err
	}
	if c.SHA == "" {
		return c, fmt.Errorf("GitHub sent an unexpected response")
	}
	return c, nil
}

// populateFallbackAssets fills the download fields from the rolling
// release when it exists. It never affects Available.
func populateFallbackAssets(info *Info, goos string) {
	endpoint := fmt.Sprintf("%s/repos/%s/releases/tags/%s", apiBase, ProjectPath, RollingReleaseTag)
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
