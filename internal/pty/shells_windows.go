//go:build windows

package pty

import (
	"os"
	"path/filepath"
)

func findShells() []Shell {
	exists := func(p string) bool { st, err := os.Stat(p); return err == nil && !st.IsDir() }
	first := func(paths ...string) string {
		for _, p := range paths {
			if p != "" && exists(p) {
				return p
			}
		}
		return ""
	}
	var out []Shell
	if p := first(os.Getenv("ProgramFiles")+`\PowerShell\7\pwsh.exe`, `C:\Program Files\PowerShell\7\pwsh.exe`); p != "" {
		out = append(out, Shell{Name: "pwsh", Label: "PowerShell 7", Path: p})
	}
	if p := first(os.Getenv("SystemRoot")+`\System32\WindowsPowerShell\v1.0\powershell.exe`, `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`); p != "" {
		out = append(out, Shell{Name: "powershell", Label: "Windows PowerShell", Path: p})
	}
	if p := first(
		os.Getenv("ProgramFiles")+`\Git\bin\bash.exe`,
		os.Getenv("ProgramFiles(x86)")+`\Git\bin\bash.exe`,
		filepath.Join(os.Getenv("LocalAppData"), `Programs\Git\bin\bash.exe`),
		`C:\Program Files\Git\bin\bash.exe`,
	); p != "" {
		out = append(out, Shell{Name: "gitbash", Label: "Git Bash", Path: p})
	}
	if p := first(os.Getenv("SystemRoot")+`\System32\wsl.exe`, `C:\Windows\System32\wsl.exe`); p != "" {
		out = append(out, Shell{Name: "wsl", Label: "WSL", Path: p})
	}
	if p := first(os.Getenv("SystemRoot")+`\System32\cmd.exe`, `C:\Windows\System32\cmd.exe`); p != "" {
		out = append(out, Shell{Name: "cmd", Label: "Command Prompt", Path: p})
	}
	return out
}

// shellCommand is the command line for a shell picked by name.
func shellCommand(s Shell) string {
	switch s.Name {
	case "pwsh", "powershell":
		return `"` + s.Path + `" ` + psArgs()
	case "gitbash":
		return withIntegration(`"` + s.Path + `" -i`)
	default:
		return `"` + s.Path + `"`
	}
}
