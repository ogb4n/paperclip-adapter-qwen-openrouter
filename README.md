# paperclip-adapter-qwen-openrouter

Run [Qwen](https://qwenlm.ai) models in your [Paperclip](https://github.com/paperclipai/paperclip) company through [OpenRouter](https://openrouter.ai), with a built-in tool loop so the model can checkout, comment, and patch issues — no local CLI required, just an OpenRouter API key.

## What this adapter does

- Registers a new adapter type `qwen_openrouter` with Paperclip's external adapter plugin system.
- On every heartbeat, runs a multi-turn OpenRouter chat completion with `tools` enabled.
- Ships an in-process tool harness so the model can call the Paperclip API, read/write files inside its workspace, and (opt-in) execute shell commands.
- Persists the conversation between heartbeats so multi-turn flows survive across wakes (capped, with Paperclip's session compactor wired up).
- Reports model, usage, and cost when OpenRouter includes them in the response (summed across turns).
- Validates auth and connectivity with a `Test environment` probe.

## Built-in tools

| name | input | what it does |
|---|---|---|
| `paperclip_api_request` | `{method, path, body?}` | HTTPS request to `PAPERCLIP_API_URL`+path with the agent's bearer token. Use for checkout, comments, status updates. |
| `paperclip_search_issues` | `{q, status?, projectId?, assigneeAgentId?}` | Wrapper around `GET /api/companies/.../issues?q=`. |
| `fs_read_file` | `{path, offset?, limit?}` | Read a UTF-8 text file inside the adapter cwd. Path traversal blocked unless `tools.fs.allowOutsideCwd` is true. |
| `fs_write_file` | `{path, content, mode?}` | Create or overwrite a text file inside the adapter cwd. |
| `fs_list_dir` | `{path}` | Directory listing as `<type> <name>` lines. |
| `shell_exec` | `{command, timeoutSec?}` | Bash command in the adapter cwd. **Off by default**, opt-in via `tools.shell.enabled`. Honors `tools.shell.allowList` prefix matching. |

The Paperclip UI renders `tool_call` / `tool_result` events the same way it renders Claude/Codex transcripts, since the adapter emits the same NDJSON event shape as the local-CLI adapters.

## Install

In your running Paperclip instance:

```bash
# From npm
paperclipai plugin install paperclip-adapter-qwen-openrouter
# or via the API:
curl -X POST "$PAPERCLIP_API_URL/api/adapters/install" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-adapter-qwen-openrouter"}'
```

For local development:

```bash
git clone <this repo>
cd paperclip-adapter-qwen-openrouter
npm install && npm run build
curl -X POST "$PAPERCLIP_API_URL/api/adapters/install" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"packageName\":\"$(pwd)\",\"isLocalPath\":true}"
```

## Hire a Qwen agent

After install, create an agent with `adapterType: "qwen_openrouter"`. Required and optional config fields are documented in the adapter's `agentConfigurationDoc` (visible in the Paperclip agent settings UI). The most common fields:

| Field | Default | Notes |
|---|---|---|
| `apiKey` | _(none)_ | OpenRouter API key. Falls back to `OPENROUTER_API_KEY`. |
| `model` | `qwen/qwen3-coder` | Any Qwen model id available on OpenRouter that supports tool calling. |
| `apiBaseUrl` | `https://openrouter.ai/api/v1` | Override for self-hosted proxies. |
| `temperature` | _model default_ | 0–2. |
| `maxTokens` | _model default_ | Cap on completion tokens. |
| `systemPrompt` | _(empty)_ | Extra system instruction. |
| `siteUrl` | _(empty)_ | Forwarded as `HTTP-Referer`. |
| `siteTitle` | `Paperclip` | Forwarded as `X-Title`. |
| `timeoutSec` | `180` | Per-turn HTTP request timeout. |
| `maxToolTurns` | `12` | Cap on the tool-call/response loop per heartbeat. |
| `sessionMessageCap` | `40` | Max conversation messages persisted across heartbeats. |
| `tools.shell.enabled` | `false` | Opt-in to `shell_exec`. |
| `tools.shell.allowList` | _(none)_ | Optional prefix allow list, e.g. `["git status", "ls"]`. |
| `tools.shell.timeoutSec` | `60` | Per-command timeout. |
| `tools.fs.allowOutsideCwd` | `false` | Permit absolute paths outside cwd. |
| `tools.fs.maxBytes` | `262144` | Max bytes per fs read/write. |

### Example: Customer Care Agent config

```json
{
  "adapterType": "qwen_openrouter",
  "model": "qwen/qwen3-coder",
  "apiKey": "sk-or-...",
  "instructionsFilePath": "AGENTS.md",
  "tools": {
    "shell": { "enabled": false },
    "fs": { "allowOutsideCwd": false }
  }
}
```

This gives the agent paperclip API + scoped filesystem tools, but no shell access.

## How the tool loop works

Each heartbeat:

1. The adapter assembles a system prompt (your `systemPrompt` + `instructionsFilePath` contents) and a user prompt (wake context, env note, and `promptTemplate`).
2. It calls `POST /chat/completions` with `tools` and `tool_choice: "auto"`.
3. If the assistant message returns `tool_calls`, the adapter runs each one in-process, appends a `role: "tool"` result message, and loops.
4. The loop ends when the model returns a plain assistant message, the `finish_reason` is `stop`, or the configured `maxToolTurns` cap is hit.
5. The final assistant text is returned to Paperclip as the run summary, and the conversation messages are serialized into `sessionParams.messages` so the next heartbeat can resume.

The conversation is capped at `sessionMessageCap` messages; older messages are dropped from the middle (the system prompt and the most recent tail are kept). Paperclip's session compactor can also recycle the session based on `defaultSessionCompaction` (10 runs / 200k tokens / 24h).

## Local development

```bash
npm install
npm run typecheck
npm run test     # vitest-free: uses node --test, all tests in src/**/*.test.ts
npm run build    # tsc -p tsconfig.build.json — excludes *.test.ts from dist
```

Reload an installed external adapter without restarting the server:

```bash
curl -X POST "$PAPERCLIP_API_URL/api/adapters/$type/reload" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

## Migrating from 0.1.x

- 0.1.x was single-turn chat-completion only. 0.2.x adds the tool loop and session resume.
- No breaking config changes: existing agents keep working. They just gain the default tool set on next heartbeat.
- If you don't want any tools, set the model's `tool_choice` indirectly by removing `tools.*` from your agent config — the adapter will still expose tools, but the model can ignore them. (A future flag will let you pass `tool_choice: "none"`.)
- If you were depending on stateless single-turn behavior, set `sessionMessageCap` to `1` to effectively disable session reuse.

## License

MIT
