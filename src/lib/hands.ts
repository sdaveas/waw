/**
 * Hands, from MediaPipe's 21-point hand model.
 *
 * Hands are the wah pedal: the hand closest to the camera sweeps the filter,
 * a second hand sets the squelch (resonance). Height is read from the palm
 * centre rather than a fingertip, so curling fingers does not move the wah.
 */

/** Wrist, then the four knuckles — a stable centre for the palm. */
const PALM_POINTS = [0, 5, 9, 13, 17]

/** Bone connections, for drawing. */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

/** Top and bottom of the useful sweep, in normalised video height (0 = top). */
const TOP = 0.15
const BOTTOM = 0.8

/**
 * MediaPipe happily labels a face, a shadow or a crossed arm as a hand, and it
 * is not shy about it: in testing a pair of crossed arms scored 0.98 while the
 * real hand scored 0.83. Confidence is therefore useless for picking between
 * them, but size is not — the hand you are playing with is the one close to the
 * camera. Anything smaller than this fraction of the frame width is ignored.
 */
const MIN_SCORE = 0.6
const MIN_SIZE_RATIO = 0.035

export type HandState = {
  /** True if any hand is in frame. */
  present: boolean
  /** 0 = wah fully closed, 1 = wide open. From hand height. */
  wah: number
  /** 0 = clean, 1 = maximum squelch. From the second hand's height. */
  squelch: number
  /** Palm centre and skeleton per detected hand, in video pixel space. */
  hands: Array<{
    handedness: string
    score: number
    /** Palm length in pixels — a proxy for how close the hand is. */
    size: number
    palm: { x: number; y: number }
    points: Array<{ x: number; y: number }>
  }>
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))

/** Normalised height → 0..1, where raising the hand opens the wah. */
function heightOf(y: number) {
  return clamp((BOTTOM - y) / (BOTTOM - TOP))
}

export function readHands(
  landmarks: Array<Array<{ x: number; y: number }>>,
  handedness: Array<Array<{ categoryName: string; score: number }>>,
  width: number,
  height: number,
): HandState {
  const hands: HandState['hands'] = []

  landmarks.forEach((points, index) => {
    if (!points || points.length < 21) return
    const category = handedness[index]?.[0]
    const score = category?.score ?? 0
    if (score < MIN_SCORE) return

    const palmX = PALM_POINTS.reduce((s, i) => s + points[i].x, 0) / PALM_POINTS.length
    const palmY = PALM_POINTS.reduce((s, i) => s + points[i].y, 0) / PALM_POINTS.length
    const label = category?.categoryName ?? 'Right'

    const px = points.map((p) => ({ x: p.x * width, y: p.y * height }))
    // Wrist to middle knuckle: a stable stand-in for how close the hand is.
    const size = Math.hypot(px[9].x - px[0].x, px[9].y - px[0].y)
    if (size < MIN_SIZE_RATIO * width) return
    hands.push({
      handedness: label,
      score,
      size,
      palm: { x: palmX * width, y: palmY * height },
      points: px,
    })

  })

  if (hands.length === 0) return { present: false, wah: 0, squelch: 0, hands }

  // Biggest hand wins: it is the one actually being played. Handedness is not
  // used for the roles, because MediaPipe derives it from a mirrored image and
  // it flips with the camera.
  const ranked = hands.slice().sort((a, b) => b.size - a.size)
  const wah = heightOf(ranked[0].palm.y / height)
  // Squelch needs a second hand; without one it sits at a clean setting.
  const squelch = ranked.length > 1 ? heightOf(ranked[1].palm.y / height) : 0.15

  return { present: true, wah, squelch, hands: ranked }
}

/** Hand movement is deliberately smoothed harder than the face. */
export function smoothHand(prev: number, next: number) {
  return prev + (next - prev) * 0.15
}
