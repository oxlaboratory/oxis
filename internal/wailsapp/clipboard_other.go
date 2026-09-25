//go:build !windows

package wailsapp

import (
	"bytes"
	"fmt"
	"os/exec"
	"runtime"
)

// writeClipboardNative writes to the OS clipboard with pbcopy (macOS)
// or whichever of xclip, xsel or wl-copy is installed (Linux). It's the
// fallback when the WebView's navigator.clipboard is rejected.
func writeClipboardNative(text string) error {
	var candidates [][]string
	switch runtime.GOOS {
	case "darwin":
		candidates = [][]string{{"pbcopy"}}
	default: // linux and other unix-likes
		candidates = [][]string{
			{"xclip", "-selection", "clipboard"},
			{"xsel", "--clipboard", "--input"},
			{"wl-copy"},
		}
	}

	var lastErr error = fmt.Errorf("no clipboard utility found")
	for _, argv := range candidates {
		if _, err := exec.LookPath(argv[0]); err != nil {
			lastErr = err
			continue
		}
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Stdin = bytes.NewReader([]byte(text))
		if err := cmd.Run(); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return fmt.Errorf("couldn't reach the system clipboard: %w", lastErr)
}
