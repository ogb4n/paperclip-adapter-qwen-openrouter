import { fsListDirTool, fsReadFileTool, fsWriteFileTool } from "./fs.js";
import { paperclipApiRequestTool, paperclipSearchIssuesTool } from "./paperclip.js";
import { shellExecTool } from "./shell.js";
import { webSearchTool } from "./web.js";
export const builtinTools = [
    paperclipApiRequestTool,
    paperclipSearchIssuesTool,
    fsReadFileTool,
    fsWriteFileTool,
    fsListDirTool,
    shellExecTool,
    webSearchTool,
];
export { findTool, toOpenRouterTools } from "./registry.js";
//# sourceMappingURL=index.js.map