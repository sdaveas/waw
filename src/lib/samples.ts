/**
 * Recorded pet sounds.
 *
 * Synthesised animal noises landed nowhere near convincing, so the cat and the
 * dog are real recordings: a CC0 Siamese meow and a public-domain dog howl,
 * both trimmed here and committed under public/audio.
 *
 * They are still played like instruments, not one-shots: playbackRate follows
 * how wide the mouth is, and the sustain of the sample loops while the mouth
 * stays open. That is what turns one recording into "niaw" or "niaaaaaaaaw".
 */

const BASE = import.meta.env.BASE_URL

/** What the sample loader needs to know about each animal. */
export type SampleSpec = {
  file: string
  /** Region of the clip to loop while the mouth is held, as a fraction of it. */
  loopStart: number
  loopEnd: number
  /** Playback rate when the mouth is barely open, and when it is wide. */
  rateTight: number
  rateWide: number
}

export const PET_SAMPLES: Record<'cat' | 'dog', SampleSpec> = {
  cat: { file: 'audio/cat-meow.wav', loopStart: 0.36, loopEnd: 0.88, rateTight: 1.55, rateWide: 0.72 },
  dog: { file: 'audio/dog-howl.wav', loopStart: 0.45, loopEnd: 0.85, rateTight: 1.25, rateWide: 0.62 },
}

const buffers = new Map<string, AudioBuffer>()

export function getSample(kind: 'cat' | 'dog') {
  return buffers.get(kind)
}

/**
 * Decode the pet samples into the running context. Failure is not fatal: the
 * instrument falls back to the synthesised voice, so a blocked request or a
 * missing file degrades rather than goes silent.
 */
export async function loadPetSamples(ctx: BaseAudioContext) {
  await Promise.all(
    (Object.keys(PET_SAMPLES) as Array<'cat' | 'dog'>).map(async (kind) => {
      if (buffers.has(kind)) return
      try {
        const res = await fetch(`${BASE}${PET_SAMPLES[kind].file}`)
        if (!res.ok) return
        buffers.set(kind, await ctx.decodeAudioData(await res.arrayBuffer()))
      } catch {
        /* keep the synth fallback */
      }
    }),
  )
}
