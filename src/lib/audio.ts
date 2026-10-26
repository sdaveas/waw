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
  type VoiceParams,
  type Voice,
} from './instruments'

/** How far the mouth must open before anything sounds. */
export const GATE = 0.58
/** Level at the gate, and at a fully open mouth. */
const LEVEL_MIN = 0.04
const LEVEL_MAX = 0.62
/** 1 = linear crescendo from the gate to a fully open mouth. */
const LEVEL_CURVE = 1

/** What the eye tracker hands the engine. */
export type MouthReading = {
  open: number
  wide: number
  round: number
  eyes: number
}

export class WaaawEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private voiceGain: GainNode | null = null
  private voice: Voice | null = null
  private instrument: Instrument
  private params: VoiceParams = { pitch: 0, bright: 0, round: 0, drive: 0, voiced: false }
  private spawnToken = 0
  private echo = 0
  private fxWet: GainNode | null = null
  private fxFeedback: GainNode | null = null
  private fxDamp: BiquadFilterNode | null = null
  private offline = false

  /**
   * @param instrumentId which voice to load
   * @param injectedCtx  test seam: pass an OfflineAudioContext to render the
   *                     real graph headlessly. Production omits it.
   */
  constructor(instrumentId: string = DEFAULT_INSTRUMENT, injectedCtx?: AudioContext) {
    this.instrument = getInstrument(instrumentId)
    this.injected = injectedCtx
  }

  private injected?: AudioContext

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
    const ctx = this.injected ?? new AudioCtor()
    // An offline context renders on a clock we do not drive.
    this.offline = typeof (ctx as unknown as { startRendering?: unknown }).startRendering === 'function'
    this.ctx = ctx

    // A compressor sits after the level control: instrument trims can then be
    // matched for loudness without the peaks clipping the output.
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -6
    comp.knee.value = 8
    comp.ratio.value = 3
    comp.attack.value = 0.005
    comp.release.value = 0.15
    // Final safety stage: tanh saturation, so a quiet mouth stays quiet and a
    // wide one gets loud without ever clipping the output.
    const limiter = ctx.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1
      curve[i] = Math.tanh(x * 1.4) * 0.92
    }
    limiter.curve = curve
    limiter.oversample = '2x'
    comp.connect(limiter).connect(ctx.destination)

    const master = ctx.createGain()
    master.gain.value = 0
    master.connect(comp)
    this.master = master

    // Echo bus: voices feed a send, the delay repeats into the compressor.
    const delay = ctx.createDelay(2)
    delay.delayTime.value = 0.26
    const damp = ctx.createBiquadFilter()
    damp.type = 'lowpass'
    damp.frequency.value = 1600
    damp.Q.value = 0.707
    const feedback = ctx.createGain()
    feedback.gain.value = 0.3
    delay.connect(damp).connect(feedback).connect(delay)

    const wet = ctx.createGain()
    wet.gain.value = 0
    delay.connect(wet).connect(comp)

    const send = ctx.createGain()
    send.gain.value = 1
    send.connect(delay)
    // Tapped after the level gate, not from the voice: a voice oscillates even
    // when it is silent, and feeding that in makes the repeats sustain forever.
    master.connect(send)

    this.fxWet = wet
    this.fxFeedback = feedback
    this.fxDamp = damp

    this.spawn()
    if (!this.offline && ctx.state !== 'running') await ctx.resume()
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
   * The face-to-sound mapping lives here, and only here.
   *
   *   vertical opening  → volume (and brightness)
   *   horizontal stretch → pitch
   *   aspect ratio      → roundness   (darkens)
   *   wide eyes         → echo
   *
   * Loudness follows the vertical opening, which is also the gate: lips apart
   * is what makes a waaaw, and stretching them is what tunes it.
   */
  setFace(mouth: MouthReading) {
    const ctx = this.ctx
    const drive = mouth.open
    const voiced = drive > GATE
    this.params = {
      pitch: mouth.wide,
      bright: mouth.open,
      round: mouth.round,
      drive,
      voiced,
    }
    if (!ctx) return

    this.voice?.setParams(this.params)
    this.setEcho(mouth.eyes)

    const master = this.master
    if (!master) return
    const t = ctx.currentTime
    const release = this.instrument.releaseMs ? this.instrument.releaseMs / 1000 : 0.04
    if (!voiced) {
      master.gain.setTargetAtTime(0, t, release)
      return
    }
    // Remap the usable range (gate → fully open) onto 0 → 1, so opening the
    // mouth is an actual crescendo instead of a step to near-full volume.
    const amount = Math.max(0, (drive - GATE) / (1 - GATE))
    const level =
      (LEVEL_MIN + (LEVEL_MAX - LEVEL_MIN) * Math.pow(amount, LEVEL_CURVE)) *
      (this.instrument.level ?? 1)
    master.gain.setTargetAtTime(level, t, 0.02)
  }

  /**
   * Wide eyes push the voice into a feedback delay. The wet path bypasses the
   * level gate, so closing your mouth lets the repeats ring out instead of
   * chopping them off.
   */
  private setEcho(eyes: number) {
    const ctx = this.ctx
    if (!ctx || !this.fxWet || !this.fxFeedback || !this.fxDamp) return
    const t = ctx.currentTime
    this.echo = eyes
    this.fxWet.gain.setTargetAtTime(0.6 * eyes, t, 0.08)
    this.fxFeedback.gain.setTargetAtTime(0.3 + 0.34 * eyes, t, 0.08)
    // Wider eyes also give brighter, more present repeats.
    this.fxDamp.frequency.setTargetAtTime(1600 + 2400 * eyes, t, 0.08)
  }

  get voiced() {
    return this.params.voiced
  }

  get echoAmount() {
    return this.echo
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
    this.fxWet = null
    this.fxFeedback = null
    this.fxDamp = null
    if (this.offline) return
    try {
      await ctx.close()
    } catch {
      /* already closed */
    }
  }
}
