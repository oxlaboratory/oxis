// Package buildinfo holds what a build recorded about itself.
//
// scripts/buildstamp.js sets the variables through
// -ldflags "-X github.com/oxis/oxis/internal/buildinfo.<Name>=<value>"
// (build-go.js and build-linux.sh pass them). The frontend gets the
// same stamp baked in by vite.config.ts, which is what 'version shows.
package buildinfo

import (
	"runtime/debug"
	"sync"
)

var (
	Version     = "0.0.0-dev"
	Commit      = "" // full SHA of the commit built
	Tag         = "" // nearest v* tag, e.g. v1.2.1
	BuildNumber = "" // commits on the built branch
	Dirty       = "" // "true" when tracked files had uncommitted changes
	CommitDate  = "" // RFC 3339
	BuildDate   = "" // RFC 3339, UTC
	Channel     = "" // "latest-build" from CI, "source" for local builds
)

var vcsOnce sync.Once

// CommitSHA is the commit this binary was built from. A plain `go build`
// inside a git checkout isn't stamped, but Go records the revision
// itself; that is used then. Empty when neither is known.
func CommitSHA() string {
	vcsOnce.Do(func() {
		if Commit != "" {
			return
		}
		bi, ok := debug.ReadBuildInfo()
		if !ok {
			return
		}
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				Commit = s.Value
			case "vcs.modified":
				if s.Value == "true" && Dirty == "" {
					Dirty = "true"
				}
			case "vcs.time":
				if CommitDate == "" {
					CommitDate = s.Value
				}
			}
		}
	})
	return Commit
}
