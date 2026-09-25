package wailsapp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// selfUpdateBackupEnv is how the OLD process tells the NEW process
// (its own replacement, launched as a separate child process — see
// PerformUpdate) where the pre-update backup of the exe lives, so the
// NEW process can delete it once IT has confirmed its own successful
// startup (see (a *App) startup in app.go, and its own doc comment
// there). An environment variable, not a file or a command-line flag
// — the simplest reliable way to hand one string to a freshly
// launched child process without building any real IPC for it.
const selfUpdateBackupEnv = "OXIS_UPDATE_BACKUP_PATH"

// PerformUpdate is the actual "replace this running exe in place"
// implementation the spec asked for — this used to not exist at all;
// 'update only ever opened a download link in the browser and left
// the rest to the person.
//
// It builds a fresh binary FROM SOURCE — clones this project's own
// GitHub repo (a plain `git clone`, no auth, same as
// cloneSourceInBackground in app.go already does for the data-dir
// fallback) and runs its real build script (scripts/build-go.js, the
// exact thing `npm run build` runs) against that clone, the same way
// a person building OXIS themselves would. Never opens a browser or
// asks the person to click anything — the whole thing runs here, in
// Go, end to end. This is the PRIMARY path; fallbackBinaryURL (from
// update.Check()'s RawBinaryURL — a prebuilt raw binary CI already
// published) is only ever used if the source build can't happen at
// all (git/node missing, clone fails, build fails) — still no browser
// link, just a plain HTTP download in Go, same as before this existed.
// If fallbackBinaryURL is empty and the source build fails, this
// reports the real reason rather than pretending to succeed.
//
// Safety guarantees, unchanged from before this used source builds:
//   - Preserves the current install path — the new binary (wherever
//     it came from) is staged into a temp file in the SAME directory
//     as the running exe, then moved into exePath itself
//     (os.Executable()), never a different, hardcoded, or "default"
//     location. This also sidesteps a real problem the source-build
//     path introduces that the old download-only version never had:
//     the freshly built binary lives wherever the git clone's own
//     temp directory landed (os.MkdirTemp's system temp dir), which
//     can be a different filesystem/volume than the install
//     directory — os.Rename across filesystems fails outright on
//     Linux (EXDEV). Staging through an in-exeDir temp file first,
//     via io.Copy, keeps the final swap a same-filesystem rename
//     either way, same as the plain-download path always was.
//   - Never leaves a partially-installed update: every failure path
//     below rolls back to the exact state before PerformUpdate was
//     called, and the very last step before reporting success is
//     confirming the NEW process actually started and is still
//     running a moment later, not just that Start() didn't return an
//     immediate error.
//   - Preserves the old install until the new one is CONFIRMED
//     working: the running exe is renamed to a backup path (Windows
//     allows renaming/moving a running exe, just not overwriting it
//     in place — this is what makes the whole approach possible at
//     all without a separate updater helper process) rather than
//     deleted, and that backup is only ever removed by the NEW
//     process itself, after ITS OWN startup has completed
//     successfully (see selfUpdateBackupEnv above) — never by this
//     function, which can't know that from the old process's side.
//
// Returns (true, "") on success, having already launched the new
// process — the CALLER (the frontend, via the PerformUpdate binding)
// is responsible for quitting the current process afterward, since
// Go code here shouldn't unilaterally kill the whole app out from
// under whatever UI state the frontend is in. Returns (false, reason)
// on any failure, having left the original exe completely untouched
// and still running exactly as before.
func (a *App) PerformUpdate(fallbackBinaryURL string) (bool, string) {
	exePath, err := os.Executable()
	if err != nil {
		return false, fmt.Sprintf("couldn't determine my own executable path: %v", err)
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return false, fmt.Sprintf("couldn't resolve my own executable path: %v", err)
	}
	exeDir := filepath.Dir(exePath)

	// 1. Get a verified new binary onto disk, in exeDir, before
	// touching the real install at all. Source build first; the
	// prebuilt download only runs if that's genuinely not possible.
	newBinaryPath, cleanupNew, buildErr := buildFromSource(exeDir)
	if buildErr != nil {
		if fallbackBinaryURL == "" {
			return false, fmt.Sprintf("couldn't build the update from source (%v), and no prebuilt fallback is available for this platform/build", buildErr)
		}
		var dlErr error
		newBinaryPath, cleanupNew, dlErr = downloadRawBinary(fallbackBinaryURL, exeDir)
		if dlErr != nil {
			return false, fmt.Sprintf("couldn't build the update from source (%v), and the prebuilt fallback download also failed (%v)", buildErr, dlErr)
		}
	}
	defer cleanupNew()

	// 2. Rename (not delete/overwrite) the CURRENTLY RUNNING exe to a
	// backup path in the same directory — this is the one step that
	// actually requires the exe to still be running, and it's safe:
	// Windows allows renaming/moving an in-use file, it just refuses
	// to delete or overwrite one in place. Everything after this
	// point either succeeds all the way through to a confirmed-working
	// new process, or gets rolled back to restore this exact file.
	backupPath := filepath.Join(exeDir, fmt.Sprintf(".oxis-update-backup-%d%s", time.Now().Unix(), filepath.Ext(exePath)))
	if err := os.Rename(exePath, backupPath); err != nil {
		return false, fmt.Sprintf("couldn't back up the current install: %v", err)
	}
	rollback := func(reason string) (bool, string) {
		// Best-effort restore — if THIS also fails, the person is left
		// without a working exe at exePath, which is exactly the
		// "bricked install" failure mode this whole function exists to
		// avoid; logged loudly rather than silently, since it's the
		// one scenario worth surfacing even without a UI to show it in.
		if restoreErr := os.Rename(backupPath, exePath); restoreErr != nil {
			return false, fmt.Sprintf("%s — AND restoring the previous version also failed (%v); your install at %s may need manual repair from backup: %s", reason, restoreErr, exePath, backupPath)
		}
		return false, reason
	}

	// 3. Move the verified new binary into the now-vacated install path.
	if err := os.Rename(newBinaryPath, exePath); err != nil {
		return rollback(fmt.Sprintf("couldn't install the new version: %v", err))
	}
	if err := os.Chmod(exePath, 0o755); err != nil {
		return rollback(fmt.Sprintf("couldn't set the new executable's permissions: %v", err))
	}

	// 4. Launch the new version as a separate process, telling it (via
	// selfUpdateBackupEnv) where its own predecessor's backup lives so
	// IT can clean that up once ITS OWN startup succeeds — never this
	// function's job, since this process has no way to know that.
	cmd := exec.Command(exePath)
	cmd.Env = append(os.Environ(), selfUpdateBackupEnv+"="+backupPath)
	cmd.Dir = exeDir
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		// The new exe is in place but wouldn't even start — restore
		// the OLD exe back over it, since a person is much better off
		// with their previous, working version than a new one that
		// can't launch at all.
		_ = os.Remove(exePath)
		return rollback(fmt.Sprintf("the new version failed to start: %v", err))
	}

	// 5. A real, if imperfect, verification that it actually launched
	// — not just that Start() returned without an error, which only
	// confirms the OS accepted the exec request, not that the process
	// didn't immediately crash on its own startup path. cmd.Wait() in
	// its own goroutine plus a select-with-timeout is the portable way
	// to ask "is it still alive after a moment" without blocking on
	// it — Unix's usual os.Process.Signal(syscall.Signal(0)) trick for
	// this doesn't work on Windows, where Signal only supports
	// os.Kill/os.Interrupt, not an arbitrary liveness probe.
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case waitErr := <-exited:
		// It exited (successfully or not) within the grace window —
		// started, then crashed almost immediately. Same rollback as
		// an outright failed Start(): restore the known-working
		// previous version rather than leave a broken one in place.
		_ = os.Remove(exePath)
		return rollback(fmt.Sprintf("the new version started but exited immediately (crashed on launch?): %v", waitErr))
	case <-time.After(2 * time.Second):
		// Still running after the grace window — the best confirmation
		// available from the old process's side that the new one
		// genuinely launched, without keeping this process alive
		// indefinitely just to babysit it further.
	}

	// New process is confirmed alive and running its own startup —
	// its OWN (a *App) startup will delete backupPath once IT is
	// fully ready (see selfUpdateBackupEnv's own doc comment); this
	// process's job is done. The caller quits the current process
	// after this returns success.
	return true, ""
}

