/**
 * Mouth geometry, derived from MediaPipe FaceLandmarker's 468-point mesh.
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

/** Aperture / mouth-width at rest (lips together). Calibrated on real faces. */
const RATIO_CLOSED = 0.055
/** Aperture / mouth-width for a fully open mouth. */
const RATIO_OPEN = 0.52

export type MouthState = {
  /** 0 = closed, 1 = wide open. */
  open: number
  /** Raw aperture divided by mouth width. */
  ratio: number
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

  const ratio = aperture / mouthWidth
  const open = clamp((ratio - RATIO_CLOSED) / (RATIO_OPEN - RATIO_CLOSED))

  const oval = OVAL_RING.map(px)
  return { open, ratio, oval }
}

/**
 * One-pole smoothing with a faster attack than release, so the mouth "pops"
 * open instantly but closes with a natural decay instead of chattering.
 */
export function smoothMouth(prev: number, next: number) {
  const alpha = next > prev ? 0.6 : 0.18
  return prev + (next - prev) * alpha
}
