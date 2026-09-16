-- ai_devops.lua — AI DevOps, OXIS's flagship premium plugin.
-- See README § AI DevOps.
--
-- Built entirely on the ordinary Lua plugin API (oxis.command with
-- real argument passing, oxis.net.request, oxis.option) — nothing
-- AI-specific lives in OXIS's core, and nothing here is a
-- placeholder: every subcommand below makes a real HTTP call to an
-- AI provider and prints its actual reply.
--
-- Needs an API key first:
--   'ai key <your-api-key>
-- Without one set, every subcommand explains that clearly instead of
-- faking a response.
--
-- Uses any OpenAI-compatible chat completions endpoint by default
-- (works with OpenAI itself, and most self-hosted/alternative
-- providers speaking the same API shape). Override with:
--   'ai endpoint <url>
--   'ai model <name>

local DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions"
local DEFAULT_MODEL = "gpt-4o-mini"

local function get_key()      return oxis.option("ai_devops_key") end
local function get_endpoint() return oxis.option("ai_devops_endpoint") or DEFAULT_ENDPOINT end
local function get_model()    return oxis.option("ai_devops_model") or DEFAULT_MODEL end

local function json_escape(s)
  s = s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', '')
  return s
end

-- Real inference call. `system` frames the task (review vs. debug vs.
-- command-generation all want different instructions), `prompt` is
-- the user's actual request/content.
local function ask(system, prompt, on_reply)
  local key = get_key()
  if not key or key == "" then
    oxis.echo("AI DevOps needs an API key first — run 'ai key <your-api-key>")
    return
  end
  if not prompt or prompt == "" then
    oxis.echo("nothing to work with — try e.g. 'ai command list all docker containers")
    return
  end

  local body = '{"model":"' .. get_model() .. '","messages":[' ..
    '{"role":"system","content":"' .. json_escape(system) .. '"},' ..
    '{"role":"user","content":"' .. json_escape(prompt) .. '"}]}'

  oxis.net.request({
    url = get_endpoint(),
    method = "POST",
    headers = { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " .. key },
    body = body,
  }, function(err, res)
    if err then
      oxis.echo("AI DevOps request failed: " .. tostring(err))
      return
    end
    if res.status ~= 200 then
      oxis.echo("AI DevOps: provider returned " .. tostring(res.status) .. " — " .. tostring(res.body):sub(1, 300))
      return
    end
    -- Targeted field extraction rather than full JSON parsing — no
    -- Lua JSON library is bundled, and an OpenAI-compatible response
    -- shape is predictable enough for this to be reliable.
    local content = res.body:match('"content"%s*:%s*"(.-)"%s*[,}]')
    if content then
      content = content:gsub('\\n', '\n'):gsub('\\"', '"')
      on_reply(content)
    else
      oxis.echo("AI DevOps: couldn't parse a response — raw reply below")
      oxis.echo(res.body:sub(1, 400))
    end
  end)
end

local SYSTEM_PROMPTS = {
  explain = "Explain this terminal/compiler error or command output clearly and concisely, including the likely root cause.",
  fix     = "The user has broken code or a failing command. Give the corrected version and a one-line reason it was broken.",
  generate= "Generate clean, correct code or a shell command for the request. Minimal commentary.",
  review  = "You are a senior engineer doing a focused code review. Point out real bugs, security issues, and unclear code. Be concise.",
  debug   = "Help debug a real failure. Give a concrete diagnosis and next step; ask a clarifying question only if truly necessary.",
  command = "Translate the request into a single correct shell command for the user's platform. Reply with ONLY the command.",
  plugin  = "You write OXIS Lua plugins. API: oxis.command(name, function(args, rest) ... end, desc), oxis.task(name, cmd, desc), oxis.run(shellCmd), oxis.echo(text), oxis.keymap(mode, combo, fn), oxis.autocmd(event, fn), oxis.fs/process/net/system.* (async callback-style, permission-gated). Generate a complete, working plugin file.",
}

oxis.command("ai", function(args, rest)
  local sub = args[1]

  if sub == "key" then
    local key = rest:match("^key%s+(.+)$")
    if not key then oxis.echo("usage: 'ai key <your-api-key>"); return end
    oxis.option("ai_devops_key", key)
    oxis.echo("AI DevOps key saved.")
    return
  end
  if sub == "endpoint" then
    local url = rest:match("^endpoint%s+(.+)$")
    if not url then oxis.echo("usage: 'ai endpoint <url>"); return end
    oxis.option("ai_devops_endpoint", url)
    oxis.echo("AI DevOps endpoint set to " .. url)
    return
  end
  if sub == "model" then
    local model = rest:match("^model%s+(.+)$")
    if not model then oxis.echo("usage: 'ai model <name>"); return end
    oxis.option("ai_devops_model", model)
    oxis.echo("AI DevOps model set to " .. model)
    return
  end

  local system = SYSTEM_PROMPTS[sub]
  if not system then
    oxis.echo("AI DevOps — try: 'ai explain, 'ai fix, 'ai generate, 'ai review, 'ai debug, 'ai command, 'ai plugin")
    oxis.echo("Config: 'ai key <key>  ·  'ai endpoint <url>  ·  'ai model <name>")
    return
  end

  local prompt = rest:match("^%S+%s+(.+)$") -- everything after the subcommand word
  ask(system, prompt, function(reply) oxis.echo(reply) end)
end, "AI DevOps — code explain/fix/generate/review/debug, command generation, plugin scaffolding")
