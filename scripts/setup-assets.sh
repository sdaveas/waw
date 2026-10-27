#!/usr/bin/env bash
# Downloads/copies the MediaPipe runtime into public/ so the app works offline.
# These binaries are gitignored (see .gitignore) — run this after a fresh clone.
set -euo pipefail
cd "$(dirname "$0")/.."

FACE_MODEL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
HAND_MODEL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
OBJECT_MODEL="https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite"

mkdir -p public/models public/wasm

if [ ! -f public/models/face_landmarker.task ]; then
  echo "→ downloading face_landmarker.task (3.6 MB)"
  curl -sSL -o public/models/face_landmarker.task "$FACE_MODEL"
fi

if [ ! -f public/models/hand_landmarker.task ]; then
  echo "→ downloading hand_landmarker.task (7.5 MB)"
  curl -sSL -o public/models/hand_landmarker.task "$HAND_MODEL"
fi

if [ ! -f public/models/efficientdet_lite0.tflite ]; then
  echo "→ downloading efficientdet_lite0.tflite (6.9 MB)"
  curl -sSL -o public/models/efficientdet_lite0.tflite "$OBJECT_MODEL"
fi

echo "→ copying MediaPipe wasm runtime"
cp node_modules/@mediapipe/tasks-vision/wasm/* public/wasm/

echo "✓ assets ready"
