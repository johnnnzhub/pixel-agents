import { CharacterState, Direction, TILE_SIZE } from '../types.js'
import type { Character, Seat, SpriteData, TileType as TileTypeVal, AgentPersonality } from '../types.js'
import type { CharacterSprites } from '../sprites/spriteData.js'
import { findPath } from '../layout/tileMap.js'
import type { POI } from './officeState.js'
import {
  WALK_SPEED_PX_PER_SEC,
  WALK_FRAME_DURATION_SEC,
  TYPE_FRAME_DURATION_SEC,
  WANDER_PAUSE_MIN_SEC,
  WANDER_PAUSE_MAX_SEC,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_MOVES_BEFORE_REST_MAX,
  IDLE_ANIM_FRAME_DURATION_SEC,
  INTERACT_MIN_SEC,
  INTERACT_MAX_SEC,
  WANDER_POI_CHANCE,
  SOCIAL_RANGE_TILES,
  SOCIAL_MIN_SEC,
  SOCIAL_MAX_SEC,
  SOCIAL_BUBBLE_TOGGLE_SEC,
  THOUGHT_BUBBLE_MIN_SEC,
  THOUGHT_BUBBLE_MAX_SEC,
  THOUGHT_BUBBLE_DURATION_MIN,
  THOUGHT_BUBBLE_DURATION_MAX,
  THOUGHT_BUBBLE_CHANCE,
  MOUSE_AWARENESS_RANGE_PX,
  MOUSE_LOOK_UPDATE_SEC,
  IDLE_LOOK_AROUND_MIN_SEC,
  IDLE_LOOK_AROUND_MAX_SEC,
} from '../../constants.js'

/** Default balanced personality */
export const DEFAULT_PERSONALITY: AgentPersonality = {
  wanderFrequency: 1.0,
  socialChance: 0.3,
  thoughtFrequency: 1.0,
  preferredPOIs: [],
}

/** Tools that show reading animation instead of typing */
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])

export function isReadingTool(tool: string | null): boolean {
  if (!tool) return false
  return READING_TOOLS.has(tool)
}

/** Pixel center of a tile */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  }
}

/** Direction from one tile to an adjacent tile */
function directionBetween(fromCol: number, fromRow: number, toCol: number, toRow: number): Direction {
  const dc = toCol - fromCol
  const dr = toRow - fromRow
  if (dc > 0) return Direction.RIGHT
  if (dc < 0) return Direction.LEFT
  if (dr > 0) return Direction.DOWN
  return Direction.UP
}

export function createCharacter(
  id: number,
  palette: number,
  seatId: string | null,
  seat: Seat | null,
  hueShift = 0,
  personality: AgentPersonality = DEFAULT_PERSONALITY,
): Character {
  const col = seat ? seat.seatCol : 1
  const row = seat ? seat.seatRow : 1
  const center = tileCenter(col, row)
  return {
    id,
    state: CharacterState.TYPE,
    dir: seat ? seat.facingDir : Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette,
    hueShift,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX),
    isActive: true,
    seatId,
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    interactType: null,
    interactTimer: 0,
    socialPartnerId: null,
    socialTimer: 0,
    socialRole: null,
    thoughtTimer: randomRange(THOUGHT_BUBBLE_MIN_SEC, THOUGHT_BUBBLE_MAX_SEC) / personality.thoughtFrequency,
    thoughtIcon: null,
    clickReactionTimer: 0,
    lookTimer: MOUSE_LOOK_UPDATE_SEC,
    idleLookTimer: randomRange(IDLE_LOOK_AROUND_MIN_SEC, IDLE_LOOK_AROUND_MAX_SEC),
    personality,
  }
}

/** Helper: pathfind to seat and transition to WALK or TYPE */
function goToSeat(
  ch: Character,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): void {
  if (!ch.seatId) {
    ch.state = CharacterState.TYPE
    ch.frame = 0
    ch.frameTimer = 0
    return
  }
  const seat = seats.get(ch.seatId)
  if (!seat) return
  const path = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
  if (path.length > 0) {
    ch.path = path
    ch.moveProgress = 0
    ch.state = CharacterState.WALK
    ch.frame = 0
    ch.frameTimer = 0
  } else {
    ch.state = CharacterState.TYPE
    ch.dir = seat.facingDir
    ch.frame = 0
    ch.frameTimer = 0
  }
}

