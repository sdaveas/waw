# waw

Open your mouth at the camera, hear a **waaaaw**. The wider you stretch your lips the higher it
sings; the more you open them the brighter it gets; open your eyes wide and it echoes.

Everything runs in the browser. No frames, no audio, no face data ever leave the machine.

## Run it

```bash
npm install     # also runs scripts/setup-assets.sh
npm run dev
```

Open the printed URL, click **Enable camera & sound**, and open your mouth.

`npm run setup` re-downloads the MediaPipe model and copies the wasm runtime into `public/` if you
ever delete them — both are gitignored (about 29 MB of binaries).

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
   ├─ smoothing      fast attack / slow release on the mouth, gentle on tone
   │
   └─ WaaawEngine.setFace({ open, wide, round, eyes })   src/lib/audio.ts
          ├─ instrument voice → master gate ─┬─→ compressor → speakers
          └─ wide eyes ─→ feedback delay ────┘
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
| `wide` (horizontal stretch) | **pitch** |
| `open` (vertical opening) | **brightness** — more open is brighter, `round` darkens |
| `round` (aspect ratio) | darkens: lower F2, a sub-octave, a tighter buzz |
| either mouth axis moving | loudness |
| `eyes` (eyelid aperture) | **echo** — a feedback delay |

Loudness follows whichever mouth axis moved most rather than the pitch axis on purpose: `wide` is
0 for a yawn, so gating on it would make yawning silent, and a yawn is the most waaaw a mouth can
make.

### Making the sound

Five voices in `src/lib/instruments.ts`, all built from Web Audio primitives:

| instrument | what it is |
| --- | --- |
| **Singer** | two detuned sawtooths through three movable formants + breath noise |
| **Violin** | bowed saw pair, resonant lowpass, two body resonances, bow noise |
| **Theremin** | sines: a fundamental plus harmonics that grow with brightness, sub-octave as it rounds |
| **Kazoo** | saw through a tight buzzing bandpass, with heavy wobble |
| **Guitar** | Karplus–Strong pluck: a noise burst in a damped delay line, strummed by the mouth and re-fretted while it rings |

Audio only engages past **openness 0.58**. A teeth-showing grin measures 0.53 and stays silent on
the mouth bars — though its width bar still moves, and wide eyes still echo.

The echo is tapped **after** the level gate, not from the voice. Voices oscillate even when they
are silent, so feeding the raw voice into a feedback delay makes the repeats sustain forever
instead of ringing out.

A compressor sits after both paths, so instrument trims can be matched for loudness without the
peaks clipping.

## Tuning

| what | where |
| --- | --- |
| how closed / open counts | `VERT_CLOSED`, `VERT_OPEN` in `src/lib/face.ts` |
| how narrow / stretched counts | `HORIZ_REST`, `HORIZ_WIDE` in `src/lib/face.ts` |
| when eyes start echoing | `EAR_REST`, `EAR_WIDE` in `src/lib/face.ts` |
| when sound starts | `GATE` in `src/lib/audio.ts` |
| which axis controls what | `setFace()` in `src/lib/audio.ts` |
| echo time, depth, feedback | `setEcho()` in `src/lib/audio.ts` |
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
  | wide yawn | 100% | 0% | 0% | 92 Hz, no echo |
  | teeth grin | 53% | 79% | 0% | 263 Hz, no echo |
  | wide-eyed surprise | 61% | 12% | 73% | 125 Hz, echoing |
