/**
 * Voices.
 *
 * The engine does the mouth-to-sound mapping, so a voice only has to know what
 * to do with four normalised signals:
 *
 *   pitch  — horizontal mouth stretch. Sets the fundamental.
 *   bright — vertical mouth opening. Sets how bright the tone is.
 *   round  — aspect ratio of the opening, 1 = pursed. Darkens the tone.
 *   drive  — how far the mouth is doing anything at all. Sets loudness.
 *
 * Swapping what each axis controls is a change here plus one line in the
 * engine, not a rewrite: the voices only see pitch/bright/round/drive.
 *
 * A voice owns its nodes and connects its output to the destination node the
 * engine hands it (a per-voice gain, so instruments can crossfade).
 */

import { getSample, PET_SAMPLES } from './samples'

export type VoiceParams = {
  pitch: number
  bright: number
  round: number
  drive: number
  /** True once the opening is past the engine's gate. */
  voiced: boolean
}

export interface Voice {
  setParams(p: VoiceParams, t?: number): void
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
  /** Keeps playing regardless of the mouth gate (the baby shark loop). */
  alwaysOn?: boolean
  /** How long the level takes to arrive, in ms. Choirs bloom, organs snap. */
  attackMs?: number
  /**
   * How far the mouth must open before this voice sounds. Instruments use the
   * global gate; pets need a lower one, because a small "niaw" is exactly what
   * a slightly open mouth is for.
   */
  gate?: number
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

/** How bright a voice should be, from the two tone axes. */
const toneOf = (bright: number, round: number, pitch: number) =>
  clamp(bright - 0.45 * round * (1 - pitch))

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
    setParams({ pitch, bright, round, drive }, t = ctx.currentTime) {
      hz = 92 + 208 * ease(pitch)
      osc.setHz(hz, t)
      osc.depth.gain.setTargetAtTime(4 + 26 * pitch, t, 0.1)
      // F1 tracks how far the jaw dropped, F2 how bright the tone is; a pursed
      // opening pulls F2 down towards a dark "oo".
      const tone = toneOf(bright, round, pitch)
      const f1 = 300 + 520 * bright
      const f2 = clamp(700 + 1500 * tone, 600, 2600)
      const f3 = 2400 + 600 * bright
      f1Band.bp.frequency.setTargetAtTime(f1, t, 0.05)
      f2Band.bp.frequency.setTargetAtTime(f2, t, 0.05)
      f3Band.bp.frequency.setTargetAtTime(f3, t, 0.05)
      f2Band.g.gain.setTargetAtTime(0.85 * (0.4 + 0.6 * tone), t, 0.05)
      f3Band.g.gain.setTargetAtTime(0.45 * (0.15 + 0.85 * tone), t, 0.05)
      breath.gain.setTargetAtTime(0.05 * ease(drive), t, 0.05)
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
    setParams({ pitch, bright, round, drive }, t = ctx.currentTime) {
      hz = 196 + 464 * ease(pitch) // G3 → E5
      osc.setHz(hz, t)
      osc.depth.gain.setTargetAtTime(8 + 35 * pitch, t, 0.2)
      const tone = toneOf(bright, round, pitch)
      lowpass.frequency.setTargetAtTime(500 + 3300 * tone, t, 0.06)
      lowpass.Q.setTargetAtTime(1.5 + 3 * tone, t, 0.06)
      bow.gain.setTargetAtTime(0.02 * ease(drive), t, 0.05)
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

  // Harmonics that appear as the tone brightens, and a sub-octave that takes
  // over as the mouth goes round. A pure sine can't get brighter, so the shape
  // has to show up in the partials.
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
    setParams({ pitch, bright, round }, t = ctx.currentTime) {
      hz = 130 + 750 * ease(pitch) // spooky range
      // Long glide: a theremin slides, it does not snap.
      osc1.frequency.setTargetAtTime(hz, t, 0.09)
      sub.frequency.setTargetAtTime(hz / 2, t, 0.09)
      const tone = toneOf(bright, round, pitch)
      for (const p of partials) {
        p.osc.frequency.setTargetAtTime(hz * p.mult, t, 0.09)
        p.g.gain.setTargetAtTime((0.3 * tone) / p.mult, t, 0.05)
        // Slight detune makes a beating wobble that grows with brightness.
        p.osc.detune.setTargetAtTime(tone * 14, t, 0.1)
      }
      subGain.gain.setTargetAtTime(0.35 * round, t, 0.05)
      depth.gain.setTargetAtTime(12 + 40 * pitch, t, 0.2)
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
    setParams({ pitch, bright, round }, t = ctx.currentTime) {
      hz = 110 + 240 * ease(pitch)
      osc.setHz(hz, t)
      osc.depth.gain.setTargetAtTime(20 + 45 * pitch, t, 0.12) // wobble hard
      const tone = toneOf(bright, round, pitch)
      buzz.frequency.setTargetAtTime(clamp(700 + 1500 * tone, 500, 2400), t, 0.05)
      buzz.Q.setTargetAtTime(4 + 6 * (1 - tone), t, 0.05)
      // The nasal band has to fade too, or it pins the tone bright no matter
      // how round the mouth is.
      nasalGain.gain.setTargetAtTime(0.9 * (0.2 + 0.8 * tone), t, 0.05)
    },
    dispose() {
      osc.dispose()
    },
  }
}

/* ------------------------------------------------------------------ guitar */

/**
 * Karplus–Strong: a noise burst injected into a damped delay line. The mouth
 * opening plucks it, so a waaaw comes out as a strum, and stretching the mouth
 * retunes the string while it rings — a whammy bar made of lips.
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

  // The wah itself: a resonant bandpass in series, with its peak parked
  // somewhere and then moved by the mouth. A wah pedal is exactly this — a
  // narrow peak sweeping across the signal — so the sweep has to come from the
  // player, not from a fixed ramp on each pluck.
  const wah = ctx.createBiquadFilter()
  wah.type = 'bandpass'
  wah.frequency.value = 700
  wah.Q.value = 3.2

  // A narrow peak parked between the string's harmonics would gate the note,
  // so keep a straight-through path alongside it: the wah colours the sound
  // instead of switching it on and off as the peak moves past each harmonic.
  const wahGain = ctx.createGain()
  wahGain.gain.value = 0.85
  const dryGain = ctx.createGain()
  dryGain.gain.value = 0.4
  delay.connect(wah).connect(wahGain).connect(out)
  delay.connect(dryGain).connect(out)

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
  let lastPitch = 0
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
    setParams({ pitch, bright, round, voiced }, t = ctx.currentTime) {
      hz = 110 + 250 * ease(pitch) // A2 → ~D4
      // Retune the string; ringing notes bend to follow the mouth.
      delay.delayTime.setTargetAtTime(1 / clamp(hz, 60, 900), t, 0.03)
      const tone = toneOf(bright, round, pitch)
      damp.frequency.setTargetAtTime(clamp(700 + 4200 * tone, 500, 6000), t, 0.05)
      // Open your mouth and the peak climbs, from a closed "wuh" to an open
      // "wah". Logarithmic, because pitch is.
      const wahHz = 330 * Math.pow(2500 / 330, clamp(bright))
      wah.frequency.setTargetAtTime(wahHz, t, 0.025)
      // Stay comfortably under unity so plucks decay instead of growing.
      fb.gain.setTargetAtTime(0.93 + 0.035 * (1 - round) + 0.02 * bright, t, 0.05)

      if (voiced) {
        // Pluck on opening, restrike when the pitch is re-fretted, and keep
        // strumming slowly while the mouth stays open.
        const rising = !wasVoiced
        const refretted = Math.abs(pitch - lastPitch) > 0.18
        const strum = t - lastPluck > 0.75
        if (rising || refretted || strum) {
          pluck(t)
          lastPluck = t
        }
      }
      lastPitch = voiced ? pitch : 0
      wasVoiced = voiced
    },
    dispose() {
      /* the delay line goes quiet on its own once it stops being fed */
    },
  }
}


