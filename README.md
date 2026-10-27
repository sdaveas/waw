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

Pet sounds live in `public/audio` and are committed, so they need no download step.

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
| `wide` (horizontal stretch) | **pitch** — but only when no hand is up |
| `round` (aspect ratio) | darkens: lower F2, a sub-octave, a tighter buzz |
| `eyes` (eyelid aperture) | **echo** — a feedback delay |
| hand height | **pitch** — takes over from mouth width when a hand is in frame |
| second hand height | **octave**, in five zones from −2 to +2 |
| `wide` again | also sweeps the wah filter (250 Hz to 8 kHz) |

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

Octave zones are sticky on purpose: a hand resting on a boundary would otherwise flip octaves
every frame, so the height has to clear the boundary by 4% before the octave changes.

The hand model runs on every second frame. Running both models on every frame cost more than
half the frame rate for no benefit, since the wah is smoothed anyway.

The guitar's wah is the mouth, not a timer. It started life as a lowpass ramped down on every
pluck, which is an auto-wah — it ignored the player. It is now a bandpass whose peak follows
`bright` (mouth opening) and a parallel dry path, so the peak moving between string harmonics
colours the note instead of gating it. Measured: energy centroid 705 Hz with the mouth shut, 2906
Hz wide open, with level even to within 1.4×.

### Pet mode

Bring a cat or a dog to the camera and the instrument is replaced by that animal's voice: a
**MIDI miaw** or an **awoooo**. The indicator sits under the mute button and lights up when one
turns up. It is not a control; hover it and it says *bring your pet to unlock*, with the small print
*[\*pets include tiny humans]*.

Cats and dogs come from MediaPipe's COCO object detector. Cats are reliable (0.77–0.82 in testing).
Dogs are mostly reliable — a clear retriever scores 0.9, but a fluffy one can come back as "bear"
(0.45) and a dog held by a person only scores 0.17. A detection has to hold for four frames to be
trusted and stay gone for ten, so it does not flicker.

**Pet sounds are the length of your mouth**, not loops. A quick opening gives a quick

- **cat**: `niaw`
- **dog**: `aww`

and holding the mouth open stretches it out — `niaaaaaaaaaaw`, `aaawwwwwwwww`. The mouth is the
gate, so closing it ends the sound with a downward "w" glide.

Both are **real recordings**, not synthesis — synthesised animal noises were not convincing:

| sound | source | licence |
| --- | --- | --- |
| `public/audio/cat-meow.wav` | *Meow of a Siamese cat* (Wikimedia Commons) | CC0 |
| `public/audio/dog-howl.wav` | *Jem howls* (Wikimedia Commons, by amethysta) | Public domain |

They are still played like instruments rather than one-shots. The clip starts on the way in, then
only its **sustain loops while the mouth stays open**, so a one-second meow can become
"niaaaaaaaaw". Playback rate follows how wide the mouth is — a tight mouth plays it fast and high
(short "niaw"), a wide one slow and low. If a sample fails to load, the voice falls back to the
synthesised version rather than going silent.

Both use a **lower gate than the instruments** (0.06 against 0.22), because a barely-open mouth is
exactly how you get a small "niaw".

**Tiny humans are inferred, not detected.** There is no baby class in COCO, and face geometry does
not separate them: eye separation over face height measures 0.51–0.70 for babies against 0.48–0.61
for adults, which overlaps badly. So the app looks for the cue that does hold — **a small face next
to a big one**, i.e. somebody holding a baby up to the camera (ratio above 1.55), or a single face
with unusually wide eyes. A baby on its own may therefore be missed. When it fires, baby shark
plays as a loop rather than a mouth sound.

### Making the sound

Five voices in `src/lib/instruments.ts`, all built from Web Audio primitives:

| instrument | what it is |
| --- | --- |
| **Singer** | two detuned sawtooths through three movable formants + breath noise |
| **Violin** | bowed saw pair, resonant lowpass, two body resonances, bow noise |
| **Theremin** | sines: a fundamental plus harmonics that grow with brightness, sub-octave as it rounds |
| **Kazoo** | saw through a tight buzzing bandpass, with heavy wobble |
| **Choir** | four sawtooths detuned against each other, one vowel, slow to bloom |
| **Organ** | six sines as drawbars with a rotary tremolo |
| **Guitar** | **wah guitar**: Karplus–Strong pluck through a bandpass whose peak follows the mouth |

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
| how sure a pet detection must be | `PET_SCORE` in `src/lib/pets.ts` |
| baby cues (face size ratio / eye ratio) | `BABY_SIZE_RATIO`, `BABY_EYES` in `src/lib/pets.ts` |
| pet flicker damping | `PetStabiliser` frame counts in `src/lib/pets.ts` |
| how often pets are checked | `PET_EVERY` in `src/App.tsx` |
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
  the second model is real. The object detector runs on every sixth frame, so pet mode is close to
  free.
- Pet mode driven by synthetic camera feeds: a cat photo → **cat**, a retriever → **dog**, an adult
  portrait → **none**, an adult holding a baby (faces 0.365 and 0.218 of frame height) → **baby**.
- All seven instruments rendered offline: silent when the mouth is shut, pitch tracks the width
  axis across their full range, and each gets brighter as `bright` rises.

- Volume rendered through the real engine against mouth opening, at a fixed pitch:

  | mouth open | 0.18 | 0.22 | 0.25 | 0.30 | 0.40 | 0.70 | 1.00 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | rms | 0 | 0 | 0.142 | 0.184 | 0.213 | 0.360 | 0.372 |

  Pitch stayed at 207 Hz across that whole sweep, and peak stayed at or below 0.82. The gate is
  deliberately low so a slight parting sings; the early volume curve means it is audible straight
  away, and the remaining range is about 8 dB up to a fully open mouth.
