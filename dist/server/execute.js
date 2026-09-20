import fs from "node:fs/promises";
import path from "node:path";
import { asNumber, asString, buildPaperclipEnv, ensureAbsoluteDirectory, joinPromptSections, parseObject, redactEnvForLogs, renderTemplate, } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OPENROUTER_BASE_URL, DEFAULT_QWEN_MODEL, DEFAULT_TIMEOUT_SEC, type as ADAPTER_TYPE, } from "../index.js";
import { isAuthError, isToolUseUnsupported, parseOpenRouterResponse } from "./parse.js";
import { builtinTools, findTool, toOpenRouterTools } from "./tools/index.js";
const DEFAULT_MAX_TOOL_TURNS = 12;
const DEFAULT_SESSION_MESSAGE_CAP = 40;
const DEFAULT_FS_MAX_BYTES = 256 * 1024;
const DEFAULT_SHELL_TIMEOUT_SEC = 60;
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
function renderPaperclipEnvNote(env) {
    const paperclipKeys = Object.keys(env)
        .filter((key) => key.startsWith("PAPERCLIP_"))
        .sort();
    if (paperclipKeys.length === 0)
        return "";
    return [
        "Paperclip runtime note:",
        `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
        "Do not assume these variables are missing without checking your shell environment.",
        "",
        "",
    ].join("\n");
}
function renderToolCapabilityNote(toolNames) {
    if (toolNames.length === 0) {
        return [
            "Paperclip API access note:",
            "If your reply needs to take action, ask the operator to forward your output to a tool-capable executor — this adapter has no tools enabled for this run.",
            "",
            "",
        ].join("\n");
    }
    return [
        "Paperclip tool-loop note:",
        `You have these tools available in this turn: ${toolNames.join(", ")}.`,
        "Use paperclip_api_request for any Paperclip API call (checkout, comments, status updates). Authentication is automatic — do not pass tokens.",
        "",
        "",
    ].join("\n");
}
function renderWakeContextNote(input) {
    const lines = [];
    if (input.taskId) {
        lines.push(`- This heartbeat was triggered for issue/task ${input.taskId}. Prioritize it first if it is assigned to you.`);
    }
    if (input.wakeReason) {
        lines.push(`- Wake reason: ${input.wakeReason}.`);
    }
    if (input.wakeReason === "issue_assigned") {
        lines.push("- Do not spend a tool call checking for assigned issues before you start. This wake already identifies the task to begin with.");
    }
    if (input.wakeCommentId) {
        lines.push(`- Triggering comment id: ${input.wakeCommentId}. Read that comment thread first when relevant.`);
    }
    if (input.linkedIssueIds.length > 0) {
        lines.push(`- Linked issue ids: ${input.linkedIssueIds.join(", ")}.`);
    }
    if (input.workspaceCwd) {
        lines.push(`- Working directory for this run: ${input.workspaceCwd}.`);
    }
    if (input.workspaceSource) {
        lines.push(`- Workspace source: ${input.workspaceSource}.`);
    }
    if (lines.length === 0)
        return "";
    return ["Paperclip wake context:", ...lines, "", ""].join("\n");
}
function readBoolean(value, fallback) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string") {
        const lower = value.trim().toLowerCase();
        if (["1", "true", "yes", "y", "on"].includes(lower))
            return true;
        if (["0", "false", "no", "n", "off"].includes(lower))
            return false;
    }
    return fallback;
}
function readStringArray(value) {
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const entry of value) {
        if (typeof entry === "string" && entry.trim().length > 0)
            out.push(entry.trim());
    }
    return out.length > 0 ? out : null;
}
function readPriorMessages(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const entry of raw) {
        if (typeof entry !== "object" || entry === null)
            continue;
        const rec = entry;
        const role = rec.role;
        if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool")
            continue;
        const message = {
            role,
            content: typeof rec.content === "string" ? rec.content : rec.content === null ? null : "",
        };
        if (typeof rec.name === "string")
            message.name = rec.name;
        if (typeof rec.tool_call_id === "string")
            message.tool_call_id = rec.tool_call_id;
        if (Array.isArray(rec.tool_calls)) {
            const calls = [];
            for (const tc of rec.tool_calls) {
                if (typeof tc !== "object" || tc === null)
                    continue;
                const tcRec = tc;
                const fn = tcRec.function;
                if (!fn || typeof fn.name !== "string")
                    continue;
                calls.push({
                    id: typeof tcRec.id === "string" ? tcRec.id : `call_${calls.length}`,
                    type: "function",
                    function: {
                        name: fn.name,
                        arguments: typeof fn.arguments === "string" ? fn.arguments : "",
                    },
                });
            }
            if (calls.length > 0)
                message.tool_calls = calls;
        }
        out.push(message);
    }
    return out;
}
function capMessages(messages, cap) {
    if (messages.length <= cap)
        return messages;
    const head = messages.slice(0, 1);
    const tail = messages.slice(-(cap - head.length));
    return [...head, ...tail];
}
function mergeUsage(into, add) {
    if (!add)
        return into;
    return {
        inputTokens: (into.inputTokens ?? 0) + (add.inputTokens ?? 0),
        outputTokens: (into.outputTokens ?? 0) + (add.outputTokens ?? 0),
        ...((into.cachedInputTokens ?? 0) + (add.cachedInputTokens ?? 0) > 0
            ? { cachedInputTokens: (into.cachedInputTokens ?? 0) + (add.cachedInputTokens ?? 0) }
            : {}),
    };
}
export async function execute(ctx) {
    const { runId, agent, runtime, config, context, onLog, onMeta } = ctx;
    const promptTemplate = asString(config.promptTemplate, "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.");
    const apiBaseUrl = (asString(config.apiBaseUrl, process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL) || process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, "");
    const model = (asString(config.model, (process.env.PAPERCLIP_DEFAULT_MODEL || DEFAULT_QWEN_MODEL)) || (process.env.PAPERCLIP_DEFAULT_MODEL || DEFAULT_QWEN_MODEL)).trim();
    const temperature = config.temperature !== undefined && config.temperature !== ""
        ? asNumber(config.temperature, NaN)
        : NaN;
    const topP = config.topP !== undefined && config.topP !== ""
        ? asNumber(config.topP, NaN)
        : NaN;
    const maxTokens = config.maxTokens !== undefined && config.maxTokens !== ""
        ? asNumber(config.maxTokens, NaN)
        : NaN;
    const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
    const systemPromptOverride = asString(config.systemPrompt, "").trim();
    const siteUrl = asString(config.siteUrl, "").trim();
    const siteTitle = asString(config.siteTitle, "Paperclip").trim();
    const providerSlug = asString(config.providerSlug, "").trim();
    const toolsConfig = parseObject(config.tools);
    const shellConfig = parseObject(toolsConfig.shell);
    const fsConfig = parseObject(toolsConfig.fs);
    const shellEnabled = readBoolean(shellConfig.enabled, false);
    const shellAllowList = readStringArray(shellConfig.allowList);
    const fsAllowOutsideCwd = readBoolean(fsConfig.allowOutsideCwd, false);
    const fsMaxBytes = Math.max(1024, asNumber(fsConfig.maxBytes, DEFAULT_FS_MAX_BYTES));
    const shellTimeoutSec = Math.max(1, Math.min(600, asNumber(shellConfig.timeoutSec, DEFAULT_SHELL_TIMEOUT_SEC)));
    const maxToolTurns = Math.max(1, Math.min(300, asNumber(config.maxToolTurns, Number(process.env.PAPERCLIP_MAX_TOOL_TURNS) || DEFAULT_MAX_TOOL_TURNS)));
    const sessionMessageCap = Math.max(4, Math.min(200, asNumber(config.sessionMessageCap, DEFAULT_SESSION_MESSAGE_CAP)));
    const workspaceContext = parseObject(context.paperclipWorkspace);
    const workspaceCwd = asString(workspaceContext.cwd, "");
    const workspaceSource = asString(workspaceContext.source, "");
    const configuredCwd = asString(config.cwd, "");
    const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
    const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
    const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    const envConfig = parseObject(config.env);
    const env = {
        ...buildPaperclipEnv(agent),
        PAPERCLIP_RUN_ID: runId,
    };
    const wakeTaskId = (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
        (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
        null;
    const wakeReason = typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
        ? context.wakeReason.trim()
        : null;
    const wakeCommentId = (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
        (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
        null;
    const approvalId = typeof context.approvalId === "string" && context.approvalId.trim().length > 0
        ? context.approvalId.trim()
        : null;
    const approvalStatus = typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
        ? context.approvalStatus.trim()
        : null;
    const linkedIssueIds = Array.isArray(context.issueIds)
        ? context.issueIds.filter((value) => typeof value === "string" && value.trim().length > 0)
        : [];
    if (wakeTaskId)
        env.PAPERCLIP_TASK_ID = wakeTaskId;
    if (wakeReason)
        env.PAPERCLIP_WAKE_REASON = wakeReason;
    if (wakeCommentId)
        env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
    if (approvalId)
        env.PAPERCLIP_APPROVAL_ID = approvalId;
    if (approvalStatus)
        env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
    if (linkedIssueIds.length > 0)
        env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
    if (effectiveWorkspaceCwd)
        env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
    if (workspaceSource)
        env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
    for (const [key, value] of Object.entries(envConfig)) {
        const resolved = resolveEnvValue(value);
        if (resolved !== null)
            env[key] = resolved;
    }
    const configApiKey = asString(config.apiKey, "").trim();
    const envApiKey = (env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "").trim();
    const apiKey = configApiKey || envApiKey;
    const paperclipApiUrl = (env.PAPERCLIP_API_URL ?? process.env.PAPERCLIP_API_URL ?? "").trim() || null;
    const paperclipApiKey = (env.PAPERCLIP_API_KEY ?? ctx.authToken ?? "").trim() || null;
    const toolEnvironment = {
        cwd,
        agent,
        runId,
        paperclipApiUrl,
        paperclipApiKey,
        shellEnabled: shellEnabled || String(env.PAPERCLIP_SHELL ?? "") === "1",
        shellAllowList,
        fsAllowOutsideCwd,
        shellTimeoutSec,
        fsMaxBytes,
        env,
    };
    const enabledTools = builtinTools.filter((t) => t.enabled(toolEnvironment));
    const openRouterTools = toOpenRouterTools(builtinTools, toolEnvironment);
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath ? path.resolve(cwd, instructionsFilePath) : "";
    const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
    let instructionsPrefix = "";
    let instructionsReadFailed = false;
    if (resolvedInstructionsFilePath) {
        try {
            const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
            instructionsPrefix =
                `${instructionsContents}\n\n` +
                    `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
                    `Resolve any relative file references from ${instructionsDir}.`;
        }
        catch (err) {
            instructionsReadFailed = true;
            const reason = err instanceof Error ? err.message : String(err);
            await onLog("stdout", `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`);
        }
    }
    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
        agentId: agent.id,
        companyId: agent.companyId,
        runId,
        company: { id: agent.companyId },
        agent,
        run: { id: runId, source: "on_demand" },
        context,
    };
    const renderedPrompt = renderTemplate(promptTemplate, templateData);
    const renderedBootstrapPrompt = bootstrapPromptTemplate.trim().length > 0 ? renderTemplate(bootstrapPromptTemplate, templateData).trim() : "";
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const paperclipEnvNote = renderPaperclipEnvNote(env);
    const toolCapabilityNote = renderToolCapabilityNote(enabledTools.map((t) => t.name));
    const wakeContextNote = renderWakeContextNote({
        taskId: wakeTaskId,
        wakeReason,
        wakeCommentId,
        linkedIssueIds,
        workspaceCwd: effectiveWorkspaceCwd,
        workspaceSource,
    });
    const systemSections = [systemPromptOverride, instructionsPrefix].filter((s) => s && s.trim().length > 0);
    const systemContent = joinPromptSections(systemSections);
    const userContent = joinPromptSections([
        renderedBootstrapPrompt,
        sessionHandoffNote,
        wakeContextNote,
        paperclipEnvNote,
        toolCapabilityNote,
        renderedPrompt,
    ]);
    const priorMessages = readPriorMessages(runtime.sessionParams?.messages);
    const messages = [];
    if (priorMessages.length === 0) {
        if (systemContent.trim().length > 0)
            messages.push({ role: "system", content: systemContent });
        messages.push({ role: "user", content: userContent });
    }
    else {
        messages.push(...priorMessages);
        messages.push({ role: "user", content: userContent });
    }
    const promptMetrics = {
        systemPromptChars: systemContent.length,
        userPromptChars: userContent.length,
        instructionsChars: instructionsPrefix.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        runtimeNoteChars: wakeContextNote.length + paperclipEnvNote.length + toolCapabilityNote.length,
        heartbeatPromptChars: renderedPrompt.length,
        priorMessages: priorMessages.length,
        enabledTools: enabledTools.length,
    };
    const commandNotes = [
        `POST ${apiBaseUrl}/chat/completions with messages=${messages.length} (system=${systemContent.length}c user=${userContent.length}c).`,
        `Adapter: paperclip-adapter-qwen-openrouter (multi-turn tool loop; ${enabledTools.length} tool(s) enabled).`,
        `Tools: ${enabledTools.map((t) => t.name).join(", ") || "(none)"}.`,
        `Max tool turns: ${maxToolTurns}.`,
    ];
    if (resolvedInstructionsFilePath) {
        if (instructionsReadFailed) {
            commandNotes.push(`Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`);
        }
        else {
            commandNotes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}.`, `Prepended instructions and a relative-path directive based on ${instructionsDir}.`);
        }
    }
    if (onMeta) {
        await onMeta({
            adapterType: ADAPTER_TYPE,
            command: `${apiBaseUrl}/chat/completions`,
            cwd,
            commandNotes,
            commandArgs: ["POST", "/chat/completions", `model=${model}`],
            env: redactEnvForLogs(env),
            prompt: userContent,
            promptMetrics,
            context,
        });
    }
    if (!apiKey) {
        const message = "OpenRouter API key is not configured.";
        await onLog("stderr", `[paperclip] ${message}\n`);
        return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: message,
            errorCode: "qwen_openrouter_missing_api_key",
            provider: "openrouter",
            biller: "openrouter",
            model,
            billingType: "metered_api",
        };
    }
    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Title": siteTitle || "Paperclip Qwen OpenRouter Adapter",
    };
    if (siteUrl)
        headers["HTTP-Referer"] = siteUrl;
    const overallStartedAt = Date.now();
    await onLog("stdout", JSON.stringify({
        type: "system",
        subtype: "init",
        ts: new Date().toISOString(),
        model,
        runId,
    }) + "\n");
    let totalUsage = { inputTokens: 0, outputTokens: 0 };
    let totalCostUsd = 0;
    let lastSessionId = runtime.sessionParams?.sessionId && typeof runtime.sessionParams.sessionId === "string"
        ? runtime.sessionParams.sessionId
        : null;
    let lastModel = model;
    let lastFinishReason = null;
    let finalAssistantText = "";
    let toolsDisabled = false;
    for (let turn = 0; turn < maxToolTurns; turn++) {
        const requestBody = {
            model,
            messages,
            usage: { include: true },
        };
        if (Number.isFinite(temperature))
            requestBody.temperature = temperature;
        if (Number.isFinite(topP))
            requestBody.top_p = topP;
        if (Number.isFinite(maxTokens) && maxTokens > 0)
            requestBody.max_tokens = maxTokens;
        if (providerSlug)
            requestBody.provider = { order: [providerSlug] };
        if (!toolsDisabled && openRouterTools.length > 0) {
            requestBody.tools = openRouterTools;
            requestBody.tool_choice = "auto";
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(timeoutSec, 5) * 1000);
        const turnStartedAt = Date.now();
        let res;
        try {
            res = await fetch(`${apiBaseUrl}/chat/completions`, {
                method: "POST",
                headers,
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });
        }
        catch (err) {
            clearTimeout(timer);
            const message = err instanceof Error ? err.message : "OpenRouter request failed";
            const aborted = err instanceof Error && (err.name === "AbortError" || /aborted/i.test(message));
            await onLog("stderr", `[paperclip] OpenRouter fetch failed (turn ${turn + 1}): ${message}\n`);
            return {
                exitCode: aborted ? 124 : 1,
                signal: null,
                timedOut: aborted,
                errorMessage: aborted ? `Timed out after ${timeoutSec}s` : message,
                errorCode: aborted ? "qwen_openrouter_timeout" : "qwen_openrouter_request_failed",
                provider: "openrouter",
                biller: "openrouter",
                model,
                billingType: "metered_api",
                usage: totalUsage,
                costUsd: totalCostUsd || null,
            };
        }
        clearTimeout(timer);
        const bodyText = await res.text();
        if (!res.ok) {
            if (!toolsDisabled && isToolUseUnsupported(res.status, bodyText)) {
                toolsDisabled = true;
                await onLog("stdout", `[paperclip] Model does not support tool use — retrying without tools.\n`);
                continue;
            }
            const auth = isAuthError(res.status, bodyText);
            await onLog("stderr", `[paperclip] OpenRouter ${res.status} ${res.statusText} (turn ${turn + 1}): ${bodyText.slice(0, 1000)}\n`);
            return {
                exitCode: 1,
                signal: null,
                timedOut: false,
                errorMessage: `OpenRouter error ${res.status}: ${bodyText.slice(0, 240)}`,
                errorCode: auth ? "qwen_openrouter_auth_required" : "qwen_openrouter_http_error",
                provider: "openrouter",
                biller: "openrouter",
                model,
                billingType: "metered_api",
                usage: totalUsage,
                costUsd: totalCostUsd || null,
            };
        }
        let parsed;
        try {
            parsed = parseOpenRouterResponse(JSON.parse(bodyText));
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Invalid JSON from OpenRouter";
            await onLog("stderr", `[paperclip] ${message}\n`);
            return {
                exitCode: 1,
                signal: null,
                timedOut: false,
                errorMessage: message,
                errorCode: "qwen_openrouter_invalid_response",
                provider: "openrouter",
                biller: "openrouter",
                model,
                billingType: "metered_api",
                usage: totalUsage,
                costUsd: totalCostUsd || null,
            };
        }
        totalUsage = mergeUsage(totalUsage, parsed.usage);
        if (parsed.costUsd && Number.isFinite(parsed.costUsd))
            totalCostUsd += parsed.costUsd;
        if (parsed.id)
            lastSessionId = parsed.id;
        if (parsed.model)
            lastModel = parsed.model;
        lastFinishReason = parsed.finishReason;
        const assistantText = parsed.assistant.content ?? "";
        const toolCalls = parsed.assistant.toolCalls;
        const assistantMessage = { role: "assistant", content: assistantText || null };
        if (toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.argumentsRaw || JSON.stringify(tc.arguments ?? {}) },
            }));
        }
        messages.push(assistantMessage);
        if (assistantText.trim().length > 0) {
            await onLog("stdout", JSON.stringify({ type: "message", role: "assistant", ts: new Date().toISOString(), text: assistantText }) + "\n");
        }
        if (toolCalls.length === 0) {
            finalAssistantText = assistantText;
            break;
        }
        for (const call of toolCalls) {
            await onLog("stdout", JSON.stringify({
                type: "tool_call",
                ts: new Date().toISOString(),
                name: call.name,
                input: call.arguments,
                toolUseId: call.id,
            }) + "\n");
            const tool = findTool(builtinTools, call.name);
            let result;
            if (!tool || !tool.enabled(toolEnvironment)) {
                result = {
                    content: `tool ${call.name} is not available; enabled tools: ${enabledTools.map((t) => t.name).join(", ") || "(none)"}`,
                    isError: true,
                };
            }
            else {
                try {
                    const r = await tool.invoke(call.arguments, toolEnvironment);
                    result = { content: r.content, isError: r.isError === true || r.ok === false };
                }
                catch (err) {
                    result = {
                        content: err instanceof Error ? err.message : String(err),
                        isError: true,
                    };
                }
            }
            await onLog("stdout", JSON.stringify({
                type: "tool_result",
                ts: new Date().toISOString(),
                toolUseId: call.id,
                toolName: call.name,
                content: result.content,
                isError: result.isError,
            }) + "\n");
            messages.push({
                role: "tool",
                tool_call_id: call.id,
                name: call.name,
                content: result.content,
            });
        }
        void turnStartedAt;
    }
    const ranOutOfTurns = lastFinishReason !== "stop" && finalAssistantText === "";
    const summary = (finalAssistantText || "").trim();
    await onLog("stdout", JSON.stringify({
        type: "result",
        ts: new Date().toISOString(),
        model: lastModel ?? model,
        finishReason: lastFinishReason,
        elapsedMs: Date.now() - overallStartedAt,
        usage: totalUsage,
        costUsd: totalCostUsd || null,
        isError: ranOutOfTurns,
        ...(ranOutOfTurns ? { errors: [`Hit maxToolTurns (${maxToolTurns}) without a final assistant message.`] } : {}),
    }) + "\n");
    const cappedMessages = capMessages(messages, sessionMessageCap);
    const sessionParams = lastSessionId
        ? { sessionId: lastSessionId, model: lastModel ?? model, messages: cappedMessages }
        : null;
    return {
        exitCode: ranOutOfTurns ? 1 : 0,
        signal: null,
        timedOut: false,
        errorMessage: ranOutOfTurns ? `Hit maxToolTurns (${maxToolTurns}) without a final assistant message.` : null,
        errorCode: ranOutOfTurns ? "qwen_openrouter_tool_loop_exhausted" : null,
        sessionId: lastSessionId,
        sessionParams,
        sessionDisplayId: lastSessionId,
        provider: "openrouter",
        biller: "openrouter",
        model: lastModel ?? model,
        billingType: "metered_api",
        usage: totalUsage,
        costUsd: totalCostUsd || null,
        summary: summary || null,
    };
}
//# sourceMappingURL=execute.js.map