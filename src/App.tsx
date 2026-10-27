import { useCallback, useEffect, useRef, useState } from 'react'
import type { FaceLandmarker, HandLandmarker, ObjectDetector } from '@mediapipe/tasks-vision'
import { GATE, WaaawEngine } from './lib/audio'
import { INSTRUMENTS, DEFAULT_INSTRUMENT } from './lib/instruments'
import { readFace, smoothMouth, smoothTone } from './lib/face'
import {
  HAND_CONNECTIONS,
  readHands,
  smoothHand,
  stableOctave,
  type HandState,
} from './lib/hands'
import { detectPet, PetStabiliser, type PetKind } from './lib/pets'
import { getHandLandmarker, getLandmarker, getObjectDetector } from './lib/tracker'

type Status = 'idle' | 'loading' | 'running' | 'error'

/**
 * The hand model is roughly as expensive as the face model, and running both
 * every frame halved the frame rate. The wah is smoothed anyway, so hands run
 * on every other frame and the last result is reused in between.
 */
const HANDS_EVERY = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 ? 3 : 2

/** The object detector is a third model; it runs on a slower cadence. */
const PET_EVERY = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 ? 9 : 6

const PET_DETAIL: Record<'cat' | 'dog' | 'baby', string> = {
  cat: 'midi miaw',
  dog: 'awoooo',
  baby: 'baby shark',
}

