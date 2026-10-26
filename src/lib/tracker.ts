import { FaceLandmarker, FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'

// Vite rewrites BASE_URL to the deploy sub-path ('/waw/' on GitHub Pages, '/' in
// dev), so the models and wasm runtime have to be resolved against it rather
// than assumed to sit at the site root.
const BASE = import.meta.env.BASE_URL

let filesetPromise: Promise<Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>> | null = null
let facePromise: Promise<FaceLandmarker> | null = null
let handPromise: Promise<HandLandmarker> | null = null

function fileset() {
  if (!filesetPromise) {
    filesetPromise = FilesetResolver.forVisionTasks(`${BASE}wasm`).catch((err) => {
      filesetPromise = null
      throw err
    })
  }
  return filesetPromise
}

/** Lazily load the face model once per page. */
export function getLandmarker() {
  if (!facePromise) {
    facePromise = (async () =>
      FaceLandmarker.createFromOptions(await fileset(), {
        baseOptions: {
          modelAssetPath: `${BASE}models/face_landmarker.task`,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }))().catch((err) => {
      facePromise = null
      throw err
    })
  }
  return facePromise
}

/** Lazily load the hand model once per page. */
export function getHandLandmarker() {
  if (!handPromise) {
    handPromise = (async () =>
      HandLandmarker.createFromOptions(await fileset(), {
        baseOptions: {
          modelAssetPath: `${BASE}models/hand_landmarker.task`,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }))().catch((err) => {
      handPromise = null
      throw err
    })
  }
  return handPromise
}
