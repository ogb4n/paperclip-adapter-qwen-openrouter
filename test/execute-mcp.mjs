// Teste le branchement du pont MCP dans execute() avec un faux serveur de complétions et un serveur MCP de test.
// Exige @paperclipai/adapter-utils, que fournit l'instance Paperclip : à lancer dans son conteneur, par exemple
//   docker cp . paperclip:/tmp/fork && docker exec paperclip sh -c \
//     'ln -sfn /paperclip/adapter-plugins/node_modules /tmp/fork/node_modules && node /tmp/fork/test/execute-mcp.mjs'
import http from "node:http";
import os from "node:os";
import { execute } from "../dist/server/execute.js";
import { clearDeclarationCache } from "../dist/server/mcp/session.js";
import { startHttpServer } from "./fixtures/mcp-fixture.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
};

// Faux serveur de complétions : 1re requête → l'assistant appelle mcp__fx__echo, 2e → réponse finale.
async function startFakeModel() {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        requests.push(request);
        const offered = (request.tools ?? []).map((t) => t.function.name);
        const asksForTool = requests.length === 1 && offered.includes("mcp__fx__echo");
        const message = asksForTool
            ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "mcp__fx__echo", arguments: JSON.stringify({ text: "depuis le modèle" }) } }] }
            : { role: "assistant", content: "terminé" };
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
            id: `cmpl-${requests.length}`,
            model: "fake",
            choices: [{ index: 0, message, finish_reason: asksForTool ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

async function run({ agentEnv, apiKey = "k" }) {
    const model = await startFakeModel();
    const mcp = await startHttpServer();
    clearDeclarationCache();
    Object.assign(process.env, {
        OPENROUTER_BASE_URL: model.url,
        OPENROUTER_API_KEY: apiKey,
        FIXTURE_TOKEN: "secret",
        PAPERCLIP_MCP_SERVERS: JSON.stringify({ fx: { transport: "http", url: mcp.url, tokenEnv: "FIXTURE_TOKEN", tools: { echo: {} } } }),
    });
    const logs = [];
    const result = await execute({
        runId: "run-test",
        agent: { id: "agent-1", companyId: "company-1", name: "Test" },
        runtime: { sessionParams: null },
        config: { cwd: os.tmpdir(), env: agentEnv },
        context: {},
        onLog: async (stream, text) => { logs.push(text); },
        onMeta: async () => { },
        authToken: "t",
    });
    const outcome = { result, logs: logs.join(""), model, mcp };
    await model.close();
    await mcp.close();
    return outcome;
}

{
    const { result, logs, model, mcp } = await run({ agentEnv: { PAPERCLIP_MCP: { type: "plain", value: "fx" } } });
    const offered = (model.requests[0].tools ?? []).map((t) => t.function.name);
    check("agent qui demande le serveur: l'outil MCP est proposé au modèle", offered.includes("mcp__fx__echo"), offered.join());
    check("le run réussit", result.exitCode === 0, result.errorMessage ?? "");
    check("l'appel est journalisé et le résultat revient", /"tool_result"/.test(logs) && /echo:depuis le modèle/.test(logs));
    const toolMessage = model.requests[1]?.messages.find((m) => m.role === "tool");
    check("le résultat est renvoyé au modèle au tour suivant", /echo:depuis le modèle/.test(toolMessage?.content ?? ""));
    check("la session MCP est fermée à la fin du run", mcp.stats.deletes === 1);
}
{
    const { result, model, mcp } = await run({ agentEnv: {} });
    const offered = (model.requests[0].tools ?? []).map((t) => t.function.name);
    check("agent sans PAPERCLIP_MCP: aucun outil MCP, aucune connexion", !offered.some((n) => n.startsWith("mcp__")) && mcp.stats.requests === 0, offered.join());
    check("le run réussit quand même", result.exitCode === 0);
}
{
    const { result, mcp } = await run({ agentEnv: { PAPERCLIP_MCP: { type: "plain", value: "fx" } }, apiKey: "" });
    check("sortie anticipée (clé absente): la session MCP est tout de même fermée", result.errorCode === "qwen_openrouter_missing_api_key" && mcp.stats.deletes === 1, `deletes=${mcp.stats.deletes}`);
}

console.log(failures === 0 ? "TOUS LES TESTS PASSENT" : `${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
