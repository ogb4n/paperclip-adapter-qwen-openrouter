// Teste le pont MCP (dist/server/mcp/) contre des serveurs de test en HTTP (JSON et SSE) et en stdio.
//   node test/mcp.mjs
// Contre un vrai serveur MCP en plus (facultatif) :
//   MCP_SMOKE_URL=http://127.0.0.1:27125/mcp MCP_SMOKE_TOKEN=… node test/mcp.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { confineArguments, exposedName, parseServers, selectServers } from "../dist/server/mcp/policy.js";
import { clearDeclarationCache, openMcpSession } from "../dist/server/mcp/session.js";
import { startHttpServer } from "./fixtures/mcp-fixture.mjs";

const stdioFixture = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));
let failures = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
};
const names = (session) => session.tools.map((t) => t.name);
const tool = (session, name) => session.tools.find((t) => t.name === name);
const logs = () => {
    const lines = [];
    return { lines, onLog: async (_stream, text) => { lines.push(text); } };
};
const httpServerConfig = (url, extra = {}) => ({
    transport: "http",
    url,
    tokenEnv: "FIXTURE_TOKEN",
    tools: {
        echo: {},
        read_note: { confine: { filepath: "Agents/" } },
        list_dir: { confine: { dirpath: "Agents/" } },
        delete_note: {},
        boom: {},
        big: {},
        image: {},
    },
    ...extra,
});
const serverEnv = (servers) => ({ PAPERCLIP_MCP_SERVERS: JSON.stringify(servers), FIXTURE_TOKEN: "secret" });

// --- configuration et politique -------------------------------------------------------------------------------
{
    check("config: JSON invalide", parseServers("{nope").errors.length === 1);
    const bad = parseServers(JSON.stringify({
        ok: { transport: "http", url: "http://x/mcp", tools: { a: {} } },
        Bad_Name: { transport: "http", url: "http://x/mcp", tools: { a: {} } },
        nourl: { transport: "http", tools: { a: {} } },
        nocmd: { transport: "stdio", tools: { a: {} } },
        notools: { transport: "http", url: "http://x/mcp" },
        emptytools: { transport: "http", url: "http://x/mcp", tools: {} },
        badconfine: { transport: "http", url: "http://x/mcp", tools: { a: { confine: { p: "../up" } } } },
        ftp: { transport: "http", url: "ftp://x", tools: { a: {} } },
    }));
    check("config: seul le serveur valide est gardé", [...bad.servers.keys()].join() === "ok", `${bad.errors.length} erreurs`);

    const servers = parseServers(JSON.stringify({
        a: { transport: "http", url: "http://x/mcp", default: true, tools: { t: {} } },
        b: { transport: "http", url: "http://x/mcp", tools: { t: {} } },
        c: { transport: "http", url: "http://x/mcp", tools: { t: {} } },
    })).servers;
    const picked = selectServers(servers, "b, zzz");
    check("sélection: défaut + demande de l'agent, inconnu signalé", picked.selected.sort().join() === "a,b" && picked.unknown.join() === "zzz");
    check("sélection: sans demande, seuls les défauts", selectServers(servers, undefined).selected.join() === "a");

    const confine = { filepath: ["Agents"] };
    check("confine: relatif", confineArguments(confine, { filepath: "notes/a.md" }).filepath === "Agents/notes/a.md");
    check("confine: absolu lu comme relatif", confineArguments(confine, { filepath: "/etc/passwd" }).filepath === "Agents/etc/passwd");
    check("confine: argument omis → racine du dossier", confineArguments(confine, {}).filepath === "Agents");
    for (const bad of ["../SI/x.md", ".obsidian/app.json", "a/../../x", "a\\b", 42]) {
        let refused = false;
        try { confineArguments(confine, { filepath: bad }); } catch { refused = true; }
        check(`confine: refuse ${JSON.stringify(bad)}`, refused);
    }
    const long = exposedName("srv", "x".repeat(100));
    check("nom exposé: 64 caractères au plus, stable", long.length <= 64 && long === exposedName("srv", "x".repeat(100)) && exposedName("srv", "a.b") === "mcp__srv__a_b");
}