/** Direction from pixel position toward another pixel position */
function directionToward(fromX: number, fromY: number, toX: number, toY: number): Direction {
  const dx = toX - fromX
  const dy = toY - fromY
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? Direction.RIGHT : Direction.LEFT
  }
  return dy > 0 ? Direction.DOWN : Direction.UP
}

/** Random direction (0-3) */
function randomDirection(): Direction {
  return Math.floor(Math.random() * 4) as Direction
}

export function updateCharacter(
  ch: Character,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  poiList: POI[],
  characters: Character[],
  mouseWorldX: number | null,
  mouseWorldY: number | null,
): void {
  ch.frameTimer += dt

  // Tick click reaction timer (all states)
  if (ch.clickReactionTimer > 0) {
    ch.clickReactionTimer -= dt
    if (ch.clickReactionTimer < 0) ch.clickReactionTimer = 0
  }

  switch (ch.state) {
    case CharacterState.TYPE: {
      if (ch.frameTimer >= TYPE_FRAME_DURATION_SEC) {
        ch.frameTimer -= TYPE_FRAME_DURATION_SEC
        ch.frame = (ch.frame + 1) % 2
      }
      // If no longer active, transition to IDLE (immediate after short seatTimer)
      if (!ch.isActive) {
        if (ch.seatTimer > 0) {
          ch.seatTimer -= dt
          break
        }
        ch.seatTimer = 0
        ch.state = CharacterState.IDLE
        ch.frame = 0
        ch.frameTimer = 0
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC) / ch.personality.wanderFrequency
        ch.wanderCount = 0
        ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
      }
      break
    }

    case CharacterState.IDLE: {
      // Animated weight-shift idle
      if (ch.frameTimer >= IDLE_ANIM_FRAME_DURATION_SEC) {
        ch.frameTimer -= IDLE_ANIM_FRAME_DURATION_SEC
        ch.frame = (ch.frame + 1) % 4
      }
      if (ch.seatTimer < 0) ch.seatTimer = 0
      // If became active, pathfind to seat
      if (ch.isActive) {
        clearIdleBubbles(ch)
        goToSeat(ch, seats, tileMap, blockedTiles)
        break
      }

      // ── Thought bubbles ──
      if (ch.bubbleType !== 'permission' && ch.bubbleType !== 'waiting') {
        if (ch.bubbleType === 'thought') {
          // Tick thought bubble duration
          ch.bubbleTimer -= dt
          if (ch.bubbleTimer <= 0) {
            ch.bubbleType = null
            ch.bubbleTimer = 0
            ch.thoughtIcon = null
            ch.thoughtTimer = randomRange(THOUGHT_BUBBLE_MIN_SEC, THOUGHT_BUBBLE_MAX_SEC) / ch.personality.thoughtFrequency
          }
        } else if (ch.bubbleType === null) {
          ch.thoughtTimer -= dt
          if (ch.thoughtTimer <= 0) {
            if (Math.random() < THOUGHT_BUBBLE_CHANCE) {
              ch.bubbleType = 'thought'
              ch.thoughtIcon = Math.floor(Math.random() * 5)
              ch.bubbleTimer = randomRange(THOUGHT_BUBBLE_DURATION_MIN, THOUGHT_BUBBLE_DURATION_MAX)
            } else {
              ch.thoughtTimer = randomRange(THOUGHT_BUBBLE_MIN_SEC, THOUGHT_BUBBLE_MAX_SEC) / ch.personality.thoughtFrequency
            }
          }
        }
      }

      // ── Mouse awareness ──
      ch.lookTimer -= dt
      if (ch.lookTimer <= 0) {
        ch.lookTimer = MOUSE_LOOK_UPDATE_SEC
        if (mouseWorldX !== null && mouseWorldY !== null) {
          const dx = mouseWorldX - ch.x
          const dy = mouseWorldY - ch.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist <= MOUSE_AWARENESS_RANGE_PX) {
            ch.dir = directionToward(ch.x, ch.y, mouseWorldX, mouseWorldY)
          }
        }
      }

      // ── Idle look around ──
      ch.idleLookTimer -= dt
      if (ch.idleLookTimer <= 0) {
        ch.idleLookTimer = randomRange(IDLE_LOOK_AROUND_MIN_SEC, IDLE_LOOK_AROUND_MAX_SEC)
        ch.dir = randomDirection()
      }

      // Countdown wander timer
      ch.wanderTimer -= dt
      if (ch.wanderTimer <= 0) {
        // ── Social trigger ──
        if (Math.random() < ch.personality.socialChance) {
          const target = findSocialTarget(ch, characters)
          if (target) {
            // Pathfind to tile adjacent to target
            const adjTile = findAdjacentWalkable(target.tileCol, target.tileRow, tileMap, blockedTiles)
            if (adjTile) {
              const path = findPath(ch.tileCol, ch.tileRow, adjTile.col, adjTile.row, tileMap, blockedTiles)
              if (path.length > 0) {
                ch.path = path
                ch.moveProgress = 0
                ch.state = CharacterState.WALK
                ch.frame = 0
                ch.frameTimer = 0
                ch.socialPartnerId = target.id
                ch.socialRole = 'initiator'
                clearIdleBubbles(ch)
                ch.wanderCount++
                break
              }
            }
          }
        }

        // POI targeting: 60% chance to target a POI, 40% random tile
        let targeted = false
        if (Math.random() < WANDER_POI_CHANCE && poiList.length > 0) {
          // Prefer personality POIs
          let poi: POI
          const preferred = poiList.filter(p => ch.personality.preferredPOIs.includes(p.interactType))
          if (preferred.length > 0 && Math.random() < 0.7) {
            poi = preferred[Math.floor(Math.random() * preferred.length)]
          } else {
            poi = poiList[Math.floor(Math.random() * poiList.length)]
          }
          const path = findPath(ch.tileCol, ch.tileRow, poi.col, poi.row, tileMap, blockedTiles)
          if (path.length > 0) {
            ch.path = path
            ch.moveProgress = 0
            ch.state = CharacterState.WALK
            ch.frame = 0
            ch.frameTimer = 0
            ch.wanderCount++
            clearIdleBubbles(ch)
            targeted = true
          }
        }
        if (!targeted && walkableTiles.length > 0) {
          const target = walkableTiles[Math.floor(Math.random() * walkableTiles.length)]
          const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, tileMap, blockedTiles)
          if (path.length > 0) {
            ch.path = path
            ch.moveProgress = 0
            ch.state = CharacterState.WALK
            ch.frame = 0
            ch.frameTimer = 0
            ch.wanderCount++
            clearIdleBubbles(ch)
          }
        }
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC) / ch.personality.wanderFrequency
      }
      break
    }

    case CharacterState.WALK: {
      // Walk animation
      if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
        ch.frameTimer -= WALK_FRAME_DURATION_SEC
        ch.frame = (ch.frame + 1) % 4
      }

      if (ch.path.length === 0) {
        // Path complete — snap to tile center and transition
        const center = tileCenter(ch.tileCol, ch.tileRow)
        ch.x = center.x
        ch.y = center.y

        if (ch.isActive) {
          if (!ch.seatId) {
            ch.state = CharacterState.TYPE
          } else {
            const seat = seats.get(ch.seatId)
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = CharacterState.TYPE
              ch.dir = seat.facingDir
            } else {
              ch.state = CharacterState.IDLE
            }
          }
        } else {
          // Check if walking to social target
          if (ch.socialPartnerId !== null && ch.socialRole === 'initiator') {
            const partner = characters.find(c => c.id === ch.socialPartnerId)
            if (partner && partner.state === CharacterState.IDLE && !partner.isActive &&
                manhattanTileDist(ch, partner) <= 2) {
              // Start social interaction for both
              const duration = randomRange(SOCIAL_MIN_SEC, SOCIAL_MAX_SEC)
              ch.state = CharacterState.SOCIAL
              ch.socialTimer = duration
              ch.dir = directionToward(ch.x, ch.y, partner.x, partner.y)
              ch.bubbleType = 'chat'
              ch.bubbleTimer = 0
              ch.frame = 0
              ch.frameTimer = 0

              partner.state = CharacterState.SOCIAL
              partner.socialPartnerId = ch.id
              partner.socialRole = 'responder'
              partner.socialTimer = duration
              partner.dir = directionToward(partner.x, partner.y, ch.x, ch.y)
              partner.bubbleType = null
              partner.bubbleTimer = 0
              partner.frame = 0
              partner.frameTimer = 0
              clearIdleBubbles(partner)
            } else {
              // Partner moved or became active — fallback
              ch.socialPartnerId = null
              ch.socialRole = null
              ch.state = CharacterState.IDLE
              ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC) / ch.personality.wanderFrequency
            }
          } else {
            // Clear social intent if we had one
            ch.socialPartnerId = null
            ch.socialRole = null
            // Check if tile is a POI → INTERACT
            const poi = poiList.find(p => p.col === ch.tileCol && p.row === ch.tileRow)
            if (poi) {
              ch.state = CharacterState.INTERACT
              ch.dir = poi.facingDir
              ch.interactType = poi.interactType
              ch.interactTimer = randomRange(INTERACT_MIN_SEC, INTERACT_MAX_SEC)
            } else {
              ch.state = CharacterState.IDLE
              ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC) / ch.personality.wanderFrequency
            }
          }
        }
        ch.frame = 0
        ch.frameTimer = 0
        break
      }

      // Move toward next tile in path
      const nextTile = ch.path[0]
      ch.dir = directionBetween(ch.tileCol, ch.tileRow, nextTile.col, nextTile.row)

      ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt

      const fromCenter = tileCenter(ch.tileCol, ch.tileRow)
      const toCenter = tileCenter(nextTile.col, nextTile.row)
      const t = Math.min(ch.moveProgress, 1)
      ch.x = fromCenter.x + (toCenter.x - fromCenter.x) * t
      ch.y = fromCenter.y + (toCenter.y - fromCenter.y) * t

      if (ch.moveProgress >= 1) {
        // Arrived at next tile
        ch.tileCol = nextTile.col
        ch.tileRow = nextTile.row
        ch.x = toCenter.x
        ch.y = toCenter.y
        ch.path.shift()
        ch.moveProgress = 0
      }

      // If became active while wandering, repath to seat
      if (ch.isActive && ch.seatId) {
        ch.socialPartnerId = null
        ch.socialRole = null
        const seat = seats.get(ch.seatId)
        if (seat) {
          const lastStep = ch.path[ch.path.length - 1]
          if (!lastStep || lastStep.col !== seat.seatCol || lastStep.row !== seat.seatRow) {
            const newPath = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
            if (newPath.length > 0) {
              ch.path = newPath
              ch.moveProgress = 0
            }
          }
        }
      }
      break
    }

    case CharacterState.INTERACT: {
      // Animate based on interactType
      const frameDur = ch.interactType === 'look'
        ? IDLE_ANIM_FRAME_DURATION_SEC
        : TYPE_FRAME_DURATION_SEC
      const frameCount = ch.interactType === 'look' ? 4 : 2
      if (ch.frameTimer >= frameDur) {
        ch.frameTimer -= frameDur
        ch.frame = (ch.frame + 1) % frameCount
      }
      // If became active, go to seat
      if (ch.isActive) {
        ch.interactType = null
        ch.interactTimer = 0
        goToSeat(ch, seats, tileMap, blockedTiles)
        break
      }
      // Countdown interaction
      ch.interactTimer -= dt
      if (ch.interactTimer <= 0) {
        ch.interactType = null
        ch.interactTimer = 0
        ch.state = CharacterState.IDLE
        ch.frame = 0
        ch.frameTimer = 0
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC) / ch.personality.wanderFrequency
      }
      break
    }

    case CharacterState.SOCIAL: {
      // Weight-shift animation while chatting
      if (ch.frameTimer >= IDLE_ANIM_FRAME_DURATION_SEC) {
        ch.frameTimer -= IDLE_ANIM_FRAME_DURATION_SEC
        ch.frame = (ch.frame + 1) % 4
      }
      // If became active, break social — go to seat
      if (ch.isActive) {
        breakSocial(ch, characters)
        goToSeat(ch, seats, tileMap, blockedTiles)
        break
      }
      // Toggle chat bubble between partners
      ch.socialTimer -= dt
      const togglePhase = Math.floor(ch.socialTimer / SOCIAL_BUBBLE_TOGGLE_SEC) % 2
      if (ch.socialRole === 'initiator') {
        ch.bubbleType = togglePhase === 0 ? 'chat' : null
      } else {
        ch.bubbleType = togglePhase === 1 ? 'chat' : null
      }

      // Check partner still exists and is in SOCIAL
      const partner = characters.find(c => c.id === ch.socialPartnerId)
      if (!partner || partner.state !== CharacterState.SOCIAL) {
        ch.bubbleType = null
        ch.socialPartnerId = null
        ch.socialRole = null
        ch.socialTimer = 0
        ch.state = CharacterState.IDLE
        ch.frame = 0
        ch.frameTimer = 0
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC) / ch.personality.wanderFrequency
        break
      }

      if (ch.socialTimer <= 0) {
        // End social — both return to IDLE
        ch.bubbleType = null
        ch.socialPartnerId = null
        ch.socialRole = null
        ch.socialTimer = 0
        ch.state = CharacterState.IDLE
        ch.frame = 0
        ch.frameTimer = 0
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC) / ch.personality.wanderFrequency

        partner.bubbleType = null
        partner.socialPartnerId = null
        partner.socialRole = null
        partner.socialTimer = 0
        partner.state = CharacterState.IDLE
        partner.frame = 0
        partner.frameTimer = 0
        partner.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC) / partner.personality.wanderFrequency
      }
      break
    }
  }
}

