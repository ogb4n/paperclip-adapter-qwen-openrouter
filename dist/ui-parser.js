/**
 * Self-contained UI parser for the qwen_openrouter adapter.
 *
 * Parses our adapter's structured stdout JSON lines into Paperclip
 * transcript entries. Zero runtime imports — eval'd in browser.
 */
function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function asRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
    return value;
}
function asString(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
function asNumber(value, fallback = 0) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function readUsage(parsed) {
    const usage = asRecord(parsed.usage);
    return {
        inputTokens: asNumber(usage?.inputTokens, 0),
        outputTokens: asNumber(usage?.outputTokens, 0),
        cachedTokens: asNumber(usage?.cachedInputTokens, 0),
        costUsd: asNumber(parsed.costUsd, 0),
    };
}
function parseLine(line, ts) {
    const parsed = asRecord(safeJsonParse(line));
    if (!parsed) {
        if (line.startsWith("[paperclip]")) {
            return [{ kind: "system", ts, text: line.replace(/^\[paperclip\]\s*/, "") }];
        }
        return [{ kind: "stdout", ts, text: line }];
    }
    const type = asString(parsed.type);
    if (type === "system" && asString(parsed.subtype) === "init") {
        const model = asString(parsed.model);
        const runId = asString(parsed.runId);
        return [
            {
                kind: "init",
                ts,
                model,
                sessionId: runId,
            },
        ];
    }
    if (type === "message") {
        const role = asString(parsed.role);
        const text = asString(parsed.text);
        if (!text)
            return [];
        if (role === "assistant")
            return [{ kind: "assistant", ts, text }];
        return [{ kind: "system", ts, text }];
    }
    if (type === "result") {
        const usage = readUsage(parsed);
        const finishReason = asString(parsed.finishReason);
        const isError = parsed.isError === true;
        const elapsedMs = asNumber(parsed.elapsedMs, 0);
        const summaryParts = [
            `OpenRouter completion finished${isError ? " with error" : ""}.`,
            finishReason ? `finish_reason=${finishReason}` : "",
            elapsedMs > 0 ? `elapsed=${elapsedMs}ms` : "",
        ].filter(Boolean);
        return [
            {
                kind: "result",
                ts,
                text: summaryParts.join(" "),
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cachedTokens: usage.cachedTokens,
                costUsd: usage.costUsd,
                subtype: finishReason || "completion",
                isError,
                errors: isError ? [summaryParts.join(" ")] : [],
            },
        ];
    }
    if (type === "error") {
        const text = asString(parsed.message, asString(parsed.error, line));
        return [{ kind: "stderr", ts, text }];
    }
    return [{ kind: "stdout", ts, text: line }];
}
function reset() {
    // Stateless parser
}
export { parseLine as parseStdoutLine };
export function createStdoutParser() {
    return { parseLine, reset };
}
//# sourceMappingURL=ui-parser.js.map