package pty

// Shell is one the page can ask for by Name (the setting "shell", or
// 'shell <name>): never a path or a command line, so a page can only
// start what this machine already has under a known name.
type Shell struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	Path  string `json:"path"`
}

// Shells lists the shells found on this machine, the default first.
func Shells() []Shell { return findShells() }

// shellByName is the found shell called name, if there is one.
func shellByName(name string) (Shell, bool) {
	if name == "" || name == "auto" {
		return Shell{}, false
	}
	for _, s := range findShells() {
		if s.Name == name {
			return s, true
		}
	}
	return Shell{}, false
}
