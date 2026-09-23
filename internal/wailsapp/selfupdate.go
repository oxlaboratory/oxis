package wailsapp

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
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
// the rest to the person. Real requirements this satisfies:
//
//   - Preserves the current install path — downloads to a temp file,
//     then moves the verified download to the SAME PATH the running
//     exe is already at (os.Executable()), never a different,
//     hardcoded, or "default" location.
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
func (a *App) PerformUpdate(downloadURL string) (bool, string) {
	exePath, err := os.Executable()
	if err != nil {
		return false, fmt.Sprintf("couldn't determine my own executable path: %v", err)
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return false, fmt.Sprintf("couldn't resolve my own executable path: %v", err)
	}
	exeDir := filepath.Dir(exePath)

	// 1. Download to a temp file FIRST — never touch the real
	// install location until the download is verified complete. A
	// failed/interrupted download here leaves nothing behind for the
	// running install to trip over.
	tmpFile, err := os.CreateTemp(exeDir, ".oxis-update-*.tmp")
	if err != nil {
		return false, fmt.Sprintf("couldn't create a temp file for the download: %v", err)
	}
	tmpPath := tmpFile.Name()
	// Cleanup for every early-return path below — a no-op once the
	// temp file has already been moved into place by a later step.
	defer os.Remove(tmpPath)

	downloadErr := func() error {
		defer tmpFile.Close()
		req, err := http.NewRequest(http.MethodGet, downloadURL, nil)
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
		return false, fmt.Sprintf("download failed: %v", downloadErr)
	}

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

	// 3. Move the verified download into the now-vacated install path.
	if err := os.Rename(tmpPath, exePath); err != nil {
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
