-- automation.lua — chained task runner
-- Edit CHAIN below to fit your own workflow

local CHAIN = "npm run lint && npm test && npm run build"

oxis.command("chain", function() oxis.run(CHAIN) end, "run the lint -> test -> build chain defined at the top of this file")

oxis.task("chain-lint",  "npm run lint", "run just the lint step of the chain command")
oxis.task("chain-test",  "npm test", "run just the test step of the chain command")
oxis.task("chain-build", "npm run build", "run just the build step of the chain command")

oxis.keymap("normal", "<C-r>", function() oxis.run(CHAIN) end)
