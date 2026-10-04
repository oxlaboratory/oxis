//go:build windows

package pty

import (
	"os/exec"
	"strings"
	"syscall"
	"testing"
)

// runPowerShell runs PowerShell with `command` quoted on its command line
// exactly as buildShellCmd quotes the hook, so the quoting is tested too.
func runPowerShell(ps, command string) ([]byte, error) {
	cmd := exec.Command(ps)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine: `"` + ps + `" -NoProfile -NonInteractive -Command "` + command + `"`,
	}
	return cmd.CombinedOutput()
}

func TestCustomBashGetsIntegration(t *testing.T) {
	t.Setenv("USERPROFILE", t.TempDir())
	t.Setenv("OXIS_SHELL_INTEGRATION", "")
	for _, in := range []string{`"C:\Program Files\Git\bin\bash.exe"`, `"C:\Program Files\Git\bin\bash.exe" -i`, `bash`} {
		got := withIntegration(in)
		if !strings.Contains(got, `--rcfile`) || !strings.Contains(got, `/.oxis/shell/bashrc"`) {
			t.Errorf("%s: %s", in, got)
		}
		if strings.HasSuffix(in, "-i") != strings.HasSuffix(got, " -i") {
			t.Errorf("%s: -i lost or added: %s", in, got)
		}
	}
	// A login shell, other flags, or another program: left as they are.
	for _, in := range []string{`"C:\Program Files\Git\bin\bash.exe" --login -i`, `bash -c "echo hi"`, `cmd.exe /k`, `"C:\msys64\usr\bin\zsh.exe"`} {
		if got := withIntegration(in); got != in {
			t.Errorf("%s changed to %s", in, got)
		}
	}
	t.Setenv("OXIS_SHELL_INTEGRATION", "0")
	if got := withIntegration("bash"); got != "bash" {
		t.Errorf("integration off: %s", got)
	}
}
