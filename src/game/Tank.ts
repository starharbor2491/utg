import * as THREE from 'three';
import { instantiateTankRig, type InstantiatedTankRig, type LoadedGameAssets } from './AssetLoader';
import { MBT_INTERNAL_MODULES } from './HitCam';
import type {
  ModuleHealthState,
  ModuleId,
  ShellHitXRayReport,
  ShellSpec,
  TankEntity,
  TankIntent,
  TankStats,
  Team,
  TerrainQuery,
  VehicleClass,
  XRayModuleHitEntry,
  XRaySpallRay,
} from './types';

const NORMAL_SHELLS: readonly [ShellSpec, ShellSpec] = [
  {
    id: 'mbt_apfsds',
    shortCode: 'APFSDS',
    displayName: '120MM APFSDS SABOT',
    muzzleSpeed: 430,
    directDamage: 290,
    splashDamage: 0,
    splashRadius: 0,
    penetrationDepth: 4.5,
    spallCount: 12,
    spallWeight: 0.52,
    explosionScale: 0.65,
    tracerColorRGB: [4.2, 6.4, 9.0],
    dispersionRad: 0.0015,
  },
  {
    id: 'mbt_he',
    shortCode: 'HE-FRAG',
    displayName: '120MM HE-FRAG',
    muzzleSpeed: 245,
    directDamage: 225,
    splashDamage: 175,
    splashRadius: 10.5,
    penetrationDepth: 1.75,
    spallCount: 16,
    spallWeight: 0.34,
    explosionScale: 1.18,
    tracerColorRGB: [8.5, 4.4, 1.2],
    dispersionRad: 0.003,
  },
];

const HEAVY_SHELLS: readonly [ShellSpec, ShellSpec] = [
  {
    id: 'heavy_apcbc',
    shortCode: '152 APCBC',
    displayName: '152MM HEAVY APCBC',
    muzzleSpeed: 345,
    directDamage: 410,
    splashDamage: 70,
    splashRadius: 3.5,
    penetrationDepth: 4.35,
    spallCount: 20,
    spallWeight: 0.58,
    explosionScale: 1.15,
    tracerColorRGB: [8.8, 7.0, 3.2],
    dispersionRad: 0.0025,
  },
  {
    id: 'heavy_he',
    shortCode: '152MM HE',
    displayName: '152MM DEMOLITION HE',
    muzzleSpeed: 205,
    directDamage: 320,
    splashDamage: 260,
    splashRadius: 14.5,
    penetrationDepth: 2.0,
    spallCount: 18,
    spallWeight: 0.44,
    explosionScale: 1.58,
    tracerColorRGB: [9.2, 3.0, 0.75],
    dispersionRad: 0.0045,
  },
];

const IFV_BELTS: readonly [ShellSpec, ShellSpec] = [
  {
    id: 'ifv_apds',
    shortCode: '30MM APDS',
    displayName: '30MM APDS-T SABOT',
    muzzleSpeed: 560,
    directDamage: 28,
    splashDamage: 0,
    splashRadius: 0,
    penetrationDepth: 2.35,
    spallCount: 5,
    spallWeight: 0.34,
    explosionScale: 0.25,
    tracerColorRGB: [3.8, 7.2, 9.0],
    dispersionRad: 0.0075,
  },
  {
    id: 'ifv_hei',
    shortCode: '30MM HEI',
    displayName: '30MM HEI-T EXPLOSIVE',
    muzzleSpeed: 450,
    directDamage: 18,
    splashDamage: 16,
    splashRadius: 3.2,
    penetrationDepth: 0.95,
    spallCount: 6,
    spallWeight: 0.25,
    explosionScale: 0.36,
    tracerColorRGB: [9.0, 3.2, 0.8],
    dispersionRad: 0.011,
  },
];

export const TANK_STATS: Record<VehicleClass, TankStats> = {
  normal: {
    vehicleClass: 'normal',
    displayName: 'NORMAL MBT',
    maxHp: 1000,
    armorDamageMult: 1.0,
    maxForwardSpeed: 18.2, // ~65 km/h
    maxReverseSpeed: 9.2,
    forwardAccel: 10.8,
    reverseAccel: 8.4,
    brakeDecel: 22.0,
    hullTurnRate: 1.05,
    turretTurnRate: 0.95,
    gunElevateRate: 0.68,
    gunMinPitch: -0.175,
    gunMaxPitch: 0.36,
    hasMainCannon: true,
    cannonReloadTime: 3.6,
    shellMuzzleSpeed: NORMAL_SHELLS[0].muzzleSpeed,
    shellDirectDamage: NORMAL_SHELLS[0].directDamage,
    shellSplashDamage: NORMAL_SHELLS[0].splashDamage,
    shellSplashRadius: NORMAL_SHELLS[0].splashRadius,
    shells: NORMAL_SHELLS,
    recoilImpulse: 0.10,
    hitRadius: 2.65,
    collisionRadius: 2.75,
    hasCoaxMG: true,
    infiniteMG: false,
    mgFireInterval: 0.085,
  },
  heavy: {
    vehicleClass: 'heavy',
    displayName: 'HEAVY TANK',
    maxHp: 1650,
    armorDamageMult: 0.62,
    maxForwardSpeed: 11.8, // ~42 km/h heavy juggernaut
    maxReverseSpeed: 5.8,
    forwardAccel: 6.8,
    reverseAccel: 5.5,
    brakeDecel: 19.0,
    hullTurnRate: 0.72,
    turretTurnRate: 0.64,
    gunElevateRate: 0.52,
    gunMinPitch: -0.14,
    gunMaxPitch: 0.34,
    hasMainCannon: true,
    cannonReloadTime: 5.2,
    shellMuzzleSpeed: HEAVY_SHELLS[0].muzzleSpeed,
    shellDirectDamage: HEAVY_SHELLS[0].directDamage,
    shellSplashDamage: HEAVY_SHELLS[0].splashDamage,
    shellSplashRadius: HEAVY_SHELLS[0].splashRadius,
    shells: HEAVY_SHELLS,
    recoilImpulse: 0.15,
    hitRadius: 2.85,
    collisionRadius: 2.9,
    hasCoaxMG: true,
    infiniteMG: false,
    mgFireInterval: 0.09,
  },
  ifv: {
    vehicleClass: 'ifv',
    displayName: 'IFV (AUTO-MG)',
    maxHp: 780,
    armorDamageMult: 1.15,
    maxForwardSpeed: 24.2, // ~87 km/h rapid recon IFV
    maxReverseSpeed: 12.5,
    forwardAccel: 15.2,
    reverseAccel: 11.5,
    brakeDecel: 26.0,
    hullTurnRate: 1.45,
    turretTurnRate: 1.55,
    gunElevateRate: 0.95,
    gunMinPitch: -0.16,
    gunMaxPitch: 0.48,
    hasMainCannon: false,
    cannonReloadTime: 0.09,
    shellMuzzleSpeed: IFV_BELTS[0].muzzleSpeed,
    shellDirectDamage: IFV_BELTS[0].directDamage,
    shellSplashDamage: IFV_BELTS[0].splashDamage,
    shellSplashRadius: IFV_BELTS[0].splashRadius,
    shells: IFV_BELTS,
    recoilImpulse: 0.022,
    hitRadius: 2.35,
    collisionRadius: 2.3,
    hasCoaxMG: true,
    infiniteMG: true,
    mgFireInterval: 0.088,
  },
};

