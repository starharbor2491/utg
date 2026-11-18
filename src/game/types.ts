import * as THREE from 'three';

/**
 * Shared coordinate & angle conventions across ALL game modules:
 * - World is Y-up right-handed Three.js space, spanning [-worldHalfSize, +worldHalfSize] on X and Z.
 * - Yaw angle `yaw` (radians) follows Three.js `rotation.y = yaw`:
 *     forwardXZ(yaw) = (Math.sin(yaw), 0, Math.cos(yaw))
 *     rightXZ(yaw)   = (-Math.cos(yaw), 0, Math.sin(yaw))  [right-hand ground tangent when looking along +forward]
 *   Note: `Math.atan2(dx, dz)` recovers `yaw` directly!
 * - All loaded tank GLBs are normalized inside `AssetLoader` / `Tank` so that inside a tank's hull frame:
 *     +Z = forward (bow), +Y = up, Y = 0 = bottom of road wheels/tracks.
 */

export type Team = 'blue' | 'red';

export type VehicleClass = 'normal' | 'heavy' | 'ifv' | 'humvee' | 'rocket' | 'support' | 'littlebird';

export type DriveType = 'tracked' | 'wheeled' | 'air';

export type ObstacleKind = 'building' | 'tower' | 'station' | 'rock' | 'barrier' | 'tree' | 'crates';

export interface ObstacleCollider {
  id: string;
  kind: ObstacleKind;
  /** World X center */
  x: number;
  /** Base terrain Y */
  y: number;
  /** World Z center */
  z: number;
  /** XZ collision circle radius (meters) for vehicle physics & AI steering */
  radius: number;
  /** Vertical height above `y` (meters) for shell/tracer occlusion */
  height: number;
  /** Damageable scenery, as opposed to a solid wreck. */
  destructible: boolean;
  /** Easier to knock over and less important for steering/LOS. */
  lightCover?: boolean;
  damage?: number;
  destroyed: boolean;
  mesh?: THREE.Object3D;
}

export interface WorldRayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  hitKind: 'terrain' | 'obstacle';
  obstacle?: ObstacleCollider;
}

