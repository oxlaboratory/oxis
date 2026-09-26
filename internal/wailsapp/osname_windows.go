package wailsapp

import (
	"fmt"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// osName describes the running Windows, e.g. "Windows 11 24H2 (build
// 26100)". RtlGetVersion isn't subject to manifest version lies.
func osName() string {
	v := windows.RtlGetVersion()
	name := fmt.Sprintf("Windows %d.%d", v.MajorVersion, v.MinorVersion)
	if v.MajorVersion == 10 {
		name = "Windows 10"
		if v.BuildNumber >= 22000 {
			name = "Windows 11"
		}
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE); err == nil {
		if dv, _, err := k.GetStringValue("DisplayVersion"); err == nil && dv != "" {
			name += " " + dv
		}
		k.Close()
	}
	return fmt.Sprintf("%s (build %d)", name, v.BuildNumber)
}
