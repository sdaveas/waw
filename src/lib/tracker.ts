import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// Vite rewrites BASE_URL to the deploy sub-path ('/waw/' on GitHub Pages, '/'
// in dev), so the model and wasm runtime have to be resolved against it rather
// than assumed to sit at the site root.
const BASE = import.meta.env.BASE_URL

let landmarkerPromise: Promise<FaceLandmarker> | null = null

/** Lazily load the model once per page. */
export function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(`${BASE}wasm`)
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${BASE}models/face_landmarker.task`,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      })
    })().catch((err) => {
      landmarkerPromise = null
      throw err
    })
  }
  return landmarkerPromise
}