// buildFromSource clones this project's own GitHub source (a plain,
// unauthenticated shallow clone — same URL cloneSourceInBackground in
// app.go already uses) into a fresh temp directory and runs its real
// build script against that clone: `node scripts/build-go.js`, the
// exact thing package.json's "build" script runs, and the same thing
// a person building OXIS by hand would do. Returns the path to the
// freshly built binary, STAGED into a new temp file inside dir (same
// filesystem as the caller's real install directory — see
// PerformUpdate's own doc comment for why that staging step exists),
// plus a cleanup func the caller must defer.
//
// Requires `git` and `node` on PATH — go itself does NOT need to be
// on PATH separately: scripts/build-go.js has its own findGo() that
// checks common install locations beyond PATH (see that file), so
// this only needs to find node to hand off to it. Both are checked
// up front with a clear, specific error naming which is missing,
// rather than letting a clone or build fail deep inside with a less
// obvious message.
func buildFromSource(dir string) (stagedPath string, cleanup func(), err error) {
	if _, e := exec.LookPath("git"); e != nil {
		return "", nil, fmt.Errorf("git is required to pull the latest source and isn't on PATH")
	}
	nodeBin, e := exec.LookPath("node")
	if e != nil {
		return "", nil, fmt.Errorf("node is required to build the pulled source and isn't on PATH")
	}

	cloneDir, e := os.MkdirTemp("", "oxis-source-update-*")
	if e != nil {
		return "", nil, fmt.Errorf("couldn't create a temp directory for the source clone: %w", e)
	}
	// Always cleaned up here, win or lose — nothing about the clone
	// itself is meant to survive past this function; only the final
	// staged binary (copied out below) does.
	defer os.RemoveAll(cloneDir)

	cloneCtx, cloneCancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cloneCancel()
	cloneCmd := exec.CommandContext(cloneCtx, "git", "clone", "--depth", "1",
		"https://github.com/oxlaboratory/oxis.git", cloneDir)
	hideWindow(cloneCmd)
	if out, cerr := cloneCmd.CombinedOutput(); cerr != nil {
		return "", nil, fmt.Errorf("git clone failed: %v — %s", cerr, lastLines(string(out), 10))
	}

	// The build script itself installs frontend deps, builds the
	// Vite frontend, embeds it, fetches Go modules, and compiles the
	// binary — everything `npm run build` does. A real build (full
	// npm install included) can genuinely take several minutes on a
	// cold cache, hence the generous timeout.
	buildCtx, buildCancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer buildCancel()
	buildCmd := exec.CommandContext(buildCtx, nodeBin, filepath.Join("scripts", "build-go.js"))
	buildCmd.Dir = cloneDir
	hideWindow(buildCmd)
	if out, berr := buildCmd.CombinedOutput(); berr != nil {
		return "", nil, fmt.Errorf("build failed: %v — %s", berr, lastLines(string(out), 20))
	}

	binName := "oxis"
	if runtime.GOOS == "windows" {
		binName = "oxis.exe"
	}
	built := filepath.Join(cloneDir, "dist", binName)
	fi, statErr := os.Stat(built)
	if statErr != nil {
		return "", nil, fmt.Errorf("build reported success but %s wasn't produced: %v", built, statErr)
	}
	// Same sanity floor as the download path below — a real OXIS
	// binary is genuinely many megabytes; this catches a build that
	// silently produced a stub or empty file without actually erroring.
	if fi.Size() < 1_000_000 {
		return "", nil, fmt.Errorf("built binary is only %d bytes — too small to be a real OXIS build", fi.Size())
	}

	// Stage OUT of cloneDir (which is about to be removed) and INTO
	// dir — the caller's own install directory — so the eventual
	// os.Rename into exePath is a same-filesystem move, not a
	// cross-device one. A straight copy, not a rename, since cloneDir
	// and dir are very likely on different filesystems (system temp
	// vs. wherever OXIS is installed) — renaming across them is
	// exactly the failure this sidesteps.
	return stageIntoDir(built, dir)
}

