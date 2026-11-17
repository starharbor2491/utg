import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { DamageEvent, ShellSpec, TankEntity, TerrainQuery } from './types';
import type { EffectsManager } from './Effects';

export const GRAVITY = 9.81;

/**
 * Shared projectile integrator used by live shell flight AND the HUD's
 * predicted-impact march, so the reticle matches real rocket ballistics.
 * Applies gravity, then (while `age < rocket.burnTime`) thrust acceleration
 * along the current velocity direction, then advances position.
 */
export function stepProjectile(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  spec: ShellSpec | undefined,
  age: number,
  dt: number
): void {
  vel.y -= GRAVITY * dt;
  const rocket = spec?.rocket;
  if (rocket && age < rocket.burnTime) {
    const sp = vel.length();
    if (sp > 1e-4) {
      const k = (rocket.thrustAccel * dt) / sp;
      vel.x += vel.x * k;
      vel.y += vel.y * k;
      vel.z += vel.z * k;
    }
  }
  pos.addScaledVector(vel, dt);
}

/** Scratch vectors for stepProjectile call sites (module-shared, non-reentrant). */
const _spPos = new THREE.Vector3();
const _spVel = new THREE.Vector3();
const _spDir = new THREE.Vector3();
const _spLead = new THREE.Vector3();

/**
 * Rocket-artillery aim solver: bisects launch pitch (<=12 iterations) on the
 * low-angle branch so the shared stepProjectile sim impacts the lead point.
 * Writes a far aim point along the solved direction into `outAimPoint`.
 */
export function solveRocketAim(
  muzzlePos: THREE.Vector3,
  targetPos: THREE.Vector3,
  targetVel: THREE.Vector3,
  spec: ShellSpec,
  pitchMin: number,
  pitchMax: number,
  outAimPoint: THREE.Vector3
): void {
  // Rough time-of-flight for target lead (rocket averages ~140 m/s)
  const dist = muzzlePos.distanceTo(targetPos);
  const tof = Math.min(6, Math.max(0.4, dist / 140));
  _spLead.set(
    targetPos.x + targetVel.x * tof,
    targetPos.y + targetVel.y * tof,
    targetPos.z + targetVel.z * tof
  );

  // Horizontal bearing muzzle -> lead point
  const dx = _spLead.x - muzzlePos.x;
  const dz = _spLead.z - muzzlePos.z;
  const hDist = Math.max(1, Math.hypot(dx, dz));
  const yaw = Math.atan2(dx, dz);
  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);
  const leadY = _spLead.y;

  const simRange = (pitch: number): number => {
    _spDir.set(sinY * Math.cos(pitch), Math.sin(pitch), cosY * Math.cos(pitch));
    _spPos.copy(muzzlePos);
    _spVel.copy(_spDir).multiplyScalar(spec.muzzleSpeed);
    const dt = 0.05;
    for (let t = 0; t < 6; t += dt) {
      const prevY = _spPos.y;
      stepProjectile(_spPos, _spVel, spec, t, dt);
      if (_spVel.y < 0 && _spPos.y <= leadY && prevY > leadY) {
        // Descending through target height: horizontal distance travelled
        return Math.hypot(_spPos.x - muzzlePos.x, _spPos.z - muzzlePos.z);
      }
      if (_spPos.y < muzzlePos.y - 30) break;
    }
    return hDist * 2; // out of reach: report overshoot so bisection lowers pitch
  };

  let lo = Math.max(0.04, pitchMin);
  let hi = Math.min(0.85, pitchMax);
  if (simRange(lo) >= hDist) {
    // Even minimum pitch overshoots (point-blank): fire flat
    lo = hi = Math.max(0.02, pitchMin);
  } else {
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) * 0.5;
      if (simRange(mid) < hDist) lo = mid;
      else hi = mid;
    }
  }
  const bestPitch = (lo + hi) * 0.5;
  _spDir.set(sinY * Math.cos(bestPitch), Math.sin(bestPitch), cosY * Math.cos(bestPitch));
  outAimPoint.copy(muzzlePos).addScaledVector(_spDir, 160);
}

const SHELL_POOL_SIZE = 48;
const MG_POOL_SIZE = 160;
const MG_MUZZLE_SPEED = 520;
const MG_DISPERSION_RAD = 0.012;

// Module-level scratch vectors for zero-allocation ballistic prediction & collision
const _predPos = new THREE.Vector3();
const _predPrev = new THREE.Vector3();
const _predNext = new THREE.Vector3();
const _predVel = new THREE.Vector3();
const _segDir = new THREE.Vector3();
const _tankCenter = new THREE.Vector3();

/**
 * Swept ray-segment `[0, segLen]` intersection against a living tank's
 * center-of-mass bounding sphere AND low-profile hull cylinder.
 */
function intersectSegmentTank(
  p0: THREE.Vector3,
  dir: THREE.Vector3,
  segLen: number,
  tank: TankEntity,
  extraRadius: number,
  outCenter: THREE.Vector3
): number | null {
  tank.getCenterMassWorld(outCenter);
  let bestT: number | null = null;

  // 1. Sphere around tank center of mass
  const r = tank.stats.hitRadius + extraRadius;
  const ocX = p0.x - outCenter.x;
  const ocY = p0.y - outCenter.y;
  const ocZ = p0.z - outCenter.z;

  const b = ocX * dir.x + ocY * dir.y + ocZ * dir.z;
  const c = ocX * ocX + ocY * ocY + ocZ * ocZ - r * r;

  if (c <= 0) {
    return 0;
  }
  if (b < 0) {
    const disc = b * b - c;
    if (disc >= 0) {
      const t = -b - Math.sqrt(disc);
      if (t >= 0 && t <= segLen) {
        bestT = t;
      }
    }
  }

  // 2. Capped vertical cylinder around hull footprint for long bow/stern glacis hits
  const cylR = tank.stats.collisionRadius * 0.92 + extraRadius;
  const dx = p0.x - tank.position.x;
  const dz = p0.z - tank.position.z;
  const a2 = dir.x * dir.x + dir.z * dir.z;
  const c2 = dx * dx + dz * dz - cylR * cylR;
  const yMin = tank.position.y - 0.1;
  const yMax = outCenter.y + tank.stats.hitRadius * 0.68;

  if (c2 <= 0) {
    if (p0.y >= yMin && p0.y <= yMax) {
      return 0;
    }
  } else if (a2 > 1e-6) {
    const b2 = dx * dir.x + dz * dir.z;
    if (b2 < 0) {
      const disc2 = b2 * b2 - a2 * c2;
      if (disc2 >= 0) {
        const tCyl = (-b2 - Math.sqrt(disc2)) / a2;
        if (tCyl >= 0 && tCyl <= segLen && (bestT === null || tCyl < bestT)) {
          const hitY = p0.y + dir.y * tCyl;
          if (hitY >= yMin && hitY <= yMax) {
            bestT = tCyl;
          }
        }
      }
    }
  }

  return bestT;
}

