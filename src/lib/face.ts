/**
 * Face geometry, derived from MediaPipe FaceLandmarker's 468-point mesh.
 *
 * Three scale-invariant axes come out of the mouth, plus one from the eyes.
 * Everything is divided by the distance between the outer eye corners, so
 * leaning towards the camera changes nothing.
 *
 *   vertical   — how far the lips part, divided by face width.
 *   horizontal — how wide the opening is stretched, divided by face width.
 *   eyes       — eyelid aperture, i.e. how wide the eyes are.
 *
 * All indices below are the *inner* lip ring, which is what actually forms the
 * oval you see when a mouth opens (the outer ring is the visible lip border).
 */

/** Upper inner lip, left corner → right corner. */
export const UPPER_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
/** Lower inner lip, right corner → left corner. */
export const LOWER_INNER = [324, 318, 402, 317, 14, 87, 178, 88, 95]
/** Mouth corners: 61 = right corner, 291 = left corner. */
export const CORNERS = [61, 291]

/** Outer eye corners — the face-width ruler. */
const EYE_CORNERS = [33, 263]

/** Eyelid contours, for drawing. */
export const EYE_RING_RIGHT = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7]
export const EYE_RING_LEFT = [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382]

/** (upper lid, lower lid) pairs used for the eye aspect ratio. */
const EYE_PAIRS_RIGHT: ReadonlyArray<readonly [number, number]> = [
  [160, 144],
  [158, 153],
]
const EYE_PAIRS_LEFT: ReadonlyArray<readonly [number, number]> = [
  [385, 380],
  [387, 373],
]

/**
 * The closed ring around the opening: upper lip → right corner → lower lip →
 * left corner. Without the corners the shape cuts the mouth short at both ends.
 */
const OVAL_RING = [...UPPER_INNER, CORNERS[1], ...LOWER_INNER, CORNERS[0]]

/** Vertically opposed landmark pairs used to measure the aperture. */
const APERTURE_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [82, 87],
  [13, 14],
  [312, 317],
]

/** Aperture / face-width with the lips together. Calibrated on real faces. */
const VERT_CLOSED = 0.006
/** Aperture / face-width for a fully open mouth (a full yawn). */
const VERT_OPEN = 0.3

/** Mouth-width / face-width at rest, lips together. */
const HORIZ_REST = 0.58
/** Mouth-width / face-width of a broad stretched grin. */
const HORIZ_WIDE = 0.9

/** Aspect ratio of the opening at a round ":o". */
const ASPECT_ROUND = 0.8

/**
 * Eye aspect ratio at a relaxed open eye, and at a genuinely wide one.
 * Measured on real faces: neutral 0.28, smiling 0.20, surprised 0.39, extreme
 * 0.46, eyes shut 0.02. Anchoring zero at a relaxed eye means normal blinking
 * and looking around cost nothing; only a deliberate wide-eyed look reacts.
 */
const EAR_REST = 0.29
const EAR_WIDE = 0.44

export type FaceState = {
  /** 0 = closed, 1 = wide open. Vertical mouth opening. */
  open: number
  /** 0 = rest width, 1 = fully stretched sideways. */
  wide: number
  /** 1 = pursed and round (":o"), 0 = stretched flat ("—"). Aspect ratio. */
  round: number
  /** 0 = normal open eyes, 1 = pulled wide in surprise. */
  eyes: number
  /** Raw measurements / face width, for tuning. */
  vertical: number
  horizontal: number
  ear: number
  /** Face height as a fraction of frame height: how big the face is on screen. */
  heightRatio: number
  /** Eye separation over face height: the "big eyes" baby cue. */
  eyesOverFaceH: number
  /** Closed polygons in video pixel space. */
  oval: Array<{ x: number; y: number }>
  eyeOvals: [Array<{ x: number; y: number }>, Array<{ x: number; y: number }>]
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))

