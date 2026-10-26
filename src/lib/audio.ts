/**
 * WaaawEngine — owns the AudioContext, the instrument voices, and the
 * mouth-to-loudness envelope.
 *
 * The engine adds a master gain on top of whatever voice is playing, so the
 * gate (a closed mouth is silent) and the level ramp are identical for every
 * instrument.
 */

import {
  DEFAULT_INSTRUMENT,
  getInstrument,
  type Instrument,
  type MouthParams,
  type Voice,
} from './instruments'

/** Openness below this stays silent — a grin is not a waaaw. */
export const GATE = 0.58
const PEAK_GAIN = 0.5

export class WaaawEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private voiceGain: GainNode | null = null
  private voice: Voice | null = null
  private instrument: Instrument
  private params: MouthParams = { open: 0, wide: 0, round: 0, voiced: false }
  private spawnToken = 0

  constructor(instrumentId: string = DEFAULT_INSTRUMENT) {
    this.instrument = getInstrument(instrumentId)
  }

  get instrumentId() {
    return this.instrument.id
  }

  get running() {
    return this.ctx?.state === 'running'
  }

  /** Must be called from a user-gesture handler or the context stays suspended. */
  async start(instrumentId?: string) {
    if (instrumentId) this.instrument = getInstrument(instrumentId)
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume()
      return
    }

    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AudioCtor()
    this.ctx = ctx

    // A compressor sits after the level control: instrument trims can then be
    // matched for loudness without the peaks clipping the output.
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -12
    comp.knee.value = 12
    comp.ratio.value = 4
    comp.attack.value = 0.005
    comp.release.value = 0.15
    comp.connect(ctx.destination)

    const master = ctx.createGain()
    master.gain.value = 0
    master.connect(comp)
    this.master = master

    this.spawn()
    if (ctx.state !== 'running') await ctx.resume()
  }

  private spawn() {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return

    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(master)

    const voice = this.instrument.create(ctx, gain)
    voice.setParams(this.params)
    gain.gain.setTargetAtTime(1, ctx.currentTime, 0.06)

    this.voice = voice
    this.voiceGain = gain
  }

  private killVoice() {
    const ctx = this.ctx
    const gain = this.voiceGain
    const voice = this.voice
    this.voice = null
    this.voiceGain = null
    if (!ctx || !gain) return
    gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05)
    window.setTimeout(() => {
      try {
        voice?.dispose()
        gain.disconnect()
      } catch {
        /* the node is gone, nothing to clean up */
      }
    }, 160)
  }

  /** Swap instruments without a click: fade out, rebuild, fade in. */
  setInstrument(instrumentId: string) {
    const next = getInstrument(instrumentId)
    if (next.id === this.instrument.id) return
    this.instrument = next
    if (!this.ctx) return
    this.killVoice()
    const token = ++this.spawnToken
    window.setTimeout(() => {
      if (token === this.spawnToken) this.spawn()
    }, 170)
  }

  /**
   * @param open  0..1 vertical opening
   * @param wide  0..1 horizontal stretch
   * @param round 0..1 aspect ratio of the opening
   */
  setMouth(open: number, wide: number, round: number) {
    const ctx = this.ctx
    const voiced = open > GATE
    this.params = { open, wide, round, voiced }
    if (!ctx) return

    this.voice?.setParams(this.params)

    const master = this.master
    if (!master) return
    const t = ctx.currentTime
    const release = this.instrument.releaseMs ? this.instrument.releaseMs / 1000 : 0.04
    if (!voiced) {
      master.gain.setTargetAtTime(0, t, release)
      return
    }
    const level = (0.12 + PEAK_GAIN * Math.pow(open, 0.85)) * (this.instrument.level ?? 1)
    master.gain.setTargetAtTime(level, t, 0.02)
  }

  /** Current fundamental, for display. */
  get hz() {
    return this.voice?.hz ?? 0
  }

  async stop() {
    const ctx = this.ctx
    if (!ctx) return
    this.master?.gain.setTargetAtTime(0, ctx.currentTime, 0.03)
    this.ctx = null
    this.master = null
    this.voice = null
    this.voiceGain = null
    try {
      await ctx.close()
    } catch {
      /* already closed */
    }
  }
}
