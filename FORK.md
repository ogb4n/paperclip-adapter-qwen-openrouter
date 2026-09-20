# Fork de paperclip-adapter-qwen-openrouter

Adaptateur Paperclip `qwen_openrouter` (boucle d'outils sur une API OpenAI-compatible), repris de
`paperclip-adapter-qwen-openrouter@0.4.0` (npm, MIT, dernière publication amont : 2026-04-27) et
ajusté à notre installation : proxy dashscope, bac à sable d'exécution, SearXNG, coffre Obsidian.

Le dépôt ne contient que `dist/` : l'amont ne publie aucune source TypeScript. On édite donc le
JavaScript directement, et les `.d.ts` et `.map` livrés sont périmés pour les fichiers modifiés.
Le paquet n'a plus de script `build`, `clean` ni `prepack` : ils auraient effacé `dist/`.

## Écarts avec l'amont

Un commit par écart, dans l'ordre où ils ont été appliqués (`git log --stat`).

| Écart | Fichier | Réglage |
|---|---|---|
| URL de l'API par défaut | `execute.js`, `test.js` | `OPENROUTER_BASE_URL` |
| Plafond de tours par défaut | `execute.js` | `PAPERCLIP_MAX_TOOL_TURNS` (plafond dur 300, l'amont : 40) |
| Modèle par défaut | `execute.js`, `test.js` | `PAPERCLIP_DEFAULT_MODEL` |
| Outil `web_search` (SearXNG) | `tools/web.js` | `SEARXNG_URL` |
| `shell_exec` par SSH dans un bac à sable | `tools/shell.js`, `execute.js` | `PAPERCLIP_SHELL_SSH_TARGET`, variable d'agent `PAPERCLIP_SHELL=1` |
| Outils `obsidian_*` (un dossier du coffre) | `tools/obsidian.js`, `tools/index.js` | `OBSIDIAN_API_URL`, `OBSIDIAN_API_KEY`, `OBSIDIAN_ROOT` |
| Pont MCP (serveurs HTTP et stdio, périmètre par outil) | `mcp/*.js`, `execute.js`, `tools/shell.js` | `PAPERCLIP_MCP_SERVERS`, variable d'agent `PAPERCLIP_MCP` |

Le « pourquoi » de chaque écart est dans le message de son commit. Un outil dont la variable manque
est absent de la liste présentée au modèle : sans réglage, une instance n'expose rien de plus que
l'amont, et `shell_exec` n'y exécute plus en local (voir plus bas).

Attentions propres à ce fork :

- **`shell_exec` n'exécute jamais en local.** Sans `PAPERCLIP_SHELL_SSH_TARGET`, l'outil échoue fermé.
  La clé SSH et `known_hosts` sont lus dans `/run/sandbox/key` et `/run/sandbox/known_hosts` du
  conteneur Paperclip (montages en lecture seule). Il s'active par agent avec la variable d'agent
  `PAPERCLIP_SHELL=1`.
- **La clé de l'API Obsidian ouvre tout le coffre** ; seul le code de `tools/obsidian.js` borne
  l'accès à `OBSIDIAN_ROOT`. Ne pas y ajouter d'outil de suppression sans décision explicite.
- `OPENROUTER_API_KEY` (lue par l'amont) porte en réalité la clé du proxy compatible OpenAI.

## Serveurs MCP

Le pont (`dist/server/mcp/`) donne aux agents les outils de serveurs MCP, avec les garanties des outils
Obsidian, généralisées : ce que l'administrateur écrit dans la configuration est tout ce que l'agent peut faire.
Client écrit à la main (JSON-RPC, une centaine de lignes par transport), sans dépendance.

Configuration : la variable `PAPERCLIP_MCP_SERVERS` du **serveur** (jamais celle d'un agent), un objet JSON :

```json
{
  "notes": {
    "transport": "http",
    "url": "http://hote:27125/mcp",
    "tokenEnv": "MCP_NOTES_TOKEN",
    "tools": {
      "obsidian_get_file_contents": { "confine": { "filepath": "Agents/" } },
      "obsidian_list_files_in_dir": { "confine": { "dirpath": "Agents/" } }
    }
  },
  "navigateur": {
    "transport": "stdio",
    "command": "npx -y @playwright/mcp --headless",
    "tools": { "browser_navigate": {}, "browser_snapshot": {}, "browser_click": {} }
  }
}
```

Ces deux entrées sont des exemples : les tests couvrent le pont (serveurs de test, un vrai serveur MCP Obsidian,
un serveur stdio réel dans le bac à sable), pas ces serveurs-là.

- **Liste blanche obligatoire.** Seuls les outils nommés sont proposés ; une liste vide ou absente invalide le
  serveur. Chaque outil apparaît sous `mcp__<serveur>__<outil>`.
- **`confine`** : l'argument est relatif au dossier donné, `..`, antislash et segments cachés sont refusés sans
  joindre le serveur ; un argument omis reçoit le dossier lui-même (sinon le serveur retomberait sur son défaut,
  souvent la racine).
- **`allowDestructive`** : un outil que le serveur annonce `destructiveHint` est écarté sauf autorisation. Ne
  compter que sur la liste blanche : le serveur MCP Obsidian n'annonce pas `obsidian_delete_file` comme
  destructif.
- **`http`** : jeton dans la variable serveur nommée par `tokenEnv` (jamais dans le JSON), aucune redirection
  suivie. **`stdio`** : la commande s'exécute dans le bac à sable par SSH (comme `shell_exec`, sans secret,
  `cwd` = dossier du run, `lifetimeSec` = durée de vie maximale) ; sans `PAPERCLIP_SHELL_SSH_TARGET` le serveur
  est écarté, jamais lancé en local.
- **Qui y a droit** : les serveurs `"default": true` pour tous les agents, les autres seulement pour l'agent dont
  la variable d'environnement `PAPERCLIP_MCP` les nomme (`navigateur,notes`), comme `PAPERCLIP_SHELL=1`.
- **Sorties** : présentées comme données non fiables, texte seul (le reste est signalé « omis »), tronquées à
  `maxResultBytes` (16 Ko).
- **Panne** : un serveur injoignable ou mal configuré est écarté du run et signalé dans son journal, le run continue.
  Les déclarations d'outils sont gardées 10 minutes entre les runs, la connexion se fait au premier appel, la
  session est fermée à la fin du run.

**Ce que le pont ne garantit pas** : filtrer ce qu'un outil renvoie. Un outil de recherche qui répond sur tout
un coffre ne se confine pas par ses arguments : ne pas le mettre sur liste blanche. C'est pourquoi les outils
`obsidian_*` natifs restent (leur recherche filtre les résultats), et pourquoi le pont n'est pas un moyen de les
remplacer.

Le serveur MCP Obsidian de la machine (`mcp-obsidian`, Streamable HTTP) refuse les en-têtes `Host` autres que la
boucle locale (protection contre le rebinding DNS) : depuis le conteneur Paperclip il faut élargir son
`allowed_hosts`. Essayé à la place contre `127.0.0.1:27125` (`MCP_SMOKE_URL`, voir `test/mcp.mjs`).

## Installer

Installation vérifiée : superposer le fork à l'adaptateur amont déjà installé.

1. Instance neuve : installer l'adaptateur amont depuis l'interface (Settings → Adapters, paquet
   `paperclip-adapter-qwen-openrouter`). Cela enregistre le type `qwen_openrouter`.
2. `scripts/deploy.sh [conteneur]` copie `dist/` et `package.json` dans
   `/paperclip/adapter-plugins/node_modules/paperclip-adapter-qwen-openrouter/`.
   Le script a été essayé sur une copie de l'amont 0.4.0 dans un conteneur jetable : les onze outils
   se chargent.
3. Compose du conteneur Paperclip : poser les variables du tableau ci-dessus, `extra_hosts:
   host.docker.internal:host-gateway` (Obsidian), le réseau du bac à sable, et monter la clé SSH et
   `known_hosts` dans `/run/sandbox/`.
4. Recréer le conteneur (`docker compose up -d`).

**Non vérifié :** l'installation depuis un chemin local par `POST /api/adapters/install`
(`isLocalPath: true`, le chemin étant celui du conteneur), et le parcours complet sur une instance
neuve. Le mécanisme existe dans le code de Paperclip ; on ne l'a pas essayé.

## Modifier

1. Éditer `dist/`, un écart par commit, message qui explique le pourquoi.
2. Lancer les tests dont les scripts sont dans `test/` : `npm run test:mcp` en local (sans rien d'autre), `test:obsidian`
   avec les variables `OBSIDIAN_*` ; `test:shell`, `test:web`, `test:mcp-execute` et `test:mcp-sandbox` depuis le
   conteneur Paperclip (la commande est en tête de chaque fichier).
3. `scripts/deploy.sh`, puis `docker restart paperclip`.

## Suivre l'amont

Pas de dépôt amont connu (le paquet npm ne déclare pas de `repository`). Pour comparer avec une
nouvelle version publiée : `npm pack paperclip-adapter-qwen-openrouter@<version>`, extraire, puis
`diff -r` contre le premier commit de ce dépôt (l'amont 0.4.0 intact) pour voir ce qui a changé de
leur côté, et rejouer nos écarts un par un.

## Dépendances

Une seule : `@paperclipai/adapter-utils`, fournie par l'instance Paperclip (`^2026.325.0`). Le
dépôt n'a pas de `node_modules`. Le fichier LICENSE manque dans l'archive amont : la licence MIT
n'est déclarée que dans `package.json`.

## État

Dépôt privé : https://github.com/ogb4n/paperclip-adapter-qwen-openrouter (branche `main`). Version `0.4.0-fork.2`.
