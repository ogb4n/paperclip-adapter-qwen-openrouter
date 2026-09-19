/**
 * Self-contained UI parser for the qwen_openrouter adapter.
 *
 * Parses our adapter's structured stdout JSON lines into Paperclip
 * transcript entries. Zero runtime imports — eval'd in browser.
 */
interface InitEntry {
    kind: "init";
    ts: string;
    model: string;
    sessionId: string;
}
interface AssistantEntry {
    kind: "assistant";
    ts: string;
    text: string;
}
interface SystemEntry {
    kind: "system";
    ts: string;
    text: string;
}
interface StderrEntry {
    kind: "stderr";
    ts: string;
    text: string;
}
interface StdoutEntry {
    kind: "stdout";
    ts: string;
    text: string;
}
interface ResultEntry {
    kind: "result";
    ts: string;
    text: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
    subtype: string;
    isError: boolean;
    errors: string[];
}
type TranscriptEntry = InitEntry | AssistantEntry | SystemEntry | StderrEntry | StdoutEntry | ResultEntry;
declare function parseLine(line: string, ts: string): TranscriptEntry[];
export { parseLine as parseStdoutLine };
export declare function createStdoutParser(): {
    parseLine: typeof parseLine;
    reset: () => void;
};
//# sourceMappingURL=ui-parser.d.ts.map