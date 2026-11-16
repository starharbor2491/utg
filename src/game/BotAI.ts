import * as THREE from 'three';
import { GRAVITY, solveBallisticAim } from './Ballistics';
import type { TankEntity, TankIntent, Team, TerrainQuery, VehicleClass } from './types';

export type BotAIState = 'advance' | 'engage_approach' | 'strafe_orbit' | 'evade_reverse';

const NUM_STEER_RAYS = 16;
const RAY_ANGLES = new Float32Array(NUM_STEER_RAYS);
const RAY_SIN = new Float32Array(NUM_STEER_RAYS);
const RAY_COS = new Float32Array(NUM_STEER_RAYS);
for (let i = 0; i < NUM_STEER_RAYS; i++) {
  const a = (i / NUM_STEER_RAYS) * Math.PI * 2 - Math.PI;
  RAY_ANGLES[i] = a;
  RAY_SIN[i] = Math.sin(a);
  RAY_COS[i] = Math.cos(a);
}

function wrapAnglePi(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

function lerpAngle(from: number, to: number, t: number): number {
  const diff = wrapAnglePi(to - from);
  return wrapAnglePi(from + diff * t);
}

function hashIdToSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function aimWanderRadians(_cls: VehicleClass): number {
  return THREE.MathUtils.degToRad(6.8);
}

function idealOrbitDistForClass(cls: VehicleClass): number {
  if (cls === 'heavy') return 112;
  if (cls === 'ifv') return 78;
  return 96;
}

const ADVANCE_LANES = [-120, -40, 40, 120];
const MAX_ACQUIRE_RANGE = 300;
const MAX_ACQUIRE_RANGE_SQ = MAX_ACQUIRE_RANGE * MAX_ACQUIRE_RANGE;
const TARGET_DROP_RANGE = 320;

interface BotBrain {
  id: string;
  state: BotAIState;
  seed: number;
  orbitSign: 1 | -1;
  orbitFlipTimer: number;
  flipCooldown: number;

  advanceX: number;
  advanceZ: number;
  laneX: number;

  targetId: string | null;
  target: TankEntity | null;
  retargetTimer: number;
  lastAttackerId: string | null;
  lastAttackedAt: number;
  smoothedTargetVel: THREE.Vector3;
  lastTargetPos: THREE.Vector3;

  alertTimer: number;
  losLockTimer: number;
  mgCycleTimer: number;

  smoothedMoveYaw: number;
  stuckAccum: number;
  unstuckTimer: number;
  unstuckSteer: number;

  lastHp: number;
  wasAlive: boolean;
}

export class BotAIManager {
  private readonly brains = new Map<string, BotBrain>();
  private readonly intents = new Map<string, TankIntent>();
  private readonly baseCenters: Record<Team, { x: number; z: number }>;

  private clock = 0;

  // Scratch arrays & vectors (zero per-frame heap allocations)
  private readonly _interest = new Float32Array(NUM_STEER_RAYS);
  private readonly _danger = new Float32Array(NUM_STEER_RAYS);
  private readonly _muzzlePos = new THREE.Vector3();
  private readonly _muzzleDir = new THREE.Vector3();
  private readonly _targetCenter = new THREE.Vector3();
  private readonly _aimPoint = new THREE.Vector3();
  private readonly _losDir = new THREE.Vector3();
  private readonly _desiredBore = new THREE.Vector3();
  private readonly _wanderRight = new THREE.Vector3();
  private readonly _candPool: { t: TankEntity | null; d: number }[] = [];
  private readonly _scratchPos = new THREE.Vector3();

  constructor(baseCenters: Record<Team, { x: number; z: number }>) {
    this.baseCenters = baseCenters;
    for (let i = 0; i < 16; i++) {
      this._candPool.push({ t: null, d: Infinity });
    }
  }

  /**
   * Returns true if the specified bot currently has a live target.
   */
  public isAlerted(botId: string): boolean {
    const brain = this.brains.get(botId);
    return Boolean(brain && brain.wasAlive && brain.target !== null);
  }

  public getState(botId: string): BotAIState {
    return this.brains.get(botId)?.state ?? 'advance';
  }

  /**
   * Alert hook fired by the match when this bot takes damage.
   */
  public notifyDamaged(botId: string, attackerId: string | null): void {
    const brain = this.brains.get(botId);
    if (brain) {
      brain.alertTimer = 16.0;
      brain.lastAttackerId = attackerId;
      brain.lastAttackedAt = this.clock;
    }
  }

  public reset(): void {
    this.brains.clear();
    this.intents.clear();
  }

  private _enemyBaseFor(bot: TankEntity): { x: number; z: number } {
    return this.baseCenters[bot.team === 'blue' ? 'red' : 'blue'];
  }

  private _getOrCreateBrain(bot: TankEntity): BotBrain {
    let brain = this.brains.get(bot.id);
    if (!brain) {
      const seed = hashIdToSeed(bot.id);
      const eBase = this._enemyBaseFor(bot);
      brain = {
        id: bot.id,
        state: 'advance',
        seed,
        orbitSign: seed >= 0.5 ? 1 : -1,
        orbitFlipTimer: 5.5 + seed * 3.5,
        flipCooldown: 0,
        advanceX: ADVANCE_LANES[Math.floor(seed * ADVANCE_LANES.length) % ADVANCE_LANES.length],
        advanceZ: eBase.z,
        laneX: ADVANCE_LANES[Math.floor(seed * ADVANCE_LANES.length) % ADVANCE_LANES.length],
        targetId: null,
        target: null,
        retargetTimer: seed * 0.8,
        lastAttackerId: null,
        lastAttackedAt: -99,
        smoothedTargetVel: new THREE.Vector3(),
        lastTargetPos: new THREE.Vector3().copy(bot.position),
        alertTimer: 0,
        losLockTimer: 0,
        mgCycleTimer: seed * 2.5,
        smoothedMoveYaw: bot.hullYaw,
        stuckAccum: 0,
        unstuckTimer: 0,
        unstuckSteer: seed >= 0.5 ? 1 : -1,
        lastHp: bot.hp,
        wasAlive: bot.alive,
      };
      this.brains.set(bot.id, brain);
    }

    if (!this.intents.has(bot.id)) {
      this.intents.set(bot.id, {
        throttle: 0,
        steer: 0,
        brake: false,
        aimPoint: new THREE.Vector3(0, 0, 0),
        fireCannon: false,
        fireMG: false,
      });
    }

    return brain;
  }

  /**
   * Picks the next advance waypoint: a random point inside the enemy half
   * (between map center and the enemy base), biased away from solid obstacles.
   */
  private _pickAdvanceWaypoint(brain: BotBrain, bot: TankEntity, world: TerrainQuery): void {
    const base = this._enemyBaseFor(bot);
    const limit = Math.max(40, world.worldHalfSize - 30);
    const obstacles = world.getObstacles();

    for (let attempt = 0; attempt < 8; attempt++) {
      const t = 0.12 + Math.random() * 0.8;
      const wx = THREE.MathUtils.clamp((Math.random() * 2 - 1) * limit, -limit, limit);
      const wz = THREE.MathUtils.clamp(base.z * t, -limit, limit);

      let clear = true;
      for (let i = 0; i < obstacles.length; i++) {
        const obs = obstacles[i];
        if (obs.destroyed || obs.destructible) continue;
        const dx = wx - obs.x;
        const dz = wz - obs.z;
        const pad = obs.radius + 6;
        if (dx * dx + dz * dz < pad * pad) {
          clear = false;
          break;
        }
      }
      if (clear || attempt === 7) {
        brain.advanceX = wx;
        brain.advanceZ = wz;
        return;
      }
    }
  }

  /**
   * LOS check from bot muzzle to target center of mass. Mirrors the destructible-
   * brush rule used by gunnery: only near crates/saplings (<12m) may be shot through.
   */
  private _losClearTo(bot: TankEntity, target: TankEntity, world: TerrainQuery): boolean {
    bot.getMuzzleWorld(this._muzzlePos, this._muzzleDir);
    target.getCenterMassWorld(this._scratchPos);
    this._losDir.subVectors(this._scratchPos, this._muzzlePos);
    const losLen = this._losDir.length();
    if (losLen <= 1.0) return true;
    this._losDir.multiplyScalar(1 / losLen);
    const checkDist = Math.max(0.5, losLen - target.stats.hitRadius * 0.85);
    const hit = world.raycastWorld(this._muzzlePos, this._losDir, checkDist);
    if (hit === null) return true;
    return (
      hit.hitKind === 'obstacle' &&
      Boolean(hit.obstacle?.destructible) &&
      hit.distance < 12
    );
  }

  /**
   * Target acquisition: alive enemies within 300m, scored by distance with bonuses
   * for clear LOS (-60) and recent attacker (-80). Hysteresis keeps the current
   * target unless the new best beats it by >40, it died, or it left 320m.
   */
  private _selectTarget(
    brain: BotBrain,
    bot: TankEntity,
    allTanks: readonly TankEntity[],
    world: TerrainQuery
  ): void {
    const pool = this._candPool;
    for (let i = 0; i < pool.length; i++) {
      pool[i].t = null;
      pool[i].d = Infinity;
    }
    let count = 0;
    for (let i = 0; i < allTanks.length; i++) {
      const t = allTanks[i];
      if (!t.alive || t === bot || t.team === bot.team) continue;
      const dx = t.position.x - bot.position.x;
      const dz = t.position.z - bot.position.z;
      const dSq = dx * dx + dz * dz;
      if (dSq > MAX_ACQUIRE_RANGE_SQ || count >= pool.length) continue;
      const slot = pool[count++];
      slot.t = t;
      slot.d = Math.sqrt(dSq);
    }
    if (count === 0) {
      brain.target = null;
      brain.targetId = null;
      return;
    }

    // Insertion sort first `count` slots by distance (n <= 16)
    for (let i = 1; i < count; i++) {
      const s = pool[i];
      let j = i - 1;
      while (j >= 0 && pool[j].d > s.d) {
        pool[j + 1] = pool[j];
        j--;
      }
      pool[j + 1] = s;
    }

    const checkN = Math.min(3, count);
    let best: TankEntity | null = null;
    let bestScore = Infinity;
    let curScore = Infinity;
    const cur = brain.target;

    for (let i = 0; i < checkN; i++) {
      const cand = pool[i].t!;
      const dist = pool[i].d;
      let score = dist;
      if (this._losClearTo(bot, cand, world)) score -= 60;
      if (cand.id === brain.lastAttackerId && this.clock - brain.lastAttackedAt < 8) {
        score -= 80;
      }
      if (cand === cur) curScore = score;
      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    }

    // Current target may sit outside the top-3 (or in the 300-320m retention band):
    // score it too so hysteresis compares like-for-like.
    if (cur && cur.alive && cur.team !== bot.team && curScore === Infinity) {
      const cdx = cur.position.x - bot.position.x;
      const cdz = cur.position.z - bot.position.z;
      const cDistSq = cdx * cdx + cdz * cdz;
      if (cDistSq <= TARGET_DROP_RANGE * TARGET_DROP_RANGE) {
        let score = Math.sqrt(cDistSq);
        if (this._losClearTo(bot, cur, world)) score -= 60;
        if (cur.id === brain.lastAttackerId && this.clock - brain.lastAttackedAt < 8) {
          score -= 80;
        }
        curScore = score;
        if (score < bestScore) {
          bestScore = score;
          best = cur;
        }
      }
    }

    let chosen: TankEntity | null;
    if (
      cur &&
      cur.alive &&
      cur.team !== bot.team &&
      curScore !== Infinity &&
      !(best !== null && best !== cur && bestScore + 40 < curScore)
    ) {
      chosen = cur;
    } else {
      chosen = best;
    }

    if (chosen !== brain.target) {
      brain.target = chosen;
      brain.targetId = chosen ? chosen.id : null;
      if (chosen) {
        brain.smoothedTargetVel.copy(chosen.velocity);
        brain.lastTargetPos.copy(chosen.position);
      }
    }
  }

  /**
   * 16-ray Context Steering solver: blends desired tactical heading with obstacle repulsion,
   * inter-tank separation (14m), and battlefield boundary avoidance.
   */
  private _computeContextSteeredYaw(
    brain: BotBrain,
    bot: TankEntity,
    desiredYaw: number,
    allTanks: readonly TankEntity[],
    world: TerrainQuery
  ): { yaw: number; blockedScore: number } {
    const ex = bot.position.x;
    const ez = bot.position.z;
    const myR = bot.stats.collisionRadius;

    const desSin = Math.sin(desiredYaw);
    const desCos = Math.cos(desiredYaw);
    const prevSin = Math.sin(brain.smoothedMoveYaw);
    const prevCos = Math.cos(brain.smoothedMoveYaw);

    for (let k = 0; k < NUM_STEER_RAYS; k++) {
      const rSin = RAY_SIN[k];
      const rCos = RAY_COS[k];
      const alignDesired = rSin * desSin + rCos * desCos; // -1..+1
      const alignPrev = rSin * prevSin + rCos * prevCos;
      // Favor desired heading while giving slight persistence bonus to prevent left/right chatter
      const baseInterest = Math.max(0.04, 0.52 + 0.48 * alignDesired);
      this._interest[k] = baseInterest + 0.12 * Math.max(0, alignPrev);
      this._danger[k] = 0;
    }

    // 1. Obstacles from World
    const obstacles = world.getObstacles();
    const obsLookahead = 19.5;
    for (let i = 0; i < obstacles.length; i++) {
      const obs = obstacles[i];
      if (obs.destroyed) continue;

      const weight = obs.destructible ? 0.16 : 1.0;
      const look = obs.destructible ? 7.0 : obsLookahead;
      const clearance = obs.radius + myR + (obs.destructible ? 1.2 : 2.8);

      const ox = obs.x - ex;
      const oz = obs.z - ez;
      const distSq = ox * ox + oz * oz;
      const maxCheck = look + clearance;
      if (distSq >= maxCheck * maxCheck || distSq < 1e-5) continue;

      const dist = Math.sqrt(distSq);
      const invDist = 1 / dist;
      const dirX = ox * invDist;
      const dirZ = oz * invDist;

      const gap = Math.max(0.01, dist - clearance);
      const proximity = Math.max(0, 1 - gap / look);
      const strength = proximity * proximity * weight;

      // Angular half-width subtended by obstacle + clearance
      const sinCone = Math.min(0.96, clearance * invDist);
      const cosThreshold = Math.sqrt(Math.max(0, 1 - sinCone * sinCone)) * 0.92;

      for (let k = 0; k < NUM_STEER_RAYS; k++) {
        const dot = RAY_SIN[k] * dirX + RAY_COS[k] * dirZ;
        if (dot > cosThreshold) {
          const coneFactor = (dot - cosThreshold) / Math.max(0.04, 1 - cosThreshold);
          const d = strength * (0.45 + 0.55 * coneFactor);
          if (d > this._danger[k]) {
            this._danger[k] = d;
          }
        }
      }
    }

    // 2. Tank-to-Tank Separation (within 14m against all other tanks)
    const sepRange = 14.0;
    const checkTankDanger = (other: TankEntity) => {
      if (other === bot) return;
      const ox = other.position.x - ex;
      const oz = other.position.z - ez;
      const clearance = myR + other.stats.collisionRadius + 2.4;
      const maxD = sepRange + clearance * 0.5;
      const distSq = ox * ox + oz * oz;
      if (distSq >= maxD * maxD || distSq < 1e-5) return;

      const dist = Math.sqrt(distSq);
      const invDist = 1 / dist;
      const dirX = ox * invDist;
      const dirZ = oz * invDist;
      const prox = Math.max(0, 1 - Math.max(0, dist - clearance) / sepRange);
      const strength = prox * prox * 0.95;

      for (let k = 0; k < NUM_STEER_RAYS; k++) {
        const dot = RAY_SIN[k] * dirX + RAY_COS[k] * dirZ;
        if (dot > 0.35) {
          const d = strength * ((dot - 0.35) / 0.65);
          if (d > this._danger[k]) {
            this._danger[k] = d;
          }
        }
      }
    };

    for (let i = 0; i < allTanks.length; i++) {
      checkTankDanger(allTanks[i]);
    }

    // 3. Battlefield Boundary Avoidance (`worldHalfSize - 22`)
    const softBorder = world.worldHalfSize - 22;
    const warnStart = softBorder - 14;
    if (Math.abs(ex) > warnStart) {
      const outSignX = Math.sign(ex);
      const pen = THREE.MathUtils.clamp((Math.abs(ex) - warnStart) / 16, 0, 1);
      for (let k = 0; k < NUM_STEER_RAYS; k++) {
        const outward = RAY_SIN[k] * outSignX;
        if (outward > 0) {
          this._danger[k] = Math.max(this._danger[k], pen * outward * 1.15);
        }
      }
    }
    if (Math.abs(ez) > warnStart) {
      const outSignZ = Math.sign(ez);
      const pen = THREE.MathUtils.clamp((Math.abs(ez) - warnStart) / 16, 0, 1);
      for (let k = 0; k < NUM_STEER_RAYS; k++) {
        const outward = RAY_COS[k] * outSignZ;
        if (outward > 0) {
          this._danger[k] = Math.max(this._danger[k], pen * outward * 1.15);
        }
      }
    }

    // Measure how blocked the raw desired direction is, and blend safe high-interest rays
    let desiredBlocked = 0;
    let sumX = 0;
    let sumZ = 0;
    let bestScore = -1;
    let bestIdx = 0;

    for (let k = 0; k < NUM_STEER_RAYS; k++) {
      const dotDes = RAY_SIN[k] * desSin + RAY_COS[k] * desCos;
      if (dotDes > 0.85 && this._danger[k] > desiredBlocked) {
        desiredBlocked = this._danger[k];
      }
      const safety = Math.max(0.02, 1 - Math.min(1, this._danger[k]));
      const score = this._interest[k] * safety * safety;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = k;
      }
    }

    // Smooth circular blend around winning neighborhood so heading never snaps across discrete 22.5 deg bins
    for (let offset = -2; offset <= 2; offset++) {
      const k = (bestIdx + offset + NUM_STEER_RAYS) % NUM_STEER_RAYS;
      const safety = Math.max(0.02, 1 - Math.min(1, this._danger[k]));
      const w = Math.pow(this._interest[k] * safety, 2);
      sumX += RAY_SIN[k] * w;
      sumZ += RAY_COS[k] * w;
    }

    const chosenYaw =
      sumX * sumX + sumZ * sumZ > 1e-6 ? Math.atan2(sumX, sumZ) : RAY_ANGLES[bestIdx];

    return { yaw: chosenYaw, blockedScore: desiredBlocked };
  }

  public update(
    dt: number,
    bots: readonly TankEntity[],
    allTanks: readonly TankEntity[],
    world: TerrainQuery
  ): Map<string, TankIntent> {
    const safeDt = Math.min(Math.max(dt, 0.0001), 0.08);
    this.clock += safeDt;

    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      const brain = this._getOrCreateBrain(bot);
      const intent = this.intents.get(bot.id)!;

      // Detect respawn
      if ((!brain.wasAlive && bot.alive) || bot.hp > brain.lastHp + 1) {
        brain.state = 'advance';
        brain.alertTimer = 0;
        brain.losLockTimer = 0;
        brain.stuckAccum = 0;
        brain.unstuckTimer = 0;
        brain.smoothedMoveYaw = bot.hullYaw;
        brain.target = null;
        brain.targetId = null;
        this._pickAdvanceWaypoint(brain, bot, world);
      }

      if (!bot.alive) {
        brain.wasAlive = false;
        brain.lastHp = 0;
        brain.state = 'advance';
        brain.target = null;
        brain.targetId = null;
        intent.throttle = 0;
        intent.steer = 0;
        intent.brake = true;
        intent.fireCannon = false;
        intent.fireMG = false;
        continue;
      }

      // Detect incoming fire via HP drop
      if (bot.hp < brain.lastHp - 0.01) {
        brain.alertTimer = 16.0;
      }
      brain.lastHp = bot.hp;
      brain.wasAlive = true;

      // Drop stale targets (died, same team, or beyond retention range)
      let target = brain.target;
      if (target) {
        const tdx = target.position.x - bot.position.x;
        const tdz = target.position.z - bot.position.z;
        if (
          !target.alive ||
          target.team === bot.team ||
          tdx * tdx + tdz * tdz > TARGET_DROP_RANGE * TARGET_DROP_RANGE
        ) {
          brain.target = null;
          brain.targetId = null;
          target = null;
        }
      }

      // Periodic target re-evaluation (0.5-0.8s per-bot jitter)
      brain.retargetTimer -= safeDt;
      if (brain.retargetTimer <= 0) {
        brain.retargetTimer = 0.5 + Math.random() * 0.3;
        this._selectTarget(brain, bot, allTanks, world);
        target = brain.target;
      }

      // Per-brain target velocity smoothing for predictive ballistic lead
      // (reset inside _selectTarget on target change or >20m teleport)
      if (target) {
        if (brain.lastTargetPos.distanceToSquared(target.position) > 400) {
          brain.smoothedTargetVel.copy(target.velocity);
        } else {
          brain.smoothedTargetVel.lerp(target.velocity, 1 - Math.exp(-6.5 * safeDt));
        }
        brain.lastTargetPos.copy(target.position);
      }

      const engaging = target !== null;

      let distToTarget = 0;
      let yawToTarget = 0;
      if (engaging && target) {
        const tdx = target.position.x - bot.position.x;
        const tdz = target.position.z - bot.position.z;
        distToTarget = Math.sqrt(tdx * tdx + tdz * tdz);
        yawToTarget = Math.atan2(tdx, tdz);
      }

      brain.alertTimer = Math.max(0, brain.alertTimer - safeDt);

      // State Machine Transitions
      if (!engaging) {
        brain.state = 'advance';
      } else if (brain.state === 'evade_reverse') {
        // Hysteresis up to 45m so tank doesn't chatter right at 38m
        if (distToTarget > 155) brain.state = 'engage_approach';
        else if (distToTarget > 45) brain.state = 'strafe_orbit';
      } else {
        if (distToTarget < 38) brain.state = 'evade_reverse';
        else if (distToTarget > 155) brain.state = 'engage_approach';
        else brain.state = 'strafe_orbit';
      }

      // Orbit direction cadence (5..9s)
      brain.flipCooldown = Math.max(0, brain.flipCooldown - safeDt);
      brain.orbitFlipTimer -= safeDt;
      if (brain.orbitFlipTimer <= 0) {
        brain.orbitSign = brain.orbitSign === 1 ? -1 : 1;
        brain.orbitFlipTimer = 5.0 + Math.random() * 4.0;
      }

      // ---------------------------------------------------------------------
      // Desired Tactical Heading & Throttle
      // ---------------------------------------------------------------------
      let rawDesiredYaw = bot.hullYaw;
      let desiredThrottle = 0.7;
      let wantsReverseMove = false;

      if (brain.state === 'advance') {
        // Drive ~0.6 throttle toward the enemy-half waypoint along this bot's lane
        const adx = brain.advanceX - bot.position.x;
        const adz = brain.advanceZ - bot.position.z;
        if (adx * adx + adz * adz < 40 * 40) {
          this._pickAdvanceWaypoint(brain, bot, world);
        }
        rawDesiredYaw = Math.atan2(
          brain.advanceX - bot.position.x,
          brain.advanceZ - bot.position.z
        );
        desiredThrottle = 0.6;
      } else if (brain.state === 'engage_approach') {
        // Close distance along a ~35 deg diagonal weave (never drive straight down target's barrel!)
        const weaveRad = 0.61 + 0.08 * Math.sin(this.clock * 0.75 + brain.seed * 6.28);
        rawDesiredYaw = wrapAnglePi(yawToTarget + brain.orbitSign * weaveRad);
        desiredThrottle = 0.56 + 0.12 * (0.5 + 0.5 * Math.sin(this.clock * 1.1 + brain.seed * 10));
      } else if (brain.state === 'strafe_orbit') {
        // 45m..155m combat band: 65-85 deg tangent orbit with class-tuned range control
        const idealDist = idealOrbitDistForClass(bot.stats.vehicleClass);
        let tangentDeg = 76;
        if (distToTarget > idealDist + 18) {
          tangentDeg = 66; // Spiral gently inward
        } else if (distToTarget < idealDist - 18) {
          tangentDeg = 92; // Spiral gently outward
        }
        const tangentRad = THREE.MathUtils.degToRad(tangentDeg);
        rawDesiredYaw = wrapAnglePi(yawToTarget + brain.orbitSign * tangentRad);
        const wave = 0.5 + 0.5 * Math.sin(this.clock * 0.92 + brain.seed * Math.PI * 2);
        desiredThrottle = 0.42 + 0.26 * wave;
      } else {
        // 'evade_reverse' (< 38m): back off if facing target, or circle hard away if already angled
        const hullToTarget = Math.abs(wrapAnglePi(yawToTarget - bot.hullYaw));
        if (hullToTarget < 1.15) {
          wantsReverseMove = true;
          rawDesiredYaw = wrapAnglePi(yawToTarget + brain.orbitSign * 0.45);
          desiredThrottle = -0.65;
        } else {
          rawDesiredYaw = wrapAnglePi(yawToTarget + brain.orbitSign * 2.18);
          desiredThrottle = 0.65;
        }
      }

      // ---------------------------------------------------------------------
      // Context-Steering Obstacle / Tank / Border Avoidance + Anti-Stuck
      // ---------------------------------------------------------------------
      if (brain.unstuckTimer > 0) {
        brain.unstuckTimer -= safeDt;
        intent.throttle = -0.88;
        intent.steer = brain.unstuckSteer;
        intent.brake = false;
      } else {
        const probeYaw = wantsReverseMove ? wrapAnglePi(rawDesiredYaw + Math.PI) : rawDesiredYaw;
        const { yaw: safeMoveYaw, blockedScore } = this._computeContextSteeredYaw(
          brain,
          bot,
          probeYaw,
          allTanks,
          world
        );

        if (blockedScore > 0.72 && brain.flipCooldown <= 0) {
          brain.orbitSign = brain.orbitSign === 1 ? -1 : 1;
          brain.flipCooldown = 1.65;
          brain.orbitFlipTimer = 5.5 + Math.random() * 3.5;
        }

        const targetHullYaw = wantsReverseMove ? wrapAnglePi(safeMoveYaw + Math.PI) : safeMoveYaw;
        brain.smoothedMoveYaw = lerpAngle(
          brain.smoothedMoveYaw,
          targetHullYaw,
          1 - Math.exp(-8.5 * safeDt)
        );

        const yawErr = wrapAnglePi(brain.smoothedMoveYaw - bot.hullYaw);
        // Match Tank.ts reverse steering flip (`this.speed < -0.6 ? -1 : 1`)
        const reverseSteerSign = bot.speed < -0.6 ? -1 : 1;
        intent.steer = THREE.MathUtils.clamp(yawErr / 0.42, -1, 1) * reverseSteerSign;
        intent.brake = false;

        if (!wantsReverseMove && Math.abs(yawErr) > 1.35) {
          // Sharp heading change: slow forward throttle to pivot tracks tightly instead of wide-turning into walls
          intent.throttle = 0.24;
        } else {
          intent.throttle = desiredThrottle;
        }

        // Anti-stuck detector: if commanding drive for > 1.8s with speed < 0.6 m/s, execute reverse recovery
        if (Math.abs(intent.throttle) > 0.35 && Math.abs(bot.speed) < 0.6) {
          brain.stuckAccum += safeDt;
          if (brain.stuckAccum > 1.8) {
            brain.stuckAccum = 0;
            brain.unstuckTimer = 1.35;
            brain.orbitSign = brain.orbitSign === 1 ? -1 : 1;
            brain.unstuckSteer = brain.orbitSign;
          }
        } else {
          brain.stuckAccum = Math.max(0, brain.stuckAccum - safeDt * 1.4);
        }
      }

      // ---------------------------------------------------------------------
      // Predictive Ballistic Gunnery, Aim Wander & Trigger Discipline
      // ---------------------------------------------------------------------
      if (!target) {
        // Advance/patrol turret scan along forward arc
        const scanYaw =
          bot.hullYaw + Math.sin(this.clock * 0.65 + brain.seed * 6.28) * 0.42;
        intent.aimPoint.set(
          bot.position.x + Math.sin(scanYaw) * 60,
          bot.position.y + 1.5,
          bot.position.z + Math.cos(scanYaw) * 60
        );
        intent.fireCannon = false;
        intent.fireMG = false;
        brain.losLockTimer = 0;
        continue;
      }

      bot.getMuzzleWorld(this._muzzlePos, this._muzzleDir);
      target.getCenterMassWorld(this._targetCenter);

      // Iterative lead + gravity drop solver
      solveBallisticAim(
        this._muzzlePos,
        this._targetCenter,
        brain.smoothedTargetVel,
        bot.stats.shellMuzzleSpeed,
        GRAVITY,
        this._aimPoint
      );

      // Add smooth humanized angular aim wander
      const baseWanderRad = aimWanderRadians(bot.stats.vehicleClass);
      const movePenaltyRad =
        0.008 * Math.min(1, Math.abs(bot.speed) / Math.max(1, bot.stats.maxForwardSpeed));
      const totalWanderRad = baseWanderRad + movePenaltyRad;

      const phase = brain.seed * 31.7;
      const noiseAz =
        Math.sin(this.clock * 1.18 + phase) * 0.65 +
        Math.cos(this.clock * 2.11 + phase * 1.7) * 0.35;
      const noiseEl =
        Math.cos(this.clock * 0.94 + phase * 1.3) * 0.6 +
        Math.sin(this.clock * 1.87 + phase * 2.1) * 0.4;

      // Right tangent perpendicular to target bearing: (-cos(yawToTarget), 0, sin(yawToTarget))
      this._wanderRight.set(-Math.cos(yawToTarget), 0, Math.sin(yawToTarget));
      const lateralSpread = distToTarget * totalWanderRad * noiseAz;
      const verticalSpread = distToTarget * totalWanderRad * 0.55 * noiseEl;

      this._aimPoint.addScaledVector(this._wanderRight, lateralSpread);
      this._aimPoint.y += verticalSpread;
      intent.aimPoint.copy(this._aimPoint);

      // Line-of-Sight check from muzzle to target center of mass
      this._losDir.subVectors(this._targetCenter, this._muzzlePos);
      const losLen = this._losDir.length();
      let losClear = true;
      if (losLen > 1.0) {
        this._losDir.multiplyScalar(1 / losLen);
        const checkDist = Math.max(0.5, losLen - target.stats.hitRadius * 0.85);
        const losHit = world.raycastWorld(this._muzzlePos, this._losDir, checkDist);
        if (losHit !== null) {
          // Only allow shooting through a nearby destructible crate/sapling (< 12m), never solid cover/ridges
          const shootableBrush =
            losHit.hitKind === 'obstacle' &&
            Boolean(losHit.obstacle?.destructible) &&
            losHit.distance < 12;
          if (!shootableBrush) {
            losClear = false;
          }
        }
      }

      if (losClear) {
        brain.losLockTimer = Math.min(3.0, brain.losLockTimer + safeDt);
      } else {
        brain.losLockTimer = Math.max(0, brain.losLockTimer - safeDt * 2.5);
      }

      // Compute bore alignment angle between actual gun barrel direction and predicted aimPoint
      this._desiredBore.subVectors(this._aimPoint, this._muzzlePos).normalize();
      const boreDot = THREE.MathUtils.clamp(this._muzzleDir.dot(this._desiredBore), -1, 1);
      const boreAngle = Math.acos(boreDot);

      // Periodic AI shell type variation (switches between AP & HE occasionally)
      intent.selectShell = Math.sin(this.clock * 0.08 + brain.seed * 10) > 0.45 ? 1 : 0;

      // Forgiving bot fire: requires 2.2s continuous LOS lock, range < 190m
      intent.fireCannon =
        bot.stats.hasMainCannon &&
        losClear &&
        brain.losLockTimer >= 2.2 &&
        distToTarget < 190 &&
        boreAngle <= 0.16;

      // Occasional short coaxial MG / IFV autocannon tracer bursts
      const mgPeriod = bot.stats.vehicleClass === 'ifv' ? 4.8 : 6.5;
      const mgBurstLen = bot.stats.vehicleClass === 'ifv' ? 0.65 : 0.42;
      brain.mgCycleTimer = (brain.mgCycleTimer + safeDt) % mgPeriod;
      intent.fireMG =
        bot.stats.hasCoaxMG &&
        !bot.mgOverheated &&
        losClear &&
        brain.losLockTimer >= 1.6 &&
        distToTarget < 135 &&
        boreAngle <= 0.22 &&
        brain.mgCycleTimer < mgBurstLen;
    }

    return this.intents;
  }
}
