// Package update checks GitHub for a newer OXIS BUILD than the one
// currently running — "newer" now means "a different, more recent
// commit on the default branch", not a tagged semver release.
//
// Points at github.com/oxlaboratory/oxis (ProjectPath below).
//
// COMMIT-BASED CHECKING — HOW THE PIECES FIT TOGETHER:
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
//  2. Available is decided against the TRUE latest commit on
//     DefaultBranch (fetched directly from GitHub's commits API), not
//     against whatever CI last happened to publish — because the
//     actual update mechanism (selfupdate.go's PerformUpdate) doesn't
//     need a CI-built release at all anymore: it clones this same
//     source itself and builds it locally, the same way a person
//     building OXIS by hand would. So "is an update available" and
//     "did CI successfully publish a release" are genuinely
//     independent questions now, and this only answers the first one.
//
//  3. DownloadURL/RawBinaryURL are still populated, best-effort, from
//     CI's rolling "latest-build" release (see RollingReleaseTag) —
//     but purely as a FALLBACK for when the local source build can't
//     run (no git/node on PATH, say) or as a link for someone who'd
//     rather grab a prebuilt installer themselves. Their absence never
//     blocks Available; the primary update path never depends on them.
package update

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// ProjectPath is this repo's path on github.com — "owner/repo".
const ProjectPath = "oxlaboratory/oxis"

// DefaultBranch is what Available is actually checked against — the
// literal, current tip of this branch, fetched fresh on every Check()
// call. Matches build.yml's own `on: push: branches: [main]`.
const DefaultBranch = "main"

// RollingReleaseTag is the single, continuously-overwritten release
// tag CI publishes to on every push to the default branch — see this
// package's own doc comment above for the full design. Not a real
// semver tag; just a fixed, stable name to always fetch the same
// release from. Only used for the DownloadURL/RawBinaryURL fallback
// fields now, never for deciding Available.
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
	DownloadURL   string `json:"downloadUrl"`  // the platform's INSTALLER asset (.msi on Windows, .deb on Linux) — for a person to download and run themselves
	RawBinaryURL  string `json:"rawBinaryUrl"` // the platform's bare, directly-executable binary (oxis.exe / oxis) — the ONLY thing PerformUpdate can safely rename over the running exe; see pickRawBinary's own doc comment for why this has to be a separate asset from DownloadURL
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

var httpClient = &http.Client{Timeout: 8 * time.Second}

type ghCommit struct {
	SHA string `json:"sha"`
}

// Check fetches DefaultBranch's true current HEAD commit and compares
// it against BuildCommit — this IS the update-available decision now
// (see this package's own doc comment, point 2, for why it no longer
// depends on CI having published anything). A network failure, an
// empty BuildCommit (this binary wasn't built with the ldflag set), or
// any other lookup failure all come back as a plain Available:false
// rather than an error or a false positive — nothing about checking
// for an update should ever be able to break app startup or nag the
// user incorrectly.
//
// goos is runtime.GOOS from the CALLING binary (e.g. "windows",
// "linux") — used only for the DownloadURL/RawBinaryURL fallback
// lookup below, never for the Available decision itself. See
// pickAsset's own doc comment for why the fallback needs it: the
// rolling release holds every platform's build output in one place,
// so picking "the first .exe/.msi/.deb" without knowing which OS is
// asking could just as easily hand a Windows install a Linux .deb.
func Check(goos string) Info {
	info := Info{CurrentCommit: BuildCommit}
	if BuildCommit == "" {
		return info // this binary wasn't built with the commit ldflag set — nothing to compare against
	}
	if strings.HasPrefix(ProjectPath, "REPLACE_WITH_") {
		return info // placeholder never replaced — fail soft rather than hitting a URL that can't possibly exist
	}

	latestCommit := latestCommitOnDefaultBranch()
	if latestCommit == "" {
		return info // network failure, rate limit, repo moved, etc. — fail soft
	}
	info.LatestCommit = latestCommit
	info.ReleaseURL = fmt.Sprintf("https://github.com/%s/commits/%s", ProjectPath, DefaultBranch)
	info.Available = !strings.EqualFold(latestCommit, BuildCommit)

	// Everything below is the best-effort FALLBACK info (see this
	// package's own doc comment, point 3) — its absence never changes
	// Available, which is already decided above from the real source
	// commit, independent of whether CI ever published anything.
	populateFallbackAssets(&info, goos)

	return info
}

