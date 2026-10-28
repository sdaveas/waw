/**
 * Costumes: what actually happens when a pet turns up.
 *
 * The detection is the same as it was for the sounds, but the payoff is drawn
 * on the face instead — a cat gets you a moustache, a dog gets you ears, a tiny
 * human gets a party hat. Everything is drawn from face landmarks, so the props
 * stick to the head as it moves and turns.
 */

import type { FaceState } from './face'
import type { PetKind } from './pets'

type Point = { x: number; y: number }

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)

/**
 * Cat face: a little pink nose plus whiskers, rather than a human moustache.
 * Whiskers are drawn twice — a soft dark stroke under a light one — so they
 * stay visible on both pale and dark skin.
 */
function catFace(ctx: CanvasRenderingContext2D, face: FaceState, scale: number) {
  const { noseTip } = face.anchors
  const faceW = dist(face.anchors.leftSide, face.anchors.rightSide)
  const noseW = faceW * 0.13
  const noseH = noseW * 0.72

  ctx.save()

  // nose: a rounded downward triangle
  ctx.beginPath()
  ctx.moveTo(noseTip.x - noseW / 2, noseTip.y - noseH * 0.45)
  ctx.quadraticCurveTo(noseTip.x, noseTip.y - noseH * 0.7, noseTip.x + noseW / 2, noseTip.y - noseH * 0.45)
  ctx.quadraticCurveTo(noseTip.x + noseW * 0.22, noseTip.y + noseH * 0.55, noseTip.x, noseTip.y + noseH * 0.62)
  ctx.quadraticCurveTo(noseTip.x - noseW * 0.22, noseTip.y + noseH * 0.55, noseTip.x - noseW / 2, noseTip.y - noseH * 0.45)
  ctx.closePath()
  ctx.fillStyle = '#f472b6'
  ctx.fill()
  ctx.strokeStyle = 'rgba(60,20,40,0.5)'
  ctx.lineWidth = Math.max(1, 1.5 * scale)
  ctx.stroke()

  // whiskers: three a side, fanned out and slightly drooping
  const origin = { x: noseTip.x, y: noseTip.y + noseH * 0.15 }
  const len = faceW * 0.48
  for (const dir of [-1, 1]) {
    for (const [i, spec] of [
      { up: -0.46, len: 0.86, sag: 0.10 },
      { up: -0.06, len: 1.02, sag: 0.05 },
      { up: 0.34, len: 0.9, sag: -0.05 },
    ].entries()) {
      const x0 = origin.x + dir * noseW * 0.45
      const y0 = origin.y + spec.up * noseW * 0.5
      const x1 = x0 + dir * len * spec.len
      const y1 = y0 + len * spec.up * 0.55
      const cx = x0 + dir * len * 0.55
      const cy = y0 + len * spec.sag * 2.2

      for (const [width, color] of [
        [Math.max(3, 5.2 * scale), 'rgba(30,20,25,0.42)'],
        [Math.max(1.4, 2.4 * scale), 'rgba(255,255,255,0.95)'],
      ] as Array<[number, string]>) {
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.quadraticCurveTo(cx, cy, x1, y1)
        ctx.strokeStyle = color
        ctx.lineWidth = width
        ctx.lineCap = 'round'
        ctx.stroke()
      }
      void i
    }
  }
  ctx.restore()
}

