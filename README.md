# waw

**[sdaveas.github.io/waw](https://sdaveas.github.io/waw/)** — needs a camera, so it wants a
laptop or phone browser rather than a curl.

Open your mouth at the camera, hear a **waaaaw**. Open your mouth to get loud, stretch it sideways
to raise the pitch, open your eyes wide for echo, and raise a hand to sweep a wah pedal.

Everything runs in the browser. No frames, no audio, no face data ever leave the machine.

## Run it

```bash
npm install     # also runs scripts/setup-assets.sh
npm run dev
```

Open the printed URL, click **Enable camera & sound**, and open your mouth.

`npm run setup` re-downloads the MediaPipe model and copies the wasm runtime into `public/` if you
ever delete them — both are gitignored (about 29 MB of binaries). It also runs on `npm install`,
so a fresh clone is ready to build with no extra steps.

## Deploying

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`: `npm ci` (which runs
the asset fetch), `npm run build`, then `actions/deploy-pages`.

The only wrinkle is the sub-path — Pages serves project sites from `/<repo>/`, so the production
build sets `base: '/waw/'` and the model and wasm paths are resolved against
`import.meta.env.BASE_URL` rather than assumed to be at the site root. `npm run dev` still serves
from `/`.

## How it works

```
camera → <video>
   │
   ├─ FaceLandmarker (MediaPipe, VIDEO mode, 1 face)   src/lib/tracker.ts
   │      └─ 468 landmarks
   │
   ├─ readFace()      src/lib/face.ts
   │      ├─ inner-lip ring → the oval drawn on screen
   │      ├─ vertical aperture  → open  0..1
   │      ├─ horizontal stretch → wide  0..1
   │      ├─ aspect ratio       → round 0..1
   │      └─ eyelid aperture    → eyes  0..1
   │
   ├─ HandLandmarker (MediaPipe, VIDEO mode, 2 hands, every 2nd frame)
   │      └─ 21 points per hand → src/lib/hands.ts
   │             ├─ palm height      → wah cutoff
   │             └─ second hand      → wah resonance
   │
   ├─ smoothing      fast attack / slow release on the mouth, gentle on tone
   │
   └─ WaaawEngine   src/lib/audio.ts
          setFace({ open, wide, round, eyes })
          setHands(wah, squelch, present)
             │
             ├─ voice → wah filter → level gate ─┬─→ compressor → limiter → speakers
             └─ wide eyes ─→ feedback delay ─────┘
```

### Detecting the mouth

The oval is the MediaPipe **inner lip ring**: 11 upper points, 9 lower points, plus both mouth
corners, closed into a 22-point polygon. That ring is what actually forms the opening; the outer
ring is just the visible lip border.

Three numbers come out of every frame, all divided by the distance between the outer eye corners
so leaning towards the camera changes nothing:

- **open** — mean gap between three opposed landmark pairs (`82–87`, `13–14`, `312–317`),
  measured **perpendicular to the mouth axis**. Projecting onto the perpendicular is what stops a
  tilted or turned head from faking an open mouth.
- **wide** — how far the corners are stretched.
- **round** — the aspect ratio, i.e. how circular the opening is.

Measured on real faces:

| mouth | open | wide | round |
| --- | --- | --- | --- |
| lips together | 0.00 | 0.0 | 0.0 |
| big grin, teeth showing | 0.53 | 0.79 | 0.20 |
| whistling / pursed | 0.06 | 0.0 | 0.05 |
| wide yawn | 1.00 | 0.0 | 0.91 |

A grin and a yawn are told apart by **width**, not by how open they are: the grin is wide and
shallow, the yawn is round and deep. That is what makes ":O" and ":o" different sounds rather than
different volumes.

### Detecting the eyes

Eye aspect ratio: mean lid gap over eye width, averaged across both eyes.

| eyes | EAR |
| --- | --- |
| shut | 0.02 |
| smiling | 0.20 |
| neutral, looking at the camera | 0.28 |
| surprised | 0.39 – 0.40 |
| extreme | 0.46 |

Zero is anchored at a *relaxed* eye (0.29), not a shut one, so blinking and looking around cost
nothing — only a deliberate wide-eyed look reacts.

### Mapping face → sound

All of the mapping lives in one method, `WaaawEngine.setFace`, so swapping what an axis controls is
a two-line change:

| face | drives |
| --- | --- |
| `open` (vertical opening) | **volume**, and brightness — more open is brighter |
| `wide` (horizontal stretch) | **pitch** |
| `round` (aspect ratio) | darkens: lower F2, a sub-octave, a tighter buzz |
| `eyes` (eyelid aperture) | **echo** — a feedback delay |
| hand height | **wah** — sweeps a resonant lowpass from 250 Hz to 8 kHz |
| second hand height | **squelch** — the wah's resonance, Q 0.7 to 11 |

Volume is likewise gated on `open`, so the two mouth axes stay independent: opening your mouth is
a crescendo and stretching it is a pitch bend.

The level is remapped so the gate is near-silent and a fully open mouth is full volume — about
11 dB of crescendo — and a tanh limiter closes the chain so louder never means clipping.

### Detecting the hands

Each hand's palm centre is the average of the wrist and the four knuckles, so curling fingers does
not move the wah. Height is normalised between the bottom and top of the frame, then squared off
against the control range.

Two details that the model's own output does not get right:

- **Confidence is not a good way to pick the hand.** In testing, a pair of crossed arms in the
  background scored 0.98 while the actual hand scored 0.83. Size works: the wrist-to-knuckle
  distance separates a hand in front of the camera (152 px) from a background false positive
  (45 px). The biggest hand drives the wah; anything under 3.5% of the frame width is ignored.
- **Handedness is not used for the roles.** MediaPipe derives it from a mirrored image, so it
  flips with the camera. "Closest hand sweeps, other hand squelches" is unambiguous.

The hand model runs on every second frame. Running both models on every frame cost more than
half the frame rate for no benefit, since the wah is smoothed anyway.

### Making the sound

Five voices in `src/lib/instruments.ts`, all built from Web Audio primitives:

| instrument | what it is |
| --- | --- |
| **Singer** | two detuned sawtooths through three movable formants + breath noise |
| **Violin** | bowed saw pair, resonant lowpass, two body resonances, bow noise |
| **Theremin** | sines: a fundamental plus harmonics that grow with brightness, sub-octave as it rounds |
| **Kazoo** | saw through a tight buzzing bandpass, with heavy wobble |
| **Guitar** | Karplus–Strong pluck: a noise burst in a damped delay line, strummed by the mouth and re-fretted while it rings |

Audio engages from **openness 0.22** — a slight parting is enough to sing. A resting face still
measures 0.00, so a closed mouth stays properly silent.

The echo is tapped **after** the level gate, not from the voice. Voices oscillate even when they
are silent, so feeding the raw voice into a feedback delay makes the repeats sustain forever
instead of ringing out.

A compressor sits after both paths, so instrument trims can be matched for loudness without the
peaks clipping.

## When there is no sound (mostly a phone problem)

Three separate causes, all now handled or made visible:

1. **The audio context started suspended.** Browsers only allow audio to start inside a user
   gesture, and mobile ones drop the gesture after the first `await`. The app used to create the
   engine *after* loading three models, which on a phone could land well outside the gesture — the
   context then stays `suspended` and nothing is audible, with no error. The engine is now created
   and resumed synchronously in the click handler, before any `await`.
2. **iOS mutes Web Audio with the side switch.** Web Audio is routed as "ambient" on iOS, so the
   hardware ringer switch silences it even at full volume. The app asks for the `playback` audio
   session where the browser exposes one, and shows an iPhone-specific hint otherwise.
3. **The context gets interrupted.** A call, a route change or the lock screen can suspend it, and
   Safari reports that as `interrupted` rather than `suspended`. Any tap or returning to the tab
   resumes it, and while it is not running the page shows a "tap to start sound" prompt with the
   actual state, so the failure is visible instead of silent.

Also for phones: the capture drops to 640×480, the hand model runs on every third frame instead of
every second, and both models fall back to a CPU delegate if the GPU one is rejected.

## Tuning

| what | where |
| --- | --- |
| how closed / open counts | `VERT_CLOSED`, `VERT_OPEN` in `src/lib/face.ts` |
| how narrow / stretched counts | `HORIZ_REST`, `HORIZ_WIDE` in `src/lib/face.ts` |
| when eyes start echoing | `EAR_REST`, `EAR_WIDE` in `src/lib/face.ts` |
| when sound starts | `GATE` in `src/lib/audio.ts` |
| which axis controls what | `setFace()` in `src/lib/audio.ts` |
| echo time, depth, feedback | `setEcho()` in `src/lib/audio.ts` |
| wah sweep range, squelch range | `WAH_LOW_HZ`, `WAH_OCTAVES`, `SQUELCH_*` in `src/lib/audio.ts` |
| which hand wins, how big a hand must be | `MIN_SIZE_RATIO` in `src/lib/hands.ts` |
| hand update rate | `HANDS_EVERY` in `src/App.tsx` |
| pitch range, timbre mapping | each voice in `src/lib/instruments.ts` |
| relative loudness | `level` on each entry in `INSTRUMENTS` |
| how long a note rings after you close | `releaseMs` (used by the guitar) |
| smoothing | `smoothMouth()`, `smoothTone()` in `src/lib/face.ts` |

## Verified

- Production build and `npm run lint` are clean.
- Landmark geometry checked against real faces (tables above); the drawn oval and eye contours
  track the actual features.
- Every voice rendered offline and measured for loudness and spectral centroid: all five are
  silent with the mouth shut, and all five get measurably brighter when `bright` rises and darker
  when `round` does.
- Echo rendered through the real engine graph, mouth open for 0.6 s then shut:

  | eyes | while singing | just after shut | 1.0 – 1.6 s | 2.2 – 2.9 s |
  | --- | --- | --- | --- | --- |
  | normal | 0.31 | 0.06 | 0.00 | 0.00 |
  | wide | 0.34 | 0.26 | 0.17 | 0.03 |

  Wide eyes leave repeats ringing and decaying after the mouth closes; normal eyes leave silence.
- Full pipeline driven by a synthetic camera feed (fake webcam, real MediaPipe, real Web Audio):

  | feed | mouth open | mouth wide | eyes | result |
  | --- | --- | --- | --- | --- |
  | wide yawn | 100% | 0% | 0% | full volume, 92 Hz, no echo |
  | teeth grin | 53% | 79% | 0% | clear, 262 Hz |
  | wide-eyed surprise | 61% | 12% | 73% | just audible, 125 Hz, echoing |

- Wah rendered through the real engine with a fixed mouth, hand sweeping the filter:

  | hand | low | mid | high | no hands |
  | --- | --- | --- | --- | --- |
  | cutoff | 297 Hz | 1414 Hz | 6727 Hz | bypassed |
  | spectral centroid | 545 Hz | 1230 Hz | 2179 Hz | 2228 Hz |

  A raised hand opens the tone to essentially the un-filtered sound, and the second hand's height
  moves Q from 0.7 to 11.
- Hand tracking verified end-to-end on a synthetic camera feed with a real hand composited into
  the frame: hand low → 250 Hz (dark), hand raised → 2.6 kHz (bright).
- Frame rate with both models, software-rendered headless Chromium: 60 fps face-only, 31 fps with
  hands on every second frame. Real hardware with the GPU delegate is faster, but the 2× cost of
  the second model is real.

- Volume rendered through the real engine against mouth opening, at a fixed pitch:

  | mouth open | 0.18 | 0.22 | 0.25 | 0.30 | 0.40 | 0.70 | 1.00 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | rms | 0 | 0 | 0.142 | 0.184 | 0.213 | 0.360 | 0.372 |

  Pitch stayed at 207 Hz across that whole sweep, and peak stayed at or below 0.82. The gate is
  deliberately low so a slight parting sings; the early volume curve means it is audible straight
  away, and the remaining range is about 8 dB up to a fully open mouth.
