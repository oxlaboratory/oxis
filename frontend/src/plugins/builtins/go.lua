-- go.lua — OXIS built-in Go plugin
oxis.command("gobuild", function() oxis.run("go build ./...") end, "go build ./...")
oxis.command("gotest",  function() oxis.run("go test ./...") end, "go test ./...")
oxis.command("gotidy",  function() oxis.run("go mod tidy") end, "go mod tidy")
oxis.command("govet",   function() oxis.run("go vet ./...") end, "go vet ./...")