/* -------------------------------------------------------------- pet voices */

/**
 * A MIDI cat, driven by the mouth rather than a timer.
 *
 * The mouth is the length of the sound: a quick blip gives a quick "niaw", and
 * holding it open gives "niaaaaaaaaaaw". The glide is quantised to semitones
 * and stepped, the way an old sound chip bends a note, which is what makes it
 * read as MIDI rather than as a synth.
 */
const createCatMeow: Instrument['create'] = (ctx, dest) => {
  const out = ctx.createGain()
  out.connect(dest)
  const input = ctx.createGain()

  const nasal = ctx.createBiquadFilter()
  nasal.type = 'peaking'
  nasal.frequency.value = 1900
  nasal.Q.value = 1.1
  nasal.gain.value = 12
  input.connect(nasal).connect(out)

  const lowpass = ctx.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = 5200
  input.connect(lowpass).connect(out)

  const square = ctx.createOscillator()
  square.type = 'square'
  square.frequency.value = 600
  square.connect(input)
  square.start()

  const body = ctx.createOscillator()
  body.type = 'triangle'
  body.frequency.value = 300
  const bodyGain = ctx.createGain()
  bodyGain.gain.value = 0.35
  body.connect(bodyGain).connect(input)
  body.start()

  const amp = ctx.createGain()
  amp.gain.value = 0
  out.disconnect(dest)
  out.connect(amp).connect(dest)

  const vibrato = ctx.createOscillator()
  vibrato.type = 'sine'
  vibrato.frequency.value = 7.5
  const vibDepth = ctx.createGain()
  vibDepth.gain.value = 46
  vibrato.connect(vibDepth)
  vibDepth.connect(square.frequency)
  vibrato.start()

  let hz = 600
  let onsetAt = -1

  const quantise = (f: number) => 440 * Math.pow(2, Math.round(12 * Math.log2(f / 440)) / 12)

  /** u goes 0 → 1 over the glide, then holds at 1 while the mouth stays open. */
  const shape = (u: number, base: number, t: number) => {
    const contour: Array<[number, number]> = [
      [0, 1.02],
      [0.18, 0.92],
      [0.45, 1.22],
      [1, 1.0],
    ]
    const at = (x: number) => {
      for (let i = 1; i < contour.length; i++) {
        const [x1, v1] = contour[i]
        const [x0, v0] = contour[i - 1]
        if (x <= x1) return v0 + ((v1 - v0) * (x - x0)) / (x1 - x0)
      }
      return contour[contour.length - 1][1]
    }
    const f = quantise(base * at(Math.min(1, u)))
    square.frequency.setTargetAtTime(f, t, 0.012)
    body.frequency.setTargetAtTime(f / 2, t, 0.012)
    hz = f
  }

  return {
    get hz() {
      return hz
    },
    setParams({ bright, voiced }, t = ctx.currentTime) {
      if (voiced) {
        if (onsetAt < 0) {
          // attack: the "n" of "niaw"
          onsetAt = t
          amp.gain.cancelScheduledValues(t)
          amp.gain.setValueAtTime(0, t)
          amp.gain.linearRampToValueAtTime(0.8, t + 0.03)
          amp.gain.linearRampToValueAtTime(0.7, t + 0.12)
        }
        // How long the "iaaaaw" takes to unfold: a barely-open mouth gets a
        // quick miaw, a wide one stretches it right out.
        const glide = 0.22 + 1.5 * bright
        const u = (t - onsetAt) / glide
        shape(u, 470 + 360 * bright, t)
        // sustain level while held
        amp.gain.setTargetAtTime(0.72, t, 0.05)
      } else if (onsetAt >= 0) {
        // release: slide down into the "w"
        onsetAt = -1
        const drop = Math.max(80, hz * 0.62)
        square.frequency.cancelScheduledValues(t)
        square.frequency.setTargetAtTime(drop, t, 0.05)
        body.frequency.setTargetAtTime(drop / 2, t, 0.05)
        amp.gain.cancelScheduledValues(t)
        amp.gain.setTargetAtTime(0, t, 0.07)
      }
    },
    dispose() {
      square.stop()
      body.stop()
      vibrato.stop()
    },
  }
}