/**
 * Computes iterative (3-pass) ballistic intercept point `outAimPoint` for a moving target
 * with full gravity-drop compensation `+0.5 * gravity * t^2` on Y.
 * Returns estimated time-of-flight `t` in seconds.
 */
export function solveBallisticAim(
  shooterMuzzlePos: THREE.Vector3,
  targetPos: THREE.Vector3,
  targetVel: THREE.Vector3,
  muzzleSpeed: number,
  gravity: number,
  outAimPoint: THREE.Vector3
): number {
  const speed = Math.max(1, muzzleSpeed);
  let t = shooterMuzzlePos.distanceTo(targetPos) / speed;

  for (let i = 0; i < 3; i++) {
    const px = targetPos.x + targetVel.x * t;
    const py = targetPos.y + targetVel.y * t + 0.5 * gravity * t * t;
    const pz = targetPos.z + targetVel.z * t;
    const dx = px - shooterMuzzlePos.x;
    const dy = py - shooterMuzzlePos.y;
    const dz = pz - shooterMuzzlePos.z;
    t = Math.sqrt(dx * dx + dy * dy + dz * dz) / speed;
  }

  outAimPoint.set(
    targetPos.x + targetVel.x * t,
    targetPos.y + targetVel.y * t + 0.5 * gravity * t * t,
    targetPos.z + targetVel.z * t
  );
  return t;
}

/**
 * Coarse ballistic trajectory march (`dtStep = 0.04s` up to `3.5s` / `600m`) under `9.81 m/s^2`
 * against `world.raycastWorld` and living enemy tanks so the HUD's Gunner Bore Reticle
 * displays exact gravity-dropped impact location and laser rangefinder distance.
 * Returns Euclidean distance in meters from `muzzlePos` to `outPoint`.
 */
export function predictBarrelImpact(
  muzzlePos: THREE.Vector3,
  muzzleDir: THREE.Vector3,
  muzzleSpeed: number,
  world: TerrainQuery,
  tanks: readonly TankEntity[],
  ignoreTank: TankEntity,
  outPoint: THREE.Vector3,
  spec?: ShellSpec
): number {
  const dtStep = 0.04;
  const maxTime = 3.5;
  const maxRangeSq = 600 * 600;

  _predPos.copy(muzzlePos);
  _predVel.copy(muzzleDir).normalize().multiplyScalar(Math.max(1, muzzleSpeed));

  let elapsed = 0;
  while (elapsed < maxTime) {
    _predPrev.copy(_predPos);
    elapsed += dtStep;
    stepProjectile(_predPos, _predVel, spec, elapsed, dtStep);
    _predNext.copy(_predPos);

    _segDir.subVectors(_predNext, _predPrev);
    const segLen = _segDir.length();
    if (segLen < 1e-5) continue;
    _segDir.multiplyScalar(1 / segLen);

    let closestDist = Infinity;
    let hitFound = false;

    // 1. Check living enemy/other tanks
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (tank === ignoreTank || !tank.alive) continue;
      const tHit = intersectSegmentTank(_predPrev, _segDir, segLen, tank, 0.14, _tankCenter);
      if (tHit !== null && tHit < closestDist) {
        closestDist = tHit;
        hitFound = true;
      }
    }

    // 2. Check terrain & world obstacles
    const worldHit = world.raycastWorld(_predPrev, _segDir, segLen);
    if (worldHit && worldHit.distance < closestDist) {
      outPoint.copy(worldHit.point);
      return muzzlePos.distanceTo(outPoint);
    }

    // 2b. River surface crossing
    const pmx = (_predPrev.x + _predNext.x) * 0.5;
    const pmz = (_predPrev.z + _predNext.z) * 0.5;
    if ((world.getWaterDepthAt?.(pmx, pmz) ?? 0) > 0.03) {
      const lvl = world.getWaterLevelAt?.(pmx, pmz) ?? 0;
      const py = _predPrev.y;
      const ny = _predNext.y;
      if (py > lvl && ny <= lvl) {
        const f = (py - lvl) / Math.max(1e-4, py - ny);
        const wDist = f * segLen;
        if (wDist < closestDist) {
          outPoint.copy(_predPrev).addScaledVector(_segDir, wDist);
          outPoint.y = lvl;
          return muzzlePos.distanceTo(outPoint);
        }
      }
    }

    if (hitFound) {
      outPoint.copy(_predPrev).addScaledVector(_segDir, closestDist);
      return muzzlePos.distanceTo(outPoint);
    }

    // Safety floor check against terrain heightmap
    const terrainY = world.getHeightAt(_predNext.x, _predNext.z);
    if (_predNext.y <= terrainY) {
      const prevAbove = Math.max(0, _predPrev.y - world.getHeightAt(_predPrev.x, _predPrev.z));
      const below = terrainY - _predNext.y;
      const frac = prevAbove + below > 1e-4 ? prevAbove / (prevAbove + below) : 1;
      outPoint.lerpVectors(_predPrev, _predNext, frac);
      outPoint.y = world.getHeightAt(outPoint.x, outPoint.z);
      return muzzlePos.distanceTo(outPoint);
    }

    if (_predPos.distanceToSquared(muzzlePos) >= maxRangeSq) {
      break;
    }
  }

  outPoint.copy(_predPos);
  return muzzlePos.distanceTo(outPoint);
}

/**
 * Builds a dual-layer glowing 3D tracer bolt geometry (inner incandescent core +
 * softer outer bloom sheath) oriented with tip at `Z = 0` and tail extending to `Z = -1`.
 * Visible from every angle including straight down the 2.8x sniper optic!
 */
function createTracerBoltGeometry(): THREE.BufferGeometry {
  const core = new THREE.CylinderGeometry(0.015, 0.065, 1.0, 6, 1, false);
  core.rotateX(Math.PI * 0.5);
  core.translate(0, 0, -0.5);
  const coreCount = core.attributes.position.count;
  const coreColors = new Float32Array(coreCount * 3);
  const corePos = core.attributes.position;
  for (let i = 0; i < coreCount; i++) {
    const z = corePos.getZ(i); // 0 at head, -1 at tail
    const tailFade = z > -0.25 ? 1.0 : 0.25;
    coreColors[i * 3] = tailFade;
    coreColors[i * 3 + 1] = tailFade;
    coreColors[i * 3 + 2] = tailFade;
  }
  core.setAttribute('color', new THREE.BufferAttribute(coreColors, 3));

  const halo = new THREE.CylinderGeometry(0.03, 0.165, 1.0, 6, 1, false);
  halo.rotateX(Math.PI * 0.5);
  halo.translate(0, 0, -0.5);
  const haloCount = halo.attributes.position.count;
  const haloColors = new Float32Array(haloCount * 3);
  const haloPos = halo.attributes.position;
  for (let i = 0; i < haloCount; i++) {
    const z = haloPos.getZ(i);
    const w = z > -0.25 ? 0.34 : 0.05;
    haloColors[i * 3] = w;
    haloColors[i * 3 + 1] = w;
    haloColors[i * 3 + 2] = w;
  }
  halo.setAttribute('color', new THREE.BufferAttribute(haloColors, 3));

  const merged = mergeGeometries([core, halo], false);
  core.dispose();
  halo.dispose();
  return merged;
}

