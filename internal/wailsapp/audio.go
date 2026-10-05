package wailsapp

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Sound files the page can play (your own sounds for OXIS's events).
var audioTypes = map[string]string{
	".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".oga": "audio/ogg",
	".opus": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac",
	".webm": "audio/webm",
}

// A sound effect, not an album.
const maxAudioSize = 10 << 20

// ReadAudio returns a sound file as a data: URL the page can play.
func (a *App) ReadAudio(path string) (string, error) {
	full := resolvePath(path)
	mime, ok := audioTypes[strings.ToLower(filepath.Ext(full))]
	if !ok {
		return "", fmt.Errorf("%s isn't a sound OXIS can play (wav, mp3, ogg, flac, m4a)", filepath.Base(full))
	}
	info, err := os.Stat(full)
	if os.IsNotExist(err) {
		return "", fmt.Errorf("there's no %s", full)
	}
	if err != nil {
		return "", err
	}
	if info.Size() > maxAudioSize {
		return "", fmt.Errorf("%s is larger than %d MB — sounds should be short", filepath.Base(full), maxAudioSize>>20)
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(b), nil
}