// downloadRawBinary is the ORIGINAL update mechanism, kept as the
// automatic (never a browser link — still a plain HTTP GET in Go)
// fallback for when buildFromSource can't run at all. Downloads url
// into a temp file inside dir (same filesystem as the eventual
// install path, same reasoning as buildFromSource's own staging
// step) and verifies it's a plausible binary before returning it.
func downloadRawBinary(url, dir string) (path string, cleanup func(), err error) {
	tmpFile, ferr := os.CreateTemp(dir, ".oxis-update-*.tmp")
	if ferr != nil {
		return "", nil, ferr
	}
	tmpPath := tmpFile.Name()
	cleanupFn := func() { os.Remove(tmpPath) }

	downloadErr := func() error {
		defer tmpFile.Close()
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		client := &http.Client{Timeout: 5 * time.Minute}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
		}
		n, err := io.Copy(tmpFile, resp.Body)
		if err != nil {
			return err
		}
		// A real, minimal verification that this is actually a binary
		// and not e.g. a GitHub "not found" HTML page or a truncated
		// download — there's no checksum published alongside the
		// rolling release to check against (a real gap, worth adding
		// to the CI workflow later), so size is the best available
		// signal without one: OXIS's own binary is genuinely many
		// megabytes; anything under 1MB here is almost certainly not
		// a real, complete executable.
		if n < 1_000_000 {
			return fmt.Errorf("downloaded file is only %d bytes — too small to be a real OXIS build", n)
		}
		return nil
	}()
	if downloadErr != nil {
		cleanupFn()
		return "", nil, downloadErr
	}
	return tmpPath, cleanupFn, nil
}

