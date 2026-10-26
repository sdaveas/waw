/**
 * Voices. Each one turns the two mouth axes into sound.
 *
 *   open  — vertical opening, 0..1. Pitch and loudness.
 *   wide  — horizontal stretch, 0..1. Brightness.
 *   round — aspect ratio of the opening, 0..1. Darkness ("ooooh" vs "aaaah").
 *
 * A voice owns its nodes and connects its output to the destination node the
 * engine hands it (a per-voice gain, so instruments can crossfade).
 */

export type MouthParams = {
  open: number
  wide: number
  round: number
  /** True once the opening is past the engine's gate. */
  voiced: boolean
}

export interface Voice {
  setParams(p: MouthParams, t?: number): void
  readonly hz: number
  dispose(): void
}

export type Instrument = {
  id: string
  label: string
  blurb: string
  create(ctx: AudioContext, dest: AudioNode): Voice
  /** Output trim, so switching instruments keeps a similar loudness. */
  level?: number
  /** How long the sound rings after the mouth closes, in ms. */
  releaseMs?: number
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const ease = (v: number) => Math.pow(v, 0.85)

/** Shared helper: an oscillator pair plus a vibrato LFO. */
function sawPair(ctx: AudioContext, input: AudioNode) {
  const a = ctx.createOscillator()
  a.type = 'sawtooth'
  const b = ctx.createOscillator()
  b.type = 'sawtooth'
  b.detune.value = 7
  a.connect(input)
  b.connect(input)

  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 5.2
  const depth = ctx.createGain()
  depth.gain.value = 6
  lfo.connect(depth)
  depth.connect(a.detune)
  depth.connect(b.detune)

  a.start()
  b.start()
  lfo.start()
  return {
    depth,
    setHz(hz: number, t: number, glide = 0.045) {
      a.frequency.setTargetAtTime(hz, t, glide)
      b.frequency.setTargetAtTime(hz * 1.004, t, glide)
    },
    dispose() {
      a.stop()
      b.stop()
      lfo.stop()
    },
  }
}

function noiseSource(ctx: AudioContext, seconds = 2) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.loop = true
  return src
}

/* ------------------------------------------------------------------ singer */

const createSinger: Instrument['create'] = (ctx, dest) => {
  const out = ctx.createGain()
  out.connect(dest)
  const input = ctx.createGain()

  const bands = [
    { hz: 300, q: 5, gain: 1.0 },
    { hz: 1100, q: 6, gain: 0.85 },
    { hz: 2600, q: 8, gain: 0.45 },
  ].map((spec) => {
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = spec.hz
    bp.Q.value = spec.q
    const g = ctx.createGain()
    g.gain.value = spec.gain
    input.connect(bp).connect(g).connect(out)
    return { bp, g }
  })
  const [f1Band, f2Band, f3Band] = bands

  // Just a trace of the raw saw: enough for body, not enough to swamp the
  // formants, which are what make "ooooh" and "aaaah" different sounds.
  const dry = ctx.createGain()
  dry.gain.value = 0.02
  input.connect(dry).connect(out)

  const noise = noiseSource(ctx)
  const noiseBp = ctx.createBiquadFilter()
  noiseBp.type = 'bandpass'
  noiseBp.frequency.value = 1600
  noiseBp.Q.value = 0.8
  const breath = ctx.createGain()
  breath.gain.value = 0
  noise.connect(noiseBp).connect(breath).connect(out)
  noise.start()

  const osc = sawPair(ctx, input)
  let hz = 92

  return {
    get hz() {
      return hz
    },
    setParams({ open, wide, round }, t = ctx.currentTime) {
      const e = ease(open)
      hz = 92 + 208 * e
      osc.setHz(hz, t)
      osc.depth.gain.setTargetAtTime(4 + 26 * open, t, 0.1)
      // F1 follows the jaw, F2 the mouth's shape: stretched brightens, round darkens.
      const f1 = 300 + 520 * open
      const f2 = clamp(1100 + 900 * wide - 750 * round, 600, 2600)
      const f3 = 2400 + 600 * wide
      f1Band.bp.frequency.setTargetAtTime(f1, t, 0.05)
      f2Band.bp.frequency.setTargetAtTime(f2, t, 0.05)
      f3Band.bp.frequency.setTargetAtTime(f3, t, 0.05)
      // Upper formants also get louder as the mouth stretches, so the two
      // axes are audible independently of where the resonances sit.
      f2Band.g.gain.setTargetAtTime(0.85 * (0.5 + 0.5 * wide), t, 0.05)
      f3Band.g.gain.setTargetAtTime(0.45 * (0.2 + 0.8 * wide) * (1 - 0.5 * round), t, 0.05)
      breath.gain.setTargetAtTime(0.05 * e, t, 0.05)
    },
    dispose() {
      noise.stop()
      osc.dispose()
    },
  }
}

