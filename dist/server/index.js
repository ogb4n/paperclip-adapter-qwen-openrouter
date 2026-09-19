import { type, models, agentConfigurationDoc } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listQwenOpenRouterModels } from "./models.js";
function readNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function readMessages(raw) {
    if (!Array.isArray(raw))
        return null;
    return raw.filter((entry) => entry && typeof entry === "object");
}
export const sessionCodec = {
    deserialize(raw) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            return null;
        const record = raw;
        const sessionId = readNonEmptyString(record.sessionId);
        if (!sessionId)
            return null;
        const model = readNonEmptyString(record.model);
        const messages = readMessages(record.messages);
        return {
            sessionId,
            ...(model ? { model } : {}),
            ...(messages && messages.length > 0 ? { messages } : {}),
        };
    },
    serialize(params) {
        if (!params)
            return null;
        const sessionId = readNonEmptyString(params.sessionId);
        if (!sessionId)
            return null;
        const model = readNonEmptyString(params.model);
        const messages = readMessages(params.messages);
        return {
            sessionId,
            ...(model ? { model } : {}),
            ...(messages && messages.length > 0 ? { messages } : {}),
        };
    },
    getDisplayId(params) {
        if (!params)
            return null;
        return readNonEmptyString(params.sessionId);
    },
};
export const sessionManagement = {
    supportsSessionResume: true,
    nativeContextManagement: "none",
    defaultSessionCompaction: {
        enabled: true,
        maxSessionRuns: 10,
        maxRawInputTokens: 200_000,
        maxSessionAgeHours: 24,
    },
};
export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listQwenOpenRouterModels } from "./models.js";
export function createServerAdapter() {
    return {
        type,
        execute,
        testEnvironment,
        sessionCodec,
        sessionManagement,
        models,
        listModels: listQwenOpenRouterModels,
        supportsLocalAgentJwt: true,
        supportsInstructionsBundle: true,
        instructionsPathKey: "instructionsFilePath",
        agentConfigurationDoc,
    };
}
//# sourceMappingURL=index.js.map