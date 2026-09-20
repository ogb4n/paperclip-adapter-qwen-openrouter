// Vérifie l'outil web_search ajouté à l'adaptateur qwen_openrouter.
// Usage (SEARXNG_URL doit être joignable) : docker cp . paperclip:/tmp/fork && docker exec paperclip node /tmp/fork/test/web-search.mjs
import { builtinTools } from "../dist/server/tools/index.js";

const tool = builtinTools.find((t) => t.name === "web_search");
console.log("enregistré :", Boolean(tool), "| actif :", tool?.enabled({}));

const ok = await tool.invoke({ query: "bitcoin price analysis", max_results: 3 }, {});
console.log("recherche  :", ok.ok, ok.isError ?? false);
console.log(ok.content.slice(0, 800));

const bad = await tool.invoke({ query: "" }, {});
console.log("requête vide :", bad.isError, "-", bad.content);
