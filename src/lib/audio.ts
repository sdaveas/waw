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
  PET_INSTRUMENTS,
  type Instrument,
  type VoiceParams,
  type Voice,
} from './instruments'
import type { PetKind } from './pets'

/**
 * How far the mouth must open before anything sounds. Low enough that a slight
 * parting sings; a resting face still measures 0.00, so silence is preserved.
 */
export const GATE = 0.22
/** Wah fully open, i.e. effectively bypassed when no hand is in frame. */
const WAH_OPEN_HZ = 18000
/** Bottom of the sweep, and octaves spanned up to fully open. */
const WAH_LOW_HZ = 250
const WAH_OCTAVES = 5
/** Resonance range: clean to squelchy. */
const SQUELCH_MIN = 0.7
const SQUELCH_MAX = 11

/** Level at the gate, and at a fully open mouth. */
const LEVEL_MIN = 0.04
const LEVEL_MAX = 0.62
/**
 * Below 1 the crescendo comes in early: just past the gate the volume is
 * already clearly audible, then it flattens towards full.
 */
const LEVEL_CURVE = 0.7

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
  /** The instrument the player chose, which pet mode temporarily overrides. */
  private manual: Instrument
  private instrument: Instrument
  private petKind: PetKind = null
  private muted = false
  private params: VoiceParams = { pitch: 0, bright: 0, round: 0, drive: 0, voiced: false }
  private spawnToken = 0
  private echo = 0
  private wah: BiquadFilterNode | null = null
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
    this.manual = getInstrument(instrumentId)
    this.instrument = this.manual
    this.injected = injectedCtx
  }

  private injected?: AudioContext

  get instrumentId() {
    return this.instrument.id
  }

  get running() {
    return this.ctx?.state === 'running'
  }

  /** 'suspended' means the browser is holding the audio, not that we are mute. */
  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none'
  }

  /** iOS interrupts the context on a route change, a call, or screen lock. */
  onStateChange?: (state: AudioContextState) => void

  async resume() {
    try {
      await this.ctx?.resume()
    } catch {
      /* not resumable without a gesture; the caller shows a tap prompt */
    }
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
    if (!this.offline) {
      ctx.onstatechange = () => this.onStateChange?.(ctx.state)
      // iOS routes Web Audio as "ambient" by default, which the hardware ringer
      // switch silences entirely. Asking for "playback" makes it audible with
      // the switch off. Feature-detected: only newer Safari has this.
      try {
        const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession
        if (session) session.type = 'playback'
      } catch {
        /* older browser, nothing to do */
      }
    }

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

    // Wah pedal: a resonant lowpass the hands sweep, in series between the
    // voice and the level gate. In series matters — a parallel path would
    // leak the unfiltered voice past the wah and dilute it.
    const wah = ctx.createBiquadFilter()
    wah.type = 'lowpass'
    wah.frequency.value = WAH_OPEN_HZ
    wah.Q.value = 0.7
    wah.connect(master)
    this.wah = wah

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
    gain.connect(this.wah ?? master)

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
    this.manual = getInstrument(instrumentId)
    // While a pet is on camera it keeps the stage; the choice is remembered for
    // when it leaves.
    if (this.petKind) return
    this.swapTo(this.manual)
  }

  /** Pet mode replaces the instrument entirely, and restores it on exit. */
  setPet(kind: PetKind) {
    if (kind === this.petKind) return
    const next = kind ? PET_INSTRUMENTS[kind] : this.manual
    // An unknown pet must not take the whole engine down with it.
    if (!next) return
    this.petKind = kind
    this.swapTo(next)
  }

  get pet() {
    return this.petKind
  }

  private swapTo(next: Instrument) {
    if (next.id === this.instrument.id) return
    this.instrument = next
    if (!this.ctx) return
    this.killVoice()
    const token = ++this.spawnToken
    window.setTimeout(() => {
      if (token === this.spawnToken) this.spawn()
    }, 170)
  }

  setMuted(muted: boolean) {
    this.muted = muted
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
    const gate = this.instrument.gate ?? GATE
    const voiced = drive > gate
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
    const trim = this.instrument.level ?? 1

    if (this.muted) {
      master.gain.setTargetAtTime(0, t, 0.03)
      return
    }
    // Pets make their own noise while they are on camera; the mouth rides on
    // top instead of gating it.
    if (this.instrument.alwaysOn) {
      const ride = 0.4 + 0.6 * Math.pow(Math.min(1, this.params.drive), 0.7)
      master.gain.setTargetAtTime(LEVEL_MAX * trim * ride, t, (this.instrument.attackMs ?? 80) / 1000)
      return
    }
    if (!voiced) {
      master.gain.setTargetAtTime(0, t, release)
      return
    }
    // Remap the usable range (gate → fully open) onto 0 → 1, so opening the
    // mouth is an actual crescendo instead of a step to near-full volume.
    const amount = Math.max(0, (drive - gate) / (1 - gate))
    const level =
      (LEVEL_MIN + (LEVEL_MAX - LEVEL_MIN) * Math.pow(amount, LEVEL_CURVE)) * trim
    const attack = (this.instrument.attackMs ?? 20) / 1000
    master.gain.setTargetAtTime(level, t, attack)
  }

  /**
   * Hands are the wah pedal: height sweeps the cutoff, the second hand sets the
   * resonance. With no hand in frame the filter parks wide open and flat, so
   * the app sounds exactly as it did before hands existed.
   */
  setHands(wah: number, squelch: number, present: boolean) {
    const ctx = this.ctx
    if (!ctx || !this.wah) return
    const t = ctx.currentTime
    if (!present) {
      this.wah.frequency.setTargetAtTime(WAH_OPEN_HZ, t, 0.1)
      this.wah.Q.setTargetAtTime(SQUELCH_MIN, t, 0.1)
      return
    }
    const hz = WAH_LOW_HZ * Math.pow(2, WAH_OCTAVES * Math.min(1, Math.max(0, wah)))
    this.wah.frequency.setTargetAtTime(hz, t, 0.05)
    this.wah.Q.setTargetAtTime(SQUELCH_MIN + (SQUELCH_MAX - SQUELCH_MIN) * squelch, t, 0.08)
  }

  /** Cutoff in Hz, for the display. */
  get wahHz() {
    return this.wah?.frequency.value ?? 0
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
    this.wah = null
    if (this.offline) return
    try {
      await ctx.close()
    } catch {
      /* already closed */
    }
  }
}
