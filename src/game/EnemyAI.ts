import * as THREE from 'three';
import { GRAVITY, solveBallisticAim } from './Ballistics';
import type { TankEntity, TankIntent, TankVariant, TerrainQuery } from './types';

export type EnemyAIState = 'roam' | 'engage_approach' | 'strafe_orbit' | 'evade_reverse';

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

function wanderRadiansForVariant(_variant: TankVariant): number {
  return THREE.MathUtils.degToRad(6.8);
}

function idealOrbitDistForVariant(variant: TankVariant): number {
  if (variant.endsWith('_heavy')) return 112;
  if (variant.endsWith('_ifv')) return 78;
  return 96;
}

interface EnemyBrain {
  id: string;
  state: EnemyAIState;
  seed: number;
  orbitSign: 1 | -1;
  orbitFlipTimer: number;
  flipCooldown: number;

  roamTargetX: number;
  roamTargetZ: number;
  roamTimer: number;

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

export class EnemyAIManager {
  private readonly brains = new Map<string, EnemyBrain>();
  private readonly intents = new Map<string, TankIntent>();

  private clock = 0;
  private readonly smoothedPlayerVel = new THREE.Vector3();
  private readonly lastPlayerPos = new THREE.Vector3();
  private playerVelInitialized = false;

  // Scratch arrays & vectors (zero per-frame heap allocations)
  private readonly _interest = new Float32Array(NUM_STEER_RAYS);
  private readonly _danger = new Float32Array(NUM_STEER_RAYS);
  private readonly _muzzlePos = new THREE.Vector3();
  private readonly _muzzleDir = new THREE.Vector3();
  private readonly _playerCenter = new THREE.Vector3();
  private readonly _aimPoint = new THREE.Vector3();
  private readonly _losDir = new THREE.Vector3();
  private readonly _desiredBore = new THREE.Vector3();
  private readonly _wanderRight = new THREE.Vector3();

  /**
   * Returns true if the specified enemy is currently alerted/engaging the player
   * (useful for HUD / minimap `alerted` telemetry).
   */
  public isAlerted(enemyId: string): boolean {
    const brain = this.brains.get(enemyId);
    return Boolean(brain && brain.wasAlive && brain.state !== 'roam');
  }

  public getState(enemyId: string): EnemyAIState {
    return this.brains.get(enemyId)?.state ?? 'roam';
  }

  /**
   * Optional explicit alert hook when damaged by the player (damage is also
   * detected automatically via HP delta inside `update`).
   */
  public notifyDamaged(enemyId: string): void {
    const brain = this.brains.get(enemyId);
    if (brain) {
      brain.alertTimer = 16.0;
    }
  }

  public reset(): void {
    this.brains.clear();
    this.intents.clear();
    this.playerVelInitialized = false;
  }

