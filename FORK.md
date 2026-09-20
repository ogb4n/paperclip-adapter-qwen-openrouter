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
2. Lancer les tests dont les scripts sont dans `test/` (`npm run test:obsidian` en local avec les
   variables `OBSIDIAN_*` ; `test:shell` et `test:web` depuis le conteneur Paperclip, la commande est
   en tête de chaque fichier).
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

Dépôt privé : https://github.com/ogb4n/paperclip-adapter-qwen-openrouter (branche `main`). Version `0.4.0-fork.1`.
