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

export type VehicleClass = 'normal' | 'heavy' | 'ifv' | 'humvee' | 'rocket';

export type DriveType = 'tracked' | 'wheeled';

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
  /** If true (trees, supply crates), heavy tanks crush/topple this obstacle on impact or HE blast */
  destructible: boolean;
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
  crushObstacle(obstacle: ObstacleCollider, impactDirXZ?: THREE.Vector2): void;
  raycastWorld(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): WorldRayHit | null;
  getSafeSpawnPoint(
    preferRadiusMin: number,
    preferRadiusMax: number,
    avoidPoints: readonly THREE.Vector3[],
    center?: { x: number; z: number }
  ): THREE.Vector3;
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
}

export interface TankStats {
  vehicleClass: VehicleClass;
  displayName: string;
  maxHp: number;
  armorDamageMult: number;
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
  /** Pull main cannon trigger */
  fireCannon: boolean;
  /** Hold coaxial MG / IFV autocannon trigger */
  fireMG: boolean;
  /** Optional shell slot switch (0 or 1) */
  selectShell?: 0 | 1 | null;
}

export type ModuleId =
  | 'track_left'
  | 'track_right'
  | 'engine'
  | 'driver'
  | 'ammo_hull'
  | 'turret_ring'
  | 'cannon_breech'
  | 'gunner'
  | 'loader'
  | 'ammo_bustle';

export type ModuleHealthState = 'ok' | 'damaged' | 'destroyed';

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
  hpRemaining: number;
  maxHp: number;
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

  hp: number;
  readonly maxHp: number;
  alive: boolean;
  respawnTimer: number;

  cannonCooldown: number;
  mgCooldown: number;
  mgHeat: number;
  mgOverheated: boolean;
  selectedShellIndex: 0 | 1;
  readonly activeShell: ShellSpec;
  lastXRayReport: ShellHitXRayReport | null;

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
    shellSpec?: ShellSpec
  ): boolean;
  respawnAt(pos: THREE.Vector3, yaw: number): void;
}

export interface DamageEvent {
  victim: TankEntity;
  attacker: TankEntity | null;
  amount: number;
  killed: boolean;
  hitPoint: THREE.Vector3;
  weapon: 'cannon' | 'mg';
  xrayReport?: ShellHitXRayReport | null;
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
}

export interface HUDTelemetry {
  vehicleClass: VehicleClass;
  activeShellIndex: 0 | 1;
  shell0Code: string;
  shell1Code: string;
  hasMainCannon: boolean;
  hasCoaxMG: boolean;
  infiniteMG: boolean;

  hp: number;
  maxHp: number;
  alive: boolean;
  respawnRemaining: number;

  speedKmh: number;
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

  /** Remaining flash timer & kind for center reticle hit confirmation */
  hitMarker: {
    kind: 'none' | 'hit' | 'kill';
    intensity: number; // 0..1
  };
  /** World azimuth (radians) where the most recent enemy hit came from, with fade 0..1 */
  incomingDamageArc: {
    fromWorldYaw: number;
    intensity: number; // 0..1
  };
  /** Recent kill/event feed notifications */
  feedMessages: readonly { id: number; text: string; age: number; accent: 'kill' | 'death' | 'info' }[];

  pointerLocked: boolean;
  sniperZoom: boolean;

  minimap: {
    playerX: number;
    playerZ: number;
    worldHalfSize: number;
    units: readonly MinimapUnit[];
    obstacles: readonly MinimapObstacle[];
  };
}
