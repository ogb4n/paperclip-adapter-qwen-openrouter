import type { AdapterAgent } from "@paperclipai/adapter-utils";
export interface ToolEnvironment {
    cwd: string;
    agent: AdapterAgent;
    runId: string;
    paperclipApiUrl: string | null;
    paperclipApiKey: string | null;
    shellEnabled: boolean;
    shellAllowList: string[] | null;
    fsAllowOutsideCwd: boolean;
    shellTimeoutSec: number;
    fsMaxBytes: number;
    env: Record<string, string>;
}
export interface ToolResult {
    ok: boolean;
    content: string;
    isError?: boolean;
}
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    enabled: (env: ToolEnvironment) => boolean;
    invoke: (input: unknown, env: ToolEnvironment) => Promise<ToolResult>;
}
export interface OpenRouterToolSpec {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
export declare function toOpenRouterTools(tools: ToolDefinition[], env: ToolEnvironment): OpenRouterToolSpec[];
export declare function findTool(tools: ToolDefinition[], name: string): ToolDefinition | null;
//# sourceMappingURL=registry.d.ts.map