  private _getOrCreateBrain(enemy: TankEntity, world: TerrainQuery): EnemyBrain {
    let brain = this.brains.get(enemy.id);
    if (!brain) {
      const seed = hashIdToSeed(enemy.id);
      brain = {
        id: enemy.id,
        state: 'roam',
        seed,
        orbitSign: seed >= 0.5 ? 1 : -1,
        orbitFlipTimer: 5.5 + seed * 3.5,
        flipCooldown: 0,
        roamTargetX: enemy.position.x,
        roamTargetZ: enemy.position.z,
        roamTimer: 0,
        alertTimer: 0,
        losLockTimer: 0,
        mgCycleTimer: seed * 2.5,
        smoothedMoveYaw: enemy.hullYaw,
        stuckAccum: 0,
        unstuckTimer: 0,
        unstuckSteer: seed >= 0.5 ? 1 : -1,
        lastHp: enemy.hp,
        wasAlive: enemy.alive,
      };
      this._pickRoamWaypoint(brain, enemy, world);
      this.brains.set(enemy.id, brain);
    }

    if (!this.intents.has(enemy.id)) {
      this.intents.set(enemy.id, {
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

  private _pickRoamWaypoint(brain: EnemyBrain, enemy: TankEntity, world: TerrainQuery): void {
    const limit = Math.max(40, world.worldHalfSize - 38);
    const obstacles = world.getObstacles();

    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 55 + Math.random() * 75;
      const wx = THREE.MathUtils.clamp(enemy.position.x + Math.sin(angle) * dist, -limit, limit);
      const wz = THREE.MathUtils.clamp(enemy.position.z + Math.cos(angle) * dist, -limit, limit);

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
        brain.roamTargetX = wx;
        brain.roamTargetZ = wz;
        brain.roamTimer = 11 + Math.random() * 5;
        return;
      }
    }
  }

  /**
   * 16-ray Context Steering solver: blends desired tactical heading with obstacle repulsion,
   * inter-tank separation (14m), and battlefield boundary avoidance.
   */
  private _computeContextSteeredYaw(
    brain: EnemyBrain,
    enemy: TankEntity,
    desiredYaw: number,
    enemies: readonly TankEntity[],
    player: TankEntity,
    world: TerrainQuery
  ): { yaw: number; blockedScore: number } {
    const ex = enemy.position.x;
    const ez = enemy.position.z;
    const myR = enemy.stats.collisionRadius;

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

    // 2. Tank-to-Tank Separation (within 14m against other enemies + player)
    const sepRange = 14.0;
    const checkTankDanger = (other: TankEntity) => {
      if (other === enemy) return;
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

    for (let i = 0; i < enemies.length; i++) {
      checkTankDanger(enemies[i]);
    }
    checkTankDanger(player);

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
    enemies: readonly TankEntity[],
    player: TankEntity,
    world: TerrainQuery
  ): Map<string, TankIntent> {
    const safeDt = Math.min(Math.max(dt, 0.0001), 0.08);
    this.clock += safeDt;

    // Smooth player velocity for realistic predictive lead (reset on respawn teleport)
    if (!this.playerVelInitialized || this.lastPlayerPos.distanceToSquared(player.position) > 400) {
      this.playerVelInitialized = true;
      this.smoothedPlayerVel.copy(player.velocity);
      this.lastPlayerPos.copy(player.position);
    } else {
      const vAlpha = 1 - Math.exp(-6.5 * safeDt);
      this.smoothedPlayerVel.lerp(player.velocity, vAlpha);
      this.lastPlayerPos.copy(player.position);
    }

    player.getCenterMassWorld(this._playerCenter);

    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      const brain = this._getOrCreateBrain(enemy, world);
      const intent = this.intents.get(enemy.id)!;

      // Detect respawn
      if ((!brain.wasAlive && enemy.alive) || enemy.hp > brain.lastHp + 1) {
        brain.state = 'roam';
        brain.alertTimer = 0;
        brain.losLockTimer = 0;
        brain.stuckAccum = 0;
        brain.unstuckTimer = 0;
        brain.smoothedMoveYaw = enemy.hullYaw;
        this._pickRoamWaypoint(brain, enemy, world);
      }

      if (!enemy.alive) {
        brain.wasAlive = false;
        brain.lastHp = 0;
        brain.state = 'roam';
        intent.throttle = 0;
        intent.steer = 0;
        intent.brake = true;
        intent.fireCannon = false;
        intent.fireMG = false;
        continue;
      }

      // Detect player hit immediately via HP drop
      if (enemy.hp < brain.lastHp - 0.01 && player.alive) {
        brain.alertTimer = 16.0;
      }
      brain.lastHp = enemy.hp;
      brain.wasAlive = true;

      const dxToPlayer = player.position.x - enemy.position.x;
      const dzToPlayer = player.position.z - enemy.position.z;
      const distToPlayer = Math.sqrt(dxToPlayer * dxToPlayer + dzToPlayer * dzToPlayer);
      const yawToPlayer = Math.atan2(dxToPlayer, dzToPlayer);

      // Alert acquisition within 175m (keeps southern player staging spawn peaceful)
      if (player.alive && distToPlayer <= 175) {
        brain.alertTimer = Math.max(brain.alertTimer, 8.5);
      } else {
        brain.alertTimer = Math.max(0, brain.alertTimer - safeDt);
      }

      const engaging = player.alive && brain.alertTimer > 0;

      // State Machine Transitions
      if (!engaging) {
        brain.state = 'roam';
      } else if (brain.state === 'evade_reverse') {
        // Hysteresis up to 45m so tank doesn't chatter right at 38m
        if (distToPlayer > 155) brain.state = 'engage_approach';
        else if (distToPlayer > 45) brain.state = 'strafe_orbit';
      } else {
        if (distToPlayer < 38) brain.state = 'evade_reverse';
        else if (distToPlayer > 155) brain.state = 'engage_approach';
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
      let rawDesiredYaw = enemy.hullYaw;
      let desiredThrottle = 0.7;
      let wantsReverseMove = false;

      if (brain.state === 'roam') {
        brain.roamTimer -= safeDt;
        const rdx = brain.roamTargetX - enemy.position.x;
        const rdz = brain.roamTargetZ - enemy.position.z;
        if (rdx * rdx + rdz * rdz < 16 * 16 || brain.roamTimer <= 0) {
          this._pickRoamWaypoint(brain, enemy, world);
        }
        rawDesiredYaw = Math.atan2(
          brain.roamTargetX - enemy.position.x,
          brain.roamTargetZ - enemy.position.z
        );
        desiredThrottle = 0.48;
      } else if (brain.state === 'engage_approach') {
        // Close distance along a ~35 deg diagonal weave (never drive straight down player's barrel!)
        const weaveRad = 0.61 + 0.08 * Math.sin(this.clock * 0.75 + brain.seed * 6.28);
        rawDesiredYaw = wrapAnglePi(yawToPlayer + brain.orbitSign * weaveRad);
        desiredThrottle = 0.56 + 0.12 * (0.5 + 0.5 * Math.sin(this.clock * 1.1 + brain.seed * 10));
      } else if (brain.state === 'strafe_orbit') {
        // 45m..155m combat band: 65-85 deg tangent orbit with variant-tuned range control
        const idealDist = idealOrbitDistForVariant(enemy.variant);
        let tangentDeg = 76;
        if (distToPlayer > idealDist + 18) {
          tangentDeg = 66; // Spiral gently inward
        } else if (distToPlayer < idealDist - 18) {
          tangentDeg = 92; // Spiral gently outward
        }
        const tangentRad = THREE.MathUtils.degToRad(tangentDeg);
        rawDesiredYaw = wrapAnglePi(yawToPlayer + brain.orbitSign * tangentRad);
        const wave = 0.5 + 0.5 * Math.sin(this.clock * 0.92 + brain.seed * Math.PI * 2);
        desiredThrottle = 0.42 + 0.26 * wave;
      } else {
        // 'evade_reverse' (< 38m): back off if facing player, or circle hard away if already angled
        const hullToPlayer = Math.abs(wrapAnglePi(yawToPlayer - enemy.hullYaw));
        if (hullToPlayer < 1.15) {
          wantsReverseMove = true;
          rawDesiredYaw = wrapAnglePi(yawToPlayer + brain.orbitSign * 0.45);
          desiredThrottle = -0.65;
        } else {
          rawDesiredYaw = wrapAnglePi(yawToPlayer + brain.orbitSign * 2.18);
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
          enemy,
          probeYaw,
          enemies,
          player,
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

        const yawErr = wrapAnglePi(brain.smoothedMoveYaw - enemy.hullYaw);
        // Match Tank.ts reverse steering flip (`this.speed < -0.6 ? -1 : 1`)
        const reverseSteerSign = enemy.speed < -0.6 ? -1 : 1;
        intent.steer = THREE.MathUtils.clamp(yawErr / 0.42, -1, 1) * reverseSteerSign;
        intent.brake = false;

        if (!wantsReverseMove && Math.abs(yawErr) > 1.35) {
          // Sharp heading change: slow forward throttle to pivot tracks tightly instead of wide-turning into walls
          intent.throttle = 0.24;
        } else {
          intent.throttle = desiredThrottle;
        }

        // Anti-stuck detector: if commanding drive for > 1.8s with speed < 0.6 m/s, execute reverse recovery
        if (Math.abs(intent.throttle) > 0.35 && Math.abs(enemy.speed) < 0.6) {
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
      if (!engaging) {
        // Patrol turret scan along forward arc
        const scanYaw =
          enemy.hullYaw + Math.sin(this.clock * 0.65 + brain.seed * 6.28) * 0.42;
        intent.aimPoint.set(
          enemy.position.x + Math.sin(scanYaw) * 60,
          enemy.position.y + 1.5,
          enemy.position.z + Math.cos(scanYaw) * 60
        );
        intent.fireCannon = false;
        intent.fireMG = false;
        brain.losLockTimer = 0;
        continue;
      }

      enemy.getMuzzleWorld(this._muzzlePos, this._muzzleDir);

      // Iterative lead + gravity drop solver
      solveBallisticAim(
        this._muzzlePos,
        this._playerCenter,
        this.smoothedPlayerVel,
        enemy.stats.shellMuzzleSpeed,
        GRAVITY,
        this._aimPoint
      );

      // Add smooth humanized angular aim wander (~1.3 deg - 2.35 deg depending on variant)
      const baseWanderRad = wanderRadiansForVariant(enemy.variant);
      const movePenaltyRad =
        0.008 * Math.min(1, Math.abs(enemy.speed) / Math.max(1, enemy.stats.maxForwardSpeed));
      const totalWanderRad = baseWanderRad + movePenaltyRad;

      const phase = brain.seed * 31.7;
      const noiseAz =
        Math.sin(this.clock * 1.18 + phase) * 0.65 +
        Math.cos(this.clock * 2.11 + phase * 1.7) * 0.35;
      const noiseEl =
        Math.cos(this.clock * 0.94 + phase * 1.3) * 0.6 +
        Math.sin(this.clock * 1.87 + phase * 2.1) * 0.4;

      // Right tangent perpendicular to player bearing: (-cos(yawToPlayer), 0, sin(yawToPlayer))
      this._wanderRight.set(-Math.cos(yawToPlayer), 0, Math.sin(yawToPlayer));
      const lateralSpread = distToPlayer * totalWanderRad * noiseAz;
      const verticalSpread = distToPlayer * totalWanderRad * 0.55 * noiseEl;

      this._aimPoint.addScaledVector(this._wanderRight, lateralSpread);
      this._aimPoint.y += verticalSpread;
      intent.aimPoint.copy(this._aimPoint);

      // Line-of-Sight check from muzzle to player center of mass
      this._losDir.subVectors(this._playerCenter, this._muzzlePos);
      const losLen = this._losDir.length();
      let losClear = true;
      if (losLen > 1.0) {
        this._losDir.multiplyScalar(1 / losLen);
        const checkDist = Math.max(0.5, losLen - player.stats.hitRadius * 0.85);
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

      // Periodic AI shell type variation on enemy tanks (switches between AP & HE occasionally)
      intent.selectShell = Math.sin(this.clock * 0.08 + brain.seed * 10) > 0.45 ? 1 : 0;

      // Slow, forgiving enemy fire: requires 2.2s continuous LOS lock, range < 190m
      intent.fireCannon =
        enemy.stats.hasMainCannon &&
        losClear &&
        brain.losLockTimer >= 2.2 &&
        distToPlayer < 190 &&
        boreAngle <= 0.16;

      // Occasional short coaxial MG / IFV autocannon tracer bursts
      const mgPeriod = enemy.stats.vehicleClass === 'ifv' ? 4.8 : 6.5;
      const mgBurstLen = enemy.stats.vehicleClass === 'ifv' ? 0.65 : 0.42;
      brain.mgCycleTimer = (brain.mgCycleTimer + safeDt) % mgPeriod;
      intent.fireMG =
        enemy.stats.hasCoaxMG &&
        !enemy.mgOverheated &&
        losClear &&
        brain.losLockTimer >= 1.6 &&
        distToPlayer < 135 &&
        boreAngle <= 0.22 &&
        brain.mgCycleTimer < mgBurstLen;
    }

    return this.intents;
  }
}
