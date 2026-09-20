// Même serveur de test, en stdio : un message JSON par ligne. Envoie aussi une requête roots/list au client
// pour vérifier qu'il répond « non supporté » sans se bloquer.
import { createHandler } from "./mcp-fixture.mjs";

const { state, handle } = createHandler();
let buffer = "";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === "srv-roots") {
            state.rootsReply = message.error?.code ?? "result";
            continue;
        }
        if (message.id === undefined) {
            if (message.method === "notifications/initialized") send({ jsonrpc: "2.0", id: "srv-roots", method: "roots/list" });
            continue;
        }
        try {
            send({ jsonrpc: "2.0", id: message.id, result: handle(message.method, message.params) });
        }
        catch (err) {
            send({ jsonrpc: "2.0", id: message.id, error: { code: err.code ?? -32603, message: err.message } });
        }
    }
});
process.stdin.on("end", () => process.exit(0));
