#!/bin/sh
# Superpose ce fork à l'adaptateur amont déjà installé dans un conteneur Paperclip (Settings → Adapters).
# Usage : scripts/deploy.sh [conteneur]   (défaut : paperclip). Redémarrer ensuite le conteneur.
set -eu
CONTAINER=${1:-paperclip}
DEST=/paperclip/adapter-plugins/node_modules/paperclip-adapter-qwen-openrouter
HERE=$(cd "$(dirname "$0")/.." && pwd)

docker exec "$CONTAINER" test -d "$DEST/dist" || {
  echo "adaptateur amont absent de $CONTAINER ($DEST) : l'installer d'abord (Settings → Adapters)" >&2
  exit 1
}
docker cp "$HERE/dist/." "$CONTAINER:$DEST/dist/"
docker cp "$HERE/package.json" "$CONTAINER:$DEST/package.json"
docker exec "$CONTAINER" chown -R node:node "$DEST"
echo "fork déployé dans $CONTAINER ; à faire : docker restart $CONTAINER"
