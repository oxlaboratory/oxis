package main

import (
	"log"

	"github.com/oxis/oxis/internal/wailsapp"
)

func main() {
	if err := wailsapp.Run(); err != nil {
		log.Fatalf("[oxis] error: %v", err)
	}
}
