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
   │      └─ aperture / mouth-width → openness (0..1)
   │
   ├─ smoothMouth()    fast attack, slow release, kills landmark jitter
   │
   └─ WaaawSynth.setOpen()   src/lib/audio.ts
          └─ Web Audio formant voice → speakers
```

### Detecting the opening

The oval is the MediaPipe **inner lip ring**: 11 upper points, 9 lower points, plus
both mouth corners, closed into a 22-point polygon. That ring is what actually forms
the opening; the outer ring is just the visible lip border.

Openness is the mean vertical gap between three opposed landmark pairs (`82–87`,
`13–14`, `312–317`) measured **perpendicular to the mouth axis**, then divided by
mouth width. Projecting onto the perpendicular is what keeps a tilted or turned head
from inflating the reading. Dividing by mouth width makes it scale- and
distance-independent.

| mouth | ratio | openness |
| --- | --- | --- |
| lips together | 0.003 – 0.009 | 0 |
| smile with teeth | 0.19 | 0.29 |
| wide yawn | 0.62 | 1.0 |

### Making the sound

A "waaaaw" is a vowel with a rising pitch contour, so the synth is a small formant
voice: two detuned sawtooths through three bandpass filters (700 / 1220 / 2600 Hz)
plus a breath-noise layer. Opening the mouth glides the fundamental from 92 Hz to
300 Hz, widens the vibrato, and lifts the gain.

Audio only engages past **openness 0.30** (ratio ≈ 0.25). A teeth-showing smile
measures 0.29 and stays silent, so the toy only answers a deliberate opening.

## Tuning

| what | where |
| --- | --- |
| how open counts as "closed" / "wide" | `RATIO_CLOSED`, `RATIO_OPEN` in `src/lib/mouth.ts` |
| when sound starts | `GATE` in `src/lib/audio.ts` |
| pitch range | `HZ_CLOSED`, `HZ_OPEN` in `src/lib/audio.ts` |
| vowel colour | `FORMANTS` in `src/lib/audio.ts` |
| smoothing | `smoothMouth()` in `src/lib/mouth.ts` |

## Verified

- Production build and `npm run lint` are clean.
- Landmark geometry checked against real faces: closed portraits read 0.003–0.009,
  a teeth-showing smile 0.19, a wide yawn 0.62, and the drawn oval tracks the lips.
- Full pipeline exercised in a browser with a synthetic camera feed: wide open →
  meter 100%, 300 Hz, oval painted; smile → meter 30%, silent.
