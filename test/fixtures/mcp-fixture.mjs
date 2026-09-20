// Serveur MCP de test : mêmes réponses en HTTP (Streamable HTTP, JSON ou SSE) et en stdio.
import http from "node:http";

export const TOOLS = [
    { name: "echo", description: "Echo the text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "read_note", description: "Read a note.", inputSchema: { type: "object", properties: { filepath: { type: "string", description: "Note path." } }, required: ["filepath"] } },
    { name: "list_dir", description: "List a folder.", inputSchema: { type: "object", properties: { dirpath: { type: "string" } } } },
    { name: "delete_note", description: "Delete a note.", annotations: { destructiveHint: true }, inputSchema: { type: "object", properties: { filepath: { type: "string" } } } },
    { name: "secret_tool", description: "Not allowed by the admin.", inputSchema: { type: "object", properties: {} } },
    { name: "boom", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
    { name: "big", description: "Large output.", inputSchema: { type: "object", properties: {} } },
    { name: "image", description: "Image output.", inputSchema: { type: "object", properties: {} } },
    { name: "server_saw", description: "Did the client refuse roots/list?", inputSchema: { type: "object", properties: {} } },
];

const text = (value, isError = false) => ({ content: [{ type: "text", text: value }], isError });

export function createHandler() {
    const state = { calls: [], toolsListCalls: 0, initializes: 0, rootsReply: null };
    const handle = (method, params) => {
        if (method === "initialize") {
            state.initializes++;
            return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
        }
        if (method === "tools/list") {
            state.toolsListCalls++;
            return params?.cursor === "2" ? { tools: TOOLS.slice(4) } : { tools: TOOLS.slice(0, 4), nextCursor: "2" };
        }
        if (method === "tools/call") {
            const { name, arguments: args } = params;
            state.calls.push({ name, args });
            switch (name) {
                case "echo": return text(`echo:${args.text}`);
                case "read_note": return text(`read:${args.filepath}`);
                case "list_dir": return text(`list:${args.dirpath ?? "(none)"}`);
                case "delete_note": return text(`deleted:${args.filepath}`);
                case "secret_tool": return text("secret");
                case "boom": return text("something broke", true);
                case "big": return text("x".repeat(5000));
                case "image": return { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "caption" }] };
                case "server_saw": return text(`roots:${JSON.stringify(state.rootsReply)}`);
            }
            const error = new Error(`unknown tool ${name}`);
            error.code = -32602;
            throw error;
        }
        const error = new Error(`unknown method ${method}`);
        error.code = -32601;
        throw error;
    };
    return { state, handle };
}

export async function startHttpServer({ token = "secret", sse = false, expireSessionOnce = false } = {}) {
    const { state, handle } = createHandler();
    const stats = { requests: 0, deletes: 0, unauthorized: 0, sessionsCreated: 0, expired: 0 };
    const sessions = new Set();
    let expireNext = expireSessionOnce;

    const server = http.createServer(async (req, res) => {
        stats.requests++;
        if (req.headers.authorization !== `Bearer ${token}`) {
            stats.unauthorized++;
            res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"unauthorized"}');
            return;
        }
        const sessionId = req.headers["mcp-session-id"];
        if (req.method === "DELETE") {
            stats.deletes++;
            sessions.delete(sessionId);
            res.writeHead(200).end();
            return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const message = JSON.parse(body);
        if (message.id === undefined) {
            if (message.method === "notifications/initialized") state.rootsReply = undefined;
            res.writeHead(202).end();
            return;
        }
        if (message.method !== "initialize" && (!sessions.has(sessionId) || (expireNext && message.method === "tools/call"))) {
            if (expireNext && message.method === "tools/call") {
                expireNext = false;
                sessions.delete(sessionId);
                stats.expired++;
            }
            res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"session not found"}');
            return;
        }
        let answer;
        const headers = {};
        try {
            answer = { jsonrpc: "2.0", id: message.id, result: handle(message.method, message.params) };
            if (message.method === "initialize") {
                const id = `session-${++stats.sessionsCreated}`;
                sessions.add(id);
                headers["Mcp-Session-Id"] = id;
            }
        }
        catch (err) {
            answer = { jsonrpc: "2.0", id: message.id, error: { code: err.code ?? -32603, message: err.message } };
        }
        if (sse) {
            res.writeHead(200, { ...headers, "Content-Type": "text/event-stream" });
            res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } })}\n\n`);
            res.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
        }
        else {
            res.writeHead(200, { ...headers, "Content-Type": "application/json" }).end(JSON.stringify(answer));
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        state,
        stats,
        close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
    };
}