function wrapAnglePi(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

function intersectRayAABB(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxLen: number,
  min: readonly [number, number, number],
  max: readonly [number, number, number]
): number | null {
  let tMin = 0;
  let tMax = maxLen;

  const axes: [number, number, number, number][] = [
    [ox, dx, min[0], max[0]],
    [oy, dy, min[1], max[1]],
    [oz, dz, min[2], max[2]],
  ];

  for (const [o, d, bMin, bMax] of axes) {
    if (Math.abs(d) < 1e-6) {
      if (o < bMin || o > bMax) return null;
    } else {
      let t1 = (bMin - o) / d;
      let t2 = (bMax - o) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }
  }
  return tMin;
}

const MODULE_LABELS: Record<ModuleId, { label: string; damagedEffect: string; destroyedEffect: string }> = {
  track_left: {
    label: 'LEFT TRACK',
    damagedEffect: 'TRACTION REDUCED',
    destroyedEffect: 'SEVERED (IMMOBILIZED)',
  },
  track_right: {
    label: 'RIGHT TRACK',
    damagedEffect: 'TRACTION REDUCED',
    destroyedEffect: 'SEVERED (IMMOBILIZED)',
  },
  engine: {
    label: 'ENGINE PACK',
    damagedEffect: 'POWER LOSS (-55%)',
    destroyedEffect: 'DESTROYED (ENGINE FIRE)',
  },
  driver: {
    label: 'DRIVER',
    damagedEffect: 'DAZED (SLOW STEER)',
    destroyedEffect: 'KNOCKED OUT (NO DRIVE)',
  },
  ammo_hull: {
    label: 'HULL AMMO RACK',
    damagedEffect: 'PROPELLANT DAMAGED',
    destroyedEffect: 'DETONATED (INSTANT KILL)',
  },
  turret_ring: {
    label: 'TURRET RING',
    damagedEffect: 'TRAVERSE SLOWED',
    destroyedEffect: 'JAMMED (TURRET LOCKED)',
  },
  cannon_breech: {
    label: 'CANNON BREECH',
    damagedEffect: 'DISPERSION INCREASED',
    destroyedEffect: 'DESTROYED (GUN DISABLED)',
  },
  gunner: {
    label: 'GUNNER',
    damagedEffect: 'CONCUSSED',
    destroyedEffect: 'KNOCKED OUT (NO AIM)',
  },
  loader: {
    label: 'LOADER',
    damagedEffect: 'WOUNDED (+50% RELOAD)',
    destroyedEffect: 'KNOCKED OUT (2X RELOAD)',
  },
  ammo_bustle: {
    label: 'TURRET AMMO RACK',
    damagedEffect: 'BLOWOUT PANEL VENTING',
    destroyedEffect: 'DETONATED (INSTANT KILL)',
  },
};

function createFreshModuleStates(): Record<ModuleId, ModuleHealthState> {
  return {
    track_left: 'ok',
    track_right: 'ok',
    engine: 'ok',
    driver: 'ok',
    ammo_hull: 'ok',
    turret_ring: 'ok',
    cannon_breech: 'ok',
    gunner: 'ok',
    loader: 'ok',
    ammo_bustle: 'ok',
  };
}

const _tmpVecA = new THREE.Vector3();
const _tmpVecB = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _crushDir = new THREE.Vector2();

export class Tank implements TankEntity {
  public readonly id: string;
  public readonly team: Team;
  public readonly isHuman: boolean;
  public readonly callsign: string;
  public readonly stats: TankStats;
  public readonly root: THREE.Group;

  public position = new THREE.Vector3();
  public velocity = new THREE.Vector3();
  public hullYaw = 0;
  public turretRelYaw = 0;
  public gunPitch = 0;
  public speed = 0;

  public hp: number;
  public readonly maxHp: number;
  public alive = true;
  public respawnTimer = 0;
  private spawnProtect = 0;

  public cannonCooldown = 0;
  public mgCooldown = 0;
  public mgHeat = 0;
  public mgOverheated = false;
  public selectedShellIndex: 0 | 1 = 0;
  public lastXRayReport: ShellHitXRayReport | null = null;

  public modules: Record<ModuleId, ModuleHealthState> = createFreshModuleStates();
  private trackRepairTimer = 0;
  private driverRecoverTimer = 0;
  private gunnerRecoverTimer = 0;
  private breechRepairTimer = 0;
  private engineFireTimer = 0;
  private fireSmokeAccum = 0;

  private readonly rig: InstantiatedTankRig;
  private readonly originalColors = new Map<THREE.MeshStandardMaterial, THREE.Color>();

  private suspPitch = 0;
  private suspRoll = 0;
  private suspPitchVel = 0;
  private suspRollVel = 0;
  private prevSpeed = 0;
  private barrelRecoilZ = 0;
  private barrelRecoilVel = 0;
  private dustAccum = 0;
  private wreckSmokeAccum = 0;

  constructor(
    id: string,
    team: Team,
    vehicleClass: VehicleClass,
    assets: LoadedGameAssets,
    spawnPos: THREE.Vector3,
    spawnYaw: number,
    isHuman: boolean,
    callsign: string
  ) {
    this.id = id;
    this.team = team;
    this.isHuman = isHuman;
    this.callsign = callsign;
    this.stats = TANK_STATS[vehicleClass];
    this.maxHp = this.stats.maxHp;
    this.hp = this.maxHp;

    this.rig = instantiateTankRig(assets, vehicleClass, team);
    this.root = this.rig.root;

    for (const mesh of this.rig.hullMeshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial;
        if (std?.isMeshStandardMaterial && !this.originalColors.has(std)) {
          this.originalColors.set(std, std.color.clone());
        }
      }
    }

    this.respawnAt(spawnPos, spawnYaw);
  }

  public get activeShell(): ShellSpec {
    return this.stats.shells[this.selectedShellIndex];
  }

  public get turretWorldYaw(): number {
    return wrapAnglePi(this.hullYaw + this.turretRelYaw);
  }

  public stepKinematics(
    dt: number,
    intent: TankIntent | null,
    world: TerrainQuery,
    allTanks: readonly Tank[],
    callbacks?: {
      onFireCannon?: (tank: Tank, pos: THREE.Vector3, dir: THREE.Vector3, shell: ShellSpec) => void;
      onFireMG?: (tank: Tank, pos: THREE.Vector3, dir: THREE.Vector3, beltSpec?: ShellSpec) => void;
      onTrackDust?: (pos: THREE.Vector3, intensity01: number) => void;
      onWreckSmoke?: (pos: THREE.Vector3) => void;
    }
  ): void {
    const safeDt = Math.min(dt, 0.05);

    if (!this.alive) {
      this.respawnTimer = Math.max(0, this.respawnTimer - safeDt);
      if (Math.abs(this.speed) > 0.02) {
        this.speed *= Math.exp(-4.5 * safeDt);
        this.velocity.set(Math.sin(this.hullYaw) * this.speed, 0, Math.cos(this.hullYaw) * this.speed);
        this.position.x += this.velocity.x * safeDt;
        this.position.z += this.velocity.z * safeDt;
        this.alignHullToTerrain(world, safeDt, 0);
      }

      this.wreckSmokeAccum += safeDt;
      if (this.wreckSmokeAccum >= 0.14) {
        this.wreckSmokeAccum = 0;
        _tmpVecA.copy(this.position);
        _tmpVecA.y += 1.65;
        callbacks?.onWreckSmoke?.(_tmpVecA);
      }
      return;
    }

    // Handle shell/ammo belt switch ([1] / [2] / [Q])
    if (intent?.selectShell === 0 || intent?.selectShell === 1) {
      if (this.selectedShellIndex !== intent.selectShell) {
        this.selectedShellIndex = intent.selectShell;
        // Brief chamber switch delay only on heavy breech-loaded cannons, instant on IFV dual-feed
        if (this.stats.hasMainCannon) {
          this.cannonCooldown = Math.max(this.cannonCooldown, 0.45);
        }
      }
    }

    this.cannonCooldown = Math.max(0, this.cannonCooldown - safeDt);
    this.mgCooldown = Math.max(0, this.mgCooldown - safeDt);
    this.spawnProtect = Math.max(0, this.spawnProtect - safeDt);

    if (this.trackRepairTimer > 0) {
      this.trackRepairTimer = Math.max(0, this.trackRepairTimer - safeDt);
      if (this.trackRepairTimer === 0) {
        if (this.modules.track_left === 'destroyed') this.modules.track_left = 'damaged';
        if (this.modules.track_right === 'destroyed') this.modules.track_right = 'damaged';
      }
    }
    if (this.driverRecoverTimer > 0) {
      this.driverRecoverTimer = Math.max(0, this.driverRecoverTimer - safeDt);
    }
    if (this.gunnerRecoverTimer > 0) {
      this.gunnerRecoverTimer = Math.max(0, this.gunnerRecoverTimer - safeDt);
    }
    if (this.breechRepairTimer > 0) {
      this.breechRepairTimer = Math.max(0, this.breechRepairTimer - safeDt);
      if (this.breechRepairTimer === 0 && this.modules.cannon_breech === 'destroyed') {
        this.modules.cannon_breech = 'damaged';
      }
    }
    if (this.engineFireTimer > 0 && this.alive) {
      this.engineFireTimer = Math.max(0, this.engineFireTimer - safeDt);
      this.fireSmokeAccum += safeDt;
      if (this.fireSmokeAccum >= 0.14) {
        this.fireSmokeAccum = 0;
        const sinE = Math.sin(this.hullYaw);
        const cosE = Math.cos(this.hullYaw);
        _tmpVecA.set(
          this.position.x - sinE * 2.5,
          this.position.y + 1.55,
          this.position.z - cosE * 2.5
        );
        callbacks?.onWreckSmoke?.(_tmpVecA);
      }
      this.hp = Math.max(1, this.hp - 24 * safeDt);
    }

    const tracksSevered =
      this.modules.track_left === 'destroyed' || this.modules.track_right === 'destroyed';
    const tracksDamaged =
      this.modules.track_left === 'damaged' || this.modules.track_right === 'damaged';
    const driverOut = this.driverRecoverTimer > 0;

    let mobilityMult = 1.0;
    let turnMult = 1.0;
    if (tracksSevered) {
      mobilityMult = 0.0;
      turnMult = 0.15;
    } else if (driverOut) {
      mobilityMult = 0.0;
      turnMult = 0.0;
    } else {
      if (tracksDamaged) {
        mobilityMult *= 0.65;
        turnMult *= 0.7;
      }
      if (this.modules.engine === 'destroyed') {
        mobilityMult *= 0.14;
        turnMult *= 0.35;
      } else if (this.modules.engine === 'damaged') {
        mobilityMult *= 0.48;
      }
      if (this.modules.driver === 'damaged') {
        turnMult *= 0.65;
      }
    }

    const gunnerDisabled = this.gunnerRecoverTimer > 0;
    const isIFV = !this.stats.hasMainCannon;
    // On IFV ("only machine gun, infinite ammo"), both LMB (fireCannon) and Space (fireMG) fire the 30mm autocannon/MG!
    const rawMGTrigger = isIFV ? Boolean(intent?.fireCannon || intent?.fireMG) : Boolean(intent?.fireMG);
    const gunBarrelBroken = isIFV && this.modules.cannon_breech === 'destroyed';
    const wantsMG = Boolean(
      rawMGTrigger && this.stats.hasCoaxMG && !this.mgOverheated && !gunnerDisabled && !gunBarrelBroken
    );

    if (this.stats.infiniteMG) {
      this.mgHeat = 0;
      this.mgOverheated = false;
    } else if (!wantsMG) {
      const coolRate = this.mgOverheated ? 0.32 : 0.44;
      this.mgHeat = Math.max(0, this.mgHeat - coolRate * safeDt);
      if (this.mgOverheated && this.mgHeat <= 0.15) {
        this.mgOverheated = false;
      }
    }

    const rawThrottle = intent ? THREE.MathUtils.clamp(intent.throttle, -1, 1) : 0;
    const rawSteer = intent ? THREE.MathUtils.clamp(intent.steer, -1, 1) : 0;
    const throttle = rawThrottle * mobilityMult;
    const steer = rawSteer * turnMult;
    const brake = Boolean(intent?.brake) || tracksSevered || driverOut;

    this.prevSpeed = this.speed;
    if (brake) {
      const decel = this.stats.brakeDecel * safeDt;
      if (Math.abs(this.speed) <= decel) this.speed = 0;
      else this.speed -= Math.sign(this.speed) * decel;
    } else if (Math.abs(throttle) > 0.02) {
      const maxFwd = this.stats.maxForwardSpeed * mobilityMult;
      const maxRev = this.stats.maxReverseSpeed * mobilityMult;
      if (throttle > 0) {
        const accel = this.speed < 0 ? this.stats.brakeDecel : this.stats.forwardAccel * mobilityMult;
        this.speed = Math.min(maxFwd, this.speed + accel * rawThrottle * safeDt);
      } else {
        const accel = this.speed > 0 ? this.stats.brakeDecel : this.stats.reverseAccel * mobilityMult;
        this.speed = Math.max(-maxRev, this.speed + accel * rawThrottle * safeDt);
      }
    } else {
      const drag = 6.2 * safeDt;
      if (Math.abs(this.speed) <= drag) this.speed = 0;
      else this.speed -= Math.sign(this.speed) * drag;
    }

    const roadBoost = 1.0 + 0.08 * world.getRoadFactorAt(this.position.x, this.position.z);
    const effectiveSpeed = this.speed * roadBoost;

    const reverseSteerSign = this.speed < -0.6 ? -1 : 1;
    const angularVel = steer * reverseSteerSign * this.stats.hullTurnRate;
    this.hullYaw = wrapAnglePi(this.hullYaw + angularVel * safeDt);

    const sinH = Math.sin(this.hullYaw);
    const cosH = Math.cos(this.hullYaw);
    this.velocity.set(sinH * effectiveSpeed, 0, cosH * effectiveSpeed);

    this.position.x += this.velocity.x * safeDt;
    this.position.z += this.velocity.z * safeDt;

    const bound = world.worldHalfSize - 8;
    if (Math.abs(this.position.x) > bound) {
      this.position.x = Math.sign(this.position.x) * bound;
      this.speed *= 0.65;
    }
    if (Math.abs(this.position.z) > bound) {
      this.position.z = Math.sign(this.position.z) * bound;
      this.speed *= 0.65;
    }

    this.resolveCollisions(world, allTanks);

    const longitudinalAccel = (this.speed - this.prevSpeed) / Math.max(safeDt, 0.001);
    this.alignHullToTerrain(world, safeDt, longitudinalAccel);

    if (this.rig.wheels.length > 0 && (Math.abs(effectiveSpeed) > 0.01 || Math.abs(angularVel) > 0.01)) {
      const halfTrack = 1.45;
      const vLeft = effectiveSpeed - angularVel * halfTrack;
      const vRight = effectiveSpeed + angularVel * halfTrack;
      for (const w of this.rig.wheels) {
        const trackV = w.side === 'L' ? vLeft : vRight;
        w.node.rotation.x += (trackV * safeDt) / w.radius;
      }
    }

    const absSpd = Math.abs(effectiveSpeed);
    if (absSpd > 3.0 && callbacks?.onTrackDust) {
      this.dustAccum += safeDt * (0.4 + absSpd * 0.45);
      if (this.dustAccum >= 0.16) {
        this.dustAccum = 0;
        const intensity = THREE.MathUtils.clamp(absSpd / this.stats.maxForwardSpeed, 0.2, 0.9);
        const rightX = -cosH;
        const rightZ = sinH;
        const rearDist = -3.2 * Math.sign(effectiveSpeed || 1);
        _tmpVecA.set(
          this.position.x + sinH * rearDist + rightX * 1.4,
          this.position.y + 0.25,
          this.position.z + cosH * rearDist + rightZ * 1.4
        );
        callbacks.onTrackDust(_tmpVecA, intensity);
      }
    }

    if (intent) {
      this.updateTurretAndGunAim(intent.aimPoint, safeDt);
    }

    const recoilSpringK = 95;
    const recoilDamp = 16;
    const recoilAcc = -recoilSpringK * this.barrelRecoilZ - recoilDamp * this.barrelRecoilVel;
    this.barrelRecoilVel += recoilAcc * safeDt;
    this.barrelRecoilZ += this.barrelRecoilVel * safeDt;
    if (this.barrelRecoilZ > 0.01) this.barrelRecoilZ = 0.01;
    this.rig.gunRecoilGroup.position.z = this.barrelRecoilZ;

    // Lightweight ancestor-only world matrix sync on muzzleNode instead of 35-mesh full subtree traversal!
    this.rig.muzzleNode.updateWorldMatrix(true, false);

    // Fire main cannon (Normal MBT & Heavy Tank)
    if (this.stats.hasMainCannon) {
      const canFireCannon =
        this.modules.cannon_breech !== 'destroyed' && this.gunnerRecoverTimer <= 0;
      if (intent?.fireCannon && this.cannonCooldown <= 0 && canFireCannon) {
        const loaderPenalty =
          this.modules.loader === 'destroyed'
            ? 2.0
            : this.modules.loader === 'damaged'
              ? 1.5
              : 1.0;
        this.cannonCooldown = this.stats.cannonReloadTime * loaderPenalty;
        this.getMuzzleWorld(_tmpVecA, _tmpVecB);
        callbacks?.onFireCannon?.(this, _tmpVecA, _tmpVecB, this.activeShell);
      }
    }

    // Fire Coax MG (Normal/Heavy) OR Primary Infinite-Ammo 30mm Chain-Gun (IFV)
    if (wantsMG && this.mgCooldown <= 0) {
      this.mgCooldown = this.stats.mgFireInterval;
      if (!this.stats.infiniteMG) {
        this.mgHeat = Math.min(1, this.mgHeat + 0.032);
        if (this.mgHeat >= 1) {
          this.mgOverheated = true;
        }
      } else {
        // Subtle crisp chain-gun barrel recoil on IFV!
        this.barrelRecoilZ = -0.09;
        this.barrelRecoilVel = -0.6;
      }
      this.getCoaxWorld(_tmpVecA, _tmpVecB);
      callbacks?.onFireMG?.(
        this,
        _tmpVecA,
        _tmpVecB,
        isIFV ? this.activeShell : undefined
      );
    }
  }

  private updateTurretAndGunAim(worldAimPoint: THREE.Vector3, dt: number): void {
    if (this.gunnerRecoverTimer > 0) return;

    const ringFactor =
      this.modules.turret_ring === 'destroyed'
        ? 0.0
        : this.modules.turret_ring === 'damaged'
          ? 0.42
          : 1.0;

    // Ancestor-only matrix update (root -> hullTiltGroup: 2 matrices instead of 35!)
    this.rig.hullTiltGroup.updateWorldMatrix(true, false);
    _tmpVecA.copy(worldAimPoint);
    this.rig.hullTiltGroup.worldToLocal(_tmpVecA);

    const tp = this.rig.turretPivot.position;
    const dx = _tmpVecA.x - tp.x;
    const dz = _tmpVecA.z - tp.z;
    const desiredRelYaw = Math.atan2(dx, dz);
    const yawDiff = wrapAnglePi(desiredRelYaw - this.turretRelYaw);
    const maxYawStep = this.stats.turretTurnRate * ringFactor * dt;
    this.turretRelYaw = wrapAnglePi(
      this.turretRelYaw + THREE.MathUtils.clamp(yawDiff, -maxYawStep, maxYawStep)
    );
    this.rig.turretPivot.rotation.y = this.turretRelYaw;

    if (this.rig.rwsNode) {
      this.rig.rwsNode.rotation.y = this.turretRelYaw * 0.25;
    }

    this.rig.turretPivot.updateWorldMatrix(false, false);
    _tmpVecB.copy(worldAimPoint);
    this.rig.turretPivot.worldToLocal(_tmpVecB);

    const gp = this.rig.gunPivot.position;
    const gdx = _tmpVecB.x - gp.x;
    const gdy = _tmpVecB.y - gp.y;
    const gdz = _tmpVecB.z - gp.z;
    const horizDist = Math.max(0.5, Math.hypot(gdx, gdz));
    const desiredPitch = THREE.MathUtils.clamp(
      Math.atan2(gdy, horizDist),
      this.stats.gunMinPitch,
      this.stats.gunMaxPitch
    );
    const pitchDiff = desiredPitch - this.gunPitch;
    const maxPitchStep = this.stats.gunElevateRate * dt;
    this.gunPitch = THREE.MathUtils.clamp(
      this.gunPitch + THREE.MathUtils.clamp(pitchDiff, -maxPitchStep, maxPitchStep),
      this.stats.gunMinPitch,
      this.stats.gunMaxPitch
    );

    this.rig.gunPivot.rotation.x = -this.gunPitch;
  }

  private alignHullToTerrain(world: TerrainQuery, dt: number, longitudinalAccel: number): void {
    const sinH = Math.sin(this.hullYaw);
    const cosH = Math.cos(this.hullYaw);
    const rightX = -cosH;
    const rightZ = sinH;

    const hw = 1.45;
    const hl = 2.65;

    const hFL = world.getHeightAt(
      this.position.x + sinH * hl - rightX * hw,
      this.position.z + cosH * hl - rightZ * hw
    );
    const hFR = world.getHeightAt(
      this.position.x + sinH * hl + rightX * hw,
      this.position.z + cosH * hl + rightZ * hw
    );
    const hRL = world.getHeightAt(
      this.position.x - sinH * hl - rightX * hw,
      this.position.z - cosH * hl - rightZ * hw
    );
    const hRR = world.getHeightAt(
      this.position.x - sinH * hl + rightX * hw,
      this.position.z - cosH * hl + rightZ * hw
    );
    const hCenter = world.getHeightAt(this.position.x, this.position.z);

    const avgCornerH = 0.25 * (hFL + hFR + hRL + hRR);
    this.position.y = Math.max(hCenter, avgCornerH);

    const frontAvg = 0.5 * (hFL + hFR);
    const rearAvg = 0.5 * (hRL + hRR);
    const leftAvg = 0.5 * (hFL + hRL);
    const rightAvg = 0.5 * (hFR + hRR);

    const terrainPitch = Math.atan2(frontAvg - rearAvg, hl * 2);
    const terrainRoll = Math.atan2(leftAvg - rightAvg, hw * 2);

    const targetSuspPitch = THREE.MathUtils.clamp(longitudinalAccel * 0.0045, -0.055, 0.055);
    const k = 42;
    const d = 9.5;
    this.suspPitchVel += (k * (targetSuspPitch - this.suspPitch) - d * this.suspPitchVel) * dt;
    this.suspPitch += this.suspPitchVel * dt;

    this.suspRollVel += (-k * this.suspRoll - d * this.suspRollVel) * dt;
    this.suspRoll += this.suspRollVel * dt;

    this.root.position.copy(this.position);
    this.root.rotation.set(0, this.hullYaw, 0);
    this.rig.hullTiltGroup.rotation.set(
      -(terrainPitch + this.suspPitch),
      0,
      -(terrainRoll + this.suspRoll),
      'YXZ'
    );
  }

  private resolveCollisions(world: TerrainQuery, allTanks: readonly Tank[]): void {
    const myR = this.stats.collisionRadius;
    const obstacles = world.getObstacles();

    for (let i = 0; i < obstacles.length; i++) {
      const obs = obstacles[i];
      if (obs.destroyed) continue;
      const dx = this.position.x - obs.x;
      const dz = this.position.z - obs.z;
      const minDist = myR + obs.radius;
      const distSq = dx * dx + dz * dz;
      if (distSq >= minDist * minDist) continue;

      if (obs.destructible && Math.abs(this.speed) > 2.6) {
        _crushDir.set(Math.sin(this.hullYaw) * Math.sign(this.speed), Math.cos(this.hullYaw) * Math.sign(this.speed));
        world.crushObstacle(obs, _crushDir);
        this.speed *= 0.84;
        continue;
      }

      const dist = Math.max(0.001, Math.sqrt(distSq));
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = minDist - dist;
      this.position.x += nx * overlap;
      this.position.z += nz * overlap;

      const forwardDot = Math.sin(this.hullYaw) * nx + Math.cos(this.hullYaw) * nz;
      if ((this.speed > 0 && forwardDot < -0.25) || (this.speed < 0 && forwardDot > 0.25)) {
        this.speed *= 0.35;
      }
    }

    for (let i = 0; i < allTanks.length; i++) {
      const other = allTanks[i];
      if (other === this) continue;
      const dx = this.position.x - other.position.x;
      const dz = this.position.z - other.position.z;
      const minDist = myR + other.stats.collisionRadius;
      const distSq = dx * dx + dz * dz;
      if (distSq >= minDist * minDist) continue;

      const dist = Math.max(0.001, Math.sqrt(distSq));
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = minDist - dist;
      const pushShare = other.alive ? 0.55 : 0.85;
      this.position.x += nx * overlap * pushShare;
      this.position.z += nz * overlap * pushShare;
      if (other.alive) {
        other.position.x -= nx * overlap * (1 - pushShare);
        other.position.z -= nz * overlap * (1 - pushShare);
      }
      this.speed *= 0.72;
    }
  }

  public getMuzzleWorld(outPos: THREE.Vector3, outDir: THREE.Vector3): void {
    this.rig.muzzleNode.updateWorldMatrix(true, false);
    this.rig.muzzleNode.getWorldPosition(outPos);
    this.rig.gunPivot.getWorldQuaternion(_tmpQuat);
    outDir.set(0, 0, 1).applyQuaternion(_tmpQuat).normalize();
  }

  public getCoaxWorld(outPos: THREE.Vector3, outDir: THREE.Vector3): void {
    this.rig.coaxNode.updateWorldMatrix(true, false);
    this.rig.coaxNode.getWorldPosition(outPos);
    this.rig.gunPivot.getWorldQuaternion(_tmpQuat);
    outDir.set(0, 0, 1).applyQuaternion(_tmpQuat).normalize();
  }

  public getCenterMassWorld(outPos: THREE.Vector3): THREE.Vector3 {
    return outPos.set(this.position.x, this.position.y + 1.35, this.position.z);
  }

  public applyRecoil(): void {
    const isHeavy = this.stats.vehicleClass === 'heavy';
    this.barrelRecoilZ = isHeavy ? -0.56 : -0.42;
    this.barrelRecoilVel = isHeavy ? -2.0 : -1.5;

    const relCos = Math.cos(this.turretRelYaw);
    const relSin = Math.sin(this.turretRelYaw);
    this.suspPitchVel += relCos * this.stats.recoilImpulse * 6.5;
    this.suspRollVel -= relSin * this.stats.recoilImpulse * 5.0;
  }

  public takeDamage(
    amount: number,
    hitWorldPos: THREE.Vector3,
    attackerPos?: THREE.Vector3,
    shellDirWorld?: THREE.Vector3,
    weapon: 'cannon' | 'mg' = 'cannon',
    shellSpec?: ShellSpec
  ): boolean {
    if (!this.alive || amount <= 0 || this.spawnProtect > 0) return false;

    const scaledAmt = amount * this.stats.armorDamageMult;

    if (shellDirWorld) {
      return this.applyLocationalPenetration(scaledAmt, hitWorldPos, shellDirWorld, weapon, shellSpec);
    }

    this.lastXRayReport = null;
    this.hp = Math.max(0, this.hp - scaledAmt);
    if (this.hp <= 0) {
      this.killTank(false);
      return true;
    }
    void attackerPos;
    return false;
  }

  private applyLocationalPenetration(
    baseAmount: number,
    hitWorldPos: THREE.Vector3,
    shellDirWorld: THREE.Vector3,
    weapon: 'cannon' | 'mg',
    shellSpec?: ShellSpec
  ): boolean {
    this.rig.hullTiltGroup.updateWorldMatrix(true, false);
    const localHit = _tmpVecA.copy(hitWorldPos);
    this.rig.hullTiltGroup.worldToLocal(localHit);

    const invQuat = _tmpQuat.setFromRotationMatrix(this.rig.hullTiltGroup.matrixWorld).invert();
    const localDir = _tmpVecB.copy(shellDirWorld).applyQuaternion(invQuat).normalize();

    const rayBackX = localHit.x - localDir.x * 3.0;
    const rayBackY = localHit.y - localDir.y * 3.0;
    const rayBackZ = localHit.z - localDir.z * 3.0;

    const tHull = intersectRayAABB(
      rayBackX,
      rayBackY,
      rayBackZ,
      localDir.x,
      localDir.y,
      localDir.z,
      7.5,
      [-1.88, 0.04, -3.96],
      [1.88, 1.60, 3.86]
    );

    const cosT = Math.cos(this.turretRelYaw);
    const sinT = Math.sin(this.turretRelYaw);
    const hullToTurretPos = (hx: number, hy: number, hz: number): [number, number, number] => {
      const rx = hx;
      const ry = hy - 1.62;
      const rz = hz + 0.5;
      return [rx * cosT - rz * sinT, ry, rx * sinT + rz * cosT];
    };
    const hullToTurretDir = (dx: number, dy: number, dz: number): [number, number, number] => [
      dx * cosT - dz * sinT,
      dy,
      dx * sinT + dz * cosT,
    ];

    const [tbOx, tbOy, tbOz] = hullToTurretPos(rayBackX, rayBackY, rayBackZ);
    const [tbDx, tbDy, tbDz] = hullToTurretDir(localDir.x, localDir.y, localDir.z);
    const tTurret = intersectRayAABB(
      tbOx,
      tbOy,
      tbOz,
      tbDx,
      tbDy,
      tbDz,
      7.5,
      [-1.50, 0.0, -2.95],
      [1.50, 0.98, 1.38]
    );
    const tGun = intersectRayAABB(
      tbOx,
      tbOy,
      tbOz,
      tbDx,
      tbDy,
      tbDz,
      7.5,
      [-0.26, 0.16, 1.0],
      [0.26, 0.62, 5.35]
    );

    let bestEntryT: number | null = null;
    for (const cand of [tHull, tTurret, tGun]) {
      if (cand !== null && (bestEntryT === null || cand < bestEntryT)) {
        bestEntryT = cand;
      }
    }

    let ex = THREE.MathUtils.clamp(localHit.x, -1.86, 1.86);
    let ey = THREE.MathUtils.clamp(localHit.y, 0.22, 2.48);
    let ez = THREE.MathUtils.clamp(localHit.z, -3.92, 3.82);
    if (bestEntryT !== null) {
      ex = rayBackX + localDir.x * bestEntryT;
      ey = rayBackY + localDir.y * bestEntryT;
      ez = rayBackZ + localDir.z * bestEntryT;
    }

    let armorZone = 'FRONT GLACIS';
    let zoneDmgMult = 1.0;
    if (ey > 1.60) {
      const [tex, , tez] = hullToTurretPos(ex, ey, ez);
      if (tez > 1.25) {
        armorZone = 'GUN BARREL / MANTLET';
        zoneDmgMult = 0.85;
      } else if (tez < -1.1) {
        armorZone = 'TURRET BUSTLE';
        zoneDmgMult = 1.35;
      } else if (Math.abs(tex) > 1.05) {
        armorZone = 'TURRET SIDE';
        zoneDmgMult = 1.2;
      } else {
        armorZone = 'TURRET CHEEK';
        zoneDmgMult = this.stats.vehicleClass === 'heavy' ? 0.72 : 0.95;
      }
    } else if (Math.abs(ex) > 1.22 && ey < 1.02) {
      armorZone = ex > 0 ? 'LEFT TRACK SPONSON' : 'RIGHT TRACK SPONSON';
      zoneDmgMult = 0.72;
    } else if (ez < -1.45) {
      armorZone = 'REAR ENGINE DECK';
      zoneDmgMult = 1.45;
    } else if (Math.abs(ex) > 1.25) {
      armorZone = ex > 0 ? 'LEFT SIDE HULL' : 'RIGHT SIDE HULL';
      zoneDmgMult = 1.25;
    } else if (this.stats.vehicleClass === 'heavy') {
      zoneDmgMult = 0.75;
    }

    const isAPAutocannon = Boolean(shellSpec && shellSpec.penetrationDepth >= 1.5);
    const penLen = shellSpec
      ? shellSpec.penetrationDepth
      : weapon === 'cannon'
        ? 2.85
        : 0.65;
    const penEnd: [number, number, number] = [
      ex + localDir.x * penLen,
      ey + localDir.y * penLen,
      ez + localDir.z * penLen,
    ];

    const upRef = Math.abs(localDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const basisA = new THREE.Vector3().crossVectors(localDir, upRef).normalize();
    const basisB = new THREE.Vector3().crossVectors(basisA, localDir).normalize();

    const spallOrigin: [number, number, number] = [
      ex + localDir.x * 0.22,
      ey + localDir.y * 0.22,
      ez + localDir.z * 0.22,
    ];

    const spallRays: XRaySpallRay[] = [];
    const moduleBestHit = new Map<ModuleId, { dist: number; weight: number }>();

    const canReachInterior = weapon === 'cannon' || isAPAutocannon || this.stats.vehicleClass === 'ifv';

    const testRayAgainstModules = (
      rox: number,
      roy: number,
      roz: number,
      rdx: number,
      rdy: number,
      rdz: number,
      rLen: number,
      weight: number
    ): { hitAny: boolean } => {
      let hitAny = false;
      const [tox, toy, toz] = hullToTurretPos(rox, roy, roz);
      const [tdx, tdy, tdz] = hullToTurretDir(rdx, rdy, rdz);

      for (const mod of MBT_INTERNAL_MODULES) {
        if (
          !canReachInterior &&
          mod.id !== 'track_left' &&
          mod.id !== 'track_right' &&
          mod.id !== 'cannon_breech'
        ) {
          continue;
        }

        const t =
          mod.space === 'hull'
            ? intersectRayAABB(rox, roy, roz, rdx, rdy, rdz, rLen, mod.min, mod.max)
            : intersectRayAABB(tox, toy, toz, tdx, tdy, tdz, rLen, mod.min, mod.max);

        if (t !== null) {
          hitAny = true;
          const prev = moduleBestHit.get(mod.id);
          if (!prev) {
            moduleBestHit.set(mod.id, { dist: t, weight });
          } else {
            prev.dist = Math.min(prev.dist, t);
            prev.weight += weight;
          }
        }
      }
      return { hitAny };
    };

    const mainSlugWeight = weapon === 'cannon' ? 2.2 : isAPAutocannon ? 0.72 : 0.32;
    testRayAgainstModules(ex, ey, ez, localDir.x, localDir.y, localDir.z, penLen, mainSlugWeight);

    const numSpall = shellSpec ? shellSpec.spallCount : weapon === 'cannon' ? 14 : 2;
    const spallWeight = shellSpec ? shellSpec.spallWeight : weapon === 'cannon' ? 0.38 : 0.08;
    for (let i = 0; i < numSpall; i++) {
      const ang = (i / Math.max(1, numSpall)) * Math.PI * 2 + (i % 2) * 0.25;
      const coneSpread = penLen > 3.2 ? 0.11 + (i % 3) * 0.08 : 0.18 + (i % 3) * 0.14;
      const sdx = localDir.x + basisA.x * Math.cos(ang) * coneSpread + basisB.x * Math.sin(ang) * coneSpread;
      const sdy = localDir.y + basisA.y * Math.cos(ang) * coneSpread + basisB.y * Math.sin(ang) * coneSpread;
      const sdz = localDir.z + basisA.z * Math.cos(ang) * coneSpread + basisB.z * Math.sin(ang) * coneSpread;
      const sNorm = Math.hypot(sdx, sdy, sdz) || 1;
      const ndx = sdx / sNorm;
      const ndy = sdy / sNorm;
      const ndz = sdz / sNorm;

      const spallLen = weapon === 'cannon' ? 1.15 + (i % 3) * 0.35 : 0.75;
      const res = testRayAgainstModules(
        spallOrigin[0],
        spallOrigin[1],
        spallOrigin[2],
        ndx,
        ndy,
        ndz,
        spallLen,
        spallWeight
      );

      spallRays.push({
        start: spallOrigin,
        end: [
          spallOrigin[0] + ndx * spallLen,
          spallOrigin[1] + ndy * spallLen,
          spallOrigin[2] + ndz * spallLen,
        ],
        hitModule: res.hitAny,
      });
    }

    const hitModules: XRayModuleHitEntry[] = [];
    let catastrophicKillReason: string | null = null;

    for (const [modId, hitData] of moduleBestHit.entries()) {
      const prev = this.modules[modId];
      if (prev === 'destroyed') continue;

      let next: ModuleHealthState = prev;
      const isAmmo = modId === 'ammo_hull' || modId === 'ammo_bustle';
      const destroyThresh = isAmmo ? 2.05 : 1.05;

      if (weapon === 'cannon') {
        if (hitData.weight >= destroyThresh || prev === 'damaged') {
          next = 'destroyed';
        } else {
          next = 'damaged';
        }
      } else if (shellSpec) {
        // IFV 30mm APDS/HEI autocannon belts reliably shred modules over a short burst!
        const chance = isAmmo ? 0.25 : 0.52;
        if (Math.random() < chance) {
          next = prev === 'ok' ? 'damaged' : 'destroyed';
        }
      } else if (Math.random() < 0.22) {
        next = prev === 'ok' ? 'damaged' : 'destroyed';
      }

      if (next === prev) continue;
      this.modules[modId] = next;

      if (modId === 'track_left' || modId === 'track_right') {
        if (next === 'destroyed') {
          this.trackRepairTimer = 11.0;
          this.speed *= 0.15;
        }
      } else if (modId === 'engine' && next === 'destroyed') {
        this.engineFireTimer = 7.5;
      } else if (modId === 'driver' && next === 'destroyed') {
        this.driverRecoverTimer = 7.5;
      } else if (modId === 'gunner' && next === 'destroyed') {
        this.gunnerRecoverTimer = 9.0;
      } else if (modId === 'cannon_breech' && next === 'destroyed') {
        this.breechRepairTimer = 14.0;
      } else if (isAmmo && next === 'destroyed') {
        catastrophicKillReason = 'AMMO RACK DETONATED';
      }

      const meta = MODULE_LABELS[modId];
      hitModules.push({
        id: modId,
        label: meta.label,
        effectText: next === 'destroyed' ? meta.destroyedEffect : meta.damagedEffect,
        newState: next,
        hitTime01: THREE.MathUtils.clamp(hitData.dist / Math.max(0.5, penLen), 0.05, 0.92),
      });
    }

    hitModules.sort((a, b) => a.hitTime01 - b.hitTime01);

    const crewOutCount =
      (this.modules.driver === 'destroyed' ? 1 : 0) +
      (this.modules.gunner === 'destroyed' ? 1 : 0) +
      (this.modules.loader === 'destroyed' ? 1 : 0);
    if (!catastrophicKillReason && crewOutCount >= 2) {
      catastrophicKillReason = 'CREW KNOCKED OUT';
    }

    const totalDmg = baseAmount * zoneDmgMult + hitModules.length * (weapon === 'cannon' ? 40 : 8);
    if (catastrophicKillReason) {
      this.hp = 0;
    } else {
      this.hp = Math.max(0, this.hp - totalDmg);
      if (this.hp <= 0) {
        catastrophicKillReason = 'HULL INTEGRITY BREACHED';
      }
    }

    const killed = this.hp <= 0;
    if (killed) {
      this.killTank(catastrophicKillReason === 'AMMO RACK DETONATED');
    }

    // Show X-Ray Hit Cam on every cannon hit, kill, or module-damaging autocannon/MG round!
    if (weapon === 'cannon' || killed || hitModules.length > 0) {
      this.lastXRayReport = {
        armorZone,
        killed,
        killReason: catastrophicKillReason,
        weapon: shellSpec ? 'cannon' : weapon,
        entryLocal: [ex, ey, ez],
        penEndLocal: penEnd,
        dirLocal: [localDir.x, localDir.y, localDir.z],
        turretRelYaw: this.turretRelYaw,
        spallRays,
        hitModules,
        allModuleStates: { ...this.modules },
        hpRemaining: this.hp,
        maxHp: this.maxHp,
      };
    } else {
      this.lastXRayReport = null;
    }

    return killed;
  }

  private killTank(ammoBlowout: boolean): void {
    this.alive = false;
    this.engineFireTimer = 0;
    this.respawnTimer = this.isHuman ? 5.0 : 7.0;
    this.applyWreckAppearance(true);
    this.rig.turretPivot.rotation.z = (Math.random() - 0.5) * (ammoBlowout ? 0.45 : 0.22);
    this.rig.turretPivot.position.y = this.rig.turretRestPos.y + (ammoBlowout ? 0.32 : 0.08);
    this.rig.gunPivot.rotation.x = 0.16;
  }

  public respawnAt(pos: THREE.Vector3, yaw: number): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.hullYaw = wrapAnglePi(yaw);
    this.turretRelYaw = 0;
    this.gunPitch = 0;
    this.speed = 0;
    this.prevSpeed = 0;
    this.hp = this.maxHp;
    this.alive = true;
    this.respawnTimer = 0;
    this.spawnProtect = 3.0;
    this.cannonCooldown = 0;
    this.mgCooldown = 0;
    this.mgHeat = 0;
    this.mgOverheated = false;
    this.lastXRayReport = null;
    this.modules = createFreshModuleStates();
    this.trackRepairTimer = 0;
    this.driverRecoverTimer = 0;
    this.gunnerRecoverTimer = 0;
    this.breechRepairTimer = 0;
    this.engineFireTimer = 0;
    this.fireSmokeAccum = 0;
    this.suspPitch = 0;
    this.suspRoll = 0;
    this.suspPitchVel = 0;
    this.suspRollVel = 0;
    this.barrelRecoilZ = 0;
    this.barrelRecoilVel = 0;

    this.rig.turretPivot.rotation.set(0, 0, 0);
    this.rig.turretPivot.position.copy(this.rig.turretRestPos);
    this.rig.gunPivot.rotation.set(0, 0, 0);
    this.rig.gunRecoilGroup.position.set(0, 0, 0);
    this.applyWreckAppearance(false);

    this.root.position.copy(pos);
    this.root.rotation.set(0, this.hullYaw, 0);
    this.root.updateMatrixWorld(true);
  }

  private applyWreckAppearance(isWreck: boolean): void {
    for (const [mat, origColor] of this.originalColors.entries()) {
      if (isWreck) {
        mat.color.copy(origColor).multiplyScalar(0.24);
        mat.roughness = Math.min(1.0, mat.roughness + 0.3);
      } else {
        mat.color.copy(origColor);
      }
    }
  }
}