// --- HTTP : JSON puis SSE -------------------------------------------------------------------------------------
for (const sse of [false, true]) {
    const label = sse ? "http+sse" : "http";
    const fixture = await startHttpServer({ sse });
    clearDeclarationCache();
    const { lines, onLog } = logs();
    const session = await openMcpSession({
        env: { PAPERCLIP_MCP: "fx" },
        onLog,
        serverEnv: serverEnv({ fx: httpServerConfig(fixture.url) }),
    });

    check(`${label}: seuls les outils de la liste blanche, destructifs écartés`,
        names(session).join() === "mcp__fx__big,mcp__fx__boom,mcp__fx__echo,mcp__fx__image,mcp__fx__list_dir,mcp__fx__read_note",
        names(session).join());
    check(`${label}: outil destructif signalé dans le journal`, lines.some((l) => /delete_note.*destructive/.test(l)));
    check(`${label}: pagination de tools/list suivie`, fixture.state.toolsListCalls === 2);
    check(`${label}: argument confiné annoncé au modèle`, /Agents\//.test(tool(session, "mcp__fx__read_note").parameters.properties.filepath.description));

    const echo = await tool(session, "mcp__fx__echo").invoke({ text: "salut" });
    check(`${label}: appel d'outil`, echo.ok === true && /echo:salut/.test(echo.content) && /UNTRUSTED OUTPUT/.test(echo.content));
    const read = await tool(session, "mcp__fx__read_note").invoke({ filepath: "projet/a.md" });
    check(`${label}: le serveur reçoit le chemin confiné`, /read:Agents\/projet\/a\.md/.test(read.content));
    const before = fixture.state.calls.length;
    const escaped = await tool(session, "mcp__fx__read_note").invoke({ filepath: "../SI/Cartographie SI.md" });
    check(`${label}: chemin de sortie refusé sans joindre le serveur`, escaped.isError === true && fixture.state.calls.length === before);
    const listed = await tool(session, "mcp__fx__list_dir").invoke({});
    check(`${label}: argument omis → dossier autorisé, pas la racine du serveur`, /list:Agents$/.test(listed.content.trim()), listed.content.split("\n").pop());
    check(`${label}: erreur d'outil remontée`, (await tool(session, "mcp__fx__boom").invoke({})).isError === true);
    const big = await tool(session, "mcp__fx__big").invoke({});
    check(`${label}: sortie sous la limite laissée intacte`, !/truncated/.test(big.content) && big.content.includes("x".repeat(5000)));
    const image = await tool(session, "mcp__fx__image").invoke({});
    check(`${label}: contenu non texte omis`, /\[image content omitted\]/.test(image.content) && /caption/.test(image.content));

    await session.close();
    check(`${label}: session fermée (DELETE)`, fixture.stats.deletes === 1);
    await fixture.close();
}

// --- limites de sortie, jeton, session expirée, cache ---------------------------------------------------------
{
    const fixture = await startHttpServer();
    clearDeclarationCache();
    const small = await openMcpSession({
        env: { PAPERCLIP_MCP: "fx" },
        serverEnv: serverEnv({ fx: httpServerConfig(fixture.url, { maxResultBytes: 1024 }) }),
    });
    const big = await tool(small, "mcp__fx__big").invoke({});
    check("sortie tronquée à maxResultBytes", /truncated at 1024 bytes/.test(big.content));
    await small.close();

    const wrong = logs();
    clearDeclarationCache();
    const denied = await openMcpSession({
        env: { PAPERCLIP_MCP: "fx" },
        onLog: wrong.onLog,
        serverEnv: { ...serverEnv({ fx: httpServerConfig(fixture.url) }), FIXTURE_TOKEN: "mauvais" },
    });
    check("mauvais jeton: serveur écarté, le run continue", denied.tools.length === 0 && wrong.lines.some((l) => /unavailable/.test(l) && /401/.test(l)), wrong.lines.join("").trim().slice(0, 100));

    const noToken = logs();
    clearDeclarationCache();
    const missing = await openMcpSession({
        env: { PAPERCLIP_MCP: "fx" },
        onLog: noToken.onLog,
        serverEnv: { PAPERCLIP_MCP_SERVERS: JSON.stringify({ fx: httpServerConfig(fixture.url) }) },
    });
    check("variable de jeton vide: serveur écarté", missing.tools.length === 0 && noToken.lines.some((l) => /FIXTURE_TOKEN is empty/.test(l)));

    const unselected = await openMcpSession({ env: {}, serverEnv: serverEnv({ fx: httpServerConfig(fixture.url) }) });
    check("agent sans PAPERCLIP_MCP: aucun outil, aucune connexion", unselected.tools.length === 0);
    const asDefault = await openMcpSession({ env: {}, serverEnv: serverEnv({ fx: httpServerConfig(fixture.url, { default: true }) }) });
    check("serveur `default`: offert à tous les agents", asDefault.tools.length === 6);
    await asDefault.close();
    await fixture.close();

    const expiring = await startHttpServer({ expireSessionOnce: true });
    clearDeclarationCache();
    const session = await openMcpSession({ env: { PAPERCLIP_MCP: "fx" }, serverEnv: serverEnv({ fx: httpServerConfig(expiring.url) }) });
    const answer = await tool(session, "mcp__fx__echo").invoke({ text: "encore" });
    check("session expirée (404): reconnexion et nouvel essai", answer.ok === true && /echo:encore/.test(answer.content) && expiring.stats.expired === 1 && expiring.stats.sessionsCreated === 2);
    await session.close();
    await expiring.close();

    const cached = await startHttpServer();
    clearDeclarationCache();
    const env = serverEnv({ fx: httpServerConfig(cached.url) });
    const first = await openMcpSession({ env: { PAPERCLIP_MCP: "fx" }, serverEnv: env });
    await first.close();
    const listsAfterFirst = cached.state.toolsListCalls;
    const initializesAfterFirst = cached.state.initializes;
    const second = await openMcpSession({ env: { PAPERCLIP_MCP: "fx" }, serverEnv: env });
    check("cache: le 2e run ne relit pas tools/list ni ne se connecte", second.tools.length === 6 && cached.state.toolsListCalls === listsAfterFirst && cached.state.initializes === initializesAfterFirst);
    await tool(second, "mcp__fx__echo").invoke({ text: "x" });
    check("cache: la connexion se fait au premier appel", cached.state.initializes === initializesAfterFirst + 1);
    await second.close();
    await cached.close();
}

// --- stdio ----------------------------------------------------------------------------------------------------
{
    const stdioConfig = { transport: "stdio", command: "ignored-in-test", tools: { echo: {}, server_saw: {}, read_note: { confine: { filepath: "Agents/" } } } };
    let launched = null;
    let child = null;
    const spawnLocal = (command, cwd, lifetimeSec) => {
        launched = { command, cwd, lifetimeSec };
        child = spawn(process.execPath, [stdioFixture], { stdio: ["pipe", "pipe", "pipe"] });
        return child;
    };
    clearDeclarationCache();
    const session = await openMcpSession({
        env: { PAPERCLIP_MCP: "loc" },
        cwd: "/workspaces/demo",
        serverEnv: { PAPERCLIP_MCP_SERVERS: JSON.stringify({ loc: stdioConfig }) },
        deps: { spawnRemote: spawnLocal },
    });
    check("stdio: outils déclarés", names(session).join() === "mcp__loc__echo,mcp__loc__read_note,mcp__loc__server_saw", names(session).join());
    check("stdio: commande, dossier de travail et durée de vie transmis au lanceur", launched?.command === "ignored-in-test" && launched?.cwd === "/workspaces/demo" && launched?.lifetimeSec === 900);
    check("stdio: appel d'outil", /echo:bonjour/.test((await tool(session, "mcp__loc__echo").invoke({ text: "bonjour" })).content));
    check("stdio: chemin confiné", /read:Agents\/a\.md/.test((await tool(session, "mcp__loc__read_note").invoke({ filepath: "a.md" })).content));
    check("stdio: requête du serveur (roots/list) refusée proprement", /roots:-32601/.test((await tool(session, "mcp__loc__server_saw").invoke({})).content));
    await session.close();
    check("stdio: le serveur est arrêté à la fermeture de la session", child.exitCode !== null || child.signalCode !== null, `code ${child.exitCode} signal ${child.signalCode}`);

    const failClosed = logs();
    clearDeclarationCache();
    const denied = await openMcpSession({
        env: { PAPERCLIP_MCP: "loc" },
        onLog: failClosed.onLog,
        serverEnv: { PAPERCLIP_MCP_SERVERS: JSON.stringify({ loc: stdioConfig }) },
    });
    check("stdio sans bac à sable configuré: échec fermé, aucun lancement local", denied.tools.length === 0 && failClosed.lines.some((l) => /PAPERCLIP_SHELL_SSH_TARGET/.test(l)));

    const crashing = logs();
    clearDeclarationCache();
    const crashed = await openMcpSession({
        env: { PAPERCLIP_MCP: "loc" },
        onLog: crashing.onLog,
        serverEnv: { PAPERCLIP_MCP_SERVERS: JSON.stringify({ loc: stdioConfig }) },
        deps: { spawnRemote: () => spawn(process.execPath, ["-e", "console.error('démarrage impossible'); process.exit(3)"], { stdio: ["pipe", "pipe", "pipe"] }) },
    });
    check("stdio: serveur qui plante au démarrage, cause rapportée", crashed.tools.length === 0 && crashing.lines.some((l) => /démarrage impossible/.test(l)), crashing.lines.join("").trim().slice(0, 120));
}

// --- vrai serveur (facultatif) --------------------------------------------------------------------------------
if (process.env.MCP_SMOKE_URL && process.env.MCP_SMOKE_TOKEN) {
    clearDeclarationCache();
    const { lines, onLog } = logs();
    const session = await openMcpSession({
        env: { PAPERCLIP_MCP: "real" },
        onLog,
        serverEnv: {
            SMOKE_TOKEN: process.env.MCP_SMOKE_TOKEN,
            PAPERCLIP_MCP_SERVERS: JSON.stringify({
                real: {
                    transport: "http",
                    url: process.env.MCP_SMOKE_URL,
                    tokenEnv: "SMOKE_TOKEN",
                    tools: { obsidian_list_files_in_dir: { confine: { dirpath: "Agents/" } } },
                },
            }),
        },
    });
    // Ce serveur n'annote pas obsidian_delete_file comme destructif : seule la liste blanche l'écarte.
    check("serveur réel: seul l'outil de la liste blanche est exposé", names(session).join() === "mcp__real__obsidian_list_files_in_dir", `${names(session).join()} | ${lines.join("").trim().slice(0, 160)}`);
    const listing = await tool(session, "mcp__real__obsidian_list_files_in_dir")?.invoke({});
    check("serveur réel: le dossier autorisé est listé, pas le coffre", /README\.md/.test(listing?.content ?? "") && !/Projects/.test(listing?.content ?? ""), (listing?.content ?? "").split("\n").pop());
    await session.close();
}

console.log(failures === 0 ? "TOUS LES TESTS PASSENT" : `${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