/** Phones get a smaller capture and a lighter model load. */
const IS_TOUCH = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
/** iPadOS reports itself as a Mac, hence the touch-point check. */
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent)))

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const openBarRef = useRef<HTMLDivElement | null>(null)
  const wideBarRef = useRef<HTMLDivElement | null>(null)
  const eyeBarRef = useRef<HTMLDivElement | null>(null)
  const wahBarRef = useRef<HTMLDivElement | null>(null)
  const hzRef = useRef<HTMLSpanElement | null>(null)
  const wahRef = useRef<HTMLSpanElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<FaceLandmarker | null>(null)
  const handLandmarkerRef = useRef<HandLandmarker | null>(null)
  const engineRef = useRef<WaaawEngine | null>(null)
  const rafRef = useRef<number | null>(null)
  const openRef = useRef(0)
  const wideRef = useRef(0)
  const roundRef = useRef(0)
  const eyesRef = useRef(0)
  const handPitchRef = useRef(0)
  const octaveRef = useRef(0)
  const frameCountRef = useRef(0)
  const objectDetectorRef = useRef<ObjectDetector | null>(null)
  const stabiliserRef = useRef(new PetStabiliser())
  const lastHandsRef = useRef<HandState | null>(null)
  const mutedRef = useRef(false)
  const lastTsRef = useRef(0)

  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [audioState, setAudioState] = useState<AudioContextState | 'none'>('none')
  const [pet, setPet] = useState<PetKind>(null)
  const [instrumentId, setInstrumentId] = useState(DEFAULT_INSTRUMENT)

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void engineRef.current?.stop()
    engineRef.current = null
    openRef.current = 0
    wideRef.current = 0
    roundRef.current = 0
    eyesRef.current = 0
    handPitchRef.current = 0
    octaveRef.current = 0
  }, [])

  useEffect(() => teardown, [teardown])

  // iOS suspends the context on a call, a route change or a lock. Nudge it back
  // whenever the page is visible again, and let any tap do it too.
  useEffect(() => {
    const wake = () => {
      const engine = engineRef.current
      // Safari says "interrupted", not just "suspended".
      if (engine && engine.state !== 'running' && engine.state !== 'none') void engine.resume()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') wake()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pointerdown', wake)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointerdown', wake)
    }
  }, [])

  const toggleMute = () => {
    mutedRef.current = !mutedRef.current
    setMuted(mutedRef.current)
    engineRef.current?.setMuted(mutedRef.current)
  }

  const pickInstrument = (id: string) => {
    setInstrumentId(id)
    engineRef.current?.setInstrument(id)
  }

  const start = async () => {
    setError(null)
    setStatus('loading')

    // The audio context has to be created and resumed inside the click handler.
    // Loading the models first costs seconds, and mobile browsers drop the user
    // gesture after the first await — leaving the context suspended and the app
    // silent with no error. This call is deliberately before any await.
    const engine = new WaaawEngine(instrumentId)
    engine.onStateChange = setAudioState
    engineRef.current = engine
    const audioReady = engine.start()

    try {
      const [landmarker, handLandmarker, objectDetector, stream] = await Promise.all([
        getLandmarker(),
        getHandLandmarker(),
        getObjectDetector(),
        navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: IS_TOUCH ? 640 : 960 },
            height: { ideal: IS_TOUCH ? 480 : 720 },
          },
          audio: false,
        }),
      ])
      landmarkerRef.current = landmarker
      handLandmarkerRef.current = handLandmarker
      objectDetectorRef.current = objectDetector
      streamRef.current = stream

      const video = videoRef.current
      if (!video) throw new Error('video element missing')
      video.srcObject = stream
      await video.play()

      await audioReady

      setStatus('running')
      rafRef.current = requestAnimationFrame(frame)
    } catch (err) {
      teardown()
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Camera permission denied. Allow camera access and try again.'
          : err instanceof Error
            ? err.message
            : 'Could not start the camera or audio engine.'
      setError(message)
      setStatus('error')
    }
  }

  // Hoisted declaration: `start` can reference it before the line below runs.
  function frame(now: number) {
    rafRef.current = requestAnimationFrame(frame)

    const video = videoRef.current
    const canvas = canvasRef.current
    const landmarker = landmarkerRef.current
    if (!video || !canvas || !landmarker) return
    if (video.readyState < 2 || video.videoWidth === 0) return

    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Timestamps must strictly increase or the graph refuses the frame.
    const ts = Math.max(now, lastTsRef.current + 1)
    lastTsRef.current = ts

    let face = null
    let handState = null
    // One face pass per frame: the model must not be handed the same timestamp
    // twice, and pet mode needs every face, not just the first.
    let faces: Array<NonNullable<ReturnType<typeof readFace>>> = []
    try {
      const result = landmarker.detectForVideo(video, ts)
      faces = (result.faceLandmarks ?? [])
        .map((lm) => readFace(lm, video.videoWidth, video.videoHeight))
        .filter((f): f is NonNullable<typeof f> => f !== null)
      // The mouth follows whichever face is closest to the camera.
      face = faces.reduce<(typeof faces)[number] | null>(
        (best, f) => (!best || f.heightRatio > best.heightRatio ? f : best),
        null,
      )
    } catch {
      /* a dropped frame is not fatal */
    }

    frameCountRef.current++

    if (objectDetectorRef.current && frameCountRef.current % PET_EVERY === 0) {
      try {
        const found = objectDetectorRef.current.detectForVideo(video, ts)
        const objects = (found.detections ?? []).map((d) => ({
          label: d.categories[0]?.categoryName ?? '',
          score: d.categories[0]?.score ?? 0,
        }))
        const kind = stabiliserRef.current.update(
          detectPet({
            objects,
            faceHeights: faces.map((f) => f.heightRatio),
            eyesOverFaceH: face?.eyesOverFaceH ?? 0,
          }),
        )
        engineRef.current?.setPet(kind)
        setPet(kind)
      } catch {
        /* pet detection is optional */
      }
    }

    if (handLandmarkerRef.current && frameCountRef.current % HANDS_EVERY === 0) {
      try {
        const hands = handLandmarkerRef.current.detectForVideo(video, ts)
        lastHandsRef.current = readHands(
          hands.landmarks ?? [],
          hands.handedness ?? [],
          video.videoWidth,
          video.videoHeight,
        )
      } catch {
        /* hands are optional; a dropped frame is not fatal */
      }
    }
    handState = lastHandsRef.current

    const open = smoothMouth(openRef.current, face?.open ?? 0)
    const wide = smoothTone(wideRef.current, face?.wide ?? 0)
    const round = smoothTone(roundRef.current, face?.round ?? 0)
    const eyes = smoothTone(eyesRef.current, face?.eyes ?? 0)
    openRef.current = open
    wideRef.current = wide
    roundRef.current = round
    eyesRef.current = eyes

    const handPitch = smoothHand(handPitchRef.current, handState?.pitch ?? 0)
    // the octave comes from the *second* hand, not the one playing the pitch
    const octave =
      handState?.octaveHeight != null
        ? stableOctave(handState.octaveHeight, octaveRef.current)
        : 0
    handPitchRef.current = handPitch
    octaveRef.current = octave

    const engine = engineRef.current
    engine?.setMuted(mutedRef.current)
    engine?.setFace({ open, wide, round, eyes })
    engine?.setHands(handPitch, octave, Boolean(handState?.present))

    // --- paint ---
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    if (face) {
      const scale = canvas.width / 960
      ctx.save()

      // Eyes: the echo control, so they glow as they widen.
      const eyeAlpha = 0.18 + 0.65 * eyes
      ctx.strokeStyle = `rgba(251 191 36 / ${eyeAlpha})`
      ctx.shadowColor = 'rgba(251 191 36 / 0.8)'
      ctx.shadowBlur = 6 + 26 * eyes
      ctx.lineWidth = Math.max(1, (1 + 2.5 * eyes) * scale)
      for (const ring of face.eyeOvals) {
        const path = new Path2D()
        ring.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)))
        path.closePath()
        ctx.stroke(path)
      }

      // Mouth: smoothed closed curve through the inner lip ring.
      const pts = face.oval
      const mouthPath = new Path2D()
      const mid = (a: number, b: number) => ({
        x: (pts[a].x + pts[b].x) / 2,
        y: (pts[a].y + pts[b].y) / 2,
      })
      const startPt = mid(pts.length - 1, 0)
      mouthPath.moveTo(startPt.x, startPt.y)
      for (let i = 0; i < pts.length; i++) {
        const next = mid(i, (i + 1) % pts.length)
        mouthPath.quadraticCurveTo(pts[i].x, pts[i].y, next.x, next.y)
      }
      mouthPath.closePath()

      ctx.shadowColor = '#38bdf8'
      ctx.shadowBlur = 14 + 34 * open
      ctx.fillStyle = `rgba(56 189 248 / ${0.08 + 0.2 * open})`
      ctx.fill(mouthPath)
      ctx.strokeStyle = '#38bdf8'
      ctx.lineWidth = Math.max(2, (2 + 4 * open) * scale)
      ctx.stroke(mouthPath)
      ctx.restore()
    }

    if (handState?.present) {
      const scale = canvas.width / 960
      ctx.save()
      ctx.strokeStyle = 'rgba(52 211 153 / 0.75)'
      ctx.fillStyle = 'rgba(52 211 153 / 0.9)'
      ctx.shadowColor = 'rgba(52 211 153 / 0.8)'
      ctx.shadowBlur = 8 + 22 * handPitch
      ctx.lineWidth = Math.max(1, 2 * scale)
      for (const hand of handState.hands) {
        for (const [a, b] of HAND_CONNECTIONS) {
          ctx.beginPath()
          ctx.moveTo(hand.points[a].x, hand.points[a].y)
          ctx.lineTo(hand.points[b].x, hand.points[b].y)
          ctx.stroke()
        }
        ctx.beginPath()
        ctx.arc(hand.palm.x, hand.palm.y, Math.max(3, 5 * scale), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

    if (openBarRef.current) openBarRef.current.style.width = `${Math.round(open * 100)}%`
    if (wideBarRef.current) wideBarRef.current.style.width = `${Math.round(wide * 100)}%`
    if (eyeBarRef.current) eyeBarRef.current.style.width = `${Math.round(eyes * 100)}%`
    if (hzRef.current) {
      hzRef.current.textContent =
        engine && engine.voiced && !mutedRef.current ? `${Math.round(engine.hz)} Hz` : 'silent'
    }
    if (wahBarRef.current) {
      wahBarRef.current.style.width = `${Math.round(handState?.present ? handPitch * 100 : 0)}%`
    }
    if (wahRef.current) {
      if (!handState?.present) {
        wahRef.current.textContent = 'no hands'
      } else {
        const sign = octave > 0 ? `+${octave}` : `${octave}`
        wahRef.current.textContent = `octave ${sign}${handState?.hasOctaveHand ? '' : ' (single)'}`
      }
    }
  }

  const gatePct = `${(GATE * 100).toFixed(0)}%`

  return (
    <main className="min-h-screen bg-ink text-paper flex flex-col items-center justify-center gap-5 p-6">
      <header className="text-center space-y-1">
        <h1 className="text-4xl font-semibold tracking-tight">
          waw<span className="text-accent">.</span>
        </h1>
        <p className="text-sm text-paper/50">open your mouth → hear the waaaw</p>
      </header>

      {/* instrument menu */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {INSTRUMENTS.map((inst) => {
          const active = inst.id === instrumentId
          return (
            <button
              key={inst.id}
              onClick={() => pickInstrument(inst.id)}
              title={inst.blurb}
              aria-pressed={active}
              className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                active
                  ? 'bg-accent text-white'
                  : 'bg-white/8 text-paper/60 hover:bg-white/15 hover:text-paper/90'
              }`}
            >
              {inst.label}
            </button>
          )
        })}
      </div>

      <div className="relative w-full max-w-2xl aspect-[4/3] rounded-2xl overflow-hidden bg-black/60 ring-1 ring-white/10">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover -scale-x-100"
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full object-cover -scale-x-100 pointer-events-none"
        />

        {status !== 'running' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center bg-ink/70 backdrop-blur-sm">
            {status === 'idle' && (
              <>
                <p className="text-sm text-paper/60 max-w-sm">
                  Needs camera access to find your face and sound output to sing. Nothing leaves
                  your device.
                </p>
                <button
                  onClick={() => void start()}
                  className="rounded-full bg-accent px-6 py-3 text-sm font-medium text-white transition hover:brightness-110 active:scale-95"
                >
                  Enable camera &amp; sound
                </button>
              </>
            )}
            {status === 'loading' && (
              <p className="text-sm text-paper/60 animate-pulse">Waking up the face tracker…</p>
            )}
            {status === 'error' && (
              <>
                <p className="text-sm text-red-300 max-w-sm">{error}</p>
                <button
                  onClick={() => void start()}
                  className="rounded-full bg-white/10 px-5 py-2.5 text-sm font-medium transition hover:bg-white/20"
                >
                  Try again
                </button>
              </>
            )}
          </div>
        )}

        {status === 'running' && audioState !== 'running' && audioState !== 'none' && (
          <button
            onClick={() => void engineRef.current?.resume()}
            className="absolute inset-0 flex items-center justify-center bg-ink/70 text-sm font-medium text-amber-200 backdrop-blur-sm"
          >
            Audio is paused by the browser ({audioState}) — tap to start sound
          </button>
        )}

        {status === 'running' && (
          <div className="absolute top-3 right-3 flex flex-col items-end gap-2">
            <button
              onClick={toggleMute}
              data-audio-state={audioState}
              className="rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-paper/80 backdrop-blur transition hover:bg-black/70"
            >
              {muted ? 'unmute' : 'mute'}
            </button>

            {/* Not a control: it lights up when a pet turns up. */}
            <div
              data-pet={pet ?? 'none'}
              className={`group relative rounded-full px-3 py-1.5 text-xs font-medium backdrop-blur transition-colors ${
                pet
                  ? 'bg-amber-400/90 text-ink'
                  : 'bg-black/50 text-paper/50'
              }`}
            >
              <span>pet mode{pet ? ` · ${pet === 'baby' ? 'tiny human' : pet}` : ''}</span>
              <div className="pointer-events-none invisible absolute right-0 top-full mt-2 w-52 rounded-xl bg-ink/95 p-3 text-left opacity-0 ring-1 ring-white/10 transition group-hover:visible group-hover:opacity-100">
                <p className="text-xs text-paper/80">
                  {pet ? `${PET_DETAIL[pet]} engaged` : 'bring your pet to unlock'}
                </p>
                <p className="mt-1 text-[11px] text-paper/40">[*pets include tiny humans]</p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="w-full max-w-2xl space-y-2">
        <div className="flex items-center justify-between text-xs text-paper/40 font-mono">
          <span>mouth ↔ wide</span>
          <span ref={hzRef}>silent</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            ref={wideBarRef}
            data-meter="wide"
            className="h-full w-0 rounded-full bg-violet-400 transition-[width] duration-75"
          />
        </div>

        <div className="flex items-center justify-between text-xs text-paper/40 font-mono pt-1">
          <span>mouth ↕ open</span>
          <span>→ volume</span>
        </div>
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            ref={openBarRef}
            data-meter="open"
            className="h-full w-0 rounded-full bg-sky-400 transition-[width] duration-75"
          />
          <div
            className="absolute top-0 h-full w-px bg-white/40"
            style={{ left: gatePct }}
            title={`sound starts past ${gatePct}`}
          />
        </div>

        <div className="flex items-center justify-between text-xs text-paper/40 font-mono pt-1">
          <span>eyes ↔ wide</span>
          <span>→ echo</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            ref={eyeBarRef}
            data-meter="eyes"
            className="h-full w-0 rounded-full bg-amber-400 transition-[width] duration-75"
          />
        </div>

        <div className="flex items-center justify-between text-xs text-paper/40 font-mono pt-1">
          <span>hand ↕ pitch</span>
          <span ref={wahRef}>no hands</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            ref={wahBarRef}
            data-meter="wah"
            className="h-full w-0 rounded-full bg-emerald-400 transition-[width] duration-75"
          />
        </div>
      </div>

      {IS_IOS && (
        <p className="max-w-md text-center text-xs text-amber-200/60">
          On iPhone: the side switch above the volume keys silences browser audio even when the
          volume is up. If it goes quiet, check that switch first.
        </p>
      )}

      <p className="max-w-md text-center text-xs text-paper/35">
        Mouth open sets the volume. Raise a hand to play the pitch; a second hand picks the octave,
        &plusmn;2. With no hand up, mouth width sets the pitch instead. Eyes wide add echo.
      </p>
    </main>
  )
}
