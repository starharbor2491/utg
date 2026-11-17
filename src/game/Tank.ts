import * as THREE from 'three';
import { instantiateTankRig, type InstantiatedTankRig, type LoadedGameAssets } from './AssetLoader';
import {
  DAMAGE_LAYOUTS,
  FIRE_COOKOFF_PER_S,
  FIRE_COOKOFF_PROPELLANT_PER_S,
  FIRE_DURATION_S,
  FIRE_DPS_HULL,
  FIRE_EXTINGUISH_AT_S,
  FIRE_EXTINGUISH_CHANCE,
  KILL_CREDIT_WINDOW_S,
  MIN_CREW_ALIVE,
  REPAIR_TIME_S,
  CREW_RECOVER_S,
  effectiveArmorMm,
  integrityState,
  isRicochet,
  moduleMaxIntegrity,
  postPenPathMm,
  rayBox,
  type CrewRole,
  type ModuleRuntime,
} from './DamageModel';
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
  WreckKillInfo,
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
    penMm: 600,
    moduleDamage: { slug: 1.2, spall: 0.35, spallCount: 14 },
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
    penMm: 60,
    moduleDamage: { slug: 0.8, spall: 0.3, spallCount: 10 },
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
    penMm: 420,
    moduleDamage: { slug: 1.4, spall: 0.4, spallCount: 16 },
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
    penMm: 90,
    moduleDamage: { slug: 1.0, spall: 0.35, spallCount: 12 },
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
    penMm: 90,
    moduleDamage: { slug: 0.55, spall: 0.15, spallCount: 5 },
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
    penMm: 15,
    moduleDamage: { slug: 0.3, spall: 0.1, spallCount: 2 },
    spallCount: 6,
    spallWeight: 0.25,
    explosionScale: 0.36,
    tracerColorRGB: [9.0, 3.2, 0.8],
    dispersionRad: 0.011,
  },
];

const HUMVEE_50CAL: readonly [ShellSpec, ShellSpec] = [
  {
    id: 'humvee_127ap',
    shortCode: '12.7 AP',
    displayName: '12.7MM M2 AP',
    muzzleSpeed: 890,
    directDamage: 9,
    splashDamage: 0,
    splashRadius: 0,
    penetrationDepth: 1.2,
    penMm: 22,
    moduleDamage: { slug: 0.24, spall: 0.08, spallCount: 2 },
    spallCount: 3,
    spallWeight: 0.3,
    explosionScale: 0.18,
    tracerColorRGB: [7.5, 6.8, 4.5],
    dispersionRad: 0.014,
  },
  {
    id: 'humvee_127api',
    shortCode: '12.7 API-T',
    displayName: '12.7MM M2 API-T INCENDIARY',
    muzzleSpeed: 890,
    directDamage: 7,
    splashDamage: 6,
    splashRadius: 2.4,
    penetrationDepth: 0.9,
    penMm: 8,
    moduleDamage: { slug: 0.1, spall: 0, spallCount: 0 },
    spallCount: 4,
    spallWeight: 0.28,
    explosionScale: 0.3,
    tracerColorRGB: [9.0, 4.2, 1.0],
    dispersionRad: 0.016,
  },
];

const ROCKET_GUIDANCE = {
  seekerConeDeg: 50,
  lockTime: 0.6,
  navGain: 3,
  maxAccel: 45,
  boostDelay: 0.25,
  maxRange: 650,
  decoyable: true,
} as const;

const SAM_GUIDANCE = {
  seekerConeDeg: 60,
  lockTime: 0.35,
  navGain: 4,
  maxAccel: 90,
  boostDelay: 0.1,
  maxRange: 700,
  decoyable: true,
} as const;

const SAM_SHELLS: readonly [ShellSpec, ShellSpec] = [
  {
    id: 'sam',
    shortCode: 'SAM',
    displayName: 'SAM MISSILE',
    muzzleSpeed: 90,
    directDamage: 60,
    splashDamage: 120,
    splashRadius: 4,
    penetrationDepth: 0.8,
    penMm: 40,
    moduleDamage: { slug: 0.35, spall: 0.12, spallCount: 4 },
    spallCount: 8,
    spallWeight: 0.4,
    explosionScale: 0.7,
    tracerColorRGB: [9.0, 9.0, 9.5],
    dispersionRad: 0.012,
    rocket: { burnTime: 1.6, thrustAccel: 160 },
    guidance: SAM_GUIDANCE,
  },
  {
    // F5b stub: selectable slot, cannot fire yet.
    id: 'fpv_drone',
    shortCode: 'FPV',
    displayName: 'FPV DRONE',
    muzzleSpeed: 0,
    directDamage: 0,
    splashDamage: 0,
    splashRadius: 0,
    penetrationDepth: 0,
    spallCount: 0,
    spallWeight: 0,
    explosionScale: 0,
    tracerColorRGB: [9, 9, 9],
    dispersionRad: 0,
  },
];

const ROCKET_SHELLS: readonly [ShellSpec, ShellSpec] = [
  {
    id: 'rocket_he',
    shortCode: '227 HE',
    displayName: '227MM HYDRA 70 HE',
    muzzleSpeed: 70,
    directDamage: 520,
    splashDamage: 380,
    splashRadius: 13,
    penetrationDepth: 1.4,
    penMm: 60,
    moduleDamage: { slug: 0.9, spall: 0.3, spallCount: 12 },
    spallCount: 22,
    spallWeight: 0.5,
    explosionScale: 1.8,
    tracerColorRGB: [9.0, 5.5, 1.4],
    dispersionRad: 0.01,
    rocket: { burnTime: 1.2, thrustAccel: 100 },
    guidance: ROCKET_GUIDANCE,
  },
  {
    id: 'rocket_at',
    shortCode: '227 AT',
    displayName: '227MM HYDRA 70 AT',
    muzzleSpeed: 70,
    directDamage: 760,
    splashDamage: 120,
    splashRadius: 5,
    penetrationDepth: 3.2,
    penMm: 700,
    moduleDamage: { slug: 1.2, spall: 0.4, spallCount: 12 },
    spallCount: 14,
    spallWeight: 0.55,
    explosionScale: 1.2,
    tracerColorRGB: [5.5, 7.5, 9.5],
    dispersionRad: 0.01,
    rocket: { burnTime: 1.2, thrustAccel: 100 },
    guidance: ROCKET_GUIDANCE,
  },
];

