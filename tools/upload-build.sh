#!/bin/sh
# Send a prebuilt game folder to the publisher on the VM (the VM cannot build: low RAM).
#   HANDSHAKE_VM_HOST=user@vm.example.com tools/upload-build.sh <game> <dist-dir> [ssh-host]
#   HANDSHAKE_VM_HOST=user@vm.example.com tools/upload-build.sh mygame ../mygame/dist
# HANDSHAKE_VM_HOST (or the optional third argument) is the ssh target of the VM running the publisher.
# The service key never leaves the VM: it is read there (root-only env file) and used by curl on the VM.
# Then use the backoffice: Send (build push), then Publish.
set -eu
GAME="${1:?game id (see games.json)}"
DIR="${2:?folder to upload}"
HOST="${3:-${HANDSHAKE_VM_HOST:-}}"
[ -n "$HOST" ] || { echo "set HANDSHAKE_VM_HOST (ssh target of the publisher VM) or pass it as 3rd argument" >&2; exit 2; }
[ -f "$DIR/index.html" ] || { echo "no index.html in $DIR" >&2; exit 2; }
case "$GAME" in *[!a-z0-9_-]*) echo "bad game id" >&2; exit 2 ;; esac
# Do not ship dev-tool leftovers.
tar -czf - --exclude=nmc.gpu.json -C "$DIR" . |
  ssh "$HOST" "sudo sh -c '. /etc/gamesaloon-publisher.env && curl -sS -f -m 600 -X PUT --data-binary @- -H \"authorization: Bearer \$PUBLISHER_KEY\" http://127.0.0.1:9997/artifacts/$GAME'"
echo