// latestCommitOnDefaultBranch fetches the true HEAD SHA of
// DefaultBranch directly from GitHub's commits API — not a release,
// not a tag, the actual current tip of the branch OXIS's own source
// build (buildFromSource in selfupdate.go) would clone. Returns "" on
// any failure; the caller treats that as "couldn't check", not "no
// commits".
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

// populateFallbackAssets fills DownloadURL/RawBinaryURL/Notes from
// CI's rolling "latest-build" release, when one exists and is
// accessible — see this package's own doc comment, point 3. Never
// touches Available; a missing or inaccessible release just leaves
// these fields empty, which the frontend/selfupdate.go already handle
// (buildFromSource is the primary path either way).
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
		return // includes 404 — the rolling release doesn't exist yet (CI never published one)
	}

	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return
	}
	info.Notes = rel.Body

	// "Never advertise a fallback download that doesn't actually
	// exist and resolve" — a real HEAD request confirms the asset URL
	// actually resolves (200), not just that GitHub's release API
	// listed something with a plausible-looking filename.
	if dl := pickAsset(rel.Assets, goos); dl != "" && artifactIsAccessible(dl) {
		info.DownloadURL = dl
	}
	if raw := pickRawBinary(rel.Assets, goos); raw != "" && artifactIsAccessible(raw) {
		info.RawBinaryURL = raw
	}
}

// pickAsset finds the release asset this OS can actually run, by file
// extension, matching exactly what build.yml's two build jobs stage
// into release-files/ for each platform:
//   - build-windows stages ONLY dist\wix\oxis-*.msi (build-msi.js's
//     WiX path — the NSIS .exe fallback only ever runs locally when
//     WiX isn't found, and CI always has WiX, so .exe is checked here
//     purely as a defensive fallback, never expected in practice).
//   - build-linux stages dist/oxis (the bare binary, no extension —
//     intentionally never matched here, it's not a self-contained
//     installer), dist/deb/oxis_*_amd64.deb, and the portable tarball.
//
// Both jobs' outputs land in the SAME rolling release (publish-release
// downloads and republishes them together), so without this a "first
// .exe/.msi/.deb found" scan could return either platform's asset
// depending purely on the order GitHub's API happened to list them in
// — a real bug this replaces, not a hypothetical one: it would have
// silently offered Windows installs a Linux .deb (or the reverse)
// whenever that order didn't happen to favor the right platform.
func pickAsset(assets []ghAsset, goos string) string {
	var exts []string
	switch goos {
	case "windows":
		exts = []string{".msi", ".exe"}
	case "linux":
		exts = []string{".deb", ".tar.gz"}
	default:
		// darwin (or anything else) — no build is produced for this
		// OS at all yet, so there is genuinely nothing to offer.
		// Returning "" here is what keeps Check() honest: no asset
		// found means Available stays false, not a mismatched link.
		return ""
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

// pickRawBinary finds the ONE asset that PerformUpdate (selfupdate.go)
// can actually use: a bare, directly-executable single-file binary at
// the exact same kind of path the running install already occupies —
// PerformUpdate's whole approach is "rename the running exe aside,
// move the downloaded file into that exact same path, then exec it",
// which only makes sense for a raw binary. It is NOT safe to use for:
//   - DownloadURL's own pick (.msi on Windows, .deb on Linux) — an
//     MSI is a Windows Installer PACKAGE, not something you can
//     rename to oxis.exe and run; msiexec has to process it, which
//     means an elevated install flow entirely separate from "swap the
//     file and relaunch". Doing that silently would overwrite the
//     real, working oxis.exe with an unrunnable MSI blob and this
//     process's own rollback would then have to undo it — this used
//     to be exactly what happened before RawBinaryURL existed as its
//     own field, since DownloadURL was the only thing PerformUpdate
//     had to work with.
//   - Linux's .deb/.tar.gz for the same reason (needs dpkg, or
//     extraction, respectively — neither is a raw binary either).
//
// windows: build-windows's CI job now also stages the raw dist\oxis.exe
// alongside the .msi (see build.yml) specifically so this has
// something to find; ".msi" is deliberately NOT matched here.
// linux: build-go.js/build-linux.sh stage the bare `dist/oxis` binary
// (no extension) into release-files/ as-is — matched by exact name,
// not just "has no extension", so this can't accidentally grab some
// unrelated extensionless file a future release might also include.
func pickRawBinary(assets []ghAsset, goos string) string {
	switch goos {
	case "windows":
		for _, a := range assets {
			n := strings.ToLower(a.Name)
			if strings.HasSuffix(n, ".exe") {
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
