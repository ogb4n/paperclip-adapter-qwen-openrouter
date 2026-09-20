// Local addition (not part of upstream paperclip-adapter-qwen-openrouter): client MCP minimal, sans dépendance.
// JSON-RPC 2.0 sur deux transports : Streamable HTTP et stdio (newline-delimited). Il n'implémente que le
// côté client des outils (initialize, tools/list, tools/call) ; les requêtes que le serveur adresse au client
// (sampling, roots) reçoivent une erreur « non supporté ».
export const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "paperclip-adapter-qwen-openrouter", version: "0.4.0-fork" };
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_CHARS = 300;
const MAX_LIST_PAGES = 20;
const STDERR_TAIL_CHARS = 1000;

export class McpError extends Error {
    // `retryable` : la session a disparu côté serveur, une nouvelle connexion peut réussir.
    constructor(message, { retryable = false } = {}) {
        super(message);
        this.name = "McpError";
        this.retryable = retryable;
    }
}

function resultOf(message) {
    if (message.error) {
        throw new McpError(`${message.error.message ?? "MCP error"} (code ${message.error.code ?? "?"})`);
    }
    return message.result;
}

async function readEventStream(res, id) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > MAX_STREAM_BYTES) throw new McpError("MCP response is too large");
            buffer += decoder.decode(value, { stream: true });
            for (let end = buffer.search(/\r?\n\r?\n/); end !== -1; end = buffer.search(/\r?\n\r?\n/)) {
                const event = buffer.slice(0, end);
                buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
                const data = event
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).replace(/^ /, ""))
                    .join("\n");
                if (!data) continue;
                let message;
                try {
                    message = JSON.parse(data);
                }
                catch {
                    continue;
                }
                const answer = Array.isArray(message) ? message.find((m) => m?.id === id) : message?.id === id ? message : null;
                if (answer && ("result" in answer || "error" in answer)) return answer;
            }
        }
    }
    finally {
        reader.cancel().catch(() => { });
    }
    throw new McpError("MCP stream ended without an answer");
}

export function httpTransport({ url, token, timeoutMs, fetchImpl = fetch }) {
    let sessionId = null;
    let protocolVersion = null;
    let nextId = 1;

    const headers = () => ({
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
    });
    // Pas de redirection : un jeton ne doit jamais suivre le serveur vers un autre hôte.
    const post = (body) => fetchImpl(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
    });
    const refuse = async (res) => {
        const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, MAX_ERROR_BODY_CHARS);
        throw new McpError(`MCP server answered HTTP ${res.status}${text ? `: ${text}` : ""}`, { retryable: res.status === 404 && sessionId !== null });
    };

    return {
        setProtocolVersion(version) {
            protocolVersion = version;
        },
        async request(method, params) {
            const id = nextId++;
            const res = await post({ jsonrpc: "2.0", id, method, params });
            sessionId = res.headers.get("mcp-session-id") ?? sessionId;
            if (!res.ok) await refuse(res);
            if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
                return resultOf(await readEventStream(res, id));
            }
            const body = await res.json();
            const answer = Array.isArray(body) ? body.find((m) => m?.id === id) : body;
            if (!answer) throw new McpError("MCP server did not answer the request");
            return resultOf(answer);
        },
        async notify(method, params) {
            const res = await post({ jsonrpc: "2.0", method, params });
            if (!res.ok) await refuse(res);
            await res.body?.cancel().catch(() => { });
        },
        async close() {
            if (!sessionId) return;
            await fetchImpl(url, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(3000), redirect: "error" })
                .then((res) => res.body?.cancel())
                .catch(() => { });
        },
    };
}

// `child` : processus déjà lancé (stdin, stdout, stderr, kill). Le lanceur reste à l'appelant, qui décide OÙ
// le serveur tourne : ici, seulement dans le bac à sable.
export function stdioTransport({ child, timeoutMs }) {
    const pending = new Map();
    let nextId = 1;
    let buffer = "";
    let stderrTail = "";
    let exited = null;

    const write = (message) => {
        if (exited) throw new McpError(`MCP server exited${exited.detail}`);
        child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const settleAll = (error) => {
        for (const { reject, timer } of pending.values()) {
            clearTimeout(timer);
            reject(error);
        }
        pending.clear();
    };
    const onLine = (line) => {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            return;
        }
        if (message.method && message.id !== undefined) {
            const reply = message.method === "ping" ? { result: {} } : { error: { code: -32601, message: "not supported by this client" } };
            try {
                write({ jsonrpc: "2.0", id: message.id, ...reply });
            }
            catch { /* le serveur est parti */ }
            return;
        }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        try {
            entry.resolve(resultOf(message));
        }
        catch (err) {
            entry.reject(err);
        }
    };

    child.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (line) onLine(line);
        }
    });
    child.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    child.on("close", (code, signal) => {
        const tail = stderrTail.trim();
        exited = { detail: ` (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ""}` };
        settleAll(new McpError(`MCP server exited${exited.detail}`));
    });
    child.on("error", (err) => {
        exited = { detail: `: ${err.message}` };
        settleAll(new McpError(`MCP server could not start${exited.detail}`));
    });
    child.stdin.on("error", () => { });

    return {
        request(method, params) {
            return new Promise((resolve, reject) => {
                const id = nextId++;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new McpError(`MCP server did not answer within ${Math.round(timeoutMs / 1000)}s`));
                }, timeoutMs);
                pending.set(id, { resolve, reject, timer });
                try {
                    write({ jsonrpc: "2.0", id, method, params });
                }
                catch (err) {
                    pending.delete(id);
                    clearTimeout(timer);
                    reject(err);
                }
            });
        },
        async notify(method, params) {
            write({ jsonrpc: "2.0", method, params });
        },
        async close() {
            if (exited) return;
            child.stdin.end();
            const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
            timer.unref();
            await new Promise((resolve) => {
                child.once("close", resolve);
                setTimeout(resolve, 3000).unref();
            });
            clearTimeout(timer);
        },
    };
}

export async function openClient(transport) {
    const init = await transport.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    transport.setProtocolVersion?.(init?.protocolVersion ?? PROTOCOL_VERSION);
    await transport.notify("notifications/initialized");
    return {
        async listTools() {
            const tools = [];
            let cursor;
            for (let page = 0; page < MAX_LIST_PAGES; page++) {
                const answer = await transport.request("tools/list", cursor ? { cursor } : {});
                tools.push(...(Array.isArray(answer?.tools) ? answer.tools : []));
                cursor = answer?.nextCursor;
                if (!cursor) break;
            }
            return tools;
        },
        callTool: (name, args) => transport.request("tools/call", { name, arguments: args }),
        close: () => transport.close(),
    };
}