/* ------------------------------------------------------------------ violin */

const createViolin: Instrument['create'] = (ctx, dest) => {
  const out = ctx.createGain()
  out.connect(dest)
  const input = ctx.createGain()

  const lowpass = ctx.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = 1800
  lowpass.Q.value = 2.5
  input.connect(lowpass).connect(out)

  // Body resonances — a box is what makes a violin sound boxy.
  for (const { hz, q, gain } of [
    { hz: 280, q: 3, gain: 0.5 },
    { hz: 620, q: 4, gain: 0.35 },
  ]) {
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = hz
    bp.Q.value = q
    const g = ctx.createGain()
    g.gain.value = gain
    input.connect(bp).connect(g).connect(out)
  }

  const noise = noiseSource(ctx)
  const bowBp = ctx.createBiquadFilter()
  bowBp.type = 'bandpass'
  bowBp.frequency.value = 3000
  bowBp.Q.value = 0.7
  const bow = ctx.createGain()
  bow.gain.value = 0
  noise.connect(bowBp).connect(bow).connect(out)
  noise.start()

  const osc = sawPair(ctx, input)
  let hz = 196

  return {
    get hz() {
      return hz
    },
    setParams({ open, wide, round }, t = ctx.currentTime) {
      const e = ease(open)
      hz = 196 + 464 * e // G3 → E5
      osc.setHz(hz, t)
      osc.depth.gain.setTargetAtTime(8 + 35 * open, t, 0.2)
      const bright = clamp(0.5 * open + 0.6 * wide - 0.3 * round)
      lowpass.frequency.setTargetAtTime(500 + 3200 * bright, t, 0.06)
      lowpass.Q.setTargetAtTime(1.5 + 3 * bright, t, 0.06)
      bow.gain.setTargetAtTime(0.02 * e, t, 0.05)
    },
    dispose() {
      noise.stop()
      osc.dispose()
    },
  }
}

/* ---------------------------------------------------------------- theremin */

