function asRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
    return value;
}
function asString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function readUsage(record) {
    const usageRecord = asRecord(record.usage);
    if (!usageRecord)
        return null;
    const inputTokens = asNumber(usageRecord.prompt_tokens) ??
        asNumber(usageRecord.input_tokens) ??
        asNumber(usageRecord.inputTokens);
    const outputTokens = asNumber(usageRecord.completion_tokens) ??
        asNumber(usageRecord.output_tokens) ??
        asNumber(usageRecord.outputTokens);
    const cachedRecord = asRecord(usageRecord.prompt_tokens_details);
    const cachedInputTokens = asNumber(usageRecord.cached_tokens) ??
        asNumber(usageRecord.cache_read_input_tokens) ??
        asNumber(usageRecord.cachedInputTokens) ??
        asNumber(cachedRecord?.cached_tokens);
    if (inputTokens === null && outputTokens === null && cachedInputTokens === null) {
        return null;
    }
    return {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    };
}
function readCostUsd(record) {
    const usageRecord = asRecord(record.usage);
    return (asNumber(record.total_cost) ??
        asNumber(record.totalCost) ??
        asNumber(usageRecord?.total_cost) ??
        asNumber(usageRecord?.cost));
}
function readContentText(message) {
    const direct = asString(message.content);
    if (direct)
        return direct;
    const arr = message.content;
    if (Array.isArray(arr)) {
        const parts = [];
        for (const item of arr) {
            if (typeof item === "string") {
                parts.push(item);
                continue;
            }
            const rec = asRecord(item);
            if (!rec)
                continue;
            const text = asString(rec.text) ?? asString(rec.value);
            if (text)
                parts.push(text);
        }
        return parts.join("");
    }
    return "";
}
function readToolCalls(message) {
    const arr = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const rec = asRecord(arr[i]);
        if (!rec)
            continue;
        const fn = asRecord(rec.function);
        const name = asString(fn?.name);
        if (!name)
            continue;
        const argumentsRaw = asString(fn?.arguments) ?? "";
        let parsed = {};
        if (argumentsRaw.trim().length > 0) {
            try {
                parsed = JSON.parse(argumentsRaw);
            }
            catch {
                parsed = { _rawArguments: argumentsRaw };
            }
        }
        const id = asString(rec.id) ?? `call_${i}`;
        out.push({ id, name, arguments: parsed, argumentsRaw });
    }
    return out;
}
export function parseOpenRouterResponse(value) {
    const record = asRecord(value);
    const fallback = {
        id: null,
        model: null,
        text: "",
        finishReason: null,
        usage: null,
        costUsd: null,
        raw: record,
        assistant: { content: "", toolCalls: [], rawMessage: null },
    };
    if (!record)
        return fallback;
    const id = asString(record.id);
    const model = asString(record.model);
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const firstChoice = asRecord(choices[0]);
    const message = firstChoice ? asRecord(firstChoice.message) : null;
    const text = message ? readContentText(message) : "";
    const toolCalls = message ? readToolCalls(message) : [];
    const finishReason = firstChoice ? asString(firstChoice.finish_reason) : null;
    const usage = readUsage(record);
    const costUsd = readCostUsd(record);
    return {
        id,
        model,
        text,
        finishReason,
        usage,
        costUsd,
        raw: record,
        assistant: { content: text, toolCalls, rawMessage: message },
    };
}
export function isAuthError(status, body) {
    if (status === 401 || status === 403)
        return true;
    const lower = body.toLowerCase();
    return (lower.includes("invalid api key") ||
        lower.includes("authentication failed") ||
        lower.includes("missing credentials"));
}
export function isToolUseUnsupported(_status, body) {
    const lower = body.toLowerCase();
    return (lower.includes("no endpoints found that support tool use") ||
        lower.includes("does not support tools") ||
        lower.includes("tool_use is not supported") ||
        lower.includes("tools are not supported"));
}
//# sourceMappingURL=parse.js.map