#!/usr/bin/env bash
# Downloads/copies the MediaPipe runtime into public/ so the app works offline.
# These binaries are gitignored (see .gitignore) — run this after a fresh clone.
set -euo pipefail
cd "$(dirname "$0")/.."

MODEL_URL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"

mkdir -p public/models public/wasm

if [ ! -f public/models/face_landmarker.task ]; then
  echo "→ downloading face_landmarker.task (3.6 MB)"
  curl -sSL -o public/models/face_landmarker.task "$MODEL_URL"
fi

echo "→ copying MediaPipe wasm runtime"
cp node_modules/@mediapipe/tasks-vision/wasm/* public/wasm/

echo "✓ assets ready"