/**
 * A dog howl, also mouth-driven: "aww" for a short opening, "aaawwwwwww" while
 * held open. The vowel slides from "ah" to "oo" as the howl unfolds.
 */
const createDogHowl: Instrument['create'] = (ctx, dest) => {
  const out = ctx.createGain()
  out.connect(dest)
  const input = ctx.createGain()

  const formants = [
    { hz: 750, q: 5, gain: 1 },
    { hz: 1150, q: 6, gain: 0.6 },
  ].map((spec) => {
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = spec.hz
    bp.Q.value = spec.q
    const g = ctx.createGain()
    g.gain.value = spec.gain
    input.connect(bp).connect(g).connect(out)
    return bp
  })

  const saw = ctx.createOscillator()
  saw.type = 'sawtooth'
  saw.frequency.value = 220
  saw.connect(input)
  saw.start()

  const noise = noiseSource(ctx, 1)
  const breathBp = ctx.createBiquadFilter()
  breathBp.type = 'bandpass'
  breathBp.frequency.value = 1200
  breathBp.Q.value = 0.6
  const breath = ctx.createGain()
  breath.gain.value = 0
  noise.connect(breathBp).connect(breath).connect(out)
  noise.start()

  const amp = ctx.createGain()
  amp.gain.value = 0
  out.disconnect(dest)
  out.connect(amp).connect(dest)

  const vibrato = ctx.createOscillator()
  vibrato.type = 'sine'
  vibrato.frequency.value = 5.4
  const vibDepth = ctx.createGain()
  vibDepth.gain.value = 0
  vibrato.connect(vibDepth)
  vibDepth.connect(saw.frequency)
  vibrato.start()

  let hz = 220
  let onsetAt = -1

  return {
    get hz() {
      return hz
    },
    setParams({ bright, voiced }, t = ctx.currentTime) {
      if (voiced) {
        if (onsetAt < 0) {
          onsetAt = t
          amp.gain.cancelScheduledValues(t)
          amp.gain.setValueAtTime(0, t)
          amp.gain.linearRampToValueAtTime(0.9, t + 0.06)
          breath.gain.setValueAtTime(0.05, t)
        }
        // Wide open stretches the "aaawwww" out; a small opening is a short "aww".
        const glide = 0.25 + 1.9 * bright
        const u = Math.min(1, (t - onsetAt) / glide)
        const f0 = 175 + 95 * bright
        // rise into the howl, then sag away as the vowel rounds
        const bend = u < 0.35 ? 0.9 + (0.42 * u) / 0.35 : 1.32 - 0.5 * ((u - 0.35) / 0.65)
        saw.frequency.setTargetAtTime(f0 * bend, t, 0.05)
        hz = f0 * bend
        formants[0].frequency.setTargetAtTime(780 - 440 * u, t, 0.08)
        formants[1].frequency.setTargetAtTime(1180 - 420 * u, t, 0.08)
        vibDepth.gain.setTargetAtTime(5 + 12 * u, t, 0.2)
        amp.gain.setTargetAtTime(0.85, t, 0.08)
      } else if (onsetAt >= 0) {
        onsetAt = -1
        saw.frequency.setTargetAtTime(Hz9(hz), t, 0.06)
        amp.gain.cancelScheduledValues(t)
        amp.gain.setTargetAtTime(0, t, 0.09)
        breath.gain.setTargetAtTime(0, t, 0.06)
      }
    },
    dispose() {
      saw.stop()
      noise.stop()
      vibrato.stop()
    },
  }
}

