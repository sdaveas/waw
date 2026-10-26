# waw

Open your mouth at the camera, hear a **waaaaw**. The wider you open, the higher it sings.

Everything runs in the browser. No frames, no audio, no landmarks ever leave the machine.

## Run it

```bash
npm install     # also runs scripts/setup-assets.sh
npm run dev
```

Open the printed URL, click **Enable camera & sound**, and open your mouth.

`npm run setup` re-downloads the MediaPipe model and copies the wasm runtime into
`public/` if you ever delete them — both are gitignored (about 29 MB of binaries).

## How it works

```
camera → <video>
   │
   ├─ FaceLandmarker (MediaPipe, VIDEO mode, 1 face)   src/lib/tracker.ts
   │      └─ 468 landmarks
   │
   ├─ readMouth()      src/lib/mouth.ts
   │      ├─ inner-lip ring → the oval you see drawn on screen
   │      ├─ vertical aperture  → open  0..1  (pitch + loudness)
   │      ├─ horizontal stretch → wide  0..1  (brightness)
   │      └─ aspect ratio       → round 0..1  (darkness)
   │
   ├─ smoothing        fast attack / slow release on openness, gentle on tone
   │
   └─ WaaawEngine.setMouth(open, wide, round)   src/lib/audio.ts
          └─ instrument voice → master gate → compressor → speakers
```

### Detecting the opening

The oval is the MediaPipe **inner lip ring**: 11 upper points, 9 lower points, plus
both mouth corners, closed into a 22-point polygon. That ring is what actually forms
the opening; the outer ring is just the visible lip border.

Three numbers come out of every frame, and all three are divided by the distance
between the outer eye corners, so leaning towards the camera changes nothing:

- **open** — mean gap between three opposed landmark pairs (`82–87`, `13–14`,
  `312–317`), measured **perpendicular to the mouth axis**. Projecting onto the
  perpendicular is what stops a tilted or turned head from faking an open mouth.
- **wide** — the width of the opening, as far as the corners are stretched.
- **round** — the aspect ratio, i.e. how circular the opening is.

Measured on real faces:

| mouth | open | wide | round |
| --- | --- | --- | --- |
| lips together | 0.00 | 0.0 | 0.0 |
| big grin, teeth showing | 0.53 | 0.79 | 0.2 |
| whistling / pursed | 0.06 | 0.0 | 0.05 |
| wide yawn | 1.00 | 0.0 | 0.91 |

So a grin and a yawn are told apart by **width**, not by how open they are: the grin
is wide and shallow, the yawn is round and deep. That is what makes ":O" and ":o"
different sounds rather than merely different volumes.

### Making the sound

Openness glides the pitch and lifts the level; width brightens the tone and round
darkens it. Audiowise:

| axis | does |
| --- | --- |
| `open` | pitch (instrument-specific range) and loudness |
| `wide` | brightens: higher formants, more upper-band gain, open lowpass |
| `round` | darkens: lower F2, a sub-octave on the theremin, tighter buzz on the kazoo |

Five voices ship in `src/lib/instruments.ts`:

| instrument | what it is |
| --- | --- |
| **Singer** | two detuned sawtooths through three movable formants + breath noise |
| **Violin** | bowed saw pair, resonant lowpass, two body resonances, bow noise |
| **Theremin** | sines: fundamental plus harmonics that grow as the mouth stretches, sub-octave as it rounds |
| **Kazoo** | saw through a tight buzzing bandpass, with heavy wobble |
| **Guitar** | Karplus–Strong pluck: a noise burst in a damped delay line, strummed by the mouth and bent while it rings |

Audio only engages past **openness 0.58**. A teeth-showing grin measures 0.53 and
stays silent (though its width bar still moves), so the toy only answers a deliberate
opening. A compressor sits after the level control, so instrument trims can be matched
for loudness without the peaks clipping.

## Tuning

| what | where |
| --- | --- |
| how closed / open counts | `VERT_CLOSED`, `VERT_OPEN` in `src/lib/mouth.ts` |
| how narrow / stretched counts | `HORIZ_REST`, `HORIZ_WIDE` in `src/lib/mouth.ts` |
| when sound starts | `GATE` in `src/lib/audio.ts` |
| pitch range, timbre mapping | each voice in `src/lib/instruments.ts` |
| relative loudness | `level` on each entry in `INSTRUMENTS` |
| how long a note rings after you close | `releaseMs` (used by the guitar) |
| smoothing | `smoothMouth()`, `smoothTone()` in `src/lib/mouth.ts` |

## Verified

- Production build and `npm run lint` are clean.
- Landmark geometry checked against real faces (table above); the drawn oval tracks
  the lips.
- Every voice rendered offline and measured for loudness and spectral centroid:
  all five are silent with the mouth shut, and all five get measurably **brighter
  when the mouth stretches wide** and darker when it rounds.
- Full pipeline exercised in a browser with a synthetic camera feed (fake webcam,
  real MediaPipe, real Web Audio):
  - wide-open yawn → height 100%, 300 Hz, oval painted
  - teeth-showing grin → height 53%, width 79%, **silent**
  - switching instruments live updates the pitch range per instrument
    (singer 300 Hz, violin 660, theremin 880, kazoo 350, guitar 360)