export interface TerrainQuery {
  readonly worldHalfSize: number;
  getHeightAt(x: number, z: number): number;
  getNormalAt(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  getRoadFactorAt(x: number, z: number): number;
  getObstacles(): readonly ObstacleCollider[];
  damageObstacle(obstacle: ObstacleCollider, amount: number, dirX?: number, dirZ?: number): boolean;
  blastObstacles(x: number, y: number, z: number, radius: number, amount: number): void;
  raycastWorld(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): WorldRayHit | null;
  getSafeSpawnPoint(
    preferRadiusMin: number,
    preferRadiusMax: number,
    avoidPoints: readonly THREE.Vector3[],
    center?: { x: number; z: number }
  ): THREE.Vector3;
  /** Water depth in meters at (x,z); 0 outside river corridors. Optional: dry worlds omit it. */
  getWaterDepthAt?(x: number, z: number): number;
  /** River surface level at (x,z); 0 outside river corridors. */
  getWaterLevelAt?(x: number, z: number): number;
}

export interface NormalizedTankTemplate {
  /** Cloned per vehicle rig instance */
  sceneRoot: THREE.Group;
  /** Approximate dimensions in meters after normalization */
  length: number;
  width: number;
  height: number;
  /** Local turret pivot height & Z offset inside normalized hull */
  turretPivotLocal: THREE.Vector3;
  /** Local gun pivot offset relative to turret pivot */
  gunPivotInTurret: THREE.Vector3;
  /** Local muzzle tip offset relative to gun pivot (along +Z forward) */
  muzzleOffsetInGun: THREE.Vector3;
  /** Coaxial MG offset relative to gun pivot */
  coaxOffsetInGun: THREE.Vector3;
}

export interface ShellSpec {
  id: string;
  shortCode: string;
  displayName: string;
  muzzleSpeed: number;
  directDamage: number;
  splashDamage: number;
  splashRadius: number;
  penetrationDepth: number;
  spallCount: number;
  spallWeight: number;
  explosionScale: number;
  tracerColorRGB: [number, number, number];
  dispersionRad: number;
  /** Rocket motors: while `age < burnTime` the round accelerates along its velocity */
  rocket?: { burnTime: number; thrustAccel: number };
  /** Generic guided-munition seeker (heat-seeking rockets now, SAMs later):
   *  launch platform acquires a lock, each round then flies proportional
   *  navigation toward the locked target after `boostDelay`. */
  guidance?: {
    /** Launch-platform seeker acquisition cone half-angle (deg) */
    seekerConeDeg: number;
    /** Seconds of continuous aim hold required to lock */
    lockTime: number;
    /** PN navigation gain N */
    navGain: number;
    /** Lateral acceleration clamp (m/s^2) */
    maxAccel: number;
    /** Seconds after launch before the seeker goes active */
    boostDelay: number;
    /** Seeker acquisition / in-flight reach (m) */
    maxRange: number;
    /** Burning wrecks can steal the seeker */
    decoyable: boolean;
  };
  /** Penetration capability in mm of RHA-equivalent armour (APFSDS/HEAT/APDS;
   *  small-arms and HE get low values). Absent = non-penetrating. */
  penMm?: number;
  /** Per-module damage on penetration: slug along path, spall cone. */
  moduleDamage?: { slug: number; spall: number; spallCount: number };
  /** Exhaust trail tuning for rocket-powered rounds (scale multiplier on
   *  the shared smoke emitter, 0..1 brighten toward white). */
  trailScale?: number;
  trailBright?: number;
}

export interface TankStats {
  vehicleClass: VehicleClass;
  displayName: string;
  maxForwardSpeed: number;   // m/s
  maxReverseSpeed: number;   // m/s
  forwardAccel: number;      // m/s^2
  reverseAccel: number;      // m/s^2
  brakeDecel: number;        // m/s^2
  hullTurnRate: number;      // rad/s
  turretTurnRate: number;    // rad/s
  gunElevateRate: number;    // rad/s
  gunMinPitch: number;       // rad (negative = depression, positive = elevation; convention: +pitch tilts gun UP)
  gunMaxPitch: number;       // rad
  hasMainCannon: boolean;
  cannonReloadTime: number;  // seconds
  shellMuzzleSpeed: number;  // default slot-0 m/s for AI lead fallback
  shellDirectDamage: number;
  shellSplashDamage: number;
  shellSplashRadius: number; // meters
  shells: readonly [ShellSpec, ShellSpec];
  recoilImpulse: number;
  hitRadius: number;         // meters (bounding sphere/cylinder radius for hits)
  collisionRadius: number;   // meters (hull XZ footprint radius)
  hasCoaxMG: boolean;
  infiniteMG: boolean;
  mgFireInterval: number;    // seconds between autocannon/MG shots
  drive: DriveType;
  /** XZ footprint half extents for terrain alignment probes (meters) */
  hullHalfWidth: number;
  hullHalfLength: number;
  /** Wheeled vehicles: bicycle-model wheelbase (meters) */
  wheelbase?: number;
  /** Rocket pod: rounds per salvo + seconds between launches */
  salvoSize?: number;
  salvoInterval?: number;
}

export interface TankIntent {
  /** -1 (full reverse) to +1 (full throttle) */
  throttle: number;
  /** -1 (turn right) to +1 (turn left) or signed yaw rate intent: +1 turns CCW (+yaw), -1 turns CW (-yaw) */
  steer: number;
  /** Handbrake / emergency track lock */
  brake: boolean;
  /** Desired world-space aim target for turret + main gun */
  aimPoint: THREE.Vector3;
  /** World-space origin of the player's aim ray (camera); bots omit it and
   *  the seeker falls back to the tank's own position. */
  aimRayOrigin?: THREE.Vector3;
  /** Optional seeker aim reference: bots set this to their current target so
   *  the lock cone measures bearing-to-target rather than the elevated
   *  ballistic solution point in `aimPoint`. */
  seekerAimPoint?: THREE.Vector3;
  /** Pull main cannon trigger */
  fireCannon: boolean;
  /** Hold coaxial MG / IFV autocannon trigger */
  fireMG: boolean;
  /** Optional shell slot switch (0 or 1) */
  selectShell?: 0 | 1 | null;
  /** Aircraft: pointer heading and cyclic pitch, plus signed collective. */
  flightYaw?: number;
  flightPitch?: number;
  lift?: number;
}

export type { ModuleId, ModuleHealthState, CrewRole, ModulePart } from './DamageModel';
import type { ModuleId, ModuleHealthState } from './DamageModel';

export interface XRaySpallRay {
  start: [number, number, number];
  end: [number, number, number];
  hitModule: boolean;
}

export interface XRayModuleHitEntry {
  id: ModuleId;
  label: string;
  effectText: string;
  newState: ModuleHealthState;
  /** 0..1 normalized timing along the penetration replay when this part gets struck */
  hitTime01: number;
}

export interface ShellHitXRayReport {
  armorZone: string;
  /** Shell defeated the effective armour on the entry face (internal damage possible). */
  penetrated: boolean;
  /** Shell ricocheted off the face (no internal damage). */
  ricochet: boolean;
  killed: boolean;
  killReason: string | null;
  weapon: 'cannon' | 'mg';
  /** Hull-local impact point [x, y, z] */
  entryLocal: [number, number, number];
  /** Hull-local shell penetration end point [x, y, z] */
  penEndLocal: [number, number, number];
  /** Hull-local incoming unit direction [dx, dy, dz] */
  dirLocal: [number, number, number];
  /** Enemy turret relative yaw at moment of impact */
  turretRelYaw: number;
  /** Spall shrapnel rays in hull-local space */
  spallRays: XRaySpallRay[];
  /** Newly damaged/destroyed modules & crew in this hit */
  hitModules: XRayModuleHitEntry[];
  /** Snapshot of all module states on the victim tank after impact */
  allModuleStates: Record<ModuleId, ModuleHealthState>;
  /** Living crew count after impact (replaces hpRemaining/maxHp) */
  crewAlive: number;
  crewTotal: number;
  /** Per-class module boxes in part-local metres for HitCam rendering */
  moduleBoxes?: readonly {
    id: ModuleId;
    space: 'hull' | 'turret';
    min: [number, number, number];
    max: [number, number, number];
    state: ModuleHealthState;
  }[];
}

export interface TankEntity {
  readonly id: string;
  readonly team: Team;
  readonly isHuman: boolean;
  readonly callsign: string;
  readonly stats: TankStats;
  readonly root: THREE.Group;

  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Forward hull heading in radians: forward = (sin(hullYaw), 0, cos(hullYaw)) */
  hullYaw: number;
  /** Turret relative yaw from hullYaw in radians */
  turretRelYaw: number;
  /** Convenience: hullYaw + turretRelYaw wrapped to [-PI, PI] */
  readonly turretWorldYaw: number;
  /** Gun elevation angle in radians (+ = aimed above horizon, - = depressed below hull plane) */
  gunPitch: number;
  /** Signed forward ground speed (m/s) */
  speed: number;

