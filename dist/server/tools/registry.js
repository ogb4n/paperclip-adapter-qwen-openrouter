export function toOpenRouterTools(tools, env) {
    return tools
        .filter((t) => t.enabled(env))
        .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}
export function findTool(tools, name) {
    return tools.find((t) => t.name === name) ?? null;
}
//# sourceMappingURL=registry.js.map