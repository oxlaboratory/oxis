package pty

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

// Shell integration: a hook that runs before each prompt and tells OXIS
// the exit status of the command that just finished (OSC 133;D) and the
// working directory (OSC 7), the way VS Code and Windows Terminal learn
// them. OXIS uses them for each command's status and to follow `cd`.
// The user's own startup files still run first; the hook only adds a
// line of escape codes to what the prompt prints. OXIS_SHELL_INTEGRATION=0
// turns it off, and a custom OXIS_SHELL never gets it.

// integrationOff says whether shell integration is turned off.
func integrationOff() bool { return os.Getenv("OXIS_SHELL_INTEGRATION") == "0" }

// psIntegration wraps PowerShell's prompt function. $? is read first,
// before anything can change it. A failed command is a cmdlet (exit
// status 1) if it added an error to $Error, else a native program,
// whose exit code is in $LASTEXITCODE ($LASTEXITCODE alone can be left
// over from an earlier program). The directory is made into a file URL
// by hand (C:\a b → file:///C:/a%20b, \\host\share → file://host/share,
// /tmp → file:///tmp): [uri] doesn't take every path on every platform.
// Nothing here may break the user's prompt, so it's all in a try.
// PSReadLine is unloaded: OXIS edits the command line itself and sends
// it whole, and PSReadLine's redrawing would garble the echo.
const psIntegration = `Remove-Module PSReadLine -ErrorAction SilentlyContinue
$global:__oxisPrompt = $function:prompt
$global:__oxisError = $Error[0]
function global:prompt {
    $ok = $?
    $mark = ''
    try {
        $newError = $Error.Count -gt 0 -and -not [object]::ReferenceEquals($Error[0], $global:__oxisError)
        $global:__oxisError = $Error[0]
        $code = if ($ok) { 0 } elseif (-not $newError -and $global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
        $e = [char]27; $b = [char]7
        $mark = "$e]133;D;$code$b"
        if ($PWD.Provider.Name -eq 'FileSystem') {
            $p = (($PWD.ProviderPath -replace '\\', '/') -split '/' | ForEach-Object { [uri]::EscapeDataString($_) -replace '%3A', ':' }) -join '/'
            $url = if ($p.StartsWith('//')) { 'file:' + $p } elseif ($p.StartsWith('/')) { 'file://' + $p } else { 'file:///' + $p }
            $mark += "$e]7;$url$b"
        }
    } catch { }
    $mark + (& $global:__oxisPrompt)
}
`

// psArgs is how PowerShell is started: no banner, stay open after the
// integration script (encoded, so no quoting can break it).
func psArgs() string {
	if integrationOff() {
		return `-NoLogo -NoExit -Command "Remove-Module PSReadLine -ErrorAction SilentlyContinue"`
	}
	return "-NoLogo -NoExit -EncodedCommand " + encodePowerShell(psIntegration)
}

// encodePowerShell encodes a script for -EncodedCommand: base64 of its
// UTF-16LE bytes.
func encodePowerShell(script string) string {
	var b bytes.Buffer
	for _, u := range utf16.Encode([]rune(script)) {
		b.WriteByte(byte(u))
		b.WriteByte(byte(u >> 8))
	}
	return base64.StdEncoding.EncodeToString(b.Bytes())
}

// bashIntegration is bash's --rcfile: the usual startup files, then the
// hook at the front of PROMPT_COMMAND (a string or, in bash 5.1+, maybe
// an array).
const bashIntegration = `# Written by OXIS for its terminal (shell integration); it is rewritten
# every time OXIS starts bash. Set OXIS_SHELL_INTEGRATION=0 to turn it off.
[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -f ~/.bashrc ] && . ~/.bashrc
__oxis_status() {
  local s=$?
  printf '\e]133;D;%s\a\e]7;file://%s%s\a' "$s" "${HOSTNAME:-}" "$PWD"
  return $s
}
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__oxis_status "${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__oxis_status${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
`

// zsh reads .zshenv and .zshrc from $ZDOTDIR: OXIS's versions read the
// user's (from their own ZDOTDIR, or home), then add the hook first in
// precmd_functions.
const zshEnvIntegration = `# Written by OXIS (shell integration). Set OXIS_SHELL_INTEGRATION=0 to turn it off.
__oxis_zdotdir=$ZDOTDIR
ZDOTDIR=${OXIS_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
OXIS_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__oxis_zdotdir
`

const zshRcIntegration = `# Written by OXIS (shell integration). Set OXIS_SHELL_INTEGRATION=0 to turn it off.
ZDOTDIR=$OXIS_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
__oxis_precmd() {
  local s=$?
  printf '\e]133;D;%s\a\e]7;file://%s%s\a' "$s" "${HOST:-}" "$PWD"
  return $s
}
precmd_functions=(__oxis_precmd $precmd_functions)
`

// fishIntegration is fish's --init-command: the status after each
// command, the directory before each prompt.
const fishIntegration = `function __oxis_status --on-event fish_postexec; printf '\e]133;D;%s\a' $status; end; ` +
	`function __oxis_cwd --on-event fish_prompt; printf '\e]7;file://%s%s\a' $hostname $PWD; end`

// shellStart returns the arguments and extra environment to start a
// Unix shell with (by its file name) so it has shell integration, or
// nothing if OXIS can't add it to that shell (or it's turned off).
func shellStart(shell string) (args, env []string) {
	if integrationOff() {
		return nil, nil
	}
	switch strings.TrimSuffix(filepath.Base(shell), ".exe") {
	case "bash":
		if path := writeHook("bashrc", bashIntegration); path != "" {
			return []string{"--rcfile", path}, nil
		}
	case "zsh":
		if writeHook(".zshenv", zshEnvIntegration) != "" && writeHook(".zshrc", zshRcIntegration) != "" {
			env = []string{"ZDOTDIR=" + hookDir()}
			if user := os.Getenv("ZDOTDIR"); user != "" {
				env = append(env, "OXIS_USER_ZDOTDIR="+user)
			}
			return nil, env
		}
	case "fish":
		return []string{"--init-command", fishIntegration}, nil
	case "pwsh":
		return []string{"-NoLogo", "-NoExit", "-EncodedCommand", encodePowerShell(psIntegration)}, nil
	}
	return nil, nil
}

// hookDir is where the startup files above are written: ~/.oxis/shell,
// which only the user can write to.
func hookDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".oxis", "shell")
}

// writeHook writes one of the startup files (if it isn't already up to
// date) and returns its path, or "" if it can't.
func writeHook(name, content string) string {
	dir := hookDir()
	if dir == "" || os.MkdirAll(dir, 0o700) != nil {
		return ""
	}
	path := filepath.Join(dir, name)
	if old, err := os.ReadFile(path); err == nil && string(old) == content {
		return path
	}
	if os.WriteFile(path, []byte(content), 0o600) != nil {
		return ""
	}
	return path
}
