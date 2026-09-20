import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OPENROUTER_BASE_URL, DEFAULT_QWEN_MODEL } from "../index.js";
import { isAuthError, parseOpenRouterResponse } from "./parse.js";
function summarizeStatus(checks) {
    if (checks.some((c) => c.level === "error"))
        return "fail";
    if (checks.some((c) => c.level === "warn"))
        return "warn";
    return "pass";
}
function resolveEnvValue(value) {
    if (typeof value === "string")
        return value;
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
    const record = value;
    if (record.type === "plain" && typeof record.value === "string")
        return record.value;
    return null;
}
function readApiKey(config, env) {
    const fromConfig = asString(config.apiKey, "").trim();
    if (fromConfig)
        return fromConfig;
    const fromEnv = (env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "").trim();
    return fromEnv;
}
export async function testEnvironment(ctx) {
    const checks = [];
    const config = parseObject(ctx.config);
    const baseUrl = (asString(config.apiBaseUrl, process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL) || process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, "");
    const model = (asString(config.model, (process.env.PAPERCLIP_DEFAULT_MODEL || DEFAULT_QWEN_MODEL)) || (process.env.PAPERCLIP_DEFAULT_MODEL || DEFAULT_QWEN_MODEL)).trim();
    const envConfig = parseObject(config.env);
    const env = {};
    for (const [key, value] of Object.entries(envConfig)) {
        const resolved = resolveEnvValue(value);
        if (resolved !== null)
            env[key] = resolved;
    }
    const apiKey = readApiKey(config, env);
    if (!apiKey) {
        checks.push({
            code: "openrouter_api_key_missing",
            level: "error",
            message: "OpenRouter API key is not configured.",
            hint: "Set apiKey in adapter config, or provide OPENROUTER_API_KEY in adapter env / host environment.",
        });
    }
    else {
        checks.push({
            code: "openrouter_api_key_present",
            level: "info",
            message: "OpenRouter API key is configured.",
        });
    }
    if (!/^qwen\//i.test(model)) {
        checks.push({
            code: "openrouter_model_not_qwen",
            level: "warn",
            message: `Configured model "${model}" is not a Qwen model.`,
            hint: "This adapter is built for Qwen via OpenRouter. Pick a model id starting with qwen/.",
        });
    }
    else {
        checks.push({
            code: "openrouter_model_configured",
            level: "info",
            message: `Configured model: ${model}`,
        });
    }
    if (apiKey) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        try {
            const res = await fetch(`${baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                    "HTTP-Referer": "https://paperclip.ing",
                    "X-Title": "Paperclip Qwen OpenRouter Adapter (env probe)",
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: "system", content: "Reply with the single word: hello." },
                        { role: "user", content: "Respond with hello." },
                    ],
                    max_tokens: 16,
                    temperature: 0,
                }),
                signal: controller.signal,
            });
            const bodyText = await res.text();
            if (!res.ok) {
                if (isAuthError(res.status, bodyText)) {
                    checks.push({
                        code: "openrouter_auth_failed",
                        level: "error",
                        message: `OpenRouter rejected the API key (status ${res.status}).`,
                        detail: bodyText.slice(0, 240),
                        hint: "Verify the key at https://openrouter.ai/keys and ensure it has access to the chosen Qwen model.",
                    });
                }
                else {
                    checks.push({
                        code: "openrouter_probe_failed",
                        level: "error",
                        message: `OpenRouter probe failed with status ${res.status}.`,
                        detail: bodyText.slice(0, 240),
                    });
                }
            }
            else {
                let parsed;
                try {
                    parsed = parseOpenRouterResponse(JSON.parse(bodyText));
                }
                catch {
                    parsed = null;
                }
                const text = parsed?.text?.trim() ?? "";
                const hasHello = /\bhello\b/i.test(text);
                checks.push({
                    code: hasHello ? "openrouter_hello_probe_passed" : "openrouter_hello_probe_unexpected_output",
                    level: hasHello ? "info" : "warn",
                    message: hasHello
                        ? "OpenRouter Qwen probe succeeded."
                        : "OpenRouter probe ran but did not return `hello` as expected.",
                    ...(text ? { detail: text.slice(0, 240) } : {}),
                });
            }
        }
        catch (err) {
            checks.push({
                code: "openrouter_probe_error",
                level: "warn",
                message: err instanceof Error ? err.message : "OpenRouter probe failed",
                hint: "Check network access from the Paperclip host to https://openrouter.ai.",
            });
        }
        finally {
            clearTimeout(timer);
        }
    }
    return {
        adapterType: ctx.adapterType,
        status: summarizeStatus(checks),
        checks,
        testedAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=test.js.map