function ears(ctx: CanvasRenderingContext2D, face: FaceState, scale: number) {
  const faceH = dist(face.anchors.brow, face.anchors.chin)
  const earH = faceH * 0.62
  const earW = faceH * 0.34

  for (const side of [
    { anchor: face.anchors.leftSide, dir: -1 },
    { anchor: face.anchors.rightSide, dir: 1 },
  ]) {
    const { anchor, dir } = side
    const top = { x: anchor.x, y: anchor.y - faceH * 0.24 }

    ctx.save()
    ctx.fillStyle = '#8a5a3b'
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'
    ctx.lineWidth = Math.max(1, 2 * scale)

    ctx.beginPath()
    ctx.moveTo(top.x + dir * -earW * 0.05, top.y)
    ctx.quadraticCurveTo(top.x + dir * earW * 1.05, top.y + earH * 0.12, top.x + dir * earW * 0.92, top.y + earH * 0.72)
    ctx.quadraticCurveTo(top.x + dir * earW * 0.8, top.y + earH * 1.05, top.x + dir * earW * 0.2, top.y + earH * 0.96)
    ctx.quadraticCurveTo(top.x + dir * earW * -0.1, top.y + earH * 0.7, top.x + dir * earW * 0.04, top.y + earH * 0.3)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()

    // inner ear
    ctx.fillStyle = '#c98a7a'
    ctx.beginPath()
    ctx.moveTo(top.x + dir * earW * 0.08, top.y + earH * 0.2)
    ctx.quadraticCurveTo(top.x + dir * earW * 0.72, top.y + earH * 0.3, top.x + dir * earW * 0.6, top.y + earH * 0.68)
    ctx.quadraticCurveTo(top.x + dir * earW * 0.45, top.y + earH * 0.85, top.x + dir * earW * 0.18, top.y + earH * 0.74)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
}

function partyHat(ctx: CanvasRenderingContext2D, face: FaceState, scale: number) {
  const faceH = dist(face.anchors.brow, face.anchors.chin)
  const faceW = dist(face.anchors.leftSide, face.anchors.rightSide)
  const baseY = face.anchors.brow.y - faceH * 0.08
  const cx = face.anchors.brow.x
  const halfW = faceW * 0.24
  const apex = { x: cx + faceW * 0.06, y: baseY - faceH * 0.34 }

  ctx.save()
  // cone
  ctx.fillStyle = '#f472b6'
  ctx.beginPath()
  ctx.moveTo(cx - halfW, baseY)
  ctx.lineTo(apex.x, apex.y)
  ctx.lineTo(cx + halfW, baseY)
  ctx.closePath()
  ctx.fill()

  // stripes
  ctx.save()
  ctx.clip()
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'
  ctx.lineWidth = Math.max(2, 5 * scale)
  for (let i = 1; i <= 3; i++) {
    const y = baseY - (faceH * 0.34 * i) / 4
    ctx.beginPath()
    ctx.moveTo(cx - halfW, y)
    ctx.lineTo(cx + halfW, y)
    ctx.stroke()
  }
  ctx.restore()

  // brim, so it still reads as a hat if the tip is cropped by the frame
  ctx.fillStyle = '#db2777'
  ctx.beginPath()
  ctx.ellipse(cx, baseY, halfW * 1.18, halfW * 0.26, 0, 0, Math.PI * 2)
  ctx.fill()

  // pom-pom
  ctx.fillStyle = '#fde68a'
  ctx.beginPath()
  ctx.arc(apex.x, apex.y - faceH * 0.03, faceH * 0.055, 0, Math.PI * 2)
  ctx.fill()

  // rosy cheeks
  ctx.fillStyle = 'rgba(248, 113, 113, 0.35)'
  for (const side of [face.anchors.leftSide, face.anchors.rightSide]) {
    const cx2 = side.x + (face.anchors.brow.x - side.x) * 0.45
    const cy2 = face.anchors.noseBase.y + faceH * 0.1
    ctx.beginPath()
    ctx.ellipse(cx2, cy2, faceH * 0.11, faceH * 0.075, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Draw the costume for whichever pet is on camera. */
export function drawCostume(
  ctx: CanvasRenderingContext2D,
  face: FaceState,
  pet: PetKind,
  scale: number,
) {
  if (pet === 'cat') catFace(ctx, face, scale)
  else if (pet === 'dog') ears(ctx, face, scale)
  else if (pet === 'baby') partyHat(ctx, face, scale)
}

/** One-line description for the indicator. */
export const COSTUME_NAME: Record<'cat' | 'dog' | 'baby', string> = {
  cat: 'whiskers',
  dog: 'ears',
  baby: 'party hat',
}