  /** Bumped on every damage event — bots use it for hit reactions (replaces hp deltas). */
  hitCounter: number;
  /** Living crew count / total crew (drives HUD "CREW n/m" and knock-out checks). */
  crewAlive: number;
  crewTotal: number;
  alive: boolean;
  respawnTimer: number;

  cannonCooldown: number;
  mgCooldown: number;
  mgHeat: number;
  mgOverheated: boolean;
  /** Gun dispersion multiplier from module damage (damaged gun = 2.5). */
  dispersionMult: number;
  selectedShellIndex: 0 | 1;
  readonly activeShell: ShellSpec;
  lastXRayReport: ShellHitXRayReport | null;
  /** Guided-munition seeker state (salvo/rocket classes only; undefined otherwise).
   *  `progress` runs 0..1 while acquiring, `locked` once held for lockTime. */
  readonly seekerLock?: {
    readonly target: TankEntity | null;
    readonly progress: number;
    readonly locked: boolean;
  };

  getMuzzleWorld(outPos: THREE.Vector3, outDir: THREE.Vector3): void;
  getCoaxWorld(outPos: THREE.Vector3, outDir: THREE.Vector3): void;
  getCenterMassWorld(outPos: THREE.Vector3): THREE.Vector3;
  applyRecoil(): void;
  takeDamage(
    amount: number,
    hitWorldPos: THREE.Vector3,
    attackerPos?: THREE.Vector3,
    shellDirWorld?: THREE.Vector3,
    weapon?: 'cannon' | 'mg',
    shellSpec?: ShellSpec,
    opts?: {
      attacker?: TankEntity | null;
      /** HE blast: world centre + radius; per-module falloff computed internally. */
      blastCenter?: THREE.Vector3;
      blastRadius?: number;
    }
  ): boolean;
  respawnAt(pos: THREE.Vector3, yaw: number): void;
}

export interface WreckKillInfo {
  tank: TankEntity;
  hitPoint: THREE.Vector3;
  shellDir: THREE.Vector3 | null;
  weapon: 'cannon' | 'mg';
  damage: number;
  /** Ammo detonation / heavy catastrophic kill: turret launches, cook-off chain */
  catastrophic: boolean;
}

export interface DamageEvent {
  victim: TankEntity;
  attacker: TankEntity | null;
  amount: number;
  killed: boolean;
  hitPoint: THREE.Vector3;
  weapon: 'cannon' | 'mg';
  xrayReport?: ShellHitXRayReport | null;
  /** KO reason for histogram/feed (falls back to xrayReport.killReason). */
  killReason?: string | null;
}

export interface ScreenReticlePos {
  x: number;
  y: number;
  visible: boolean;
}

export interface MinimapUnit {
  x: number;
  z: number;
  yaw: number;
  alive: boolean;
  ally: boolean;
  spotted: boolean;
}

export interface MinimapObstacle {
  x: number;
  z: number;
  radius: number;
  kind: ObstacleKind;
  destroyed?: boolean;
}

/** River centreline sample for the tactical radar (world space). */
export interface RadarRiverSample {
  x: number;
  z: number;
  halfWidth: number;
}

/** Terrain mound footprint for the tactical radar. */
export interface RadarMound {
  x: number;
  z: number;
  radius: number;
  height: number;
}

export interface HUDTelemetry {
  vehicleClass: VehicleClass;
  activeShellIndex: 0 | 1;
  shell0Code: string;
  shell1Code: string;
  hasMainCannon: boolean;
  hasCoaxMG: boolean;
  infiniteMG: boolean;

