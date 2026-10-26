import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

let landmarkerPromise: Promise<FaceLandmarker> | null = null

/** Lazily load the model once per page. */
export function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks('/wasm')
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: '/models/face_landmarker.task',
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
