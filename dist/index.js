export const type = "qwen_openrouter";
export const label = "Qwen via OpenRouter";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_QWEN_MODEL = "qwen/qwen3-coder";
export const DEFAULT_TIMEOUT_SEC = 180;
export const models = [
    { id: "qwen/qwen3-coder", label: "Qwen3 Coder" },
    { id: "qwen/qwen3-coder:free", label: "Qwen3 Coder 480B A35B (free)" },
    { id: "qwen/qwen3-235b-a22b", label: "Qwen3 235B A22B" },
    { id: "qwen/qwen3-235b-a22b-thinking", label: "Qwen3 235B A22B Thinking" },
    { id: "qwen/qwen3-30b-a3b", label: "Qwen3 30B A3B" },
    { id: "qwen/qwen3-30b-a3b-thinking", label: "Qwen3 30B A3B Thinking" },
    { id: "qwen/qwen3-32b", label: "Qwen3 32B" },
    { id: "qwen/qwen3-14b", label: "Qwen3 14B" },
    { id: "qwen/qwen3-8b", label: "Qwen3 8B" },
    { id: "qwen/qwq-32b", label: "Qwen QwQ 32B" },
    { id: "qwen/qwen2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B" },
    { id: "qwen/qwen2.5-72b-instruct", label: "Qwen 2.5 72B" },
    { id: "google/gemma-4-31b-it:free", label: "Google Gemma 4 31B (free)" },
    { id: "google/gemma-4-26b-a4b-it:free", label: "Google Gemma 4 26B A4B (free)" },
    { id: "baidu/qianfan-ocr-fast:free", label: "Baidu Qianfan OCR Fast (free)" },
    { id: "nousresearch/hermes-3-llama-3.1-405b:free", label: "NousResearch Hermes 3 Llama 3.1 405B (free)" },
    { id: "tencent/hy3-preview:free", label: "Tencent HY3 Preview (free)" },
];
export const agentConfigurationDoc = `# qwen_openrouter agent configuration

Adapter: qwen_openrouter
Registration: external plugin (loaded via the adapter plugin system, not hardcoded)

Use when:
- You want to run Qwen models through OpenRouter without installing a local CLI
- You want a tool-loop agent that can call the Paperclip API and read/write files in its workspace
- You are happy to provide an OpenRouter API key per agent or via OPENROUTER_API_KEY

Don't use when:
- You need a CLI subprocess (use claude_local, codex_local, droid_local, opencode_local, or pi_local)
- You need streaming/SSE responses

Core fields:
- apiKey (string, optional): OpenRouter API key. If unset, the OPENROUTER_API_KEY env var is used.
- apiKeySecretRef (string, optional): name of a Paperclip-managed secret to read the OpenRouter key from at runtime.
- apiBaseUrl (string, optional): OpenRouter base URL; defaults to https://openrouter.ai/api/v1
- model (string, optional): OpenRouter model id; defaults to qwen/qwen3-coder
- temperature (number, optional): sampling temperature (0–2); omitted when blank
- maxTokens (number, optional): cap on completion tokens
- topP (number, optional): nucleus sampling
- systemPrompt (string, optional): extra system instruction prepended to every run
- siteUrl (string, optional): forwarded as HTTP-Referer for OpenRouter app attribution
- siteTitle (string, optional): forwarded as X-Title for OpenRouter app attribution

Prompt assembly fields:
- cwd (string, optional): working directory used for resolving instructionsFilePath
- instructionsFilePath (string, optional): markdown file prepended to the prompt at runtime
- promptTemplate (string, optional): heartbeat prompt template
- bootstrapPromptTemplate (string, optional): only sent on the first run for a new session

Operational fields:
- timeoutSec (number, optional): HTTP request timeout in seconds (per OpenRouter call); defaults to ${DEFAULT_TIMEOUT_SEC}
- env (object, optional): KEY=VALUE entries; OPENROUTER_API_KEY here also satisfies authentication
- providerSlug (string, optional): override the OpenRouter \`provider\` routing slug
- maxToolTurns (number, optional): cap on the tool-call/response loop per heartbeat; defaults to 12
- sessionMessageCap (number, optional): max number of conversation messages persisted across heartbeats; defaults to 40

Tool harness (v0.2+):
- This adapter runs an in-process tool loop. By default these tools are exposed to the model:
  - paperclip_api_request — authenticated HTTP requests to the Paperclip API (GET/POST/PATCH/PUT/DELETE)
  - paperclip_search_issues — search issues by free text, optionally scoped by status/project/assignee
  - fs_read_file, fs_write_file, fs_list_dir — filesystem access scoped to the adapter cwd
  - shell_exec — bash command execution (opt-in, off by default)
- Configure tools via the \`tools\` config object:
  - tools.shell.enabled (boolean): default false. Enable to expose shell_exec.
  - tools.shell.allowList (string[]): optional command-prefix allow list (e.g. ["git status", "ls"]).
  - tools.shell.timeoutSec (number): per-command timeout, default 60s.
  - tools.fs.allowOutsideCwd (boolean): default false. When true, fs_* tools accept absolute paths outside cwd.
  - tools.fs.maxBytes (number): max bytes per fs read/write, default 262144 (256 KiB).

Notes:
- The adapter persists conversation messages across heartbeats so multi-turn flows survive between wakes (capped by sessionMessageCap; subject to Paperclip's session compactor).
- Usage and cost are reported back to Paperclip when OpenRouter includes them in the response (summed across turns).
- To rotate keys, set apiKey to empty and provide OPENROUTER_API_KEY in env or the host process environment.
`;
export { createServerAdapter } from "./server/index.js";
//# sourceMappingURL=index.js.map