// Board sounds: real recordings (wood knocks, a small bell, a soft thud) from
// Kenney's CC0 Impact Sounds and Casino Audio packs, trimmed and levelled well
// below clipping. The two LICENSE files sit next to the mp3s in public/sound/.
// Buffers are decoded once so they play instantly on phones. Nothing plays
// before the first tap (browsers block it) or when sound is off.

export type SoundName = 'move' | 'capture' | 'check' | 'good' | 'bad' | 'win' | 'lose' | 'draw' | 'notify' | 'lowtime'

// Which sound a just-landed move makes: a capture or a check outranks a plain
// knock. Pure, so the mapping is testable without an AudioContext.
export function landSound(capture: boolean, check: boolean): 'capture' | 'check' | 'move' {
  if (check) return 'check'
  if (capture) return 'capture'
  return 'move'
}

// A Turning Points score read as a game result: every stop found is a win,
// none is a loss, some is a draw. No stops at all is no result.
export function scoreSound(found: number, total: number): 'win' | 'lose' | 'draw' | undefined {
  if (total <= 0) return undefined
  if (found >= total) return 'win'
  if (found <= 0) return 'lose'
  return 'draw'
}

let enabled = readFlag('lidrill.sound', true)
const buffers = new Map<SoundName, Promise<AudioBuffer | null>>()

export function setSound(on: boolean): void {
  enabled = on
  writeFlag('lidrill.sound', on)
  if (on) play('move') // immediate feedback that sound is back
}

export function soundOn(): boolean {
  return enabled
}

function audio(): AudioContext | null {
  if (!enabled) return null
  routeAudioSession() // best effort: browsers without the API ignore it
  if (!ctx) {
    const AC = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0.8 // the recordings are already levelled; just stay shy of full scale
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

// iOS Safari routes WebAudio through the earpiece and obeys the silent switch
// unless the page's audio session is 'playback'. Only some browsers expose
// navigator.audioSession; setting it must never throw where it doesn't exist.
function routeAudioSession(): void {
  try {
    const nav = navigator as Navigator & { audioSession?: { setType?: (t: string) => void } }
    nav.audioSession?.setType?.('playback')
  } catch {
    // sounds still play, subject to the silent switch
  }
}

function load(a: AudioContext, name: SoundName): Promise<AudioBuffer | null> {
  let p = buffers.get(name)
  if (!p) {
    p = fetch(`/sound/${name}.mp3`)
      .then(r => r.arrayBuffer())
      .then(b => a.decodeAudioData(b))
      .catch(() => null)
    buffers.set(name, p)
  }
  return p
}

function play(name: SoundName): void {
  const a = audio()
  if (!a || !master) return
  const out = master // a local, so the callback below sees a non-null node
  void load(a, name).then(buf => {
    if (!buf) return
    const src = a.createBufferSource()
    src.buffer = buf
    src.connect(out)
    src.start()
  })
}

// Warm the common ones on the first tap, so the first move isn't silent while it downloads
if (typeof window !== 'undefined')
  window.addEventListener(
    'pointerdown',
    () => {
      const a = audio()
      if (a) for (const n of ['move', 'capture', 'check', 'good', 'bad'] as SoundName[]) void load(a, n)
    },
    { once: true },
  )

// Per-browser preference; storage can be off (private mode), which just means
// the default, like ctrl's readFlag/writeFlag
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // not saved; fine
  }
}

let ctx: AudioContext | null = null
let master: GainNode | null = null

export const sound = {
  move: () => play('move'),
  capture: () => play('capture'),
  check: () => play('check'),
  good: () => play('good'),
  bad: () => play('bad'),
  win: () => play('win'),
  lose: () => play('lose'),
  draw: () => play('draw'),
  notify: () => play('notify'),
  lowtime: () => play('lowtime'),
}
