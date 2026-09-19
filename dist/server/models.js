import { models as defaultModels } from "../index.js";
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null;
export function resetQwenOpenRouterModelsCacheForTests() {
    cache = null;
}
function asString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
async function fetchOpenRouterModels(baseUrl, apiKey, signal) {
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    const headers = {
        Accept: "application/json",
        "User-Agent": "paperclip-adapter-qwen-openrouter",
    };
    if (apiKey)
        headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(url, { method: "GET", headers, signal });
    if (!res.ok) {
        throw new Error(`OpenRouter /models returned ${res.status} ${res.statusText}`);
    }
    const body = (await res.json());
    const entries = Array.isArray(body.data) ? body.data : [];
    const defaultLabelById = new Map(defaultModels.map((m) => [m.id, m.label]));
    const extraIds = new Set(defaultModels.map((m) => m.id).filter((id) => !id.toLowerCase().startsWith("qwen/")));
    const out = [];
    const seen = new Set();
    for (const entry of entries) {
        const id = asString(entry?.id);
        if (!id)
            continue;
        const isQwen = id.toLowerCase().startsWith("qwen/");
        if (!isQwen && !extraIds.has(id))
            continue;
        if (seen.has(id))
            continue;
        seen.add(id);
        const remoteLabel = asString(entry?.name);
        out.push({ id, label: defaultLabelById.get(id) ?? remoteLabel ?? id });
    }
    out.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
    return out;
}
export async function listQwenOpenRouterModels() {
    const baseUrl = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
    const apiKey = process.env.OPENROUTER_API_KEY?.trim() || null;
    const now = Date.now();
    if (cache && now - cache.fetchedAt < MODELS_CACHE_TTL_MS) {
        return cache.models;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
        const fetched = await fetchOpenRouterModels(baseUrl, apiKey, controller.signal);
        if (fetched.length > 0) {
            cache = { fetchedAt: now, models: fetched };
            return fetched;
        }
    }
    catch {
        // Swallow — fall through to defaults.
    }
    finally {
        clearTimeout(timer);
    }
    return defaultModels;
}
//# sourceMappingURL=models.js.map