/**
 * @param points normalised (0..1) landmark array
 * @param width  video width in pixels
 * @param height video height in pixels
 */
export function readFace(
  points: Array<{ x: number; y: number }>,
  width: number,
  height: number,
): FaceState | null {
  if (!points || points.length < 468) return null

  const px = (i: number) => ({ x: points[i].x * width, y: points[i].y * height })

  const eyeA = px(EYE_CORNERS[0])
  const eyeB = px(EYE_CORNERS[1])
  const faceWidth = Math.hypot(eyeB.x - eyeA.x, eyeB.y - eyeA.y)
  if (faceWidth < 1) return null

  const left = px(CORNERS[0])
  const right = px(CORNERS[1])
  const dx = right.x - left.x
  const dy = right.y - left.y
  const mouthWidth = Math.hypot(dx, dy)
  if (mouthWidth < 1) return null

  // Rotate into mouth-local space so a tilted head doesn't inflate the gap.
  const ax = dx / mouthWidth
  const ay = dy / mouthWidth

  let aperture = 0
  for (const [a, b] of APERTURE_PAIRS) {
    const p = px(a)
    const q = px(b)
    const vx = q.x - p.x
    const vy = q.y - p.y
    aperture += Math.abs(vx * ay - vy * ax) // perpendicular component only
  }
  aperture /= APERTURE_PAIRS.length

  const vertical = aperture / faceWidth
  const horizontal = mouthWidth / faceWidth

  const open = clamp((vertical - VERT_CLOSED) / (VERT_OPEN - VERT_CLOSED))
  const wide = clamp((horizontal - HORIZ_REST) / (HORIZ_WIDE - HORIZ_REST))
  // Aspect ratio of the opening, normalised by a typical round ":o".
  const round = clamp(vertical / Math.max(horizontal, 1e-4) / ASPECT_ROUND)

  // Eye aspect ratio: mean lid gap over eye width, both eyes averaged.
  const earOf = (pairs: ReadonlyArray<readonly [number, number]>, cornerA: number, cornerB: number) => {
    const a = px(cornerA)
    const b = px(cornerB)
    const w = Math.hypot(b.x - a.x, b.y - a.y)
    if (w < 1) return 0
    let gap = 0
    for (const [u, l] of pairs) {
      const p = px(u)
      const q = px(l)
      gap += Math.hypot(q.x - p.x, q.y - p.y)
    }
    return gap / pairs.length / w
  }
  const ear =
    (earOf(EYE_PAIRS_RIGHT, EYE_CORNERS[0], 133) + earOf(EYE_PAIRS_LEFT, EYE_CORNERS[1], 362)) / 2

  const eyes = clamp((ear - EAR_REST) / (EAR_WIDE - EAR_REST))

  // Forehead (10) to chin (152): the whole face, for the "tiny human" cue.
  const brow = px(10)
  const chin = px(152)
  const faceHeight = Math.hypot(chin.x - brow.x, chin.y - brow.y)
  const eyesSpan = Math.hypot(eyeB.x - eyeA.x, eyeB.y - eyeA.y)

  return {
    open,
    wide,
    round,
    eyes,
    vertical,
    horizontal,
    ear,
    heightRatio: faceHeight / height,
    eyesOverFaceH: faceHeight > 1 ? eyesSpan / faceHeight : 0,
    oval: OVAL_RING.map(px),
    eyeOvals: [EYE_RING_RIGHT.map(px), EYE_RING_LEFT.map(px)],
  }
}

/**
 * One-pole smoothing with a faster attack than release, so the mouth "pops"
 * open instantly but closes with a natural decay instead of chattering.
 */
export function smoothMouth(prev: number, next: number) {
  const alpha = next > prev ? 0.6 : 0.18
  return prev + (next - prev) * alpha
}

/** Gentler smoothing for the tone axes, which should not twitch. */
export function smoothTone(prev: number, next: number) {
  return prev + (next - prev) * 0.12
}