/** A little downward sag for the tail of a howl. */
function Hz9(hz: number) {
  return Math.max(70, hz * 0.72)
}

const NOTE: Record<string, number> = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23,
  G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25,
}

/**
 * Baby shark, in the loosest sense: an approximation of the riff, not a
 * transcription. A lookahead scheduler queues notes slightly ahead of the audio
 * clock, because setTimeout alone is too jittery to keep a beat.
 */
const createBabyShark: Instrument['create'] = (ctx, dest) => {
  const out = ctx.createGain()
  out.connect(dest)
  const lead = ctx.createGain()
  lead.gain.value = 0.5
  lead.connect(out)
  const bass = ctx.createGain()
  bass.gain.value = 0.35
  bass.connect(out)

  const MELODY = ['C4', 'C4', 'D4', 'E4', 'E4', 'D4', 'C4', 'D4']
  const BASS = ['C4', 'G4', 'C4', 'G4']
  const STEP = 0.19 // eighth notes
  let index = 0
  let nextTime = ctx.currentTime + 0.1
  let timer: number | null = null
  let hz = NOTE.C4

  const blip = (freq: number, at: number, target: GainNode, type: OscillatorType, len: number) => {
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(1, at + 0.01)
    g.gain.exponentialRampToValueAtTime(0.001, at + len)
    osc.connect(g).connect(target)
    osc.start(at)
    osc.stop(at + len + 0.05)
  }

  const pump = () => {
    while (nextTime < ctx.currentTime + 0.3) {
      const note = MELODY[index % MELODY.length]
      hz = NOTE[note]
      blip(hz, nextTime, lead, 'triangle', 0.16)
      // a bass note every two steps, for the bounce
      if (index % 2 === 0) {
        blip(NOTE[BASS[(index / 2) % BASS.length]] / 2, nextTime, bass, 'sine', 0.24)
      }
      index++
      nextTime += STEP
    }
    timer = window.setTimeout(pump, 60)
  }
  pump()

  return {
    get hz() {
      return hz
    },
    setParams() {
      /* the loop runs itself; the mouth does not gate it */
    },
    dispose() {
      if (timer !== null) window.clearTimeout(timer)
    },
  }
}