/** Break a social interaction: free both partners */
function breakSocial(ch: Character, characters: Character[]): void {
  if (ch.socialPartnerId !== null) {
    const partner = characters.find(c => c.id === ch.socialPartnerId)
    if (partner && partner.state === CharacterState.SOCIAL) {
      partner.bubbleType = null
      partner.socialPartnerId = null
      partner.socialRole = null
      partner.socialTimer = 0
      partner.state = CharacterState.IDLE
      partner.frame = 0
      partner.frameTimer = 0
      partner.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC) / partner.personality.wanderFrequency
    }
  }
  ch.bubbleType = null
  ch.socialPartnerId = null
  ch.socialRole = null
  ch.socialTimer = 0
}

/** Clear idle-specific bubbles (thought) without touching permission/waiting */
function clearIdleBubbles(ch: Character): void {
  if (ch.bubbleType === 'thought' || ch.bubbleType === 'chat') {
    ch.bubbleType = null
    ch.bubbleTimer = 0
    ch.thoughtIcon = null
  }
}

/** Find a social target: another IDLE, non-active, non-subagent character within range */
function findSocialTarget(ch: Character, characters: Character[]): Character | null {
  let best: Character | null = null
  let bestDist = Infinity
  const range = SOCIAL_RANGE_TILES * TILE_SIZE
  for (const other of characters) {
    if (other.id === ch.id) continue
    if (other.state !== CharacterState.IDLE) continue
    if (other.isActive || other.isSubagent) continue
    if (other.socialPartnerId !== null) continue
    const dist = Math.abs(other.x - ch.x) + Math.abs(other.y - ch.y)
    if (dist <= range && dist < bestDist) {
      bestDist = dist
      best = other
    }
  }
  return best
}

