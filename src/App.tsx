import { useCallback, useEffect, useRef, useState } from 'react'
import type { FaceLandmarker } from '@mediapipe/tasks-vision'
import { GATE, WaaawSynth } from './lib/audio'
import { readMouth, smoothMouth } from './lib/mouth'
import { getLandmarker } from './lib/tracker'

type Status = 'idle' | 'loading' | 'running' | 'error'

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const meterRef = useRef<HTMLDivElement | null>(null)
  const hzRef = useRef<HTMLSpanElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<FaceLandmarker | null>(null)
  const synthRef = useRef<WaaawSynth | null>(null)
  const rafRef = useRef<number | null>(null)
  const openRef = useRef(0)
  const mutedRef = useRef(false)
  const lastTsRef = useRef(0)
  const hasFaceRef = useRef(false)

  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void synthRef.current?.stop()
    synthRef.current = null
    openRef.current = 0
  }, [])

  useEffect(() => teardown, [teardown])

  const toggleMute = () => {
    mutedRef.current = !mutedRef.current
    setMuted(mutedRef.current)
    if (mutedRef.current) {
      openRef.current = 0
      synthRef.current?.setOpen(0)
    }
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

      const synth = new WaaawSynth()
      await synth.start()
      synthRef.current = synth

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

    let target = 0
    let mouth = null
    try {
      const result = landmarker.detectForVideo(video, ts)
      const face = result.faceLandmarks?.[0]
      if (face) {
        mouth = readMouth(face, video.videoWidth, video.videoHeight)
        if (mouth) target = mouth.open
      }
    } catch {
      /* a dropped frame is not fatal */
    }

    hasFaceRef.current = mouth !== null

    const smoothed = smoothMouth(openRef.current, target)
    openRef.current = smoothed
    synthRef.current?.setOpen(mutedRef.current ? 0 : smoothed)

    // --- paint ---
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    if (mouth) {
      const hue = 196 - 152 * smoothed
      const light = 58 + 12 * smoothed
      const stroke = `hsl(${hue} 92% ${light}%)`
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
      ctx.fillStyle = `hsla(${hue} 92% ${light}% / ${0.1 + 0.22 * smoothed})`
      ctx.fill(path)
      ctx.shadowColor = stroke
      ctx.shadowBlur = 14 + 34 * smoothed
      ctx.strokeStyle = stroke
      ctx.lineWidth = Math.max(2, (2 + 4 * smoothed) * scale)
      ctx.stroke(path)
      ctx.restore()
    }

    if (meterRef.current) {
      meterRef.current.style.width = `${Math.round(smoothed * 100)}%`
      meterRef.current.style.background = `hsl(${196 - 152 * smoothed} 92% ${58 + 12 * smoothed}%)`
    }
    if (hzRef.current) {
      const synth = synthRef.current
      const voiced = smoothed > GATE && !mutedRef.current
      hzRef.current.textContent = voiced && synth ? `${Math.round(synth.hz)} Hz` : 'silent'
    }
  }

  return (
    <main className="min-h-screen bg-ink text-paper flex flex-col items-center justify-center gap-6 p-6">
      <header className="text-center space-y-1">
        <h1 className="text-4xl font-semibold tracking-tight">
          waw<span className="text-accent">.</span>
        </h1>
        <p className="text-sm text-paper/50">open your mouth → hear the waaaw</p>
      </header>

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
          <span>mouth</span>
          <span ref={hzRef}>silent</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div ref={meterRef} className="h-full w-0 rounded-full transition-[width] duration-75" />
        </div>
      </div>
    </main>
  )
}
