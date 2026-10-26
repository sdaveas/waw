/**
 * Mouth geometry, derived from MediaPipe FaceLandmarker's 468-point mesh.
 *
 * Two independent, scale-invariant axes come out of this:
 *
 *   vertical   — how far the lips part, divided by face width. Drives pitch.
 *   horizontal — how wide the opening is stretched, divided by face width.
 *                Drives tone colour.
 *
 * Both are divided by the distance between the outer eye corners so leaning
 * towards the camera changes nothing.
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

export type MouthState = {
  /** 0 = closed, 1 = wide open. Vertical. */
  open: number
  /** 0 = rest width, 1 = fully stretched sideways. Horizontal. */
  wide: number
  /** 1 = pursed and round (":o"), 0 = stretched flat ("—"). Aspect ratio. */
  round: number
  /** Raw measurements / face width, for tuning. */
  vertical: number
  horizontal: number
  /** Closed polygon tracing the inner lip ring, in video pixel space. */
  oval: Array<{ x: number; y: number }>
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))

/**
 * @param points normalised (0..1) landmark array
 * @param width  video width in pixels
 * @param height video height in pixels
 */
export function readMouth(
  points: Array<{ x: number; y: number }>,
  width: number,
  height: number,
): MouthState | null {
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

  const oval = OVAL_RING.map(px)
  return { open, wide, round, vertical, horizontal, oval }
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