/**
 * A pet voice built from a real recording.
 *
 * The mouth is the length again: the clip starts on the way in, then only its
 * sustain loops while the mouth stays open, so holding it gives
 * "niaaaaaaaaw" from a one-second meow. Playback rate follows how wide the
 * mouth is — a tight mouth plays it fast and high (a short "niaw"), a wide one
 * slow and low.
 */
const createSampledPet = (kind: 'cat' | 'dog', level: number): Instrument => {
  const spec = PET_SAMPLES[kind]
  return {
    id: `pet-${kind}`,
    label: kind === 'cat' ? 'Cat' : 'Dog',
    blurb: kind === 'cat' ? 'real meow' : 'real howl',
    level,
    releaseMs: 120,
    gate: 0.06,
    create: (ctx, dest) => {
      const buffer = getSample(kind)
      if (!buffer) return null as unknown as Voice

      const out = ctx.createGain()
      out.gain.value = 0
      out.connect(dest)

      let src: AudioBufferSourceNode | null = null
      let hz = 0

      const rateFor = (bright: number) =>
        spec.rateTight + (spec.rateWide - spec.rateTight) * clamp(bright)

      const begin = (t: number, rate: number) => {
        const node = ctx.createBufferSource()
        node.buffer = buffer
        node.loop = true
        node.loopStart = spec.loopStart * buffer.duration
        node.loopEnd = spec.loopEnd * buffer.duration
        node.playbackRate.value = rate
        node.connect(out)
        node.start(t)
        out.gain.setTargetAtTime(0.9, t, 0.008)
        src = node
      }

      const end = (t: number) => {
        const node = src
        src = null
        if (!node) return
        out.gain.cancelScheduledValues(t)
        out.gain.setTargetAtTime(0, t, 0.05)
        try {
          node.stop(t + 0.25)
        } catch {
          /* already stopped */
        }
      }

      return {
        get hz() {
          return hz
        },
        setParams({ bright, voiced }, t = ctx.currentTime) {
          const rate = rateFor(bright)
          hz = 0 // sampled, so there is no fundamental to report
          if (voiced) {
            if (!src) begin(t, rate)
            else src.playbackRate.setTargetAtTime(rate, t, 0.06)
          } else if (src) {
            end(t)
          }
        },
        dispose() {
          end(ctx.currentTime)
        },
      }
    },
  }
}

