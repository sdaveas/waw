/**
 * WaaawSynth — a tiny formant synthesiser.
 *
 * A "waaaaw" is a vowel (roughly /ɑː/, formants ~700 / 1200 / 2600 Hz) with a
 * rising pitch contour. We get both by feeding two detuned sawtooths through a
 * three-band formant filter and gliding the fundamental with the mouth opening.
 */

const HZ_CLOSED = 92
const HZ_OPEN = 300
const PEAK_GAIN = 0.42
/** Openness below this stays silent — a smile is not a waaaw. */
export const GATE = 0.3

type Formant = { hz: number; q: number; gain: number }

const FORMANTS: Formant[] = [
  { hz: 700, q: 7, gain: 1.0 },
  { hz: 1220, q: 9, gain: 0.55 },
  { hz: 2600, q: 12, gain: 0.22 },
]

export class WaaawSynth {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private oscA: OscillatorNode | null = null
  private oscB: OscillatorNode | null = null
  private lfoDepth: GainNode | null = null
  private breathGain: GainNode | null = null
  private open = 0

  get running() {
    return this.ctx?.state === 'running'
  }

  /** Must be called from a user-gesture handler or the context stays suspended. */
  async start() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') await this.ctx.resume()
      return
    }

    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AudioCtor()
    this.ctx = ctx

    const master = ctx.createGain()
    master.gain.value = 0
    master.connect(ctx.destination)
    this.master = master

    // Sum bus for all formant bands.
    const formantBus = ctx.createGain()
    formantBus.gain.value = 1
    formantBus.connect(master)

    for (const f of FORMANTS) {
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = f.hz
      bp.Q.value = f.q
      const g = ctx.createGain()
      g.gain.value = f.gain
      bp.connect(g).connect(formantBus)
    }
    // A little dry signal keeps it from sounding like a pure filter sweep.
    const dry = ctx.createGain()
    dry.gain.value = 0.06
    dry.connect(master)

    const oscA = ctx.createOscillator()
    oscA.type = 'sawtooth'
    oscA.frequency.value = HZ_CLOSED
    const oscB = ctx.createOscillator()
    oscB.type = 'sawtooth'
    oscB.frequency.value = HZ_CLOSED
    oscB.detune.value = 8
    oscA.connect(formantBus)
    oscB.connect(formantBus)
    oscA.connect(dry)
    oscB.connect(dry)

    // Vibrato: shallow when closed, wider as the mouth opens.
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 5.2
    const lfoDepth = ctx.createGain()
    lfoDepth.gain.value = 5
    lfo.connect(lfoDepth)
    lfoDepth.connect(oscA.detune)
    lfoDepth.connect(oscB.detune)

    // Breath noise — sells the "voice" more than the oscillators alone.
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    const noise = ctx.createBufferSource()
    noise.buffer = noiseBuffer
    noise.loop = true
    const noiseBp = ctx.createBiquadFilter()
    noiseBp.type = 'bandpass'
    noiseBp.frequency.value = 1600
    noiseBp.Q.value = 0.8
    const breathGain = ctx.createGain()
    breathGain.gain.value = 0
    noise.connect(noiseBp).connect(breathGain).connect(master)

    oscA.start()
    oscB.start()
    lfo.start()
    noise.start()

    this.oscA = oscA
    this.oscB = oscB
    this.lfoDepth = lfoDepth
    this.breathGain = breathGain

    if (ctx.state !== 'running') await ctx.resume()
  }

  /** @param open 0..1 mouth opening, already smoothed. */
  setOpen(open: number) {
    this.open = open
    const ctx = this.ctx
    if (!ctx || !this.master || !this.oscA || !this.oscB) return

    const t = ctx.currentTime
    // Ignore anything below a deliberate opening, so smiles and lip smacks
    // stay quiet. Above the gate the rest of the range is the instrument.
    const voiced = Math.min(1, Math.max(0, (open - GATE) / (1 - GATE)))
    const eased = Math.pow(voiced, 0.85)

    const hz = HZ_CLOSED + (HZ_OPEN - HZ_CLOSED) * eased
    // Small portamento so pitch bends rather than jumps.
    this.oscA.frequency.setTargetAtTime(hz, t, 0.045)
    this.oscB.frequency.setTargetAtTime(hz * 1.004, t, 0.045)

    this.lfoDepth?.gain.setTargetAtTime(4 + 26 * voiced, t, 0.1)

    const gate = voiced <= 0 ? 0 : 0.12 + PEAK_GAIN * eased
    this.master.gain.setTargetAtTime(gate, t, voiced <= 0 ? 0.05 : 0.02)

    this.breathGain?.gain.setTargetAtTime(voiced <= 0 ? 0 : 0.05 * eased, t, 0.05)
  }

  /** Current fundamental, for display. */
  get hz() {
    const voiced = Math.min(1, Math.max(0, (this.open - GATE) / (1 - GATE)))
    return HZ_CLOSED + (HZ_OPEN - HZ_CLOSED) * Math.pow(voiced, 0.85)
  }

  async stop() {
    if (!this.ctx) return
    const ctx = this.ctx
    this.master?.gain.setTargetAtTime(0, ctx.currentTime, 0.03)
    this.ctx = null
    this.master = null
    this.oscA = null
    this.oscB = null
    try {
      await ctx.close()
    } catch {
      /* already closed */
    }
  }
}
