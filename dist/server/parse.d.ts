import type { UsageSummary } from "@paperclipai/adapter-utils";
export interface ParsedToolCall {
    id: string;
    name: string;
    arguments: unknown;
    argumentsRaw: string;
}
export interface ParsedAssistantMessage {
    content: string;
    toolCalls: ParsedToolCall[];
    rawMessage: Record<string, unknown> | null;
}
export interface ParsedOpenRouterResponse {
    id: string | null;
    model: string | null;
    text: string;
    finishReason: string | null;
    usage: UsageSummary | null;
    costUsd: number | null;
    raw: Record<string, unknown> | null;
    assistant: ParsedAssistantMessage;
}
export declare function parseOpenRouterResponse(value: unknown): ParsedOpenRouterResponse;
export declare function isAuthError(status: number, body: string): boolean;
export declare function isToolUseUnsupported(_status: number, body: string): boolean;
//# sourceMappingURL=parse.d.ts.map