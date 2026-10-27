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
  /** 0..1 pitch, from the main hand's height. */
  pitch: number
  /** Whole octaves, -2..+2, from the second hand's height. */
  octave: number
  /** Raw height of the octave hand, or null when only one hand is up. */
  octaveHeight: number | null
  /** True when a second hand is visible and setting the octave. */
  hasOctaveHand: boolean
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

  if (hands.length === 0)
    return { present: false, pitch: 0, octave: 0, octaveHeight: null, hasOctaveHand: false, hands }

  // Biggest hand wins: it is the one actually being played. Handedness is not
  // used for the roles, because MediaPipe derives it from a mirrored image and
  // it flips with the camera.
  const ranked = hands.slice().sort((a, b) => b.size - a.size)
  const pitch = heightOf(ranked[0].palm.y / height)
  const hasOctaveHand = ranked.length > 1
  const octaveHeight = hasOctaveHand ? heightOf(ranked[1].palm.y / height) : null
  const octave = octaveHeight !== null ? octaveFor(octaveHeight) : 0

  return { present: true, pitch, octave, octaveHeight, hasOctaveHand, hands: ranked }
}

/** Five octave zones: low hand = two down, high hand = two up. */
export function octaveFor(height: number) {
  const zone = Math.min(4, Math.max(0, Math.floor(clamp(height) * 5)))
  return zone - 2
}

/**
 * Octave changes have to be sticky: a hand hovering on a zone boundary would
 * otherwise flip octaves every frame. Only move when the height clears the
 * boundary by a margin.
 */
export function stableOctave(height: number, previous: number) {
  const next = octaveFor(height)
  if (next === previous) return previous
  const boundaryLow = (next + 2) / 5
  const boundaryHigh = (next + 3) / 5
  const margin = 0.04
  const h = clamp(height)
  if (h < boundaryLow + margin || h > boundaryHigh - margin) return previous
  return next
}

/** Hand movement is deliberately smoothed harder than the face. */
export function smoothHand(prev: number, next: number) {
  return prev + (next - prev) * 0.15
}