const petInstrument = (
  id: string,
  label: string,
  blurb: string,
  create: Instrument['create'],
  level: number,
  alwaysOn = false,
): Instrument => ({ id, label, blurb, create, level, releaseMs: 200, alwaysOn, gate: 0.06 })

export const PET_INSTRUMENTS: Record<'cat' | 'dog' | 'baby', Instrument> = {
  cat: withSampleFallback(createSampledPet('cat', 1.7), () =>
    petInstrument('pet-cat', 'Cat', 'midi miaw', createCatMeow, 0.36),
  ),
  dog: withSampleFallback(createSampledPet('dog', 1.7), () =>
    petInstrument('pet-dog', 'Dog', 'awoooo', createDogHowl, 3.4),
  ),
  baby: petInstrument('pet-baby', 'Tiny human', 'baby shark', createBabyShark, 1.6, true),
}

/** Whether this instrument should keep sounding while the mouth is shut. */
export function isAlwaysOn(instrument: Instrument) {
  return instrument.alwaysOn === true
}

/* ------------------------------------------------------------------- choir */

/**
 * A choir is several voices, slightly out of tune with each other, singing the
 * same vowel. Detuned saws give the beating, a slow chorus LFO keeps it moving,
 * and the formants follow the mouth so the vowel changes.
 */
const createChoir: Instrument['create'] = (ctx, dest) => {
  const out = ctx.createGain()
  out.connect(dest)
  const input = ctx.createGain()

  const bands = [650, 1150, 2500].map((hz, i) => {
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = hz
    bp.Q.value = [4, 5, 6][i]
    const g = ctx.createGain()
    g.gain.value = [1, 0.7, 0.35][i]
    input.connect(bp).connect(g).connect(out)
    return { bp, g }
  })

  // Four voices: detune spread gives the "many people" chorus.
  const DETUNE = [-9, -3, 4, 11]
  const oscs = DETUNE.map((cents) => {
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.detune.value = cents
    osc.frequency.value = 220
    osc.connect(input)
    osc.start()
    return osc
  })

  // Slow drift so the chord never sits perfectly still.
  const drift = ctx.createOscillator()
  drift.type = 'sine'
  drift.frequency.value = 0.23
  const driftDepth = ctx.createGain()
  driftDepth.gain.value = 6
  drift.connect(driftDepth)
  oscs.forEach((o) => driftDepth.connect(o.detune))
  drift.start()

  const vib = ctx.createOscillator()
  vib.type = 'sine'
  vib.frequency.value = 5.1
  const vibDepth = ctx.createGain()
  vibDepth.gain.value = 7
  vib.connect(vibDepth)
  oscs.forEach((o) => vibDepth.connect(o.detune))
  vib.start()

  let hz = 220

  return {
    get hz() {
      return hz
    },
    setParams({ pitch, bright, round }, t = ctx.currentTime) {
      hz = 174 + 320 * ease(pitch) // F3 → ~A4
      // Voices glide, they do not jump to a note.
      oscs.forEach((o) => o.frequency.setTargetAtTime(hz, t, 0.12))
      vibDepth.gain.setTargetAtTime(5 + 14 * pitch, t, 0.2)
      const f1 = 480 + 320 * bright
      const f2 = clamp(760 + 1400 * bright - 520 * round, 600, 2400)
      const f3 = 2400 + 500 * bright
      bands[0].bp.frequency.setTargetAtTime(f1, t, 0.08)
      bands[1].bp.frequency.setTargetAtTime(f2, t, 0.08)
      bands[2].bp.frequency.setTargetAtTime(f3, t, 0.08)
      bands[1].g.gain.setTargetAtTime(0.7 * (0.55 + 0.45 * bright), t, 0.08)
    },
    dispose() {
      oscs.forEach((o) => o.stop())
      drift.stop()
      vib.stop()
    },
  }
}

