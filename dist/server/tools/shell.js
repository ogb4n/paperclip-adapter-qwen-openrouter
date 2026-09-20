// Version modifiée de dist/server/tools/shell.js de paperclip-adapter-qwen-openrouter.
// Différences avec l'original : la commande ne s'exécute JAMAIS dans le conteneur Paperclip ;
// elle est envoyée par SSH au bac à sable (PAPERCLIP_SHELL_SSH_TARGET, ex. agent@agent-sandbox).
// Sans cible configurée, l'outil refuse (échec fermé) au lieu de retomber sur bash local.
import { spawn } from "node:child_process";
const MAX_SHELL_OUTPUT_BYTES = 64 * 1024;
const SSH_KEY = "/run/sandbox/key";
const SSH_KNOWN_HOSTS = "/run/sandbox/known_hosts";

function sshTarget() {
    return (process.env.PAPERCLIP_SHELL_SSH_TARGET ?? "").trim();
}
function isAllowed(command, allowList) {
    if (!allowList || allowList.length === 0)
        return true;
    const trimmed = command.trim();
    return allowList.some((prefix) => trimmed.startsWith(prefix));
}
function shq(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function runRemote(command, cwd, timeoutSec) {
    return new Promise((resolve) => {
        const script = `cd -- ${shq(cwd)} && ${command}`;
        const b64 = Buffer.from(script, "utf8").toString("base64");
        // `timeout` tue le groupe de processus côté bac à sable au dépassement du délai.
        const remote = `timeout -k 5 ${timeoutSec} bash -lc "$(printf %s ${b64} | base64 -d)"`;
        const args = [
            "-F", "/dev/null", "-T",
            "-i", SSH_KEY,
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=yes",
            "-o", `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
            "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=15",
            "-o", "LogLevel=ERROR",
            sshTarget(),
            remote,
        ];
        // Environnement minimal : aucune variable du serveur (clés, secrets) n'est transmise.
        const child = spawn("ssh", args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent" } });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let truncated = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                child.kill("SIGTERM");
            }
            catch {
                // ignore
            }
        }, (timeoutSec + 15) * 1000);
        const append = (target, chunk) => {
            const text = chunk.toString("utf8");
            if (target === "stdout") {
                if (stdout.length + text.length > MAX_SHELL_OUTPUT_BYTES) {
                    stdout = (stdout + text).slice(0, MAX_SHELL_OUTPUT_BYTES);
                    truncated = true;
                }
                else {
                    stdout += text;
                }
            }
            else {
                if (stderr.length + text.length > MAX_SHELL_OUTPUT_BYTES) {
                    stderr = (stderr + text).slice(0, MAX_SHELL_OUTPUT_BYTES);
                    truncated = true;
                }
                else {
                    stderr += text;
                }
            }
        };
        child.stdout.on("data", (chunk) => append("stdout", chunk));
        child.stderr.on("data", (chunk) => append("stderr", chunk));
        child.on("close", (code) => {
            clearTimeout(timer);
            if (truncated)
                stderr += `\n[output truncated at ${MAX_SHELL_OUTPUT_BYTES} bytes]`;
            if (code === 124 || code === 137)
                timedOut = true;
            resolve({ exitCode: code, stdout, stderr, timedOut });
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ exitCode: 1, stdout, stderr: stderr + `\nspawn error: ${err.message}`, timedOut });
        });
    });
}
export const shellExecTool = {
    name: "shell_exec",
    description: "Run a bash command in the isolated sandbox container (non-root, no secrets, restricted network) inside the current workspace directory. Disabled unless enabled for this agent.",
    parameters: {
        type: "object",
        properties: {
            command: { type: "string", description: "Bash command to run." },
            timeoutSec: { type: "integer", minimum: 1, maximum: 600, description: "Optional timeout in seconds; defaults to adapter shellTimeoutSec." },
        },
        required: ["command"],
        additionalProperties: false,
    },
    enabled: (env) => env.shellEnabled === true,
    async invoke(input, env) {
        const params = (input ?? {});
        if (typeof params.command !== "string" || params.command.trim().length === 0) {
            return { ok: false, content: "command must be a non-empty string", isError: true };
        }
        if (sshTarget().length === 0) {
            return { ok: false, content: "shell_exec is unavailable: no sandbox is configured on the server (PAPERCLIP_SHELL_SSH_TARGET).", isError: true };
        }
        if (!isAllowed(params.command, env.shellAllowList)) {
            return { ok: false, content: `command rejected by tools.shell.allowList`, isError: true };
        }
        const timeoutSec = typeof params.timeoutSec === "number" && Number.isFinite(params.timeoutSec)
            ? Math.min(600, Math.max(1, Math.trunc(params.timeoutSec)))
            : env.shellTimeoutSec;
        // Trace de référence : journal du serveur (docker logs paperclip).
        console.log(`[shell_exec] ${JSON.stringify({ ts: new Date().toISOString(), agent: env.agent?.name, cwd: env.cwd, command: params.command.slice(0, 500) })}`);
        const result = await runRemote(params.command, env.cwd, timeoutSec);
        const blocks = [];
        blocks.push(`exitCode: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
        if (result.stdout)
            blocks.push(`--- stdout ---\n${result.stdout}`);
        if (result.stderr)
            blocks.push(`--- stderr ---\n${result.stderr}`);
        return {
            ok: result.exitCode === 0 && !result.timedOut,
            content: blocks.join("\n"),
            isError: result.exitCode !== 0 || result.timedOut,
        };
    },
};