/** Find a walkable tile adjacent to a given tile */
function findAdjacentWalkable(col: number, row: number, tileMap: TileTypeVal[][], blockedTiles: Set<string>): { col: number; row: number } | null {
  const dirs = [
    { dc: 0, dr: -1 },
    { dc: 0, dr: 1 },
    { dc: -1, dr: 0 },
    { dc: 1, dr: 0 },
  ]
  for (const d of dirs) {
    const ac = col + d.dc
    const ar = row + d.dr
    if (ar < 0 || ar >= tileMap.length) continue
    if (ac < 0 || ac >= (tileMap[0]?.length ?? 0)) continue
    if (blockedTiles.has(`${ac},${ar}`)) continue
    return { col: ac, row: ar }
  }
  return null
}

/** Manhattan distance in tiles between two characters */
function manhattanTileDist(a: Character, b: Character): number {
  return Math.abs(a.tileCol - b.tileCol) + Math.abs(a.tileRow - b.tileRow)
}

/** Get the correct sprite frame for a character's current state and direction */
export function getCharacterSprite(ch: Character, sprites: CharacterSprites): SpriteData {
  switch (ch.state) {
    case CharacterState.TYPE:
      if (isReadingTool(ch.currentTool)) {
        return sprites.reading[ch.dir][ch.frame % 2]
      }
      return sprites.typing[ch.dir][ch.frame % 2]
    case CharacterState.WALK:
      return sprites.walk[ch.dir][ch.frame % 4]
    case CharacterState.IDLE:
      return sprites.walk[ch.dir][ch.frame % 4]
    case CharacterState.INTERACT:
      if (ch.interactType === 'read') return sprites.reading[ch.dir][ch.frame % 2]
      if (ch.interactType === 'operate') return sprites.typing[ch.dir][ch.frame % 2]
      return sprites.walk[ch.dir][ch.frame % 4]
    case CharacterState.SOCIAL:
      return sprites.walk[ch.dir][ch.frame % 4]
    default:
      return sprites.walk[ch.dir][1]
  }
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}