  crewAlive: number;
  crewTotal: number;
  alive: boolean;
  respawnRemaining: number;

  speedKmh: number;
  altitudeM?: number;
  gearLabel: string;
  throttle: number;

  hullYaw: number;
  turretWorldYaw: number;
  cameraYaw: number;
  cameraFovRad: number;

  cannonReloadProgress: number; // 0..1 (1 = ready)
  cannonCooldownSec: number;
  shellSpeedMs: number;
  mgHeat: number;               // 0..1
  mgOverheated: boolean;

  commanderAim: ScreenReticlePos;
  gunnerBore: ScreenReticlePos & {
    onTarget: boolean;
    rangeMeters: number;
  };

  kills: number;
  deaths: number;
  activeEnemies: number;
  /** Rocket launcher pod state (0 for other classes) */
  rocketsLeft: number;
  /** Rocket pod capacity (undefined for non-rocket classes) */
  salvoSize?: number;
  score: { blue: number; red: number };
  playerTeam: Team;
  fps: number;

  /** F5b: present while the player's FPV drone is airborne — HUD switches
   *  to the drone overlay and hides vehicle chrome. */
  fpv?: {
    speedKmh: number;
    altM: number;
    rangeM: number;
    cooldown: number;
  };
  /** Support slot-2 status for the vehicle panel: FPV READY / FPV n S / FPV AIRBORNE */
  fpvSlotStatus?: string;

  /** Guided-munition seeker lock box (rocket class only; absent otherwise).
   *  Screen-space position is filled by main.ts each frame. */
  lockOn?: {
    targetId: string;
    /** 0..1 acquisition progress while seeking; 1 while locked */
    progress: number;
    locked: boolean;
    screenX: number;
    screenY: number;
    /** False when the target projects outside the view — HUD hides the box */
    onScreen: boolean;
    rangeMeters: number;
  };
  /** Remaining flash timer & kind for center reticle hit confirmation */
  hitMarker: {
    kind: 'none' | 'hit' | 'kill';
    intensity: number; // 0..1
  };
  /** Parts-panel rows for the player vehicle (module id, state, repair countdown). */
  parts?: readonly { id: string; state: 'ok' | 'damaged' | 'destroyed'; repairSec: number }[];
  /** Crew seat pips for the player vehicle. */
  crewPips?: readonly { role: 'D' | 'G' | 'C' | 'L'; state: 'ok' | 'wounded' | 'out' }[];
  /** Vehicle fire state for the parts panel strip. */
  onFire: boolean;
  /** Seconds until the extinguisher attempt while burning (-1 = none pending). */
  fireExtSec: number;
  /** Short result text of the player's latest hit (RICOCHET / NO PENETRATION / PENETRATION · …). */
  hitResultText: string;
  hitResultIntensity: number; // 0..1
  /** Kill reason of the player's most recent death (for the respawn banner). */
  deathReason: string | null;

  /** World azimuth (radians) where the most recent enemy hit came from, with fade 0..1 */
  incomingDamageArc: {
    fromWorldYaw: number;
    intensity: number; // 0..1
  };
  /** Recent kill/event feed notifications */
  feedMessages: readonly { id: number; text: string; age: number; accent: 'kill' | 'death' | 'info'; actorName?: string; actorTeam?: Team; targetName?: string; targetTeam?: Team }[];

  pointerLocked: boolean;
  sniperZoom: boolean;

  minimap: {
    playerX: number;
    playerZ: number;
    worldHalfSize: number;
    units: readonly MinimapUnit[];
    obstacles: readonly MinimapObstacle[];
    rivers?: readonly (readonly RadarRiverSample[])[];
    mounds?: readonly RadarMound[];
  };
}