/** In-flight guidance state for a guided shell slot. */
interface GuidedState {
  /** Live target entity (null once decoyed or lost) */
  entity: TankEntity | null;
  /** Fixed decoy aim point once a wreck steals the seeker (world space) */
  decoyX: number;
  decoyY: number;
  decoyZ: number;
  hasDecoy: boolean;
  decoyTimer: number;
  /** Set once the round leaves the seeker cone / target dies — ballistic from then on */
  lost: boolean;
  /** Previous unit LOS vector + range for proportional-navigation LOS rate */
  hasPrevLos: boolean;
  prevLx: number;
  prevLy: number;
  prevLz: number;
  prevDist: number;
  /** Closest approach to the aim point this flight (QA miss metric) */
  minDist: number;
}

interface ShellSlot {
  active: boolean;
  shooter: TankEntity | null;
  shellSpec: ShellSpec | null;
  guide: GuidedState | null;
  originX: number;
  originY: number;
  originZ: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  maxAge: number;
  trailTick: number;
  directDamage: number;
  splashDamage: number;
  splashRadius: number;
  explosionScale: number;
  trR: number;
  trG: number;
  trB: number;
}

interface MgSlot {
  active: boolean;
  shooter: TankEntity | null;
  beltSpec: ShellSpec | null;
  originX: number;
  originY: number;
  originZ: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  maxAge: number;
  isPlayer: boolean;
  directDamage: number;
  splashDamage: number;
  splashRadius: number;
  trR: number;
  trG: number;
  trB: number;
}

export class BallisticsManager {
  public readonly GRAVITY = GRAVITY;

  private readonly scene: THREE.Scene;
  private readonly effects: EffectsManager;

  private readonly boltGeo: THREE.BufferGeometry;
  private readonly boltMat: THREE.MeshBasicMaterial;
  private readonly shellMesh: THREE.InstancedMesh;
  private readonly mgMesh: THREE.InstancedMesh;

  private readonly shells: ShellSlot[] = [];
  private shellCursor = 0;

  private readonly mgRounds: MgSlot[] = [];
  private mgCursor = 0;

  private readonly crateMgHits = new Map<string, number>();

  // Scratch math objects
  private readonly _hiddenMat4 = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly _mat4 = new THREE.Matrix4();
  private readonly _quat = new THREE.Quaternion();
  private readonly _color = new THREE.Color();
  private readonly _prevPos = new THREE.Vector3();
  private readonly _nextPos = new THREE.Vector3();
  private readonly _flyPos = new THREE.Vector3();
  private readonly _flyVel = new THREE.Vector3();
  private readonly _segDir = new THREE.Vector3();
  private readonly _hitPoint = new THREE.Vector3();
  private readonly _hitNormal = new THREE.Vector3();
  private readonly _victimCenter = new THREE.Vector3();
  private readonly _splashCenter = new THREE.Vector3();
  private readonly _attackerPos = new THREE.Vector3();
  private readonly _scaleVec = new THREE.Vector3();
  private readonly _fwdZ = new THREE.Vector3(0, 0, 1);
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _coaxSpreadDir = new THREE.Vector3();
  private readonly _tangentA = new THREE.Vector3();
  private readonly _tangentB = new THREE.Vector3();
  private readonly _gAim = new THREE.Vector3();
  private readonly _gTo = new THREE.Vector3();
  private readonly _gVelDir = new THREE.Vector3();
  private readonly _gLosRate = new THREE.Vector3();
  private readonly _gAccel = new THREE.Vector3();
  private readonly _gPerp = new THREE.Vector3();

  // QA metrics for guidedTest()
  public guidedHits = 0;
  public guidedDecoys = 0;
  public guidedMinMiss = Infinity;
  /** When set, every rocket shell tracks closest approach to this entity (miss metric). */
  public missProbeTarget: TankEntity | null = null;
  public missProbeMin = Infinity;

  public resetGuidedStats(): void {
    this.guidedHits = 0;
    this.guidedDecoys = 0;
    this.guidedMinMiss = Infinity;
    this.missProbeMin = Infinity;
  }

