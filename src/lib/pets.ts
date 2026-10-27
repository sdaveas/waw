/**
 * Pet mode.
 *
 * Cats and dogs come from the COCO object detector, which is reliable for cats
 * and mostly reliable for dogs (a clear dog scores 0.9; a fluffy one can come
 * back as "bear").
 *
 * "Tiny humans" have no COCO class and, measured on real faces, cannot be told
 * from adults by geometry: eye separation over face height is 0.51–0.70 for
 * babies and 0.48–0.61 for adults, which overlaps. So a baby is inferred from
 * the one cue that does hold — a small face next to a big one, i.e. somebody
 * holding the baby up to the camera.
 */

export type PetKind = 'cat' | 'dog' | 'baby' | null

export type Detection = { label: string; score: number }

export type PetCue = {
  /** Object detector output for this frame. */
  objects: Detection[]
  /** Face heights as a fraction of frame height, one per detected face. */
  faceHeights: number[]
  /** Eye separation over face height, for the largest face. */
  eyesOverFaceH: number
}

/** A dog or cat has to be found at least this confidently. */
const PET_SCORE = 0.25
/** A face this much smaller than another one is likely a baby being held. */
const BABY_SIZE_RATIO = 1.55
/** Or: a single face this wide-eyed is likely a baby. */
const BABY_EYES = 0.65

export function detectPet(cue: PetCue): PetKind {
  const best = (label: string) =>
    cue.objects.filter((o) => o.label === label).reduce((max, o) => Math.max(max, o.score), 0)

  const cat = best('cat')
  const dog = best('dog')
  if (cat >= PET_SCORE && cat >= dog) return 'cat'
  if (dog >= PET_SCORE) return 'dog'

  const faces = cue.faceHeights.filter((h) => h > 0)
  if (faces.length >= 2) {
    const big = Math.max(...faces)
    const small = Math.min(...faces)
    if (big / small >= BABY_SIZE_RATIO) return 'baby'
  } else if (faces.length === 1 && cue.eyesOverFaceH >= BABY_EYES) {
    return 'baby'
  }

  return null
}

/**
 * Pet mode should not flicker between frames, so a detection has to hold for a
 * few frames before it is trusted, and has to stay gone a little longer before
 * it lets go.
 */
export class PetStabiliser {
  private pending: PetKind = null
  private count = 0
  private current: PetKind = null
  private enterFrames: number
  private exitFrames: number

  constructor(enterFrames = 4, exitFrames = 10) {
    this.enterFrames = enterFrames
    this.exitFrames = exitFrames
  }

  update(next: PetKind): PetKind {
    if (next === this.current) {
      this.pending = null
      this.count = 0
      return this.current
    }
    if (next === this.pending) this.count++
    else {
      this.pending = next
      this.count = 1
    }
    const needed = next === null ? this.exitFrames : this.enterFrames
    if (this.count >= needed) {
      this.current = next
      this.pending = null
      this.count = 0
    }
    return this.current
  }

  get kind() {
    return this.current
  }
}