const createTheremin: Instrument['create'] = (ctx, dest) => {
  const out = ctx.createGain()
  out.connect(dest)

  const osc1 = ctx.createOscillator()
  osc1.type = 'sine'
  const g1 = ctx.createGain()
  g1.gain.value = 1
  osc1.connect(g1).connect(out)

  // Harmonics that appear as the mouth stretches sideways, and a sub-octave
  // that takes over as it goes round. A pure sine can't get brighter, so the
  // shape has to show up in the partials.
  const partials = [2, 3].map((mult) => {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    const g = ctx.createGain()
    g.gain.value = 0
    osc.connect(g).connect(out)
    return { osc, g, mult }
  })
  const sub = ctx.createOscillator()
  sub.type = 'sine'
  const subGain = ctx.createGain()
  subGain.gain.value = 0
  sub.connect(subGain).connect(out)

  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 5.5
  const depth = ctx.createGain()
  depth.gain.value = 12
  lfo.connect(depth)
  depth.connect(osc1.detune)
  for (const p of partials) depth.connect(p.osc.detune)
  depth.connect(sub.detune)

  // Slow tremolo keeps it voice-like.
  const trem = ctx.createOscillator()
  trem.type = 'sine'
  trem.frequency.value = 0.7
  const tremDepth = ctx.createGain()
  tremDepth.gain.value = 0.12
  trem.connect(tremDepth).connect(g1.gain)

  osc1.start()
  sub.start()
  for (const p of partials) p.osc.start()
  lfo.start()
  trem.start()

  let hz = 130

  return {
    get hz() {
      return hz
    },
    setParams({ open, wide, round }, t = ctx.currentTime) {
      const e = ease(open)
      hz = 130 + 750 * e // spooky range
      // Long glide: a theremin slides, it does not snap.
      osc1.frequency.setTargetAtTime(hz, t, 0.09)
      sub.frequency.setTargetAtTime(hz / 2, t, 0.09)
      const bright = wide * (1 - 0.7 * round)
      for (const p of partials) {
        p.osc.frequency.setTargetAtTime(hz * p.mult, t, 0.09)
        p.g.gain.setTargetAtTime(0.28 * bright / p.mult, t, 0.05)
        // Slight detune makes a beating wobble that grows as you stretch.
        p.osc.detune.setTargetAtTime(wide * 14, t, 0.1)
      }
      subGain.gain.setTargetAtTime(0.35 * round, t, 0.05)
      depth.gain.setTargetAtTime(12 + 40 * open, t, 0.2)
    },
    dispose() {
      osc1.stop()
      sub.stop()
      for (const p of partials) p.osc.stop()
      lfo.stop()
      trem.stop()
    },
  }
}

/* ------------------------------------------------------------------- kazoo */

const createKazoo: Instrument['create'] = (ctx, dest) => {
  const out = ctx.createGain()
  out.connect(dest)
  const input = ctx.createGain()

  // The buzzing membrane: a tight resonance well above the fundamental.
  const buzz = ctx.createBiquadFilter()
  buzz.type = 'bandpass'
  buzz.frequency.value = 1400
  buzz.Q.value = 4
  const buzzGain = ctx.createGain()
  buzzGain.gain.value = 2.2
  input.connect(buzz).connect(buzzGain).connect(out)

  const nasal = ctx.createBiquadFilter()
  nasal.type = 'bandpass'
  nasal.frequency.value = 3200
  nasal.Q.value = 6
  const nasalGain = ctx.createGain()
  nasalGain.gain.value = 0.9
  input.connect(nasal).connect(nasalGain).connect(out)

  const osc = sawPair(ctx, input)
  let hz = 110

  return {
    get hz() {
      return hz
    },
    setParams({ open, wide, round }, t = ctx.currentTime) {
      const e = ease(open)
      hz = 110 + 240 * e
      osc.setHz(hz, t)
      osc.depth.gain.setTargetAtTime(20 + 45 * open, t, 0.12) // wobble hard
      buzz.frequency.setTargetAtTime(clamp(900 + 900 * wide - 400 * round, 500, 2400), t, 0.05)
      buzz.Q.setTargetAtTime(4 + 6 * (1 - wide), t, 0.05)
      // The nasal band has to fade too, or it pins the tone bright no matter
      // how round the mouth is.
      nasalGain.gain.setTargetAtTime(0.9 * (0.25 + 0.75 * wide) * (1 - 0.4 * round), t, 0.05)
    },
    dispose() {
      osc.dispose()
    },
  }
}

/* ------------------------------------------------------------------ guitar */

/**
 * Karplus–Strong: a noise burst injected into a damped delay line. The mouth
 * opening plucks it, so a waaaw comes out as a strum, and changing the opening
 * while it rings bends the string like a whammy bar.
 */