  constructor(scene: THREE.Scene, effects: EffectsManager) {
    this.scene = scene;
    this.effects = effects;
    this._hiddenMat4.setPosition(0, 0, 0);

    this.boltGeo = createTracerBoltGeometry();
    this.boltMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
    });

    this.shellMesh = new THREE.InstancedMesh(this.boltGeo, this.boltMat, SHELL_POOL_SIZE);
    this.shellMesh.name = 'ballistics_shell_tracers';
    this.shellMesh.frustumCulled = false;
    this.shellMesh.renderOrder = 8;
    this.shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._initPoolMesh(this.shellMesh, SHELL_POOL_SIZE);
    this.scene.add(this.shellMesh);

    this.mgMesh = new THREE.InstancedMesh(this.boltGeo, this.boltMat, MG_POOL_SIZE);
    this.mgMesh.name = 'ballistics_mg_tracers';
    this.mgMesh.frustumCulled = false;
    this.mgMesh.renderOrder = 8;
    this.mgMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._initPoolMesh(this.mgMesh, MG_POOL_SIZE);
    this.scene.add(this.mgMesh);

    for (let i = 0; i < SHELL_POOL_SIZE; i++) {
      this.shells.push({
        active: false,
        shooter: null,
        shellSpec: null,
        guide: null,
        originX: 0,
        originY: 0,
        originZ: 0,
        px: 0,
        py: -1000,
        pz: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        age: 0,
        maxAge: 4.5,
        trailTick: 0,
        directDamage: 55,
        splashDamage: 30,
        splashRadius: 6.5,
        explosionScale: 1,
        trR: 8,
        trG: 5,
        trB: 1.6,
      });
    }

    for (let i = 0; i < MG_POOL_SIZE; i++) {
      this.mgRounds.push({
        active: false,
        shooter: null,
        beltSpec: null,
        originX: 0,
        originY: 0,
        originZ: 0,
        px: 0,
        py: -1000,
        pz: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        age: 0,
        maxAge: 1.35,
        isPlayer: false,
        directDamage: 2.8,
        splashDamage: 0,
        splashRadius: 0,
        trR: 6.5,
        trG: 3.0,
        trB: 0.75,
      });
    }
  }

  private _initPoolMesh(mesh: THREE.InstancedMesh, capacity: number): void {
    this._color.setRGB(0, 0, 0);
    for (let i = 0; i < capacity; i++) {
      mesh.setMatrixAt(i, this._hiddenMat4);
      mesh.setColorAt(i, this._color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor.needsUpdate = true;
    }
    // Keep count >= 1 with hidden slot 0 so shader compiles at frame 0
    mesh.count = 1;
  }

  /**
   * Fires a pooled glowing 120mm HE-FRAG shell, spawns cannon muzzle flash + shockwave,
   * and triggers hull/gun recoil on `shooter`.
   */
  public fireCannon(
    shooter: TankEntity,
    muzzlePos: THREE.Vector3,
    muzzleDir: THREE.Vector3,
    shellSpec?: ShellSpec,
    guideTarget?: TankEntity | null
  ): void {
    let slot: ShellSlot | null = null;
    for (let n = 0; n < SHELL_POOL_SIZE; n++) {
      const idx = (this.shellCursor + n) % SHELL_POOL_SIZE;
      if (!this.shells[idx].active) {
        this.shellCursor = (idx + 1) % SHELL_POOL_SIZE;
        slot = this.shells[idx];
        break;
      }
    }
    if (!slot) {
      slot = this.shells[this.shellCursor];
      this.shellCursor = (this.shellCursor + 1) % SHELL_POOL_SIZE;
    }

    const spec = shellSpec ?? shooter.activeShell;
    this._segDir.copy(muzzleDir).normalize();
    if (!shooter.isHuman) {
      if (Math.abs(this._segDir.y) < 0.92) {
        this._tangentA.crossVectors(this._segDir, this._up).normalize();
      } else {
        this._tangentA.set(1, 0, 0).cross(this._segDir).normalize();
      }
      this._tangentB.crossVectors(this._tangentA, this._segDir).normalize();
      const scatterAng = Math.random() * Math.PI * 2;
      // Rockets use their own tight dispersion; guns keep the bot scatter
      const scatterMag = spec.rocket
        ? spec.dispersionRad * (0.6 + Math.random() * 0.8)
        : (0.045 + Math.random() * 0.055) * (Math.random() < 0.82 ? 1.0 : 0.35);
      this._segDir
        .addScaledVector(this._tangentA, Math.cos(scatterAng) * scatterMag)
        .addScaledVector(this._tangentB, Math.sin(scatterAng) * scatterMag * 0.65)
        .normalize();
    }
    const speed = spec.muzzleSpeed;

    slot.active = true;
    slot.shooter = shooter;
    slot.shellSpec = spec;
    slot.originX = muzzlePos.x;
    slot.originY = muzzlePos.y;
    slot.originZ = muzzlePos.z;
    slot.px = muzzlePos.x;
    slot.py = muzzlePos.y;
    slot.pz = muzzlePos.z;
    slot.vx = this._segDir.x * speed;
    slot.vy = this._segDir.y * speed;
    slot.vz = this._segDir.z * speed;
    slot.age = 0;
    slot.maxAge = spec.rocket ? 7.0 : 4.5;
    slot.trailTick = 0;
    // Guided rounds only when the spec opts in AND a live lock target was passed
    if (spec.guidance && guideTarget && guideTarget.alive && guideTarget.team !== shooter.team) {
      let g = slot.guide;
      if (!g) {
        g = {
          entity: null, decoyX: 0, decoyY: 0, decoyZ: 0,
          hasDecoy: false, decoyTimer: 0, lost: false,
          hasPrevLos: false, prevLx: 0, prevLy: 0, prevLz: 0, prevDist: 0,
          minDist: Infinity,
        };
        slot.guide = g;
      }
      g.entity = guideTarget;
      g.hasDecoy = false;
      g.lost = false;
      g.hasPrevLos = false;
      g.minDist = Infinity;
      g.decoyTimer = Math.random() * 0.2;
    } else {
      slot.guide = null;
    }
    slot.directDamage = spec.directDamage;
    slot.splashDamage = spec.splashDamage;
    slot.splashRadius = spec.splashRadius;
    slot.explosionScale = spec.explosionScale;
    slot.trR = spec.tracerColorRGB[0];
    slot.trG = spec.tracerColorRGB[1];
    slot.trB = spec.tracerColorRGB[2];

    this.effects.spawnMuzzleFlash(
      muzzlePos,
      this._segDir,
      spec.rocket ? 0.85 : shooter.stats.vehicleClass === 'heavy' ? 1.35 : 1.0
    );
    if (spec.rocket) {
      // Backblast smoke thrown backwards off the launch pod
      this.effects.spawnRocketBackblast(muzzlePos, this._segDir);
    }
    shooter.applyRecoil();
  }

  public fireCoaxMG(
    shooter: TankEntity,
    coaxPos: THREE.Vector3,
    coaxDir: THREE.Vector3,
    beltSpec?: ShellSpec
  ): void {
    let slot: MgSlot | null = null;
    for (let n = 0; n < MG_POOL_SIZE; n++) {
      const idx = (this.mgCursor + n) % MG_POOL_SIZE;
      if (!this.mgRounds[idx].active) {
        this.mgCursor = (idx + 1) % MG_POOL_SIZE;
        slot = this.mgRounds[idx];
        break;
      }
    }
    if (!slot) {
      slot = this.mgRounds[this.mgCursor];
      this.mgCursor = (this.mgCursor + 1) % MG_POOL_SIZE;
    }

    this._coaxSpreadDir.copy(coaxDir).normalize();
    if (Math.abs(this._coaxSpreadDir.y) < 0.92) {
      this._tangentA.crossVectors(this._coaxSpreadDir, this._up).normalize();
    } else {
      this._tangentA.set(1, 0, 0).cross(this._coaxSpreadDir).normalize();
    }
    this._tangentB.crossVectors(this._tangentA, this._coaxSpreadDir).normalize();

    const angle = Math.random() * Math.PI * 2;
    const baseDisp = !shooter.isHuman
      ? 0.075
      : beltSpec
        ? beltSpec.dispersionRad
        : MG_DISPERSION_RAD;
    const spread = Math.sqrt(Math.random()) * baseDisp;
    this._coaxSpreadDir
      .addScaledVector(this._tangentA, Math.cos(angle) * spread)
      .addScaledVector(this._tangentB, Math.sin(angle) * spread)
      .normalize();

    const spd = beltSpec ? beltSpec.muzzleSpeed : MG_MUZZLE_SPEED;

    slot.active = true;
    slot.shooter = shooter;
    slot.beltSpec = beltSpec ?? null;
    slot.originX = coaxPos.x;
    slot.originY = coaxPos.y;
    slot.originZ = coaxPos.z;
    slot.px = coaxPos.x;
    slot.py = coaxPos.y;
    slot.pz = coaxPos.z;
    slot.vx = this._coaxSpreadDir.x * spd;
    slot.vy = this._coaxSpreadDir.y * spd;
    slot.vz = this._coaxSpreadDir.z * spd;
    slot.age = 0;
    slot.maxAge = 1.45;
    slot.isPlayer = shooter.isHuman;
    const mgBaseDamage = beltSpec ? beltSpec.directDamage : 2.8;
    slot.directDamage = shooter.isHuman ? mgBaseDamage : mgBaseDamage * 0.6;
    slot.splashDamage = beltSpec ? beltSpec.splashDamage : 0;
    slot.splashRadius = beltSpec ? beltSpec.splashRadius : 0;
    if (beltSpec) {
      slot.trR = beltSpec.tracerColorRGB[0];
      slot.trG = beltSpec.tracerColorRGB[1];
      slot.trB = beltSpec.tracerColorRGB[2];
    } else if (slot.isPlayer) {
      slot.trR = 6.5;
      slot.trG = 3.0;
      slot.trB = 0.75;
    } else {
      slot.trR = 6.5;
      slot.trG = 1.35;
      slot.trB = 0.45;
    }

    this.effects.spawnMGFlash(coaxPos, this._coaxSpreadDir);
  }

  /**
   * Proportional-navigation guidance for guided shell slots. Runs after
   * boostDelay while the aim point stays inside the seeker cone of the
   * round's velocity; wreck decoys can steal the seeker every 0.2 s.
   * Modifies `vel` in place before stepProjectile integrates.
   */
  private _applyGuidance(
    s: ShellSlot,
    vel: THREE.Vector3,
    tanks: readonly TankEntity[],
    decoyPoints: readonly { x: number; y: number; z: number }[] | undefined,
    dt: number
  ): void {
    const g = s.guide;
    const gd = s.shellSpec?.guidance;
    if (!g || !gd || g.lost || dt <= 0 || s.age < gd.boostDelay) return;

    // Resolve aim point: live target heat region, or fixed decoy position
    let tx: number, ty: number, tz: number;
    if (g.hasDecoy) {
      tx = g.decoyX;
      ty = g.decoyY;
      tz = g.decoyZ;
    } else {
      const t = g.entity;
      if (!t || !t.alive) {
        g.lost = true;
        return;
      }
      // Engine heat region: hull centre +0.8 m up, 30% hull length toward rear
      const rear = t.stats.collisionRadius * 2 * 0.3;
      const fx = Math.sin(t.hullYaw);
      const fz = Math.cos(t.hullYaw);
      tx = t.position.x - fx * rear;
      ty = t.position.y + 1.8;
      tz = t.position.z - fz * rear;
    }

    // Unit LOS + range
    this._gTo.set(tx - s.px, ty - s.py, tz - s.pz);
    const dist = this._gTo.length();
    if (dist < 0.5) {
      g.lost = true;
      return;
    }
    this._gTo.multiplyScalar(1 / dist);
    if (dist < g.minDist) g.minDist = dist;
    if (!g.hasDecoy && g.entity) {
      const dAim = Math.hypot(
        s.px - g.entity.position.x,
        s.py - (g.entity.position.y + 1.35),
        s.pz - g.entity.position.z
      );
      if (s.shooter?.isHuman && dAim < this.guidedMinMiss) this.guidedMinMiss = dAim;
    }

    // Velocity unit vector (the live integration velocity)
    this._gVelDir.set(vel.x, vel.y, vel.z);
    const spd = this._gVelDir.length();
    if (spd < 1) {
      g.lost = true;
      return;
    }
    this._gVelDir.multiplyScalar(1 / spd);

    // Seeker cone check: target must stay within seekerConeDeg of velocity
    const coneCos = Math.cos((gd.seekerConeDeg * Math.PI) / 180);
    if (this._gTo.dot(this._gVelDir) < coneCos) {
      g.lost = true;
      return;
    }

    // Wreck decoy scan every 0.2 s (only while tracking a live entity)
    if (gd.decoyable && !g.hasDecoy && g.entity) {
      g.decoyTimer -= dt;
      if (g.decoyTimer <= 0 && decoyPoints && decoyPoints.length > 0) {
        g.decoyTimer = 0.2;
        const cos8 = Math.cos((8 * Math.PI) / 180);
        for (let i = 0; i < decoyPoints.length; i++) {
          const d = decoyPoints[i];
          this._gLosRate.set(d.x - s.px, d.y - s.py, d.z - s.pz);
          const dd = this._gLosRate.length();
          if (dd < 1 || dd >= dist) continue; // must be closer than the target
          this._gLosRate.multiplyScalar(1 / dd);
          if (this._gLosRate.dot(this._gTo) < cos8) continue;
          if (Math.random() < 0.15) {
            g.hasDecoy = true;
            g.entity = null;
            g.decoyX = d.x;
            g.decoyY = d.y;
            g.decoyZ = d.z;
            g.hasPrevLos = false;
            if (s.shooter?.isHuman) this.guidedDecoys++;
            break;
          }
        }
      }
    }

    // Proportional navigation: a = N · Vc · LOS-rate, perpendicular to velocity
    if (g.hasPrevLos) {
      const invDt = 1 / dt;
      const vc = Math.max(0, -(dist - g.prevDist) * invDt); // closing speed
      let ax = gd.navGain * vc * ((this._gTo.x - g.prevLx) * invDt);
      let ay = gd.navGain * vc * ((this._gTo.y - g.prevLy) * invDt);
      let az = gd.navGain * vc * ((this._gTo.z - g.prevLz) * invDt);
      // Strip the along-track component, clamp to maxAccel
      const aDotV = ax * this._gVelDir.x + ay * this._gVelDir.y + az * this._gVelDir.z;
      ax -= aDotV * this._gVelDir.x;
      ay -= aDotV * this._gVelDir.y;
      az -= aDotV * this._gVelDir.z;
      const aMag = Math.sqrt(ax * ax + ay * ay + az * az);
      if (aMag > gd.maxAccel) {
        const k = gd.maxAccel / aMag;
        ax *= k;
        ay *= k;
        az *= k;
      }
      vel.x += ax * dt;
      vel.y += ay * dt;
      vel.z += az * dt;
    }

    g.hasPrevLos = true;
    g.prevLx = this._gTo.x;
    g.prevLy = this._gTo.y;
    g.prevLz = this._gTo.z;
    g.prevDist = dist;
  }

  /** QA miss probe: track closest approach of rocket shells to an entity. */
  private _updateMissProbe(s: ShellSlot): void {
    const t = this.missProbeTarget;
    if (!t || !t.alive || !s.shellSpec?.rocket || !s.shooter?.isHuman) return;
    const dx = s.px - t.position.x;
    const dy = s.py - (t.position.y + 1.35);
    const dz = s.pz - t.position.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < this.missProbeMin) this.missProbeMin = d;
  }

  public update(
    dt: number,
    world: TerrainQuery,
    tanks: readonly TankEntity[],
    onDamage: (ev: DamageEvent) => void,
    decoyPoints?: readonly { x: number; y: number; z: number }[]
  ): void {
    const stepDt = Math.min(Math.max(dt, 0), 0.05);
    if (stepDt === 0) return;

    const boundLimit = world.worldHalfSize + 120;

    // -----------------------------------------------------------------------
    // 1. Step 120mm HE-FRAG Shells
    // -----------------------------------------------------------------------
    let activeShellCount = 0;

    for (let i = 0; i < SHELL_POOL_SIZE; i++) {
      const s = this.shells[i];
      if (!s.active) continue;

      s.age += stepDt;
      if (s.age >= s.maxAge) {
        s.active = false;
        continue;
      }

      this._prevPos.set(s.px, s.py, s.pz);
      this._flyPos.set(s.px, s.py, s.pz);
      this._flyVel.set(s.vx, s.vy, s.vz);
      this._applyGuidance(s, this._flyVel, tanks, decoyPoints, stepDt);
      this._updateMissProbe(s);
      stepProjectile(this._flyPos, this._flyVel, s.shellSpec ?? undefined, s.age, stepDt);
      s.px = this._flyPos.x;
      s.py = this._flyPos.y;
      s.pz = this._flyPos.z;
      s.vx = this._flyVel.x;
      s.vy = this._flyVel.y;
      s.vz = this._flyVel.z;
      this._nextPos.copy(this._flyPos);

      // Burning rocket motors leave a dense smoke trail + motor flare
      const rocket = s.shellSpec?.rocket;
      if (rocket && s.age < rocket.burnTime + 0.15) {
        s.trailTick += stepDt;
        if (s.trailTick >= 0.035) {
          s.trailTick = 0;
          this.effects.spawnRocketTrail(this._flyPos);
        }
      }

      this._segDir.subVectors(this._nextPos, this._prevPos);
      const segLen = this._segDir.length();
      if (segLen < 1e-6) continue;
      this._segDir.multiplyScalar(1 / segLen);

      // Check living tank intersections
      let hitTank: TankEntity | null = null;
      let bestTankDist = Infinity;
      for (let tIdx = 0; tIdx < tanks.length; tIdx++) {
        const tank = tanks[tIdx];
        if (!tank.alive || tank.team === s.shooter?.team) continue;
        const tHit = intersectSegmentTank(this._prevPos, this._segDir, segLen, tank, 0.14, this._victimCenter);
        if (tHit !== null && tHit < bestTankDist) {
          bestTankDist = tHit;
          hitTank = tank;
        }
      }

      // Check terrain + obstacle raycast
      let worldHit = world.raycastWorld(this._prevPos, this._segDir, segLen);

      // River surface crossing: segment dips through the water plane inside a corridor
      let waterDist = Infinity;
      let waterLevelY = 0;
      {
        const mx = (this._prevPos.x + this._nextPos.x) * 0.5;
        const mz = (this._prevPos.z + this._nextPos.z) * 0.5;
        const wDepth = world.getWaterDepthAt?.(mx, mz) ?? 0;
        if (wDepth > 0.03) {
          const lvl = world.getWaterLevelAt?.(mx, mz) ?? 0;
          const py = this._prevPos.y;
          const ny = this._nextPos.y;
          if (py > lvl && ny <= lvl) {
            const f = (py - lvl) / Math.max(1e-4, py - ny);
            waterDist = f * segLen;
            waterLevelY = lvl;
          } else if (py <= lvl && ny <= lvl) {
            waterDist = 0;
            waterLevelY = lvl;
          }
        }
      }

      // Safety fallback against terrain floor tunneling
      if (!worldHit) {
        const floorY = world.getHeightAt(this._nextPos.x, this._nextPos.z);
        if (this._nextPos.y <= floorY) {
          const prevAbove = Math.max(0, this._prevPos.y - world.getHeightAt(this._prevPos.x, this._prevPos.z));
          const below = floorY - this._nextPos.y;
          const frac = prevAbove + below > 1e-4 ? prevAbove / (prevAbove + below) : 1;
          const hitPt = new THREE.Vector3().lerpVectors(this._prevPos, this._nextPos, frac);
          hitPt.y = world.getHeightAt(hitPt.x, hitPt.z);
          const hitNrm = world.getNormalAt(hitPt.x, hitPt.z, new THREE.Vector3());
          worldHit = {
            point: hitPt,
            normal: hitNrm,
            distance: frac * segLen,
            hitKind: 'terrain',
          };
        }
      }

      const worldDist = worldHit ? worldHit.distance : Infinity;
      const impactIsWater = waterDist <= worldDist;

      if (hitTank !== null || worldHit !== null || waterDist < Infinity) {
        s.active = false;
        if (s.shooter) {
          this._attackerPos.copy(s.shooter.position);
        } else {
          this._attackerPos.set(s.originX, s.originY, s.originZ);
        }

        let directVictim: TankEntity | null = null;

        if (hitTank !== null && bestTankDist <= worldDist) {
          // Direct hit on enemy/player armor!
          directVictim = hitTank;
          this._hitPoint.copy(this._prevPos).addScaledVector(this._segDir, bestTankDist);
          directVictim.getCenterMassWorld(this._victimCenter);
          this._hitNormal.subVectors(this._hitPoint, this._victimCenter);
          if (this._hitNormal.lengthSq() < 1e-4) {
            this._hitNormal.copy(this._segDir).negate();
          } else {
            this._hitNormal.normalize();
          }

          const dmg = s.directDamage;
          if (s.guide?.entity === directVictim && s.shooter?.isHuman) this.guidedHits++;
          const killed = directVictim.takeDamage(
            dmg,
            this._hitPoint.clone(),
            this._attackerPos,
            this._segDir,
            'cannon',
            s.shellSpec ?? undefined
          );
          onDamage({
            victim: directVictim,
            attacker: s.shooter,
            amount: dmg,
            killed,
            hitPoint: this._hitPoint.clone(),
            weapon: 'cannon',
            xrayReport: directVictim.lastXRayReport,
          });

          this.effects.spawnExplosion(
            this._hitPoint,
            this._hitNormal,
            killed ? 1.38 : s.explosionScale,
            killed ? 'tank_kill' : 'he_armor'
          );
        } else if (impactIsWater && (!worldHit || waterDist <= worldHit.distance)) {
          // Shell stops at the surface: splash + reduced HE detonation in the water
          const wHitX = this._prevPos.x + this._segDir.x * waterDist;
          const wHitZ = this._prevPos.z + this._segDir.z * waterDist;
          this._hitPoint.set(wHitX, waterLevelY + 0.15, wHitZ);
          this._hitNormal.set(0, 1, 0);
          this.effects.spawnWaterSplash(this._hitPoint, s.explosionScale * 1.6);
          this.effects.spawnExplosion(this._hitPoint, this._hitNormal, s.explosionScale * 0.45, 'he_ground');
        } else if (worldHit !== null) {
          this._hitPoint.copy(worldHit.point);
          this._hitNormal.copy(worldHit.normal);

          if (
            worldHit.hitKind === 'obstacle' &&
            worldHit.obstacle &&
            worldHit.obstacle.destructible &&
            !worldHit.obstacle.destroyed
          ) {
            const dirXZ = new THREE.Vector2(this._segDir.x, this._segDir.z);
            if (dirXZ.lengthSq() > 1e-5) dirXZ.normalize();
            world.crushObstacle(worldHit.obstacle, dirXZ);
          }

          this.effects.spawnExplosion(this._hitPoint, this._hitNormal, s.explosionScale, 'he_ground');
        }

        // HE-FRAG Splash Radius: knock down destructible obstacles & deal radial falloff damage
        // Water impacts burst half as far and flatter.
        const R = impactIsWater ? s.splashRadius * 0.5 : s.splashRadius;
        if (R > 0) {
          const obstacles = world.getObstacles();
          for (let oIdx = 0; oIdx < obstacles.length; oIdx++) {
            const obs = obstacles[oIdx];
            if (!obs.destructible || obs.destroyed) continue;
            const dx = obs.x - this._hitPoint.x;
            const dz = obs.z - this._hitPoint.z;
            const distXZ = Math.sqrt(dx * dx + dz * dz);
            if (distXZ <= R + obs.radius * 0.5) {
              const push = new THREE.Vector2(dx, dz);
              if (push.lengthSq() < 1e-4) {
                push.set(this._segDir.x, this._segDir.z);
              }
              if (push.lengthSq() > 1e-5) push.normalize();
              world.crushObstacle(obs, push);
            }
          }

          for (let tIdx = 0; tIdx < tanks.length; tIdx++) {
            const tank = tanks[tIdx];
            if (!tank.alive || tank === directVictim || tank.team === s.shooter?.team) continue;
            tank.getCenterMassWorld(this._splashCenter);
            const rawDist = this._hitPoint.distanceTo(this._splashCenter);
            const effDist = Math.max(0, rawDist - tank.stats.hitRadius * 0.35);
            if (effDist < R) {
              const falloff = 1 - effDist / R;
              const splashDmg = s.splashDamage * falloff;
              if (splashDmg >= 0.5) {
                const killed = tank.takeDamage(splashDmg, this._hitPoint.clone(), this._attackerPos);
                onDamage({
                  victim: tank,
                  attacker: s.shooter,
                  amount: splashDmg,
                  killed,
                  hitPoint: this._hitPoint.clone(),
                  weapon: 'cannon',
                });
                if (killed) {
                  this.effects.spawnExplosion(this._splashCenter, this._up, 1.35, 'tank_kill');
                }
              }
            }
          }
        }

        continue;
      }

      // Advance shell in flight
      s.px = this._nextPos.x;
      s.py = this._nextPos.y;
      s.pz = this._nextPos.z;

      if (Math.abs(s.px) > boundLimit || Math.abs(s.pz) > boundLimit || s.py < -80) {
        s.active = false;
        continue;
      }

      // Render glowing 3D shell tracer bolt stretched along flight direction
      const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
      const streakLen = Math.min(6.2, Math.max(2.2, speed * 0.022));
      this._quat.setFromUnitVectors(this._fwdZ, this._segDir);
      this._scaleVec.set(1.25, 1.25, streakLen);
      this._mat4.compose(this._nextPos, this._quat, this._scaleVec);

      const outIdx = activeShellCount++;
      this.shellMesh.setMatrixAt(outIdx, this._mat4);
      this._color.setRGB(s.trR, s.trG, s.trB);
      this.shellMesh.setColorAt(outIdx, this._color);
    }

    if (activeShellCount === 0) {
      this.shellMesh.visible = false;
    } else {
      this.shellMesh.visible = true;
      this.shellMesh.count = activeShellCount;
      this.shellMesh.instanceMatrix.clearUpdateRanges();
      this.shellMesh.instanceMatrix.addUpdateRange(0, activeShellCount * 16);
      this.shellMesh.instanceMatrix.needsUpdate = true;
      if (this.shellMesh.instanceColor) {
        this.shellMesh.instanceColor.clearUpdateRanges();
        this.shellMesh.instanceColor.addUpdateRange(0, activeShellCount * 3);
        this.shellMesh.instanceColor.needsUpdate = true;
      }
    }

    // -----------------------------------------------------------------------
    // 2. Step 7.62mm Coaxial MG Rounds
    // -----------------------------------------------------------------------
    let activeMgCount = 0;

    for (let i = 0; i < MG_POOL_SIZE; i++) {
      const m = this.mgRounds[i];
      if (!m.active) continue;

      m.age += stepDt;
      if (m.age >= m.maxAge) {
        m.active = false;
        continue;
      }

      this._prevPos.set(m.px, m.py, m.pz);
      m.vy -= this.GRAVITY * stepDt;
      this._nextPos.set(
        m.px + m.vx * stepDt,
        m.py + m.vy * stepDt,
        m.pz + m.vz * stepDt
      );

      this._segDir.subVectors(this._nextPos, this._prevPos);
      const segLen = this._segDir.length();
      if (segLen < 1e-6) continue;
      this._segDir.multiplyScalar(1 / segLen);

      let hitTank: TankEntity | null = null;
      let bestTankDist = Infinity;
      for (let tIdx = 0; tIdx < tanks.length; tIdx++) {
        const tank = tanks[tIdx];
        if (!tank.alive || tank.team === m.shooter?.team) continue;
        const tHit = intersectSegmentTank(this._prevPos, this._segDir, segLen, tank, 0.03, this._victimCenter);
        if (tHit !== null && tHit < bestTankDist) {
          bestTankDist = tHit;
          hitTank = tank;
        }
      }

      const worldHit = world.raycastWorld(this._prevPos, this._segDir, segLen);
      const worldDist = worldHit ? worldHit.distance : Infinity;

      // River surface crossing
      let mgWaterDist = Infinity;
      let mgWaterY = 0;
      {
        const mx = (this._prevPos.x + this._nextPos.x) * 0.5;
        const mz = (this._prevPos.z + this._nextPos.z) * 0.5;
        const wDepth = world.getWaterDepthAt?.(mx, mz) ?? 0;
        if (wDepth > 0.03) {
          const lvl = world.getWaterLevelAt?.(mx, mz) ?? 0;
          const py = this._prevPos.y;
          const ny = this._nextPos.y;
          if (py > lvl && ny <= lvl) {
            const f = (py - lvl) / Math.max(1e-4, py - ny);
            mgWaterDist = f * segLen;
            mgWaterY = lvl;
          } else if (py <= lvl && ny <= lvl) {
            mgWaterDist = 0;
            mgWaterY = lvl;
          }
        }
      }
      const mgWaterHit = mgWaterDist <= worldDist && mgWaterDist < Infinity;

      if (hitTank !== null || worldHit !== null || mgWaterHit) {
        m.active = false;
        if (m.shooter) {
          this._attackerPos.copy(m.shooter.position);
        } else {
          this._attackerPos.set(m.originX, m.originY, m.originZ);
        }

        if (hitTank !== null && bestTankDist <= worldDist) {
          this._hitPoint.copy(this._prevPos).addScaledVector(this._segDir, bestTankDist);
          hitTank.getCenterMassWorld(this._victimCenter);
          this._hitNormal.subVectors(this._hitPoint, this._victimCenter);
          if (this._hitNormal.lengthSq() < 1e-4) {
            this._hitNormal.copy(this._segDir).negate();
          } else {
            this._hitNormal.normalize();
          }

          const chipDamage = m.directDamage;
          const killed = hitTank.takeDamage(
            chipDamage,
            this._hitPoint.clone(),
            this._attackerPos,
            this._segDir,
            'mg',
            m.beltSpec ?? undefined
          );
          onDamage({
            victim: hitTank,
            attacker: m.shooter,
            amount: chipDamage,
            killed,
            hitPoint: this._hitPoint.clone(),
            weapon: 'mg',
            xrayReport: hitTank.lastXRayReport,
          });

          if (m.splashRadius > 0) {
            this.effects.spawnExplosion(this._hitPoint, this._hitNormal, 0.36, 'he_armor');
          } else {
            this.effects.spawnSparkImpact(this._hitPoint, this._hitNormal, true);
          }
          if (killed) {
            this.effects.spawnExplosion(this._victimCenter, this._up, 1.3, 'tank_kill');
          }
        } else if (mgWaterHit && (!worldHit || mgWaterDist <= worldHit.distance)) {
          const wHitX = this._prevPos.x + this._segDir.x * mgWaterDist;
          const wHitZ = this._prevPos.z + this._segDir.z * mgWaterDist;
          this._hitPoint.set(wHitX, mgWaterY + 0.1, wHitZ);
          this._hitNormal.set(0, 1, 0);
          if (m.splashRadius > 0) {
            this.effects.spawnWaterSplash(this._hitPoint, 0.9);
            this.effects.spawnExplosion(this._hitPoint, this._hitNormal, 0.3, 'he_ground');
            for (let tIdx = 0; tIdx < tanks.length; tIdx++) {
              const tank = tanks[tIdx];
              if (!tank.alive || tank.team === m.shooter?.team) continue;
              tank.getCenterMassWorld(this._splashCenter);
              const d = Math.max(0, this._hitPoint.distanceTo(this._splashCenter) - tank.stats.hitRadius * 0.4);
              if (d < m.splashRadius * 0.5) {
                const sDmg = m.splashDamage * (1 - d / (m.splashRadius * 0.5));
                if (sDmg >= 0.2) {
                  const sKilled = tank.takeDamage(sDmg, this._hitPoint.clone(), this._attackerPos, this._segDir, 'mg', m.beltSpec ?? undefined);
                  onDamage({
                    victim: tank,
                    attacker: m.shooter,
                    amount: sDmg,
                    killed: sKilled,
                    hitPoint: this._hitPoint.clone(),
                    weapon: 'mg',
                    xrayReport: tank.lastXRayReport,
                  });
                  if (sKilled) {
                    this.effects.spawnExplosion(this._splashCenter, this._up, 1.3, 'tank_kill');
                  }
                }
              }
            }
          } else {
            this.effects.spawnWaterSplash(this._hitPoint, 0.5);
          }
        } else if (worldHit !== null) {
          const obs = worldHit.obstacle;
          const isHardSurface =
            worldHit.hitKind === 'obstacle' &&
            obs !== undefined &&
            obs.kind !== 'tree' &&
            obs.kind !== 'crates';

          if (m.splashRadius > 0) {
            this.effects.spawnExplosion(worldHit.point, worldHit.normal, 0.34, 'he_ground');
            // 30mm HEI-T splash damage to nearby living tanks
            for (let tIdx = 0; tIdx < tanks.length; tIdx++) {
              const tank = tanks[tIdx];
              if (!tank.alive || tank.team === m.shooter?.team) continue;
              tank.getCenterMassWorld(this._splashCenter);
              const d = Math.max(0, worldHit.point.distanceTo(this._splashCenter) - tank.stats.hitRadius * 0.4);
              if (d < m.splashRadius) {
                const sDmg = m.splashDamage * (1 - d / m.splashRadius);
                if (sDmg >= 0.2) {
                  const sKilled = tank.takeDamage(sDmg, worldHit.point.clone(), this._attackerPos, this._segDir, 'mg', m.beltSpec ?? undefined);
                  onDamage({
                    victim: tank,
                    attacker: m.shooter,
                    amount: sDmg,
                    killed: sKilled,
                    hitPoint: worldHit.point.clone(),
                    weapon: 'mg',
                    xrayReport: tank.lastXRayReport,
                  });
                  if (sKilled) {
                    this.effects.spawnExplosion(this._splashCenter, this._up, 1.3, 'tank_kill');
                  }
                }
              }
            }
          } else {
            this.effects.spawnSparkImpact(worldHit.point, worldHit.normal, isHardSurface);
          }

          if (
            obs &&
            obs.destructible &&
            !obs.destroyed &&
            (obs.kind === 'crates' || obs.kind === 'barrier')
          ) {
            const hits = (this.crateMgHits.get(obs.id) ?? 0) + 1;
            if (hits >= 5) {
              this.crateMgHits.delete(obs.id);
              const dirXZ = new THREE.Vector2(this._segDir.x, this._segDir.z);
              if (dirXZ.lengthSq() > 1e-5) dirXZ.normalize();
              world.crushObstacle(obs, dirXZ);
            } else {
              this.crateMgHits.set(obs.id, hits);
            }
          }
        }

        continue;
      }

      // Terrain height safety floor
      const floorY = world.getHeightAt(this._nextPos.x, this._nextPos.z);
      if (this._nextPos.y <= floorY) {
        m.active = false;
        this._hitPoint.set(this._nextPos.x, floorY, this._nextPos.z);
        world.getNormalAt(this._hitPoint.x, this._hitPoint.z, this._hitNormal);
        this.effects.spawnSparkImpact(this._hitPoint, this._hitNormal, false);
        continue;
      }

      m.px = this._nextPos.x;
      m.py = this._nextPos.y;
      m.pz = this._nextPos.z;

      if (Math.abs(m.px) > boundLimit || Math.abs(m.pz) > boundLimit) {
        m.active = false;
        continue;
      }

      this._quat.setFromUnitVectors(this._fwdZ, this._segDir);
      const tracerLen = Math.min(5.2, Math.max(1.8, segLen * 0.85));
      this._scaleVec.set(0.42, 0.42, tracerLen);
      this._mat4.compose(this._nextPos, this._quat, this._scaleVec);

      const outIdx = activeMgCount++;
      this.mgMesh.setMatrixAt(outIdx, this._mat4);
      this._color.setRGB(m.trR, m.trG, m.trB);
      this.mgMesh.setColorAt(outIdx, this._color);
    }

    if (activeMgCount === 0) {
      this.mgMesh.visible = false;
    } else {
      this.mgMesh.visible = true;
      this.mgMesh.count = activeMgCount;
      this.mgMesh.instanceMatrix.clearUpdateRanges();
      this.mgMesh.instanceMatrix.addUpdateRange(0, activeMgCount * 16);
      this.mgMesh.instanceMatrix.needsUpdate = true;
      if (this.mgMesh.instanceColor) {
        this.mgMesh.instanceColor.clearUpdateRanges();
        this.mgMesh.instanceColor.addUpdateRange(0, activeMgCount * 3);
        this.mgMesh.instanceColor.needsUpdate = true;
      }
    }
  }

  public dispose(): void {
    this.scene.remove(this.shellMesh, this.mgMesh);
    this.boltGeo.dispose();
    this.boltMat.dispose();
  }
}