export const TANK_STATS: Record<VehicleClass, TankStats> = {
  normal: {
    vehicleClass: 'normal',
    displayName: 'NORMAL MBT',
    maxForwardSpeed: 17.2, // ~62 km/h
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
    drive: 'tracked',
    hullHalfWidth: 1.45,
    hullHalfLength: 2.65,
  },
  heavy: {
    vehicleClass: 'heavy',
    displayName: 'HEAVY TANK',
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
    drive: 'tracked',
    hullHalfWidth: 1.5,
    hullHalfLength: 2.7,
  },
  ifv: {
    vehicleClass: 'ifv',
    displayName: 'IFV (AUTO-MG)',
    maxForwardSpeed: 20.5, // ~74 km/h rapid recon IFV
    maxReverseSpeed: 10.5,
    forwardAccel: 12.0,
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
    drive: 'tracked',
    hullHalfWidth: 1.55,
    hullHalfLength: 3.7,
  },
  humvee: {
    vehicleClass: 'humvee',
    displayName: 'HUMVEE (M2 .50CAL)',
    maxForwardSpeed: 25, // ~90 km/h gun truck
    maxReverseSpeed: 8,
    forwardAccel: 8,
    reverseAccel: 6,
    brakeDecel: 24,
    hullTurnRate: 0.9,
    turretTurnRate: 2.2,
    gunElevateRate: 1.4,
    gunMinPitch: -0.2,
    gunMaxPitch: 0.6,
    hasMainCannon: false,
    cannonReloadTime: 0.09,
    shellMuzzleSpeed: HUMVEE_50CAL[0].muzzleSpeed,
    shellDirectDamage: HUMVEE_50CAL[0].directDamage,
    shellSplashDamage: HUMVEE_50CAL[0].splashDamage,
    shellSplashRadius: HUMVEE_50CAL[0].splashRadius,
    shells: HUMVEE_50CAL,
    recoilImpulse: 0.02,
    hitRadius: 1.9,
    collisionRadius: 2.0,
    hasCoaxMG: true,
    infiniteMG: true,
    mgFireInterval: 0.1,
    drive: 'wheeled',
    hullHalfWidth: 1.2,
    hullHalfLength: 2.6,
    wheelbase: 3.05,
  },
  rocket: {
    vehicleClass: 'rocket',
    displayName: 'MLRS ROCKET ARTY',
    maxForwardSpeed: 18.5, // ~67 km/h launcher truck
    maxReverseSpeed: 5.5,
    forwardAccel: 6.2,
    reverseAccel: 4,
    brakeDecel: 20,
    hullTurnRate: 0.7,
    turretTurnRate: 0.7,
    gunElevateRate: 0.35,
    gunMinPitch: 0,
    gunMaxPitch: 1.0,
    hasMainCannon: true,
    cannonReloadTime: 14,
    salvoSize: 6,
    salvoInterval: 0.28,
    shellMuzzleSpeed: ROCKET_SHELLS[0].muzzleSpeed,
    shellDirectDamage: ROCKET_SHELLS[0].directDamage,
    shellSplashDamage: ROCKET_SHELLS[0].splashDamage,
    shellSplashRadius: ROCKET_SHELLS[0].splashRadius,
    shells: ROCKET_SHELLS,
    recoilImpulse: 0.1,
    hitRadius: 2.9,
    collisionRadius: 2.6,
    hasCoaxMG: false,
    infiniteMG: false,
    mgFireInterval: 0.1,
    drive: 'wheeled',
    hullHalfWidth: 1.15,
    hullHalfLength: 3.4,
    wheelbase: 4.4,
  },
  support: {
    vehicleClass: 'support',
    displayName: 'SAM SUPPORT',
    maxForwardSpeed: 18.5, // ~67 km/h same truck as the launcher
    maxReverseSpeed: 5.5,
    forwardAccel: 6.2,
    reverseAccel: 4,
    brakeDecel: 20,
    hullTurnRate: 0.7,
    turretTurnRate: 0.7,
    gunElevateRate: 0.35,
    gunMinPitch: 0,
    gunMaxPitch: 1.0,
    hasMainCannon: true,
    cannonReloadTime: 10, // full 8-round ripple reload
    salvoSize: 8,
    salvoInterval: 0.3,
    shellMuzzleSpeed: SAM_SHELLS[0].muzzleSpeed,
    shellDirectDamage: SAM_SHELLS[0].directDamage,
    shellSplashDamage: SAM_SHELLS[0].splashDamage,
    shellSplashRadius: SAM_SHELLS[0].splashRadius,
    shells: SAM_SHELLS,
    recoilImpulse: 0.08,
    hitRadius: 2.9,
    collisionRadius: 2.6,
    hasCoaxMG: false,
    infiniteMG: false,
    mgFireInterval: 0.1,
    drive: 'wheeled',
    hullHalfWidth: 1.15,
    hullHalfLength: 3.4,
    wheelbase: 4.4,
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
  engine: { label: 'ENGINE', damagedEffect: 'POWER LOSS (-40%)', destroyedEffect: 'DESTROYED (IMMOBILE)' },
  fuel: { label: 'FUEL', damagedEffect: 'FUEL LEAK', destroyedEffect: 'FIRE / EXPLOSION' },
  ammo: { label: 'AMMO', damagedEffect: 'PROPELLANT DAMAGED', destroyedEffect: 'DETONATION / COOK-OFF' },
  track_left: { label: 'LEFT TRACK', damagedEffect: 'TRACTION REDUCED', destroyedEffect: 'SEVERED (IMMOBILIZED)' },
  track_right: { label: 'RIGHT TRACK', damagedEffect: 'TRACTION REDUCED', destroyedEffect: 'SEVERED (IMMOBILIZED)' },
  wheels_left: { label: 'LEFT WHEELS', damagedEffect: 'TYRE DAMAGE', destroyedEffect: 'WHEELS DESTROYED' },
  wheels_right: { label: 'RIGHT WHEELS', damagedEffect: 'TYRE DAMAGE', destroyedEffect: 'WHEELS DESTROYED' },
  turret_ring: { label: 'TURRET RING', damagedEffect: 'TRAVERSE SLOWED', destroyedEffect: 'JAMMED (TURRET LOCKED)' },
  gun: { label: 'GUN', damagedEffect: 'DISPERSION INCREASED', destroyedEffect: 'GUN DISABLED' },
  launcher: { label: 'LAUNCHER', damagedEffect: 'RELOAD SLOWED', destroyedEffect: 'LAUNCHER DESTROYED' },
  driver: { label: 'DRIVER', damagedEffect: 'WOUNDED (SLOW)', destroyedEffect: 'KNOCKED OUT' },
  gunner: { label: 'GUNNER', damagedEffect: 'CONCUSSED', destroyedEffect: 'KNOCKED OUT' },
  commander: { label: 'COMMANDER', damagedEffect: 'WOUNDED', destroyedEffect: 'KNOCKED OUT' },
  loader: { label: 'LOADER', damagedEffect: 'WOUNDED', destroyedEffect: 'KNOCKED OUT' },
};

const ALL_MODULE_IDS: readonly ModuleId[] = [
  'engine', 'fuel', 'ammo', 'track_left', 'track_right', 'wheels_left', 'wheels_right',
  'turret_ring', 'gun', 'launcher', 'driver', 'gunner', 'commander', 'loader',
];

function createModuleStates(cls: VehicleClass): Map<ModuleId, import('./DamageModel').ModuleRuntime> {
  const layout = DAMAGE_LAYOUTS[cls];
  const map = new Map<ModuleId, import('./DamageModel').ModuleRuntime>();
  for (const def of layout.modules) {
    const maxI = moduleMaxIntegrity(def.id);
    map.set(def.id, {
      id: def.id,
      integrity: maxI,
      maxIntegrity: maxI,
      part: 'hull',
      external: false,
      crew: def.crew ?? null,
      boxes: [],
    });
  }
  return map;
}

const _tmpVecA = new THREE.Vector3();
const _tmpVecB = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _crushDir = new THREE.Vector2();
const _seekOrigin = new THREE.Vector3();
const _seekDir = new THREE.Vector3();
const _seekTo = new THREE.Vector3();
const _seekLos = new THREE.Vector3();

// Damage-model scratch (never stored)
const _partInvM4 = new THREE.Matrix4();
const _hO = new THREE.Vector3();
const _hD = new THREE.Vector3();
const _tO = new THREE.Vector3();
const _tD = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _entryW = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _slugO = new THREE.Vector3();
const _spallOrg = new THREE.Vector3();
const _spallDir = new THREE.Vector3();
const _upRef = new THREE.Vector3();
const _basisA = new THREE.Vector3();
const _basisB = new THREE.Vector3();
const _sO = new THREE.Vector3();
const _sD = new THREE.Vector3();
const _sO2 = new THREE.Vector3();
const _sD2 = new THREE.Vector3();
const _blastO = new THREE.Vector3();
const _blastD = new THREE.Vector3();

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

  public hitCounter = 0;
  /** QA: last takeDamage internals (entry face, pen, modules hit). */
  public dbgTakeDamage: { amount: number; entryPart: string | null; penetrated: boolean; ricochet: boolean; armorZone: string; modulesHit: number; aliveAfterBlast?: boolean; applied?: number } | null = null;
  public dbgDamageCalls = 0;
  public crewAlive = 0;
  public crewTotal = 0;
  public alive = true;
  public respawnTimer = 0;
  private spawnProtect = 0;

  public cannonCooldown = 0;
  public mgCooldown = 0;
  public dispersionMult = 1;
  public mgHeat = 0;
  public mgOverheated = false;
  public selectedShellIndex: 0 | 1 = 0;
  public lastXRayReport: ShellHitXRayReport | null = null;

  // ---- Damage model state ----
  /** Per-class module integrity map (only modules in the class layout exist). */
  public readonly modules: Map<ModuleId, ModuleRuntime> = new Map();
  /** Part bounding boxes in part-local metres, measured at rig build. */
  private hullBoundsMin = new THREE.Vector3();
  private hullBoundsSize = new THREE.Vector3();
  private turretBoundsMin = new THREE.Vector3();
  private turretBoundsSize = new THREE.Vector3();
  private layout = DAMAGE_LAYOUTS.normal;
  /** Module repair countdowns (destroyed -> damaged). */
  private repairTimers = new Map<ModuleId, number>();
  /** Crew seat recovery countdowns (destroyed -> wounded refill). */
  private crewOutTimers = new Map<CrewRole, number>();
  /** Internal fire state. */
  private fireT = 0;
  private fireElapsed = 0;
  private firePropellant = false;
  private extinguisherDone = false;
  private fireSmokeAccum = 0;
  private cookOffAccum = 0;
  /** Kill credit: last enemy to damage this tank. */
  private lastAttacker: TankEntity | null = null;
  private lastDamageAt = -999;
  private _clock = 0;

  public readonly rig: InstantiatedTankRig;

  private suspPitch = 0;
  private suspRoll = 0;
  private suspRollTarget = 0;
  private suspPitchVel = 0;
  private suspRollVel = 0;
  private prevSpeed = 0;
  private barrelRecoilZ = 0;
  private barrelRecoilVel = 0;
  private dustAccum = 0;

  // Last-hit context captured in takeDamage for the destruction manager
  private readonly _dkHitPoint = new THREE.Vector3();
  private readonly _dkShellDir = new THREE.Vector3();
  private _dkHasDir = false;
  private _dkWeapon: 'cannon' | 'mg' = 'cannon';
  private _dkDamage = 0;
  private _dkShellSpec: ShellSpec | null = null;
  private _dkKillReason: string | null = null;
  /** True while inside takeDamage — kills there are reported by the caller via the return value. */
  private _inTakeDamage = false;
  /** Kill reason of the most recent death (until respawn). */
  public get lastKillReason(): string | null {
    return this._dkKillReason;
  }
  /** Per-class module boxes (part-local metres) for the X-Ray hit cam. */
  private _xrayBoxes: NonNullable<ShellHitXRayReport['moduleBoxes']> = [];
  /** Wired by main.ts — internal kills (fire cook-off, ammo/fuel detonation) report here for scoring/feed. */
  public onKillEvent: ((ev: { victim: TankEntity; attacker: TankEntity | null; killed: boolean; hitPoint: THREE.Vector3; weapon: 'cannon' | 'mg'; amount: number; killReason: string | null }) => void) | null = null;
  /** Wired by main.ts — spawns the persistent physical wreck on kill */
  public onDestroyed: ((info: WreckKillInfo) => void) | null = null;

  // Wheeled drive state
  private steerAngle = 0;
  private wheelDistAccum = 0;

  // Rocket pod salvo state
  private salvoActive = false;
  private salvoTimer = 0;
  private salvoFired = 0;
  private _rocketsLeft = 0;
  private salvoSpec: ShellSpec | null = null;
  private salvoGuideTarget: TankEntity | null = null;

  // Guided-munition seeker state (salvo classes only)
  private seekerTarget: TankEntity | null = null;
  private seekerProgress = 0;
  private seekerLocked = false;
  private seekerOffTimer = 0;
  private seekerScanTimer = 0;
  private readonly _seekerLockView = {
    target: null as TankEntity | null,
    progress: 0,
    locked: false,
  };
  /** QA: forces this tank to drive a circle (guidedTest target). */
  public qaDriveCircle: { cx: number; cz: number; radius: number; speed: number; phase: number } | null = null;

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

    this.rig = instantiateTankRig(assets, vehicleClass, team);
    this.root = this.rig.root;
    this._initDamageModel(vehicleClass);

    this.respawnAt(spawnPos, spawnYaw);
  }

  public get activeShell(): ShellSpec {
    return this.stats.shells[this.selectedShellIndex];
  }

  /** Rocket pods: rounds remaining in the current pod (0 once empty until reload finishes). */
  public get rocketsLeft(): number {
    return this.stats.salvoSize ? this._rocketsLeft : 0;
  }

  public get salvoInProgress(): boolean {
    return this.salvoActive;
  }

  /** Seeker lock state for HUD/bots (reused view object — read synchronously).
   *  Undefined for classes without guided munitions. */
  public get seekerLock():
    | {
        readonly target: TankEntity | null;
        readonly progress: number;
        readonly locked: boolean;
      }
    | undefined {
    if (!this.stats.salvoSize || !this.activeShell.guidance) return undefined;
    const v = this._seekerLockView;
    v.target = this.seekerTarget;
    v.progress = this.seekerProgress;
    v.locked = this.seekerLocked;
    return v;
  }

  /** Drops the seeker lock (off-screen target, manual reset). */
  public dropSeekerLock(): void {
    this.seekerTarget = null;
    this.seekerProgress = 0;
    this.seekerLocked = false;
    this.seekerOffTimer = 0;
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
      onFireCannon?: (tank: Tank, pos: THREE.Vector3, dir: THREE.Vector3, shell: ShellSpec, guideTarget?: TankEntity | null) => void;
      onFireMG?: (tank: Tank, pos: THREE.Vector3, dir: THREE.Vector3, beltSpec?: ShellSpec) => void;
      onTrackDust?: (pos: THREE.Vector3, intensity01: number) => void;
      onWaterWake?: (pos: THREE.Vector3, intensity01: number) => void;
      onWreckSmoke?: (pos: THREE.Vector3) => void;
    },
    seekerExtras?: readonly TankEntity[]
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

      return;
    }

    // QA-driven circular target path (guidedTest): kinematic placement, no
    // weapons fire, turret still tracks the supplied aim point.
    if (this.qaDriveCircle) {
      const d = this.qaDriveCircle;
      d.phase += (d.speed * safeDt) / d.radius;
      const px = d.cx + Math.cos(d.phase) * d.radius;
      const pz = d.cz + Math.sin(d.phase) * d.radius;
      this.hullYaw = Math.atan2(-Math.sin(d.phase), Math.cos(d.phase));
      this.position.set(px, 0, pz);
      this.speed = d.speed;
      this.velocity.set(Math.sin(this.hullYaw) * d.speed, 0, Math.cos(this.hullYaw) * d.speed);
      this.alignHullToTerrain(world, safeDt, 0);
      if (intent) this.updateTurretAndGunAim(intent.aimPoint, safeDt);
      this.rig.articulate?.(this.gunPitch);
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

    this._clock += safeDt;

    // ---- module repairs & crew seat recovery (need >=2 crew, only while not on fire) ----
    const canRecover = this.alive && this.fireT <= 0 && this.crewAlive >= MIN_CREW_ALIVE;
    if (canRecover) {
      for (const [id, t] of this.repairTimers) {
        const nt = t - safeDt;
        if (nt <= 0) {
          const rt = this.modules.get(id);
          if (rt && rt.integrity <= 0) rt.integrity = 0.6; // destroyed -> damaged
          this.repairTimers.delete(id);
        } else {
          this.repairTimers.set(id, nt);
        }
      }
      for (const [role, t] of this.crewOutTimers) {
        const nt = t - safeDt;
        if (nt <= 0) {
          this.crewOutTimers.delete(role);
          const rt = this.modules.get(role as ModuleId);
          if (rt && rt.integrity <= 0) {
            let otherAlive = false;
            for (const c of this.modules.values()) {
              if (c.crew && c.id !== role && c.integrity > 0) {
                otherAlive = true;
                break;
              }
            }
            if (otherAlive) {
              rt.integrity = 0.5; // seat refilled by another crewman (wounded)
              this._recountCrew();
            }
          }
        } else {
          this.crewOutTimers.set(role, nt);
        }
      }
    }

    // ---- internal fire: burns hull crew + engine, cooks off ammo ----
    if (this.fireT > 0 && this.alive) {
      this.fireT = Math.max(0, this.fireT - safeDt);
      this.fireElapsed += safeDt;
      this.fireSmokeAccum += safeDt;
      if (this.fireSmokeAccum >= 0.14) {
        this.fireSmokeAccum = 0;
        callbacks?.onWreckSmoke?.(this._fireAnchorPos(_tmpVecA));
      }
      if (!this.extinguisherDone && this.fireElapsed >= FIRE_EXTINGUISH_AT_S) {
        this.extinguisherDone = true;
        if (Math.random() < FIRE_EXTINGUISH_CHANCE) this.fireT = 0;
      }
      for (const rt of this.modules.values()) {
        if (rt.integrity <= 0) continue;
        const isHullCrew = rt.crew !== null && rt.boxes[0]?.part === 'hull';
        if (rt.id === 'engine' || isHullCrew) {
          this._damageModule(rt.id, FIRE_DPS_HULL * safeDt);
        }
      }
      this.cookOffAccum += safeDt * (this.firePropellant ? FIRE_COOKOFF_PROPELLANT_PER_S : FIRE_COOKOFF_PER_S);
      if (this.cookOffAccum >= 1 && this.alive) {
        this.cookOffAccum -= 1;
        const ammo = this.modules.get('ammo');
        if (ammo && ammo.integrity > 0) {
          ammo.integrity = 0;
          this._recountCrew();
          this.killTank(true, 'COOK-OFF');
        }
      }
    } else {
      this.fireSmokeAccum = 0;
    }

    // ---- derived module effects ----
    const mst = (id: ModuleId): ModuleHealthState => {
      const rt = this.modules.get(id);
      return rt ? integrityState(rt.integrity) : 'ok';
    };
    const tracksSevered = mst('track_left') === 'destroyed' || mst('track_right') === 'destroyed';
    const driverOut = mst('driver') === 'destroyed';
    const gunnerOut = mst('gunner') === 'destroyed';

    let mobilityMult = 1.0;
    let turnMult = 1.0;
    let wheelPull = 0;
    if (tracksSevered || driverOut || mst('engine') === 'destroyed') {
      mobilityMult = 0;
      turnMult = tracksSevered ? 0.15 : 0;
    } else {
      if (mst('track_left') === 'damaged') mobilityMult *= 0.75;
      if (mst('track_right') === 'damaged') mobilityMult *= 0.75;
      if (mst('engine') === 'damaged') mobilityMult *= 0.6;
      if (mst('driver') === 'damaged') {
        mobilityMult *= 0.7;
        turnMult *= 0.7;
      }
      if (this.stats.drive === 'wheeled') {
        const wl = mst('wheels_left');
        const wr = mst('wheels_right');
        if (wl === 'destroyed' || wr === 'destroyed') {
          mobilityMult *= 0.35;
          if (wl === 'destroyed') wheelPull += 0.5;
          if (wr === 'destroyed') wheelPull -= 0.5;
        } else {
          if (wl === 'damaged') mobilityMult *= 0.8;
          if (wr === 'damaged') mobilityMult *= 0.8;
        }
      }
    }

    const gunSt = mst('gun');
    const launcherSt = mst('launcher');
    const primarySt = mst(this.stats.salvoSize ? 'launcher' : 'gun');
    const primaryOut = primarySt === 'destroyed';
    const gunnerDisabled = gunnerOut;
    const isIFV = !this.stats.hasMainCannon;
    // On IFV ("only machine gun, infinite ammo"), both LMB (fireCannon) and Space (fireMG) fire the 30mm autocannon/MG!
    const rawMGTrigger = isIFV ? Boolean(intent?.fireCannon || intent?.fireMG) : Boolean(intent?.fireMG);
    // Classes without a separate main cannon lose their only weapon when 'gun' dies;
    // MBTs/heavy keep the coax MG when the main gun is knocked out.
    const mgWeaponOut = !this.stats.hasMainCannon && gunSt === 'destroyed';
    const wantsMG = Boolean(
      rawMGTrigger && this.stats.hasCoaxMG && !this.mgOverheated && !gunnerDisabled && !mgWeaponOut
    );
    this.dispersionMult = gunSt === 'damaged' ? 2.5 : 1.0;
    const loaderSt = mst('loader');
    const reloadMult =
      (launcherSt === 'damaged' ? 2 : 1) *
      (loaderSt === 'destroyed' ? 1.6 : loaderSt === 'damaged' ? 1.43 : 1);
    const ringSt = mst('turret_ring');
    const turretTraverseMult =
      (ringSt === 'destroyed' ? 0 : ringSt === 'damaged' ? 0.5 : 1) * (mst('gunner') === 'damaged' ? 0.7 : 1);
    const canFirePrimary = !primaryOut && !gunnerOut;
    void primarySt;

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

    // Fording: depth > 0.25 m scrubs top speed (tracked -> x0.5, wheeled -> x0.35
    // at 1.1 m) and bleeds acceleration; wakes replace track dust in water.
    const waterDepth = world.getWaterDepthAt?.(this.position.x, this.position.z) ?? 0;
    const fordT = waterDepth > 0.25 ? Math.min(1.1, waterDepth) / 1.1 : 0;
    const fordMul =
      fordT > 0
        ? this.stats.drive === 'wheeled'
          ? 1 - 0.65 * fordT
          : 1 - 0.5 * fordT
        : 1;
    const accelMul = fordT > 0 ? 0.72 : 1;

    const rawThrottle = intent ? THREE.MathUtils.clamp(intent.throttle, -1, 1) : 0;
    const rawSteer = intent ? THREE.MathUtils.clamp(intent.steer, -1, 1) : 0;
    const throttle = rawThrottle * mobilityMult;
    const steer = rawSteer * turnMult + wheelPull * Math.min(1, Math.abs(this.speed) / 4);
    const brake = Boolean(intent?.brake) || tracksSevered || driverOut;

    this.prevSpeed = this.speed;
    if (brake) {
      const decel = this.stats.brakeDecel * safeDt;
      if (Math.abs(this.speed) <= decel) this.speed = 0;
      else this.speed -= Math.sign(this.speed) * decel;
    } else if (Math.abs(throttle) > 0.02) {
      const maxFwd = this.stats.maxForwardSpeed * mobilityMult * fordMul;
      const maxRev = this.stats.maxReverseSpeed * mobilityMult * fordMul;
      if (throttle > 0) {
        const accel = this.speed < 0 ? this.stats.brakeDecel : this.stats.forwardAccel * mobilityMult * accelMul;
        this.speed = Math.min(maxFwd, this.speed + accel * rawThrottle * safeDt);
      } else {
        const accel = this.speed > 0 ? this.stats.brakeDecel : this.stats.reverseAccel * mobilityMult * accelMul;
        this.speed = Math.max(-maxRev, this.speed + accel * rawThrottle * safeDt);
      }
    } else {
      const drag = 6.2 * safeDt;
      if (Math.abs(this.speed) <= drag) this.speed = 0;
      else this.speed -= Math.sign(this.speed) * drag;
    }

    const roadBoost = 1.0 + 0.08 * world.getRoadFactorAt(this.position.x, this.position.z);
    const effectiveSpeed = this.speed * roadBoost;

    const isWheeled = this.stats.drive === 'wheeled';
    let angularVel = 0;
    let lateralAccel = 0;

    if (isWheeled) {
      // Bicycle model: smoothed steer angle, speed-dependent max steer, no turn-on-spot
      const speedFrac = Math.min(1, Math.abs(this.speed) / Math.max(1, this.stats.maxForwardSpeed));
      const maxSteer = THREE.MathUtils.lerp(0.6, 0.25, speedFrac);
      const steerTarget = steer * maxSteer;
      this.steerAngle += (steerTarget - this.steerAngle) * (1 - Math.exp(-10 * safeDt));
      const wheelbase = this.stats.wheelbase ?? 3.0;
      angularVel = (this.speed / wheelbase) * Math.tan(this.steerAngle);
      lateralAccel = angularVel * this.speed;
      this.hullYaw = wrapAnglePi(this.hullYaw + angularVel * safeDt);

      // Body roll from lateral acceleration (consumed by alignHullToTerrain's spring)
      this.suspRollTarget = THREE.MathUtils.clamp(-lateralAccel * 0.0065, -0.07, 0.07);
    } else {
      const reverseSteerSign = this.speed < -0.6 ? -1 : 1;
      angularVel = steer * reverseSteerSign * this.stats.hullTurnRate;
      this.hullYaw = wrapAnglePi(this.hullYaw + angularVel * safeDt);
    }

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

    if (this.rig.wheels.length > 0) {
      if (isWheeled) {
        // Wheel spin = distance travelled / radius; front steer nodes yaw with steerAngle
        this.wheelDistAccum += effectiveSpeed * safeDt;
        for (const w of this.rig.wheels) {
          w.node.rotation.x = this.wheelDistAccum / w.radius;
        }
        for (const s of this.rig.steerNodes) {
          s.rotation.y = this.steerAngle;
        }
      } else if (Math.abs(effectiveSpeed) > 0.01 || Math.abs(angularVel) > 0.01) {
        const halfTrack = 1.45;
        const vLeft = effectiveSpeed - angularVel * halfTrack;
        const vRight = effectiveSpeed + angularVel * halfTrack;
        for (const w of this.rig.wheels) {
          const trackV = w.side === 'L' ? vLeft : vRight;
          w.node.rotation.x += (trackV * safeDt) / w.radius;
        }
      }
    }

    const absSpd = Math.abs(effectiveSpeed);
    const wantDust = absSpd > 3.0 && (callbacks?.onTrackDust || (fordT > 0 && callbacks?.onWaterWake));
    if (wantDust) {
      this.dustAccum += safeDt * (0.4 + absSpd * 0.45);
      if (this.dustAccum >= 0.16) {
        this.dustAccum = 0;
        const intensity = THREE.MathUtils.clamp(absSpd / this.stats.maxForwardSpeed, 0.2, 0.9);
        const rightX = -cosH;
        const rightZ = sinH;
        const rearDist = isWheeled
          ? -this.stats.hullHalfLength * 0.62
          : -3.2 * Math.sign(effectiveSpeed || 1);
        const sideOff = isWheeled ? this.stats.hullHalfWidth * 0.8 : 1.4;
        const sides = isWheeled ? 2 : 1;
        for (let sIdx = 0; sIdx < sides; sIdx++) {
          const sideSign = sides === 2 ? (sIdx === 0 ? -1 : 1) : 1;
          _tmpVecA.set(
            this.position.x + sinH * rearDist + rightX * sideOff * sideSign,
            this.position.y + 0.25,
            this.position.z + cosH * rearDist + rightZ * sideOff * sideSign
          );
          if (fordT > 0 && callbacks?.onWaterWake) {
            const wY = world.getWaterLevelAt?.(_tmpVecA.x, _tmpVecA.z) ?? this.position.y;
            _tmpVecA.y = wY + 0.12;
            callbacks.onWaterWake(_tmpVecA, intensity);
          } else {
            callbacks?.onTrackDust?.(_tmpVecA, intensity);
          }
        }
      }
    }

    if (intent) {
      this.updateTurretAndGunAim(intent.aimPoint, safeDt);
    }
    this.rig.articulate?.(this.gunPitch);

    const recoilSpringK = 95;
    const recoilDamp = 16;
    const recoilAcc = -recoilSpringK * this.barrelRecoilZ - recoilDamp * this.barrelRecoilVel;
    this.barrelRecoilVel += recoilAcc * safeDt;
    this.barrelRecoilZ += this.barrelRecoilVel * safeDt;
    if (this.barrelRecoilZ > 0.01) this.barrelRecoilZ = 0.01;
    this.rig.gunRecoilGroup.position.z = this.barrelRecoilZ;

    // Lightweight ancestor-only world matrix sync on muzzleNode instead of 35-mesh full subtree traversal!
    this.rig.muzzleNode.updateWorldMatrix(true, false);

    // Guided-munition seeker: scan/track while the rocket class is active and
    // no salvo is in flight. Frozen during a salvo (each rocket already carries
    // the lock captured at trigger time).
    if (
      this.stats.salvoSize &&
      this.activeShell.guidance &&
      intent &&
      (!this.salvoActive || this.stats.vehicleClass === 'support')
    ) {
      this._updateSeeker(intent, world, allTanks, safeDt, seekerExtras);
    }

    // Fire main cannon (Normal MBT & Heavy Tank) or rocket pod salvo (MLRS)
    if (this.stats.hasMainCannon) {
      const canFireCannon = canFirePrimary;

      if (this.stats.salvoSize) {
        const salvoSize = this.stats.salvoSize;
        // Pod reload finished -> all tubes visible again
        if (!this.salvoActive && this.cannonCooldown <= 0 && this._rocketsLeft < salvoSize) {
          this._rocketsLeft = salvoSize;
          this._setRocketMeshesVisible(true);
        }

        if (this.salvoActive) {
          this.salvoTimer -= safeDt;
          if (this.salvoTimer <= 0 && this._rocketsLeft > 0 && canFireCannon) {
            this._fireNextRocket(callbacks);
            this.salvoTimer = this.stats.salvoInterval ?? 0.28;
          }
          if (this._rocketsLeft <= 0 || !canFireCannon) {
            this.salvoActive = false;
            if (this._rocketsLeft <= 0) {
              this.cannonCooldown = this.stats.cannonReloadTime;
            }
          }
        } else if (
          intent?.fireCannon &&
          this.cannonCooldown <= 0 &&
          this._rocketsLeft > 0 &&
          canFireCannon &&
          this.activeShell.id !== 'fpv_drone'
        ) {
          this.salvoActive = true;
          this.salvoTimer = 0;
          this.salvoFired = 0;
          this.salvoSpec = this.activeShell;
          this.salvoGuideTarget = this.seekerLocked ? this.seekerTarget : null;
        }
      } else if (intent?.fireCannon && this.cannonCooldown <= 0 && canFireCannon) {
        this.cannonCooldown = this.stats.cannonReloadTime * reloadMult;
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
    const rtGunner = this.modules.get('gunner');
    if (rtGunner && rtGunner.integrity <= 0) return; // gunner out: no aiming

    const rtRing = this.modules.get('turret_ring');
    const ringFactor =
      (rtRing && rtRing.integrity <= 0 ? 0 : rtRing && rtRing.integrity <= 0.6 ? 0.5 : 1) *
      (rtGunner && rtGunner.integrity > 0 && rtGunner.integrity <= 0.6 ? 0.7 : 1);

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

    const hw = this.stats.hullHalfWidth;
    const hl = this.stats.hullHalfLength;

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

    this.suspRollVel += (-k * (this.suspRoll - this.suspRollTarget) - d * this.suspRollVel) * dt;
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

  /**
   * Guided-munition seeker: at 10 Hz pick the enemy nearest the aim ray inside
   * the guidance cone with clear LOS; per-frame track hold/drop. Lock completes
   * after `guidance.lockTime` seconds continuously inside the cone; leaving the
   * cone for >0.3 s (or the target dying) drops it.
   */
  private _updateSeeker(
    intent: TankIntent,
    world: TerrainQuery,
    allTanks: readonly Tank[],
    dt: number,
    extras?: readonly TankEntity[]
  ): void {
    const g = this.activeShell.guidance;
    if (!g) return;

    // Aim ray: player supplies the camera origin; bots fall back to own position.
    if (intent.aimRayOrigin) {
      _seekOrigin.copy(intent.aimRayOrigin);
    } else {
      _seekOrigin.set(this.position.x, this.position.y + 1.6, this.position.z);
    }
    // Seeker aim reference: bots pass their target bearing explicitly (their
    // aimPoint is an elevated ballistic solution, not a bearing); the player
    // uses the crosshair aim point.
    _seekDir.subVectors(intent.seekerAimPoint ?? intent.aimPoint, _seekOrigin);
    if (_seekDir.lengthSq() < 0.04) {
      _seekDir.set(Math.sin(this.hullYaw), 0, Math.cos(this.hullYaw));
    } else {
      _seekDir.normalize();
    }
    // Lock-on acquisition/hold cone is a fixed 6° (guidance.seekerConeDeg is
    // the wider in-flight retention cone used by Ballistics)
    const coneCos = Math.cos(THREE.MathUtils.degToRad(6));

    // Instant drop on target death
    if (this.seekerTarget && !this.seekerTarget.alive) {
      this._clearSeeker();
    }

    // Per-frame hold/drop tracking on the current target (cheap cone test)
    if (this.seekerTarget) {
      const held = this._seekerInCone(this.seekerTarget, g, coneCos);
      if (!held) {
        this.seekerOffTimer += dt;
        this.seekerProgress = Math.max(0, this.seekerProgress - dt * 1.6);
        if (this.seekerOffTimer > 0.3) this._clearSeeker();
      } else {
        this.seekerOffTimer = 0;
        if (!this.seekerLocked) {
          this.seekerProgress = Math.min(1, this.seekerProgress + dt / g.lockTime);
          if (this.seekerProgress >= 1) this.seekerLocked = true;
        }
      }
    }

    // 10 Hz acquisition scan — skipped while locked (lock persists until drop)
    this.seekerScanTimer -= dt;
    if (this.seekerScanTimer <= 0 && !this.seekerLocked) {
      this.seekerScanTimer = 0.1;
      let cand = this._scanSeekerCandidate(world, allTanks, g, coneCos);
      if (extras && extras.length) {
        const alt = this._scanSeekerCandidate(world, extras, g, coneCos);
        if (alt && (!cand || this._seekerCandidateDot(alt, g, coneCos) > this._seekerCandidateDot(cand, g, coneCos))) {
          cand = alt;
        }
      }
      if (cand !== this.seekerTarget) {
        this.seekerTarget = cand;
        this.seekerProgress = 0;
        this.seekerOffTimer = 0;
        this.seekerLocked = false;
      }
    }
  }

  private _clearSeeker(): void {
    this.seekerTarget = null;
    this.seekerProgress = 0;
    this.seekerLocked = false;
    this.seekerOffTimer = 0;
  }

  /** Cheap per-frame cone/range/alive test for the current seeker target. */
  private _seekerInCone(t: TankEntity, g: NonNullable<ShellSpec['guidance']>, coneCos: number): boolean {
    if (!t.alive || t.team === this.team) return false;
    _seekTo.set(t.position.x, t.position.y + 1.5, t.position.z).sub(_seekOrigin);
    const dist = _seekTo.length();
    if (dist < 60 || dist > g.maxRange) return false;
    _seekTo.multiplyScalar(1 / dist);
    return _seekTo.dot(_seekDir) >= coneCos;
  }

  /** Dot of candidate vs seeker aim dir (for preferring drone/tank candidates). */
  private _seekerCandidateDot(t: TankEntity, _g: NonNullable<ShellSpec['guidance']>, _coneCos: number): number {
    _seekTo.set(t.position.x, t.position.y + 1.5, t.position.z).sub(_seekOrigin);
    const dist = _seekTo.length();
    return dist > 0.001 ? _seekTo.dot(_seekDir) / dist : -1;
  }

  /** 10 Hz scan: enemy nearest the aim ray inside cone+range with clear LOS. */
  private _scanSeekerCandidate(
    world: TerrainQuery,
    allTanks: readonly TankEntity[],
    g: NonNullable<ShellSpec['guidance']>,
    coneCos: number
  ): TankEntity | null {
    // Top-2 by aim-ray angle (dot), then LOS-check in order
    let best: TankEntity | null = null;
    let bestDot = coneCos;
    let second: TankEntity | null = null;
    let secondDot = coneCos;
    for (let i = 0; i < allTanks.length; i++) {
      const t = allTanks[i];
      if (t === this || !t.alive || t.team === this.team) continue;
      _seekTo.set(t.position.x, t.position.y + 1.5, t.position.z).sub(_seekOrigin);
      const dist = _seekTo.length();
      if (dist < 60 || dist > g.maxRange) continue;
      const dot = _seekTo.dot(_seekDir) / dist;
      if (dot > bestDot) {
        second = best;
        secondDot = bestDot;
        best = t;
        bestDot = dot;
      } else if (dot > secondDot) {
        second = t;
        secondDot = dot;
      }
    }
    for (const cand of [best, second]) {
      if (!cand) break;
      _seekTo.set(cand.position.x, cand.position.y + 1.5, cand.position.z).sub(_seekOrigin);
      const dist = _seekTo.length();
      if (dist < 1) continue;
      _seekLos.copy(_seekTo).multiplyScalar(1 / dist);
      const checkDist = Math.max(0.5, dist - (cand.stats?.hitRadius ?? 1.2) * 0.5 - 1);
      const hit = world.raycastWorld(_seekOrigin, _seekLos, checkDist);
      if (!hit) return cand;
      // Destructible brush < 12 m doesn't block the seeker
      const brushOk =
        hit.hitKind === 'obstacle' && Boolean(hit.obstacle?.destructible) && hit.distance < 12;
      if (brushOk) return cand;
    }
    return null;
  }

  /** Launches the next rocket from its own pod tube; that tube's mesh stays hidden until reload. */
  private _fireNextRocket(callbacks?: {
    onFireCannon?: (tank: Tank, pos: THREE.Vector3, dir: THREE.Vector3, shell: ShellSpec, guideTarget?: TankEntity | null) => void;
  }): void {
    const meshes = this.rig.rocketMeshes;
    if (meshes.length === 0) return;
    const mesh = meshes[this.salvoFired % meshes.length];
    this.salvoFired++;
    mesh.updateWorldMatrix(true, false);
    mesh.getWorldPosition(_tmpVecA);
    this.rig.gunPivot.getWorldQuaternion(_tmpQuat);
    _tmpVecB.set(0, 0, 1).applyQuaternion(_tmpQuat).normalize();
    mesh.visible = false;
    this._rocketsLeft = Math.max(0, this._rocketsLeft - 1);
    // SAM ripple: each missile snapshots the CURRENT lock at launch so the
    // player can walk the ripple onto a new target mid-salvo.
    const guide =
      this.stats.vehicleClass === 'support'
        ? this.seekerLocked
          ? this.seekerTarget
          : null
        : this.salvoGuideTarget;
    callbacks?.onFireCannon?.(
      this,
      _tmpVecA,
      _tmpVecB,
      this.salvoSpec ?? this.activeShell,
      guide
    );
  }

  private _setRocketMeshesVisible(visible: boolean): void {
    for (const m of this.rig.rocketMeshes) {
      m.visible = visible;
    }
  }

  public applyRecoil(): void {
    const isRocket = Boolean(this.stats.salvoSize);
    const isHeavy = this.stats.vehicleClass === 'heavy';
    this.barrelRecoilZ = isRocket ? -0.07 : isHeavy ? -0.56 : -0.42;
    this.barrelRecoilVel = isRocket ? -0.5 : isHeavy ? -2.0 : -1.5;

    const relCos = Math.cos(this.turretRelYaw);
    const relSin = Math.sin(this.turretRelYaw);
    this.suspPitchVel += relCos * this.stats.recoilImpulse * 6.5;
    this.suspRollVel -= relSin * this.stats.recoilImpulse * 5.0;
  }

  // ===================== DAMAGE MODEL =====================

  private _initDamageModel(cls: VehicleClass): void {
    this.layout = DAMAGE_LAYOUTS[cls];
    for (const [id, rt] of createModuleStates(cls)) this.modules.set(id, rt);
    this.root.updateMatrixWorld(true);
    this._measurePartBounds(this.rig.hullTiltGroup, this.rig.turretPivot as THREE.Object3D, this.hullBoundsMin, this.hullBoundsSize);
    this._measurePartBounds(this.rig.turretPivot as THREE.Object3D, null, this.turretBoundsMin, this.turretBoundsSize);
    if (this.turretBoundsSize.lengthSq() < 1e-4) {
      this.turretBoundsMin.copy(this.hullBoundsMin);
      this.turretBoundsSize.copy(this.hullBoundsSize);
    }
    // Build module runtimes with local-metre boxes + world anchors.
    for (const def of this.layout.modules) {
      const rt = this.modules.get(def.id);
      if (!rt) continue;
      for (const nb of def.boxes) {
        const isHull = nb.part === 'hull';
        const bMin2 = isHull ? this.hullBoundsMin : this.turretBoundsMin;
        const bSize2 = isHull ? this.hullBoundsSize : this.turretBoundsSize;
        rt.boxes.push({
          part: nb.part,
          external: nb.external,
          min: [
            bMin2.x + nb.min[0] * bSize2.x,
            bMin2.y + nb.min[1] * bSize2.y,
            bMin2.z + nb.min[2] * bSize2.z,
          ],
          max: [
            bMin2.x + nb.max[0] * bSize2.x,
            bMin2.y + nb.max[1] * bSize2.y,
            bMin2.z + nb.max[2] * bSize2.z,
          ],
        });
      }
      rt.part = def.boxes[0].part;
      rt.external = def.boxes.some((b) => b.external);
      rt.crew = def.crew ?? null;
    }
    this._recountCrew();
    this._buildXrayBoxes();
  }

  /** Union of mesh geometry bounds expressed in `space`'s local frame, skipping `skip` subtree. */
  private _measurePartBounds(
    space: THREE.Object3D,
    skip: THREE.Object3D | null,
    outMin: THREE.Vector3,
    outSize: THREE.Vector3
  ): void {
    space.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(space.matrixWorld).invert();
    const box = new THREE.Box3();
    box.makeEmpty();
    const tmpM = new THREE.Matrix4();
    const tmpV = new THREE.Vector3();
    const cb = new THREE.Box3();
    space.traverse((o) => {
      if (skip) {
        let p: THREE.Object3D | null = o;
        let inside = false;
        while (p) {
          if (p === skip) { inside = true; break; }
          p = p.parent;
        }
        if (inside) return;
      }
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const gb = mesh.geometry.boundingBox;
      if (!gb || gb.isEmpty()) return;
      tmpM.multiplyMatrices(inv, mesh.matrixWorld);
      cb.copy(gb).applyMatrix4(tmpM);
      box.union(cb);
      void tmpV;
    });
    if (box.isEmpty()) {
      outMin.set(-2, 0, -3);
      outSize.set(4, 2, 6);
      return;
    }
    outMin.copy(box.min);
    outSize.copy(box.max).sub(box.min);
  }

  private _rayToPartLocal(
    part: THREE.Object3D,
    o: THREE.Vector3,
    d: THREE.Vector3,
    outO: THREE.Vector3,
    outD: THREE.Vector3
  ): void {
    part.updateWorldMatrix(true, false);
    _partInvM4.copy(part.matrixWorld).invert();
    outO.copy(o).applyMatrix4(_partInvM4);
    outD.copy(d).transformDirection(_partInvM4);
  }

  /** Entry face of an AABB for a ray already in that box's local space. */
  private _entryFace(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    minx: number, miny: number, minz: number,
    maxx: number, maxy: number, maxz: number
  ): { face: 'front' | 'side' | 'rear' | 'top' | 'bottom'; cos: number } {
    // largest entry t wins the slab -> that axis is the entered face
    let bestT = -Infinity;
    let axis = 0;
    const axes: [number, number, number, number, number][] = [
      [ox, dx, minx, maxx, 0],
      [oy, dy, miny, maxy, 1],
      [oz, dz, minz, maxz, 2],
    ];
    for (const [o, d, mn, mx, ax] of axes) {
      if (Math.abs(d) < 1e-9) continue;
      const t1 = (mn - o) / d;
      const t2 = (mx - o) / d;
      const tEnter = Math.min(t1, t2);
      if (tEnter > bestT) {
        bestT = tEnter;
        axis = ax;
      }
    }
    if (axis === 0) return { face: 'side', cos: Math.abs(dx) };
    if (axis === 1) {
      // +Y up: entering through top means dir.y < 0
      return { face: dy < 0 ? 'top' : 'bottom', cos: Math.abs(dy) };
    }
    // z: +Z forward; front face is maxz (dir.z < 0 enters it)
    return { face: dz < 0 ? 'front' : 'rear', cos: Math.abs(dz) };
  }

  /** |dot(dirLocal, tiltedFaceNormal)| for an armour zone slope.
   *  The face's outward normal is rotated about its horizontal axis so it
   *  tips upward by slopeDeg (glacis/skirt slope). */
  private _slopeFaceCos(
    face: 'front' | 'side' | 'rear' | 'top' | 'bottom',
    slopeDeg: number,
    lx: number, ly: number, lz: number,
    ld: THREE.Vector3,
    bMin: THREE.Vector3,
    bMax: THREE.Vector3
  ): number {
    // outward unit normal of the entered face
    let nx = 0, ny = 0, nz = 0;
    if (face === 'front') nz = 1;
    else if (face === 'rear') nz = -1;
    else if (face === 'top') ny = 1;
    else if (face === 'bottom') ny = -1;
    else nx = lx >= (bMin.x + bMax.x) * 0.5 ? 1 : -1;
    if (face === 'top' || face === 'bottom') return face === 'top' ? Math.abs(ld.y) : Math.abs(ld.y);
    const s = (slopeDeg * Math.PI) / 180;
    const cs = Math.cos(s), sn = Math.sin(s);
    // tilt the normal toward +Y (up-slope), renormalize
    const tx = nx * cs, ty = ny * cs + sn, tz = nz * cs;
    const tl = Math.hypot(tx, ty, tz) || 1;
    return Math.abs((ld.x * tx + ld.y * ty + ld.z * tz) / tl);
  }

  /** Part-space bounds used by the damage model (references, no alloc). */
  public getDamageBounds(): {
    hullMin: THREE.Vector3; hullSize: THREE.Vector3;
    turretMin: THREE.Vector3; turretSize: THREE.Vector3;
  } {
    return {
      hullMin: this.hullBoundsMin, hullSize: this.hullBoundsSize,
      turretMin: this.turretBoundsMin, turretSize: this.turretBoundsSize,
    };
  }

  /** Health state of one module for the HUD parts panel (null if absent). */
  public moduleHealth(id: ModuleId): ModuleHealthState | null {
    const rt = this.modules.get(id);
    return rt ? integrityState(rt.integrity) : null;
  }

  /** Seconds left on a destroyed->damaged auto-repair (0 when not repairing). */
  public moduleRepairRemaining(id: ModuleId): number {
    return this.repairTimers.get(id) ?? 0;
  }

  public get isBurning(): boolean {
    return this.fireT > 0 && this.alive;
  }

  /** Seconds until the one-shot extinguisher attempt; -1 when not pending. */
  public get fireExtinguisherIn(): number {
    if (this.fireT <= 0 || this.extinguisherDone || this.fireElapsed >= FIRE_EXTINGUISH_AT_S) return -1;
    return FIRE_EXTINGUISH_AT_S - this.fireElapsed;
  }

  private _recountCrew(): void {
    let alive = 0;
    let total = 0;
    for (const rt of this.modules.values()) {
      if (!rt.crew) continue;
      total++;
      if (rt.integrity > 0) alive++;
    }
    this.crewTotal = total;
    this.crewAlive = alive;
  }

  private _startFire(propellant: boolean): void {
    if (this.fireT > 0 || !this.alive) return;
    this.fireT = FIRE_DURATION_S;
    this.fireElapsed = 0;
    this.firePropellant = propellant;
    this.extinguisherDone = false;
    this.cookOffAccum = 0;
  }

  /** Applies damage to a module; handles destroy side-effects. Returns true if it was destroyed by this hit. */
  private _damageModule(id: ModuleId, dmg: number): boolean {
    const rt = this.modules.get(id);
    if (!rt || rt.integrity <= 0 || dmg <= 0 || !this.alive) return false;
    const wasAlive = rt.integrity > 0;
    // Fragile soft-skins: integrityScale divides incoming damage (identical
    // kill thresholds to scaling max integrity, but modules spawn 'ok').
    const scale = this.layout.integrityScale ?? 1;
    rt.integrity = Math.max(0, rt.integrity - dmg / scale);
    this.dbgDamageCalls++;
    const destroyedNow = wasAlive && rt.integrity <= 0;
    if (rt.crew) this._recountCrew();
    if (destroyedNow) this._onModuleDestroyed(id);
    return destroyedNow;
  }

  private _onModuleDestroyed(id: ModuleId): void {
    const soft = this.layout.softSkin;
    if (id === 'engine') {
      if (Math.random() < 0.3) this._startFire(false);
    } else if (id === 'fuel') {
      this._startFire(false);
      if (soft && Math.random() < 0.35) {
        this.killTank(true, 'FUEL EXPLOSION');
        return;
      }
    } else if (id === 'ammo') {
      if (Math.random() < 0.8) {
        this.killTank(true, 'AMMO DETONATION');
      } else {
        this._startFire(true);
      }
    } else if (id === 'driver' || id === 'gunner' || id === 'commander' || id === 'loader') {
      this.crewOutTimers.set(id as CrewRole, CREW_RECOVER_S);
    } else {
      const t = REPAIR_TIME_S[id];
      if (t && this.crewAlive >= MIN_CREW_ALIVE) this.repairTimers.set(id, t);
    }
  }

  private _checkKO(): void {
    if (this.alive && this.crewAlive < MIN_CREW_ALIVE && this.crewTotal > 0) {
      this.killTank(false, 'CREW KNOCKED OUT');
    }
  }

  /** HE blast: per-module falloff; interior gated by armour on the face toward the blast. */
  private _applyBlast(center: THREE.Vector3, radius: number, spec: ShellSpec): void {
    if (radius <= 0) return;
    const splashFactor = (spec.splashDamage > 0 ? spec.splashDamage : 60) / 400;
    const penGate = (spec.penMm ?? 0) * 0.5;
    const anchor = new THREE.Vector3();
    const toBlast = new THREE.Vector3();
    const dirLocal = new THREE.Vector3();
    const partObj = (p: 'hull' | 'turret') => (p === 'hull' ? this.rig.hullTiltGroup : this.rig.turretPivot);
    for (const rt of this.modules.values()) {
      if (rt.integrity <= 0) continue;
      // representative point = centre of first box, transformed to world
      const bx = rt.boxes[0];
      if (!bx) continue;
      const part = partObj(bx.part);
      part.updateWorldMatrix(true, false);
      anchor.set(
        (bx.min[0] + bx.max[0]) * 0.5,
        (bx.min[1] + bx.max[1]) * 0.5,
        (bx.min[2] + bx.max[2]) * 0.5
      );
      part.localToWorld(anchor);
      const d = anchor.distanceTo(center);
      if (d >= radius) continue;
      const fall = 1 - d / radius;
      const dmg = splashFactor * fall * fall;
      if (dmg <= 0.01) continue;
      if (rt.external) {
        this._damageModule(rt.id, dmg);
        continue;
      }
      // interior: armour on the face toward the blast must be < penMm*0.5
      toBlast.subVectors(center, anchor);
      this._rayToPartLocal(part, anchor, toBlast.normalize(), _blastO, _blastD);
      const ax = Math.abs(_blastD.x), ay = Math.abs(_blastD.y), az = Math.abs(_blastD.z);
      let face: 'front' | 'side' | 'rear' | 'top' | 'bottom';
      if (ax >= ay && ax >= az) face = 'side';
      else if (ay >= az) face = _blastD.y > 0 ? 'top' : 'bottom';
      else face = _blastD.z > 0 ? 'front' : 'rear';
      const armor = bx.part === 'hull' ? this.layout.hullArmor : this.layout.turretArmor;
      if (armor[face] < penGate) this._damageModule(rt.id, dmg);
    }
    if (!this.alive) return;
    this._checkKO();
  }

  public takeDamage(
    amount: number,
    hitWorldPos: THREE.Vector3,
    attackerPos?: THREE.Vector3,
    shellDirWorld?: THREE.Vector3,
    weapon: 'cannon' | 'mg' = 'cannon',
    shellSpec?: ShellSpec,
    opts?: {
      attacker?: TankEntity | null;
      blastCenter?: THREE.Vector3;
      blastRadius?: number;
    }
  ): boolean {
    if (!this.alive || this.spawnProtect > 0) return false;
    const blastC = opts?.blastCenter;
    const blastR = opts?.blastRadius ?? 0;
    const hasBlast = !!blastC && blastR > 0;
    if (amount <= 0 && !shellSpec && !hasBlast) return false;

    this._inTakeDamage = true;
    this._dkHitPoint.copy(hitWorldPos);
    this._dkHasDir = !!shellDirWorld;
    if (shellDirWorld) this._dkShellDir.copy(shellDirWorld);
    this._dkWeapon = weapon;
    this._dkDamage = amount;
    this._dkShellSpec = shellSpec ?? null;
    this.hitCounter++;
    this.dbgTakeDamage = { amount, entryPart: null, penetrated: false, ricochet: false, armorZone: 'PENDING', modulesHit: 0 };
    if (opts?.attacker && opts.attacker.team !== this.team) {
      this.lastAttacker = opts.attacker;
      this.lastDamageAt = this._clock;
    }

    const spec = shellSpec;
    const md = spec?.moduleDamage;
    const penMm = spec?.penMm ?? 0;
    const hitModules = new Map<ModuleId, { dmg: number; dist: number }>();
    const spallRays: XRaySpallRay[] = [];
    let armorZone = 'EXTERIOR';
    let ricochet = false;
    let penetrated = false;
    let entryPart: 'hull' | 'turret' | null = null;
    let ex = 0, ey = 0, ez = 0;
    const penEnd: [number, number, number] = [0, 0, 0];

    // ---------- HE blast path (splash victims / dedicated blast calls) ----------
    if (hasBlast && blastC && spec) {
      this._applyBlast(blastC, blastR, spec);
      if (this.dbgTakeDamage) this.dbgTakeDamage.aliveAfterBlast = this.alive;
      if (!this.alive) { this._inTakeDamage = false; this._finishDamageReport(armorZone, weapon, spec, hitModules, spallRays, ex, ey, ez, penEnd, entryPart, ricochet, penetrated); return true; }
      // splash-only callers pass no shellDirWorld -> done after blast
      if (!shellDirWorld) {
        this._inTakeDamage = false;
        this._finishDamageReport(armorZone, weapon, spec, hitModules, spallRays, ex, ey, ez, penEnd, entryPart, ricochet, penetrated);
        return false;
      }
    }

    // ---------- direct-hit path ----------
    if (shellDirWorld) {
      const dir = _tmpVecB.copy(shellDirWorld).normalize();
      // ray origin: 6 m behind the impact point
      const ro = _rayOrigin.copy(hitWorldPos).addScaledVector(dir, -6);
      // transform into both part spaces
      this._rayToPartLocal(this.rig.hullTiltGroup, ro, dir, _hO, _hD);
      this._rayToPartLocal(this.rig.turretPivot as THREE.Object3D, ro, dir, _tO, _tD);

      const tHull = rayBox(_hO.x, _hO.y, _hO.z, _hD.x, _hD.y, _hD.z,
        this.hullBoundsMin.x, this.hullBoundsMin.y, this.hullBoundsMin.z,
        this.hullBoundsMin.x + this.hullBoundsSize.x, this.hullBoundsMin.y + this.hullBoundsSize.y, this.hullBoundsMin.z + this.hullBoundsSize.z, 40);
      const tTurret = rayBox(_tO.x, _tO.y, _tO.z, _tD.x, _tD.y, _tD.z,
        this.turretBoundsMin.x, this.turretBoundsMin.y, this.turretBoundsMin.z,
        this.turretBoundsMin.x + this.turretBoundsSize.x, this.turretBoundsMin.y + this.turretBoundsSize.y, this.turretBoundsMin.z + this.turretBoundsSize.z, 40);

      let entryT = Infinity;
      if (tHull !== null && tHull < entryT) { entryT = tHull; entryPart = 'hull'; }
      if (tTurret !== null && tTurret < entryT) { entryT = tTurret; entryPart = 'turret'; }

      // entry point in world space
      const entryWorld = _entryW.copy(ro).addScaledVector(dir, Number.isFinite(entryT) ? entryT : 0);
      ex = entryWorld.x; ey = entryWorld.y; ez = entryWorld.z;

      // local coords of entry for the XRay report
      if (entryPart === 'turret') {
        this.rig.turretPivot.updateWorldMatrix(true, false);
        _tmpVecA.copy(entryWorld);
        (this.rig.turretPivot as THREE.Object3D).worldToLocal(_tmpVecA);
      } else {
        this.rig.hullTiltGroup.worldToLocal(_tmpVecA.copy(entryWorld));
      }
      const lx = _tmpVecA.x, ly = _tmpVecA.y, lz = _tmpVecA.z;

      // ---------- external modules: direct box hits regardless of armour ----------
      const slugScale = Math.min(1, penMm / 40);
      const extSlug = md ? md.slug * slugScale : amount * 0.004 * slugScale;
      if (extSlug > 0) {
        for (const rt of this.modules.values()) {
          if (rt.integrity <= 0) continue;
          for (const bx of rt.boxes) {
            if (!bx.external) continue;
            const part = bx.part === 'hull' ? this.rig.hullTiltGroup : (this.rig.turretPivot as THREE.Object3D);
            const o = bx.part === 'hull' ? _hO : _tO;
            const d = bx.part === 'hull' ? _hD : _tD;
            const t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, bx.min[0], bx.min[1], bx.min[2], bx.max[0], bx.max[1], bx.max[2], 40);
            if (t !== null && t > entryT - 0.8 && t < entryT + 4.5) {
              const prev = hitModules.get(rt.id);
              const add = extSlug * (bx.external ? 1 : 0.5);
              if (prev) prev.dmg += add; else hitModules.set(rt.id, { dmg: add, dist: t });
              break; // one box per module is enough
            }
          }
        }
      }

      // ---------- armour + penetration on the entry part ----------
      if (entryPart !== null && Number.isFinite(entryT)) {
        const isHull = entryPart === 'hull';
        const lo = isHull ? _hO : _tO;
        const ld = isHull ? _hD : _tD;
        const armor = isHull ? this.layout.hullArmor : this.layout.turretArmor;
        const bMin = isHull ? this.hullBoundsMin : this.turretBoundsMin;
        const bMax = isHull
          ? _v3b.copy(this.hullBoundsMin).add(this.hullBoundsSize)
          : _v3b.copy(this.turretBoundsMin).add(this.turretBoundsSize);
        const faceInfo = this._entryFace(lo.x, lo.y, lo.z, ld.x, ld.y, ld.z, bMin.x, bMin.y, bMin.z, bMax.x, bMax.y, bMax.z);
        // Armour zones: normalized face rect -> mm + slope-tilted normal
        const zones = (isHull ? this.layout.hullZones : this.layout.turretZones)?.[faceInfo.face];
        let zoneMm = armor[faceInfo.face];
        let zoneCos = faceInfo.cos;
        if (zones && zones.length > 0) {
          const sx = Math.max(1e-6, bMax.x - bMin.x);
          const sy = Math.max(1e-6, bMax.y - bMin.y);
          const sz = Math.max(1e-6, bMax.z - bMin.z);
          let u = 0, v = 0;
          if (faceInfo.face === 'side') {
            u = (lz - bMin.z) / sz; v = (ly - bMin.y) / sy;
          } else if (faceInfo.face === 'top' || faceInfo.face === 'bottom') {
            u = (lx - bMin.x) / sx; v = (lz - bMin.z) / sz;
          } else {
            u = (lx - bMin.x) / sx; v = (ly - bMin.y) / sy;
          }
          const zone = zones.find((z) => u >= z.u0 && u <= z.u1 && v >= z.v0 && v <= z.v1);
          if (zone) {
            zoneMm = zone.mm;
            if (zone.slopeDeg > 0) zoneCos = this._slopeFaceCos(faceInfo.face, zone.slopeDeg, lx, ly, lz, ld, bMin, bMax);
          }
        }
        const faceMm = zoneMm;
        const effMm = effectiveArmorMm(faceMm, zoneCos);
        armorZone = `${faceInfo.face.toUpperCase()} ${isHull ? 'HULL' : 'TURRET'}`;
        penetrated = penMm > effMm && penMm > 0;
        ricochet = !penetrated && penMm > 0 && isRicochet(faceMm, penMm, zoneCos);

        if (penetrated && md) {
          const pathLen = postPenPathMm(penMm, effMm);
          // slug: damages internal modules along the path in BOTH part spaces
          const slugOriginWorld = _slugO.copy(entryWorld).addScaledVector(dir, 0.15);
          this._rayDamageModules(hitModules, slugOriginWorld, dir, pathLen, md.slug, null);
          // spall cone
          const numSpall = md.spallCount;
          if (numSpall > 0 && md.spall > 0) {
            const spallOrigin = _spallOrg.copy(entryWorld).addScaledVector(dir, 0.25);
            const upRef = Math.abs(dir.y) < 0.9 ? _upRef.set(0, 1, 0) : _upRef.set(1, 0, 0);
            const basisA = _basisA.crossVectors(dir, upRef).normalize();
            const basisB = _basisB.crossVectors(basisA, dir).normalize();
            const spread = 0.42;
            const spallLen = 2.4;
            for (let i = 0; i < numSpall; i++) {
              const ang = (i / numSpall) * Math.PI * 2 + (i % 2) * 0.3;
              _spallDir
                .copy(dir)
                .addScaledVector(basisA, Math.cos(ang) * spread)
                .addScaledVector(basisB, Math.sin(ang) * spread)
                .normalize();
              const before = hitModules.size;
              void before;
              // record ray for xray
              spallRays.push({
                start: [spallOrigin.x, spallOrigin.y, spallOrigin.z],
                end: [spallOrigin.x + _spallDir.x * spallLen, spallOrigin.y + _spallDir.y * spallLen, spallOrigin.z + _spallDir.z * spallLen],
                hitModule: false,
              });
              this._rayDamageModules(hitModules, spallOrigin, _spallDir, spallLen, md.spall, spallRays[spallRays.length - 1]);
            }
          }
          penEnd[0] = lx + _hD.x * pathLen; // approx in entry part local
          penEnd[1] = ly + _hD.y * pathLen;
          penEnd[2] = lz + _hD.z * pathLen;
        } else if (ricochet) {
          // spark only — no internal damage; externals already collected
        } else if (!md && amount > 0) {
          // generic small-arms / unknown spec: trickle damage along a short path
          const fakeSlug = amount * 0.004;
          const slugOriginWorld = _slugO.copy(entryWorld).addScaledVector(dir, 0.15);
          this._rayDamageModules(hitModules, slugOriginWorld, dir, 1.2, fakeSlug, null);
        }
      }

      // HE direct hit also blasts the victim itself
      if (spec && spec.splashDamage > 0 && spec.splashRadius > 0 && !hasBlast) {
        this._applyBlast(hitWorldPos, spec.splashRadius, spec);
      }
    } else if (spec && spec.splashDamage > 0 && hasBlast) {
      // already applied above
    }

    // ---------- apply accumulated module damage ----------
    const destroyedNow: ModuleId[] = [];
    for (const [id, rec] of hitModules) {
      if (this._damageModule(id, rec.dmg)) destroyedNow.push(id);
    }
    if (!this.alive) {
      this._inTakeDamage = false;
      this._finishDamageReport(armorZone, weapon, spec, hitModules, spallRays, ex, ey, ez, penEnd, entryPart, ricochet, penetrated);
      return true;
    }
    this._checkKO();
    const killed = !this.alive;

    if (this.dbgTakeDamage) { this.dbgTakeDamage.entryPart = entryPart; this.dbgTakeDamage.penetrated = penetrated; this.dbgTakeDamage.ricochet = ricochet; this.dbgTakeDamage.armorZone = armorZone; this.dbgTakeDamage.modulesHit = hitModules.size; this.dbgTakeDamage.applied = this.dbgDamageCalls; }
    this._inTakeDamage = false;
    this._finishDamageReport(armorZone, weapon, spec, hitModules, spallRays, ex, ey, ez, penEnd, entryPart, ricochet, penetrated);
    void destroyedNow;
    void attackerPos;
    return killed;
  }

  /** Ray vs all internal module boxes (both part spaces); accumulates damage. */
  private _rayDamageModules(
    hitModules: Map<ModuleId, { dmg: number; dist: number }>,
    worldOrigin: THREE.Vector3,
    worldDir: THREE.Vector3,
    len: number,
    dmgPer: number,
    spallRay: XRaySpallRay | null
  ): void {
    this._rayToPartLocal(this.rig.hullTiltGroup, worldOrigin, worldDir, _sO, _sD);
    this._rayToPartLocal(this.rig.turretPivot as THREE.Object3D, worldOrigin, worldDir, _sO2, _sD2);
    let anyHit = false;
    for (const rt of this.modules.values()) {
      if (rt.integrity <= 0) continue;
      for (const bx of rt.boxes) {
        if (bx.external) continue;
        const o = bx.part === 'hull' ? _sO : _sO2;
        const d = bx.part === 'hull' ? _sD : _sD2;
        const t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, bx.min[0], bx.min[1], bx.min[2], bx.max[0], bx.max[1], bx.max[2], len);
        if (t !== null) {
          anyHit = true;
          const prev = hitModules.get(rt.id);
          if (prev) prev.dmg += dmgPer; else hitModules.set(rt.id, { dmg: dmgPer, dist: t });
        }
      }
    }
    if (spallRay) spallRay.hitModule = anyHit;
  }

  private _finishDamageReport(
    armorZone: string,
    weapon: 'cannon' | 'mg',
    spec: ShellSpec | undefined,
    hitModules: Map<ModuleId, { dmg: number; dist: number }>,
    spallRays: XRaySpallRay[],
    ex: number, ey: number, ez: number,
    penEnd: [number, number, number],
    entryPart: 'hull' | 'turret' | null,
    ricochet: boolean,
    penetrated: boolean
  ): void {
    const entries: XRayModuleHitEntry[] = [];
    const states: Record<ModuleId, ModuleHealthState> = {} as Record<ModuleId, ModuleHealthState>;
    for (const id of ALL_MODULE_IDS) {
      const rt = this.modules.get(id);
      states[id] = rt ? integrityState(rt.integrity) : 'ok';
    }
    // sort by distance along path
    const sorted = [...hitModules.entries()].sort((a, b) => a[1].dist - b[1].dist);
    for (const [id, rec] of sorted) {
      const rt = this.modules.get(id);
      const meta = MODULE_LABELS[id];
      const st = rt ? integrityState(rt.integrity) : 'ok';
      entries.push({
        id,
        label: meta.label,
        effectText: st === 'destroyed' ? meta.destroyedEffect : meta.damagedEffect,
        newState: st,
        hitTime01: THREE.MathUtils.clamp(rec.dist / 4, 0.05, 0.95),
      });
    }
    this.lastXRayReport = {
      armorZone: ricochet ? `${armorZone} (RICOCHET)` : armorZone,
      penetrated,
      ricochet,
      killed: !this.alive,
      killReason: this.alive ? null : this._dkKillReason,
      weapon: spec ? 'cannon' : weapon,
      entryLocal: [ex, ey, ez],
      penEndLocal: penEnd,
      dirLocal: [0, 0, 0],
      turretRelYaw: this.turretRelYaw,
      spallRays,
      hitModules: entries,
      allModuleStates: states,
      crewAlive: this.crewAlive,
      crewTotal: this.crewTotal,
      moduleBoxes: this._xrayBoxes.map((b) => ({
        ...b,
        state: (() => {
          const rt = this.modules.get(b.id);
          return rt ? integrityState(rt.integrity) : ('ok' as ModuleHealthState);
        })(),
      })),
    };
    void entryPart;
  }

  /** QA/selftest: apply raw module damage bypassing ballistics. */
  public debugDamageModule(id: ModuleId, amount: number): void {
    this._damageModule(id, amount);
    this._checkKO();
  }

  /** World position of the burning module (fuel > ammo > engine > hull centre). */
  private _fireAnchorPos(out: THREE.Vector3): THREE.Vector3 {
    for (const id of ['fuel', 'ammo', 'engine'] as ModuleId[]) {
      const rt = this.modules.get(id);
      const bx = rt?.boxes[0];
      if (rt && rt.integrity <= 0 && bx) {
        const part = bx.part === 'hull' ? this.rig.hullTiltGroup : (this.rig.turretPivot as THREE.Object3D);
        part.updateWorldMatrix(true, false);
        out.set(
          (bx.min[0] + bx.max[0]) * 0.5,
          (bx.min[1] + bx.max[1]) * 0.5,
          (bx.min[2] + bx.max[2]) * 0.5
        );
        part.localToWorld(out);
        return out;
      }
    }
    const sinE = Math.sin(this.hullYaw);
    const cosE = Math.cos(this.hullYaw);
    out.set(this.position.x - sinE * 2.5, this.position.y + 1.55, this.position.z - cosE * 2.5);
    return out;
  }

  private _resetDamageState(): void {
    for (const rt of this.modules.values()) {
      rt.integrity = rt.maxIntegrity;
    }
    this.repairTimers.clear();
    this.crewOutTimers.clear();
    this.fireT = 0;
    this.fireElapsed = 0;
    this.firePropellant = false;
    this.extinguisherDone = false;
    this.fireSmokeAccum = 0;
    this.cookOffAccum = 0;
    this._recountCrew();
  }

  /** Precompute X-Ray module boxes (part-local metres) with live states. */
  private _buildXrayBoxes(): void {
    const out: { id: ModuleId; space: 'hull' | 'turret'; min: [number, number, number]; max: [number, number, number]; state: ModuleHealthState }[] = [];
    for (const rt of this.modules.values()) {
      const st = integrityState(rt.integrity);
      for (const bx of rt.boxes) {
        out.push({
          id: rt.id,
          space: bx.part,
          min: [bx.min[0], bx.min[1], bx.min[2]],
          max: [bx.max[0], bx.max[1], bx.max[2]],
          state: st,
        });
      }
    }
    // keep geometry stable; refresh states each report instead
    this._xrayBoxes = out;
  }

  private killTank(catastrophic: boolean, reason?: string): void {
    if (!this.alive) return;
    this.alive = false;
    this.fireT = 0;
    this.respawnTimer = this.isHuman ? 5.0 : 7.0;
    this._dkKillReason = reason ?? (catastrophic ? 'DETONATION' : 'CREW KNOCKED OUT');

    // Kill credit: last enemy to damage this tank within the credit window.
    const killer =
      this.lastAttacker && this._clock - this.lastDamageAt <= KILL_CREDIT_WINDOW_S
        ? this.lastAttacker
        : null;

    // Wreck: catastrophic = ammo/fuel explosion or heavy blast; crew KO burns.
    if (this.onDestroyed) {
      this.onDestroyed({
        tank: this,
        hitPoint: this._dkHitPoint,
        shellDir: this._dkHasDir ? this._dkShellDir : null,
        weapon: this._dkWeapon,
        damage: this._dkDamage,
        catastrophic,
      });
    }
    if (!this._inTakeDamage) {
      this.onKillEvent?.({
        victim: this,
        attacker: killer,
        killed: true,
        hitPoint: this._dkHitPoint,
        weapon: this._dkWeapon,
        amount: this._dkDamage,
        killReason: this._dkKillReason,
      });
    }
    this.root.visible = false;
  }

  public respawnAt(pos: THREE.Vector3, yaw: number): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.hullYaw = wrapAnglePi(yaw);
    this.turretRelYaw = 0;
    this.gunPitch = 0;
    this.speed = 0;
    this.prevSpeed = 0;
    this.hitCounter = 0;
    this._dkKillReason = null;
    this.lastAttacker = null;
    this.lastDamageAt = -999;
    this.alive = true;
    this.respawnTimer = 0;
    this.spawnProtect = 3.0;
    this.cannonCooldown = 0;
    this.mgCooldown = 0;
    this.mgHeat = 0;
    this.mgOverheated = false;
    this.lastXRayReport = null;
    this._resetDamageState();
    this.suspPitch = 0;
    this.suspRoll = 0;
    this.suspRollTarget = 0;
    this.suspPitchVel = 0;
    this.suspRollVel = 0;
    this.barrelRecoilZ = 0;
    this.barrelRecoilVel = 0;
    this.steerAngle = 0;
    this.wheelDistAccum = 0;
    this.salvoActive = false;
    this.salvoTimer = 0;
    this.salvoFired = 0;
    this.salvoSpec = null;
    this.salvoGuideTarget = null;
    this.seekerTarget = null;
    this.seekerProgress = 0;
    this.seekerLocked = false;
    this.seekerOffTimer = 0;
    this.seekerScanTimer = 0;
    this.qaDriveCircle = null;
    this._rocketsLeft = this.stats.salvoSize ?? 0;
    this._setRocketMeshesVisible(true);

    this.root.visible = true;
    this.rig.turretPivot.rotation.set(0, 0, 0);
    this.rig.turretPivot.position.copy(this.rig.turretRestPos);
    this.rig.gunPivot.rotation.set(0, 0, 0);
    this.rig.gunRecoilGroup.position.set(0, 0, 0);

    this.root.position.copy(pos);
    this.root.rotation.set(0, this.hullYaw, 0);
    this.root.updateMatrixWorld(true);
  }

  /** QA hook: kill as if hit by a cannon round from the vehicle's front. */
  public debugKill(catastrophic: boolean): void {
    if (!this.alive) return;
    const fwd = _tmpVecA.set(Math.sin(this.hullYaw), 0, Math.cos(this.hullYaw));
    this._dkHitPoint.set(
      this.position.x + fwd.x * this.stats.collisionRadius,
      this.position.y + 1.4,
      this.position.z + fwd.z * this.stats.collisionRadius
    );
    this._dkShellDir.copy(fwd).negate();
    this._dkHasDir = true;
    this._dkWeapon = 'cannon';
    this._dkDamage = 9999;
    this._dkShellSpec = this.stats.shells[0];
    this.killTank(catastrophic);
  }
}