const createGuitar: Instrument['create'] = (ctx, dest) => {
  const out = ctx.createGain()
  out.connect(dest)

  const delay = ctx.createDelay(1)
  delay.delayTime.value = 1 / 110

  const damp = ctx.createBiquadFilter()
  damp.type = 'lowpass'
  damp.frequency.value = 3000
  // Q must stay flat (0.707): a resonant lowpass has gain above 1 at cutoff,
  // and any loop gain over 1 makes the string explode instead of decay.
  damp.Q.value = 0.707
  const fb = ctx.createGain()
  fb.gain.value = 0.96

  const rumbleCut = ctx.createBiquadFilter()
  rumbleCut.type = 'highpass'
  rumbleCut.frequency.value = 90
  rumbleCut.Q.value = 0.707

  // Safety net: even a mis-set loop can only saturate, never run away.
  const limiter = ctx.createWaveShaper()
  const curve = new Float32Array(1024)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(x * 1.5)
  }
  limiter.curve = curve
  limiter.oversample = '2x'

  delay.connect(damp).connect(rumbleCut).connect(limiter).connect(fb).connect(delay)
  delay.connect(out)

  // Soundbox colour.
  for (const { hz, q, gain } of [
    { hz: 200, q: 2, gain: 0.3 },
    { hz: 900, q: 3, gain: 0.18 },
  ]) {
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = hz
    bp.Q.value = q
    const g = ctx.createGain()
    g.gain.value = gain
    delay.connect(bp).connect(g).connect(out)
  }

  // Excitation burst, reused for every pluck.
  const burstBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate)
  const bd = burstBuf.getChannelData(0)
  for (let i = 0; i < bd.length; i++) {
    bd[i] = (Math.random() * 2 - 1) * (1 - i / bd.length)
  }

  let hz = 110
  let lastOpen = 0
  let lastPluck = 0
  let wasVoiced = false

  const pluck = (when: number) => {
    const src = ctx.createBufferSource()
    src.buffer = burstBuf
    src.connect(delay)
    src.start(when)
    src.stop(when + 0.05)
  }

  return {
    get hz() {
      return hz
    },
    setParams({ open, wide, round, voiced }, t = ctx.currentTime) {
      const e = ease(open)
      hz = 110 + 250 * e // A2 → ~D4
      // Retune the string; ringing notes bend to follow the mouth.
      delay.delayTime.setTargetAtTime(1 / clamp(hz, 60, 900), t, 0.03)
      damp.frequency.setTargetAtTime(clamp(1200 + 3600 * wide - 900 * round, 500, 6000), t, 0.05)
      // Stay comfortably under unity so plucks decay instead of growing.
      fb.gain.setTargetAtTime(0.93 + 0.035 * (1 - round) + 0.02 * wide, t, 0.05)

      if (voiced) {
        // Pluck on opening, restrike on a big change, and keep strumming
        // slowly while the mouth stays open.
        const rising = !wasVoiced
        const jumped = Math.abs(open - lastOpen) > 0.22
        const strum = t - lastPluck > 0.75
        if (rising || jumped || strum) {
          pluck(t)
          lastPluck = t
        }
      }
      lastOpen = voiced ? open : 0
      wasVoiced = voiced
    },
    dispose() {
      /* the delay line goes quiet on its own once it stops being fed */
    },
  }
}

export const INSTRUMENTS: Instrument[] = [
  {
    id: 'singer',
    label: 'Singer',
    blurb: 'Formant voice: "ooooh" when round, "aaaah" when stretched.',
    create: createSinger,
    level: 3.8,
  },
  {
    id: 'violin',
    label: 'Violin',
    blurb: 'Bowed string with a wooden body.',
    create: createViolin,
    level: 1.4,
  },
  {
    id: 'theremin',
    label: 'Theremin',
    blurb: 'Pure sliding tone, no frets.',
    create: createTheremin,
    level: 1.25,
  },
  {
    id: 'kazoo',
    label: 'Kazoo',
    blurb: 'Nasal buzz with heavy wobble.',
    create: createKazoo,
    level: 3.5,
  },
  {
    id: 'guitar',
    label: 'Guitar',
    blurb: 'Plucked string: strums when you open, bends while you hold.',
    create: createGuitar,
    level: 1.25,
    releaseMs: 300,
  },
]

export const DEFAULT_INSTRUMENT = 'singer'

export function getInstrument(id: string) {
  return INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0]
}
