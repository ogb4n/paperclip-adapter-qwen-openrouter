// Teste un serveur MCP stdio lancé pour de vrai dans le bac à sable, par SSH : commande passée en base64, dossier de
// travail, stdio à travers ssh, arrêt du serveur quand la session se ferme. À lancer dans le conteneur Paperclip
// (clé SSH montée dans /run/sandbox/, dossier /workspaces partagé avec le bac à sable) :
//   docker cp . paperclip:/tmp/fork && docker exec -e PAPERCLIP_SHELL_SSH_TARGET=agent@agent-sandbox paperclip node /tmp/fork/test/mcp-sandbox.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearDeclarationCache, openMcpSession } from "../dist/server/mcp/session.js";
import { spawnRemote } from "../dist/server/tools/shell.js";

if (!process.env.PAPERCLIP_SHELL_SSH_TARGET) {
    console.error("variable manquante : PAPERCLIP_SHELL_SSH_TARGET");
    process.exit(2);
}
const dir = "/workspaces/_mcp-test";
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
fs.mkdirSync(dir, { recursive: true });
for (const file of ["mcp-fixture.mjs", "mcp-stdio-server.mjs"]) fs.copyFileSync(path.join(fixtures, file), path.join(dir, file));

let failures = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
};
const remote = (command) => {
    const child = spawnRemote(command, dir, 20);
    return new Promise((resolve) => {
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        child.on("close", () => resolve(out.trim()));
    });
};

try {
    clearDeclarationCache();
    const lines = [];
    const session = await openMcpSession({
        env: { PAPERCLIP_MCP: "sbx" },
        cwd: dir,
        onLog: async (_s, text) => { lines.push(text); },
        serverEnv: {
            ...process.env,
            PAPERCLIP_MCP_SERVERS: JSON.stringify({
                sbx: { transport: "stdio", command: "node mcp-stdio-server.mjs", tools: { echo: {}, server_saw: {} } },
            }),
        },
    });
    check("stdio dans le bac à sable: outils déclarés", session.tools.map((t) => t.name).join() === "mcp__sbx__echo,mcp__sbx__server_saw", lines.join("").trim());
    const echo = await session.tools.find((t) => t.name === "mcp__sbx__echo")?.invoke({ text: "via ssh" });
    check("appel d'outil à travers SSH", /echo:via ssh/.test(echo?.content ?? ""), echo?.content?.split("\n").pop());
    // Le crochet de `[n]ode` évite que pgrep ne se compte lui-même : son propre argument contient le motif.
    check("le serveur tourne bien dans le bac à sable", Number(await remote("pgrep -fc '[n]ode mcp-stdio-server.mjs' || true")) >= 1);
    await session.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    check("fermeture de la session: plus aucun serveur dans le bac à sable", Number(await remote("pgrep -fc '[n]ode mcp-stdio-server.mjs' || true")) === 0);
}
finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "TOUS LES TESTS PASSENT" : `${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