/* ------------------------------------------------------------------- organ */

/** Drawbar levels for harmonics 1, 2, 3, 4, 6, 8 — a small combo organ. */
const DRAWBARS = [
  { mult: 1, gain: 1 },
  { mult: 2, gain: 0.65 },
  { mult: 3, gain: 0.45 },
  { mult: 4, gain: 0.3 },
  { mult: 6, gain: 0.18 },
  { mult: 8, gain: 0.1 },
]

/**
 * Additive sines, one per drawbar, with a fast attack and a slow rotary
 * tremolo. An organ is the easiest instrument to fake convincingly, because it
 * really is just stacked sines.
 */
const createOrgan: Instrument['create'] = (ctx, dest) => {
  const out = ctx.createGain()
  out.connect(dest)

  const bars = DRAWBARS.map(({ mult, gain }) => {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 220 * mult
    const g = ctx.createGain()
    g.gain.value = gain
    osc.connect(g).connect(out)
    osc.start()
    return { osc, g, mult, base: gain }
  })

  // Leslie-ish: amplitude wobble plus a touch of pitch, at different rates.
  const rotary = ctx.createOscillator()
  rotary.type = 'sine'
  rotary.frequency.value = 5.6
  const ampDepth = ctx.createGain()
  ampDepth.gain.value = 0.12
  rotary.connect(ampDepth).connect(out.gain)
  const pitchDepth = ctx.createGain()
  pitchDepth.gain.value = 3
  rotary.connect(pitchDepth)
  bars.forEach((b) => pitchDepth.connect(b.osc.detune))
  rotary.start()

  let hz = 220

  return {
    get hz() {
      return hz
    },
    setParams({ pitch, bright }, t = ctx.currentTime) {
      hz = 130 + 300 * ease(pitch)
      for (const bar of bars) {
        bar.osc.frequency.setTargetAtTime(hz * bar.mult, t, 0.02)
        // Pulling the upper drawbars in brightens it, like a real organ.
        bar.g.gain.setTargetAtTime(bar.base * (bar.mult === 1 ? 1 : 0.35 + 0.9 * bright), t, 0.05)
      }
    },
    dispose() {
      bars.forEach((b) => b.osc.stop())
      rotary.stop()
    },
  }
}

export const INSTRUMENTS: Instrument[] = [
  {
    id: 'singer',
    label: 'Singer',
    blurb: 'Formant voice: "ooooh" when round, "aaaah" when bright.',
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
    id: 'choir',
    label: 'Choir',
    blurb: 'Four detuned voices on one vowel, slow to bloom.',
    create: createChoir,
    level: 1.5,
    attackMs: 260,
  },
  {
    id: 'organ',
    label: 'Organ',
    blurb: 'Stacked drawbars with a rotary wobble.',
    create: createOrgan,
    level: 1.1,
    attackMs: 30,
  },
  {
    id: 'guitar',
    label: 'Guitar',
    blurb: 'Wah guitar: the mouth is the pedal — open it to sweep the peak.',
    create: createGuitar,
    // the wah filter eats a lot of the pluck, so it needs a bigger trim
    level: 2.6,
    releaseMs: 300,
  },
]

export const DEFAULT_INSTRUMENT = 'singer'

export function getInstrument(id: string) {
  return INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0]
}

/**
 * Use the recording when it decoded, and the synthesised voice otherwise. The
 * decision is made per create() call, so a sample that arrives late simply
 * takes over on the next pet.
 */
function withSampleFallback(sampled: Instrument, fallback: () => Instrument): Instrument {
  return {
    ...sampled,
    create: (ctx, dest) => {
      const voice = sampled.create(ctx, dest)
      // createSampledPet returns a null-ish voice when the buffer is missing
      if (voice && (voice as { setParams?: unknown }).setParams) return voice
      return fallback().create(ctx, dest)
    },
  }
}
