import { MAX_DELTA_TIME_SEC } from '../../constants.js'

/** Milliseconds without a rAF callback before activating setInterval fallback */
const RAF_STALL_THRESHOLD_MS = 500
/** Fallback interval when rAF is not firing (target ~30 FPS) */
const FALLBACK_INTERVAL_MS = 33

export interface GameLoopCallbacks {
  update: (dt: number) => void
  render: (ctx: CanvasRenderingContext2D) => void
}

/** Diagnostic counters exposed for DebugView */
export const gameLoopDiagnostics = {
  frameCount: 0,
  fps: 0,
  usingFallback: false,
}

export function startGameLoop(
  canvas: HTMLCanvasElement,
  callbacks: GameLoopCallbacks,
): () => void {
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  let lastTime = 0
  let rafId = 0
  let stopped = false
  let lastRafTimestamp = performance.now()

  // FPS tracking
  let fpsFrameCount = 0
  let fpsLastSample = performance.now()

  const tick = (time: number) => {
    if (stopped) return
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC)
    lastTime = time
    lastRafTimestamp = performance.now()

    callbacks.update(dt)

    ctx.imageSmoothingEnabled = false
    callbacks.render(ctx)

    gameLoopDiagnostics.frameCount++
    fpsFrameCount++

    // Sample FPS every second
    const now = performance.now()
    if (now - fpsLastSample >= 1000) {
      gameLoopDiagnostics.fps = fpsFrameCount
      fpsFrameCount = 0
      fpsLastSample = now
    }
  }

  // Primary: requestAnimationFrame
  const rafFrame = (time: number) => {
    if (stopped) return
    gameLoopDiagnostics.usingFallback = false
    tick(time)
    rafId = requestAnimationFrame(rafFrame)
  }
  rafId = requestAnimationFrame(rafFrame)

  // Fallback: setInterval watchdog — activates if rAF stalls
  const fallbackTimer = setInterval(() => {
    if (stopped) return
    const elapsed = performance.now() - lastRafTimestamp
    if (elapsed > RAF_STALL_THRESHOLD_MS) {
      gameLoopDiagnostics.usingFallback = true
      tick(performance.now())
    }
  }, FALLBACK_INTERVAL_MS)

  return () => {
    stopped = true
    cancelAnimationFrame(rafId)
    clearInterval(fallbackTimer)
  }
}
