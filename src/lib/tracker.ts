import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  ObjectDetector,
} from '@mediapipe/tasks-vision'

// Vite rewrites BASE_URL to the deploy sub-path ('/waw/' on GitHub Pages, '/' in
// dev), so the models and wasm runtime have to be resolved against it rather
// than assumed to sit at the site root.
const BASE = import.meta.env.BASE_URL

let filesetPromise: Promise<Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>> | null = null
let facePromise: Promise<FaceLandmarker> | null = null
let handPromise: Promise<HandLandmarker> | null = null
let objectPromise: Promise<ObjectDetector> | null = null

function fileset() {
  if (!filesetPromise) {
    filesetPromise = FilesetResolver.forVisionTasks(`${BASE}wasm`).catch((err) => {
      filesetPromise = null
      throw err
    })
  }
  return filesetPromise
}

/**
 * Build with the GPU delegate, and fall back to CPU if the device cannot do it.
 * Some mobile GPUs reject the delegate outright, which used to mean the app
 * simply never started.
 */
async function createWithFallback<T>(
  create: (delegate: 'GPU' | 'CPU') => Promise<T>,
): Promise<T> {
  try {
    return await create('GPU')
  } catch {
    return await create('CPU')
  }
}

/** Lazily load the face model once per page. */
export function getLandmarker() {
  if (!facePromise) {
    facePromise = (async () =>
      createWithFallback(async (delegate) =>
        FaceLandmarker.createFromOptions(await fileset(), {
          baseOptions: {
            modelAssetPath: `${BASE}models/face_landmarker.task`,
            delegate,
          },
          runningMode: 'VIDEO',
          // Two, so pet mode can spot a small face next to a big one. The mouth
          // always follows the largest face.
          numFaces: 2,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }),
      ))().catch((err) => {
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
      createWithFallback(async (delegate) =>
        HandLandmarker.createFromOptions(await fileset(), {
          baseOptions: {
            modelAssetPath: `${BASE}models/hand_landmarker.task`,
            delegate,
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }),
      ))().catch((err) => {
      handPromise = null
      throw err
    })
  }
  return handPromise
}

/** Lazily load the object detector, used only for pet mode. */
export function getObjectDetector() {
  if (!objectPromise) {
    objectPromise = (async () =>
      createWithFallback(async (delegate) =>
        ObjectDetector.createFromOptions(await fileset(), {
          baseOptions: {
            modelAssetPath: `${BASE}models/efficientdet_lite0.tflite`,
            delegate,
          },
          runningMode: 'VIDEO',
          scoreThreshold: 0.25,
          maxResults: 6,
        }),
      ))().catch((err) => {
      objectPromise = null
      throw err
    })
  }
  return objectPromise
}
