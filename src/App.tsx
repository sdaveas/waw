import { useCallback, useEffect, useRef, useState } from 'react'
import type { FaceLandmarker } from '@mediapipe/tasks-vision'
import { GATE, WaaawEngine } from './lib/audio'
import { INSTRUMENTS, DEFAULT_INSTRUMENT } from './lib/instruments'
import { readMouth, smoothMouth, smoothTone } from './lib/mouth'
import { getLandmarker } from './lib/tracker'

type Status = 'idle' | 'loading' | 'running' | 'error'

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const heightBarRef = useRef<HTMLDivElement | null>(null)
  const widthBarRef = useRef<HTMLDivElement | null>(null)
  const hzRef = useRef<HTMLSpanElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<FaceLandmarker | null>(null)
  const engineRef = useRef<WaaawEngine | null>(null)
  const rafRef = useRef<number | null>(null)
  const openRef = useRef(0)
  const wideRef = useRef(0)
  const roundRef = useRef(0)
  const mutedRef = useRef(false)
  const lastTsRef = useRef(0)

  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
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
  }, [])

  useEffect(() => teardown, [teardown])

  const toggleMute = () => {
    mutedRef.current = !mutedRef.current
    setMuted(mutedRef.current)
    if (mutedRef.current) {
      engineRef.current?.setMouth(0, 0, 0)
    }
  }

  const pickInstrument = (id: string) => {
    setInstrumentId(id)
    engineRef.current?.setInstrument(id)
  }

  const start = async () => {
    setError(null)
    setStatus('loading')
    try {
      const [landmarker, stream] = await Promise.all([
        getLandmarker(),
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } },
          audio: false,
        }),
      ])
      landmarkerRef.current = landmarker
      streamRef.current = stream

      const video = videoRef.current
      if (!video) throw new Error('video element missing')
      video.srcObject = stream
      await video.play()

      const engine = new WaaawEngine(instrumentId)
      await engine.start()
      engineRef.current = engine

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

    let targetOpen = 0
    let targetWide = 0
    let targetRound = 0
    let mouth = null
    try {
      const result = landmarker.detectForVideo(video, ts)
      const face = result.faceLandmarks?.[0]
      if (face) {
        mouth = readMouth(face, video.videoWidth, video.videoHeight)
        if (mouth) {
          targetOpen = mouth.open
          targetWide = mouth.wide
          targetRound = mouth.round
        }
      }
    } catch {
      /* a dropped frame is not fatal */
    }

    const open = smoothMouth(openRef.current, targetOpen)
    const wide = smoothTone(wideRef.current, targetWide)
    const round = smoothTone(roundRef.current, targetRound)
    openRef.current = open
    wideRef.current = wide
    roundRef.current = round

    const engine = engineRef.current
    engine?.setMouth(mutedRef.current ? 0 : open, wide, round)

    // --- paint ---
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    if (mouth) {
      const stroke = '#38bdf8'
      const scale = canvas.width / 960
      const pts = mouth.oval

      // Smooth closed curve through the inner lip ring (midpoint smoothing).
      const path = new Path2D()
      const mid = (a: number, b: number) => ({
        x: (pts[a].x + pts[b].x) / 2,
        y: (pts[a].y + pts[b].y) / 2,
      })
      const startPt = mid(pts.length - 1, 0)
      path.moveTo(startPt.x, startPt.y)
      for (let i = 0; i < pts.length; i++) {
        const next = mid(i, (i + 1) % pts.length)
        path.quadraticCurveTo(pts[i].x, pts[i].y, next.x, next.y)
      }
      path.closePath()

      ctx.save()
      ctx.fillStyle = `rgba(56 189 248 / ${0.08 + 0.2 * open})`
      ctx.fill(path)
      ctx.shadowColor = stroke
      ctx.shadowBlur = 14 + 34 * open
      ctx.strokeStyle = stroke
      ctx.lineWidth = Math.max(2, (2 + 4 * open) * scale)
      ctx.stroke(path)
      ctx.restore()

      // A tick on the height bar showing where the sound switches on, and a
      // soft dot on the width bar showing the stretch.
      if (widthBarRef.current) {
        widthBarRef.current.style.width = `${Math.round(wide * 100)}%`
      }
    }

    if (heightBarRef.current) {
      heightBarRef.current.style.width = `${Math.round(open * 100)}%`
    }
    if (hzRef.current) {
      const voiced = open > GATE && !mutedRef.current
      hzRef.current.textContent = voiced && engine ? `${Math.round(engine.hz)} Hz` : 'silent'
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
                  Needs camera access to find your mouth and sound output to sing. Nothing leaves
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

        {status === 'running' && (
          <button
            onClick={toggleMute}
            className="absolute top-3 right-3 rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-paper/80 backdrop-blur transition hover:bg-black/70"
          >
            {muted ? 'unmute' : 'mute'}
          </button>
        )}
      </div>

      <div className="w-full max-w-2xl space-y-2">
        <div className="flex items-center justify-between text-xs text-paper/40 font-mono">
          <span>mouth ↕ open</span>
          <span ref={hzRef}>silent</span>
        </div>
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            ref={heightBarRef}
            className="h-full w-0 rounded-full bg-sky-400 transition-[width] duration-75"
          />
          {/* where the sound switches on */}
          <div
            className="absolute top-0 h-full w-px bg-white/40"
            style={{ left: gatePct }}
            title={`sound starts past ${gatePct} open`}
          />
        </div>

        <div className="flex items-center justify-between text-xs text-paper/40 font-mono pt-1">
          <span>mouth ↔ wide</span>
          <span>brightness</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            ref={widthBarRef}
            className="h-full w-0 rounded-full bg-violet-400 transition-[width] duration-75"
          />
        </div>
      </div>

      <p className="max-w-md text-center text-xs text-paper/35">
        Vertical opening sets the pitch. Stretching the mouth sideways brightens it; a round
        &ldquo;:o&rdquo; darkens it. Nothing sings until the mouth passes the marker.
      </p>
    </main>
  )
}
