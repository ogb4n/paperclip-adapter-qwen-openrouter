// Teste shell_exec contre le bac à sable : à lancer depuis un conteneur du réseau `sandbox-net` qui a la clé SSH et
// known_hosts montés dans /run/sandbox/, par exemple le conteneur paperclip :
//   docker cp . paperclip:/tmp/fork && docker exec -e PAPERCLIP_SHELL_SSH_TARGET=agent@agent-sandbox paperclip node /tmp/fork/test/shell.mjs
import { shellExecTool } from "../dist/server/tools/shell.js";
const env = { shellEnabled: true, shellAllowList: [], cwd: "/workspaces/finance", shellTimeoutSec: 20, agent: { name: "test" } };
const show = async (label, input, e = env) => { const r = await shellExecTool.invoke(input, e); console.log(`--- ${label}\n${r.content.trim()}\n(ok=${r.ok})`); };
await show("identité et cwd", { command: "id -un; pwd" });
await show("guillemets et caractères spéciaux", { command: `printf '%s\\n' "a'b" 'c"d' \$HOME; echo 'é à ü'` });
await show("code de sortie", { command: "exit 7" });
await show("secrets locaux non transmis", { command: "env | grep -c -i -E 'SECRET|API_KEY' || true" });
await show("timeout (3 s) et arrêt du groupe de processus", { command: "sleep 30 & sleep 30", timeoutSec: 3 });
await show("pas de cwd hors bac à sable", { command: "pwd" }, { ...env, cwd: "/nonexistent" });
