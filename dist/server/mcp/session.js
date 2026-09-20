// Local addition (not part of upstream paperclip-adapter-qwen-openrouter): pont entre la boucle d'outils de
// l'adaptateur et des serveurs MCP.
//
// Configuration (environnement du SERVEUR Paperclip, jamais celui d'un agent) : PAPERCLIP_MCP_SERVERS, un objet JSON
//   { "<nom>": { "transport": "http", "url": "http://hôte:port/mcp", "tokenEnv": "NOM_DE_VARIABLE",
//                "default": false, "timeoutSec": 30, "maxResultBytes": 16384,
//                "tools": { "<outil>": { "confine": { "<argument>": "Dossier/" }, "allowDestructive": false } } },
//     "<nom>": { "transport": "stdio", "command": "npx -y …", "lifetimeSec": 900, "tools": { … } } }
// Un serveur `stdio` s'exécute dans le bac à sable par SSH (comme shell_exec) et n'y reçoit aucun secret ;
// un serveur `http` doit être joignable depuis le conteneur, son jeton vient de la variable `tokenEnv`.
// Un agent obtient les serveurs `default`, plus ceux que nomme sa variable d'environnement PAPERCLIP_MCP.
import { McpError, httpTransport, openClient, stdioTransport } from "./client.js";
import { confineArguments, declareTools, parseServers, selectServers, shapeResult } from "./policy.js";
import { spawnRemote as defaultSpawnRemote } from "../tools/shell.js";

const CACHE_TTL_MS = 10 * 60_000;
// Déclarations d'outils gardées entre les runs : un run qui n'appelle aucun outil MCP ne relance donc pas
// de serveur stdio. Clé = nom + définition, une modification de la configuration invalide l'entrée.
const declarationCache = new Map();

const EMPTY_SESSION = { tools: [], close: async () => { } };

export function clearDeclarationCache() {
    declarationCache.clear();
}

export async function openMcpSession({ env = {}, cwd = "/", onLog = async () => { }, serverEnv = process.env, deps = {} }) {
    const raw = (serverEnv.PAPERCLIP_MCP_SERVERS ?? "").trim();
    if (!raw) return EMPTY_SESSION;
    const log = (text) => onLog("stderr", `[paperclip] MCP: ${text}\n`);

    const { servers, errors } = parseServers(raw);
    for (const error of errors) await log(error);
    const { selected, unknown } = selectServers(servers, env.PAPERCLIP_MCP);
    for (const name of unknown) await log(`this agent asks for "${name}", which is not configured`);
    if (selected.length === 0) return EMPTY_SESSION;

    const spawnRemote = deps.spawnRemote ?? defaultSpawnRemote;
    const connections = new Map();

    const connect = (name) => {
        if (!connections.has(name)) {
            const cfg = servers.get(name);
            const pending = openServerClient(cfg).catch((err) => {
                connections.delete(name);
                throw err;
            });
            connections.set(name, pending);
        }
        return connections.get(name);
    };
    const disconnect = async (name) => {
        const pending = connections.get(name);
        connections.delete(name);
        await pending?.then((client) => client.close()).catch(() => { });
    };

    async function openServerClient(cfg) {
        const timeoutMs = cfg.timeoutSec * 1000;
        let transport;
        if (cfg.transport === "http") {
            const token = cfg.tokenEnv ? (serverEnv[cfg.tokenEnv] ?? "").trim() : "";
            if (cfg.tokenEnv && !token) throw new McpError(`the token variable ${cfg.tokenEnv} is empty on the server`);
            transport = httpTransport({ url: cfg.url, token, timeoutMs, fetchImpl: deps.fetch });
        }
        else {
            if (!(serverEnv.PAPERCLIP_SHELL_SSH_TARGET ?? "").trim() && !deps.spawnRemote) {
                throw new McpError("stdio servers run in the sandbox, and none is configured (PAPERCLIP_SHELL_SSH_TARGET)");
            }
            transport = stdioTransport({ child: spawnRemote(cfg.command, cwd, cfg.lifetimeSec), timeoutMs });
        }
        try {
            return await openClient(transport);
        }
        catch (err) {
            await transport.close().catch(() => { });
            throw err;
        }
    }

    async function declarations(name) {
        const cfg = servers.get(name);
        const key = `${name}:${cfg.transport}:${cfg.url ?? cfg.command}:${JSON.stringify([...cfg.tools])}`;
        const cached = declarationCache.get(key);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.declared;
        const client = await connect(name);
        const { declared, warnings } = declareTools(name, cfg, await client.listTools());
        for (const warning of warnings) await log(warning);
        declarationCache.set(key, { at: Date.now(), declared });
        return declared;
    }

    function toTool(name, cfg, declaration) {
        return {
            name: declaration.name,
            description: declaration.description,
            parameters: declaration.parameters,
            enabled: () => true,
            async invoke(input) {
                let args;
                try {
                    args = confineArguments(declaration.confine, input);
                }
                catch (err) {
                    return { ok: false, isError: true, content: err.message };
                }
                for (let attempt = 0; ; attempt++) {
                    try {
                        const client = await connect(name);
                        return shapeResult(name, await client.callTool(declaration.serverTool, args), cfg.maxResultBytes);
                    }
                    catch (err) {
                        if (err instanceof McpError && err.retryable && attempt === 0) {
                            await disconnect(name);
                            continue;
                        }
                        return { ok: false, isError: true, content: `MCP server "${name}": ${err instanceof Error ? err.message : String(err)}` };
                    }
                }
            },
        };
    }

    const tools = [];
    await Promise.all(selected.map(async (name) => {
        try {
            for (const declaration of await declarations(name)) tools.push(toTool(name, servers.get(name), declaration));
        }
        catch (err) {
            await log(`server "${name}" unavailable, its tools are left out of this run: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return {
        tools,
        close: async () => {
            await Promise.allSettled([...connections.keys()].map(disconnect));
        },
    };
}
