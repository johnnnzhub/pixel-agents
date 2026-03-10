/**
 * Audio manager for Pixel Agents office.
 * Provides ambient sounds, typing effects, and lo-fi music via stream.
 * All features have independent toggles.
 */

let audioCtx: AudioContext | null = null

// ── State ──
let ambientEnabled = false
let typingEnabled = false
let musicEnabled = false
let ambientNode: AudioBufferSourceNode | null = null
let ambientGain: GainNode | null = null
let musicElement: HTMLAudioElement | null = null
let typingInterval: ReturnType<typeof setInterval> | null = null
let isTypingActive = false

// Lo-fi stream URL (Lofi Girl YouTube live → direct stream)
const LOFI_STREAM_URL = 'https://play.streamafrica.net/lofiradio'

function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext()
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume()
  }
  return audioCtx
}

// ── Ambient Sound (white noise + filter) ──

function startAmbient(): void {
  if (ambientNode) return
  try {
    const ctx = getCtx()
    // Generate 2 seconds of white noise
    const bufferSize = ctx.sampleRate * 2
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.15
    }

    ambientNode = ctx.createBufferSource()
    ambientNode.buffer = buffer
    ambientNode.loop = true

    // Low-pass filter for soft ambient
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 400
    filter.Q.value = 0.5

    ambientGain = ctx.createGain()
    ambientGain.gain.value = 0.08

    ambientNode.connect(filter)
    filter.connect(ambientGain)
    ambientGain.connect(ctx.destination)
    ambientNode.start()
  } catch {
    // Audio not available
  }
}

function stopAmbient(): void {
  try {
    ambientNode?.stop()
  } catch { /* already stopped */ }
  ambientNode?.disconnect()
  ambientGain?.disconnect()
  ambientNode = null
  ambientGain = null
}

// ── Typing Sound ──

function playTypingClick(): void {
  try {
    const ctx = getCtx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = ctx.currentTime

    // Short high-frequency click
    osc.type = 'square'
    osc.frequency.setValueAtTime(800 + Math.random() * 400, t)

    gain.gain.setValueAtTime(0.03, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.03)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.03)
  } catch {
    // ignore
  }
}

export function startTyping(): void {
  if (!typingEnabled || isTypingActive) return
  isTypingActive = true
  // Random clicks at typing speed (50-120ms intervals)
  const tick = () => {
    if (!isTypingActive || !typingEnabled) return
    playTypingClick()
    typingInterval = setTimeout(tick, 50 + Math.random() * 70)
  }
  tick()
}

export function stopTyping(): void {
  isTypingActive = false
  if (typingInterval) {
    clearTimeout(typingInterval)
    typingInterval = null
  }
}

// ── Music (external stream) ──

function startMusic(): void {
  if (musicElement) return
  try {
    musicElement = new Audio(LOFI_STREAM_URL)
    musicElement.volume = 0.15
    musicElement.crossOrigin = 'anonymous'
    musicElement.play().catch(() => {
      // Autoplay blocked or network error — fail silently
      musicElement = null
    })
  } catch {
    musicElement = null
  }
}

function stopMusic(): void {
  if (musicElement) {
    musicElement.pause()
    musicElement.src = ''
    musicElement = null
  }
}

// ── Public API ──

export function setAmbientEnabled(enabled: boolean): void {
  ambientEnabled = enabled
  if (enabled) startAmbient()
  else stopAmbient()
}

export function setTypingEnabled(enabled: boolean): void {
  typingEnabled = enabled
  if (!enabled) stopTyping()
}

export function setMusicEnabled(enabled: boolean): void {
  musicEnabled = enabled
  if (enabled) startMusic()
  else stopMusic()
}

export function isAmbientEnabled(): boolean { return ambientEnabled }
export function isTypingEnabled(): boolean { return typingEnabled }
export function isMusicEnabled(): boolean { return musicEnabled }

/** Call from any user gesture to unlock AudioContext */
export function unlockAudioManager(): void {
  try {
    if (audioCtx?.state === 'suspended') {
      audioCtx.resume()
    }
  } catch {
    // ignore
  }
}
