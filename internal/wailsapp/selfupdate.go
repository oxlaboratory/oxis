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

	"github.com/oxis/oxis/internal/update"
)

// selfUpdateBackupEnv tells the newly launched build where the previous
// executable was backed up, so it can delete it once it has started.
const selfUpdateBackupEnv = "OXIS_UPDATE_BACKUP_PATH"

// releaseDownloadPrefix is where prebuilt fallback binaries must come from.
const releaseDownloadPrefix = "https://github.com/" + update.ProjectPath + "/releases/download/"

// PerformUpdate replaces the running executable with a newer build.
//
// It builds from source first (shallow clone + scripts/build-go.js);
// fallbackBinaryURL, a prebuilt binary from the rolling release, is
// only used if that isn't possible (no git/node, clone or build fails).
//
// The swap is transactional:
//   - the new binary is staged in the executable's own folder so the
//     final rename never crosses filesystems;
//   - the running executable is renamed to a backup (Windows allows
//     renaming an in-use file, not overwriting it);
//   - the new build is launched and must still be running after two
//     seconds, otherwise the backup is restored;
//   - the backup is deleted by the new process itself once its startup
//     completes (cleanupSelfUpdateBackup).
//
// On success the new process is already running and the caller should
// quit this one. On failure the original install is untouched.
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

	newBinaryPath, cleanupNew, buildErr := buildFromSource(exeDir)
	if buildErr != nil {
		if fallbackBinaryURL == "" {
			return false, fmt.Sprintf("couldn't build the update from source (%v), and no prebuilt fallback is available for this platform/build", buildErr)
		}
		// The page passes the URL in, so only this project's own release
		// downloads are accepted: anything else would let a script in the
		// page swap OXIS for an arbitrary program.
		if !strings.HasPrefix(fallbackBinaryURL, releaseDownloadPrefix) {
			return false, fmt.Sprintf("refusing to install an update from %q: updates only come from %s", fallbackBinaryURL, releaseDownloadPrefix)
		}
		var dlErr error
		newBinaryPath, cleanupNew, dlErr = downloadRawBinary(fallbackBinaryURL, exeDir)
		if dlErr != nil {
			return false, fmt.Sprintf("couldn't build the update from source (%v), and the prebuilt fallback download also failed (%v)", buildErr, dlErr)
		}
	}
	defer cleanupNew()
	return installAndRestart(exePath, newBinaryPath)
}

// installAndRestart moves newBinaryPath into exePath (the current one is
// renamed to a backup first), starts it, and restores the backup if it
// can't start or exits within two seconds.
func installAndRestart(exePath, newBinaryPath string) (bool, string) {
	exeDir := filepath.Dir(exePath)
	backupPath := filepath.Join(exeDir, fmt.Sprintf(".oxis-update-backup-%d%s", time.Now().Unix(), filepath.Ext(exePath)))
	if err := os.Rename(exePath, backupPath); err != nil {
		return false, fmt.Sprintf("couldn't back up the current install: %v", err)
	}
	rollback := func(reason string) (bool, string) {
		if restoreErr := os.Rename(backupPath, exePath); restoreErr != nil {
			return false, fmt.Sprintf("%s — AND restoring the previous version also failed (%v); your install at %s may need manual repair from backup: %s", reason, restoreErr, exePath, backupPath)
		}
		return false, reason
	}

	if err := os.Rename(newBinaryPath, exePath); err != nil {
		return rollback(fmt.Sprintf("couldn't install the new version: %v", err))
	}
	if err := os.Chmod(exePath, 0o755); err != nil {
		_ = os.Remove(exePath)
		return rollback(fmt.Sprintf("couldn't set the new executable's permissions: %v", err))
	}

	// Not hideWindow: on Windows that starts the process with SW_HIDE,
	// which a GUI program's first ShowWindow obeys, so the updated OXIS
	// would run with no visible window.
	cmd := exec.Command(exePath)
	cmd.Env = append(os.Environ(), selfUpdateBackupEnv+"="+backupPath)
	cmd.Dir = exeDir
	if err := cmd.Start(); err != nil {
		_ = os.Remove(exePath)
		return rollback(fmt.Sprintf("the new version failed to start: %v", err))
	}

	// Make sure it stays up. cmd.Wait in a goroutine is the portable
	// liveness check (Signal(0) doesn't work on Windows).
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case waitErr := <-exited:
		_ = os.Remove(exePath)
		return rollback(fmt.Sprintf("the new version started but exited immediately (crashed on launch?): %v", waitErr))
	case <-time.After(2 * time.Second):
	}

	return true, ""
}

// buildFromSource shallow-clones the repo into a temp dir, runs
// `node scripts/build-go.js` there (which finds Go on its own), and
// stages the resulting binary into dir. Needs git and node on PATH.
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
	defer os.RemoveAll(cloneDir)

	cloneCtx, cloneCancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cloneCancel()
	cloneCmd := exec.CommandContext(cloneCtx, "git", "clone", "--depth", "1",
		"https://github.com/oxlaboratory/oxis.git", cloneDir)
	hideWindow(cloneCmd)
	if out, cerr := cloneCmd.CombinedOutput(); cerr != nil {
		return "", nil, fmt.Errorf("git clone failed: %v — %s", cerr, lastLines(string(out), 10))
	}

	// A cold build includes npm install, so allow plenty of time.
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
	// A real build is many megabytes; anything tiny is a broken build.
	if fi.Size() < 1_000_000 {
		return "", nil, fmt.Errorf("built binary is only %d bytes — too small to be a real OXIS build", fi.Size())
	}

	return stageIntoDir(built, dir)
}

// downloadRawBinary downloads url into a temp file inside dir and checks
// that it is plausibly a real binary.
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
		// No checksum is published, so size is the sanity check: an
		// error page or truncated download is far below 1 MB.
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

// stageIntoDir copies src into a temp file inside dir (os.Rename fails
// across filesystems on Linux).
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

// lastLines keeps the last n lines of command output for error messages.
func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) <= n {
		return strings.Join(lines, "\n")
	}
	return strings.Join(lines[len(lines)-n:], "\n")
}