// stageIntoDir copies src into a new temp file inside dir and returns
// that path plus a cleanup func — used to bring a file produced
// somewhere else (a source build's own temp clone directory) onto the
// same filesystem as an eventual os.Rename target, since Go's
// os.Rename fails outright across filesystems on Linux (EXDEV).
func stageIntoDir(src, dir string) (string, func(), error) {
	in, err := os.Open(src)
	if err != nil {
		return "", nil, fmt.Errorf("couldn't open the built binary to stage it: %w", err)
	}
	defer in.Close()

	out, err := os.CreateTemp(dir, ".oxis-update-*.tmp")
	if err != nil {
		return "", nil, fmt.Errorf("couldn't create a staging file: %w", err)
	}
	outPath := out.Name()
	cleanupFn := func() { os.Remove(outPath) }

	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		cleanupFn()
		return "", nil, fmt.Errorf("couldn't stage the built binary: %w", err)
	}
	if err := out.Close(); err != nil {
		cleanupFn()
		return "", nil, fmt.Errorf("couldn't finish staging the built binary: %w", err)
	}
	return outPath, cleanupFn, nil
}

// lastLines trims cmd output down to its final n lines for error
// messages — full build/clone output can be hundreds of lines; the
// actual failure reason is almost always at the very end, and a
// multi-hundred-line error string is worse than useless in a one-line
// terminal message.
func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) <= n {
		return strings.Join(lines, "\n")
	}
	return strings.Join(lines[len(lines)-n:], "\n")
}
