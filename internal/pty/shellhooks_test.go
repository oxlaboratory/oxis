package pty

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMarksComeInOrderWithOutput(t *testing.T) {
	var got []string
	send := func(kind, data string) { got = append(got, kind+":"+data) }
	m := newLineScreen(80, 24, send)
	m.write("out\r\n\x1b]133;D;3\x07\x1b]7;file://h/tmp\x07\x1b]0;title\x07\x1b]133;A\x07$ ")
	m.flush()
	// The title and the prompt-start mark aren't passed on.
	if want := "output:out\n|mark:133;D;3|mark:7;file://h/tmp|output:$ "; strings.Join(got, "|") != want {
		t.Errorf("got %q\nwant %q", strings.Join(got, "|"), want)
	}
}

// Windows PowerShell and PowerShell 7, whichever are installed.
func TestPowerShellIntegration(t *testing.T) {
	found := false
	for _, name := range []string{"powershell", "pwsh"} {
		if ps, err := exec.LookPath(name); err == nil {
			found = true
			t.Run(name, func(t *testing.T) { testPowerShellHook(t, ps) })
		}
	}
	if !found {
		t.Skip("no PowerShell")
	}
}

func testPowerShellHook(t *testing.T, ps string) {
	dir := filepath.Join(t.TempDir(), "a b")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	fail3 := "cmd /c exit 3"
	if runtime.GOOS != "windows" {
		fail3 = "sh -c 'exit 3'"
	}
	// The hook as OXIS passes it, then commands and prompts.
	command := psCommand() + "; " + fail3 + "; [Console]::Out.Write((prompt)); " +
		"Get-Item -LiteralPath 'no such file' -ErrorAction Continue 2>$null; [Console]::Out.Write((prompt)); " +
		"Set-Location -LiteralPath '" + dir + "'; [Console]::Out.Write((prompt))"
	out, err := runPowerShell(ps, command)
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	s := string(out)
	if !strings.Contains(s, "\x1b]133;D;3\x07") {
		t.Errorf("no exit status 3 in %q", s)
	}
	// A failed cmdlet after it is 1, not the program's leftover 3.
	if !strings.Contains(s, "\x1b]133;D;1\x07") {
		t.Errorf("no exit status 1 for the failed cmdlet in %q", s)
	}
	if !strings.Contains(s, "\x1b]133;D;0\x07\x1b]7;file://") {
		t.Errorf("no success mark and directory in %q", s)
	}
	// The directory as a file URL, with the space encoded.
	if !strings.Contains(s, "/a%20b\x07") || !strings.Contains(s, "\x1b]7;file:///") {
		t.Errorf("directory %s not in %q", dir, s)
	}
}

// runShell runs a shell as shellStart would start it, with commands on
// stdin, from an empty home folder.
func runShell(t *testing.T, name, input string, extraArgs ...string) string {
	t.Helper()
	shell, err := exec.LookPath(name)
	if err != nil || runtime.GOOS == "windows" {
		t.Skip("no " + name)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ZDOTDIR", "")
	args, env := shellStart(shell)
	cmd := exec.Command(shell, append(args, extraArgs...)...)
	cmd.Env = append(os.Environ(), env...)
	cmd.Dir = home
	cmd.Stdin = strings.NewReader(input)
	out, _ := cmd.Output()
	return string(out)
}

func checkMarks(t *testing.T, out string) {
	t.Helper()
	if !strings.Contains(out, "\x1b]133;D;1\x07") {
		t.Errorf("no exit status 1 in %q", out)
	}
	if !strings.Contains(out, "/oxis-hook-test\x07") {
		t.Errorf("no directory mark in %q", out)
	}
}

func TestBashIntegration(t *testing.T) {
	out := runShell(t, "bash", "false\nmkdir oxis-hook-test\ncd oxis-hook-test\nexit\n", "-i")
	checkMarks(t, out)
}

func TestZshIntegration(t *testing.T) {
	out := runShell(t, "zsh", "false\nmkdir oxis-hook-test\ncd oxis-hook-test\nexit\n", "-i")
	checkMarks(t, out)
}

func TestIntegrationOff(t *testing.T) {
	t.Setenv("OXIS_SHELL_INTEGRATION", "0")
	if args, env := shellStart("/bin/bash"); args != nil || env != nil {
		t.Errorf("got %q %q", args, env)
	}
	if strings.Contains(psArgs(), "__oxis") {
		t.Errorf("PowerShell still gets the hook: %s", psArgs())
	}
}

// The PowerShell hook is plain text on one command line: nothing
// encoded (security tools flag that), and nothing that would end the
// double quotes it's wrapped in or comment out the rest of the line.
func TestPowerShellCommandIsPlain(t *testing.T) {
	args := psArgs()
	for _, bad := range []string{"-EncodedCommand", "-enc ", "-ExecutionPolicy", "Invoke-Expression", "-WindowStyle"} {
		if strings.Contains(args, bad) {
			t.Errorf("PowerShell is started with %s: %s", bad, args)
		}
	}
	if strings.ContainsAny(psIntegration, "\"#`") {
		t.Errorf("the hook has a double quote, # or backtick: %s", psIntegration)
	}
	if strings.Contains(psCommand(), "\n") {
		t.Errorf("the hook isn't one line: %q", psCommand())
	}
}
