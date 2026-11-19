/**
 * DamageModel — pure data + math for the module-based damage system.
 * No three.js dependency: all geometry is plain arrays so the model is
 * unit-testable headlessly. Tank.ts adapts world rays into part-local space
 * and applies the results; Ballistics/main consume the outcomes.
 *
 * Conventions:
 * - Module boxes are NORMALIZED (0..1) inside their part's bounding box,
 *   measured at rig build. x = width, y = height, z = length (+Z forward).
 * - Values >1 or <0 are allowed on z for extensions (gun barrel).
 * - Armour is in mm per face: front / side / rear / top / bottom.
 */

export type DamageClass = 'normal' | 'heavy' | 'ifv' | 'humvee' | 'rocket' | 'support' | 'littlebird' | 'apache';

export type ModuleId =
  | 'engine'
  | 'fuel'
  | 'ammo'
  | 'track_left'
  | 'track_right'
  | 'wheels_left'
  | 'wheels_right'
  | 'turret_ring'
  | 'gun'
  | 'launcher'
  | 'driver'
  | 'gunner'
  | 'commander'
  | 'loader';

export type CrewRole = 'driver' | 'gunner' | 'commander' | 'loader';
export type ModulePart = 'hull' | 'turret';
export type ModuleHealthState = 'ok' | 'damaged' | 'destroyed';

export interface NormBox {
  part: ModulePart;
  /** External modules take slug/blast damage on their own box regardless of armour. */
  external: boolean;
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

export interface ModuleDef {
  id: ModuleId;
  crew?: CrewRole;
  boxes: readonly NormBox[];
}

export interface FaceArmour {
  front: number;
  side: number;
  rear: number;
  top: number;
  bottom: number;
}

export interface ClassDamageLayout {
  modules: readonly ModuleDef[];
  hullArmor: FaceArmour;
  turretArmor: FaceArmour;
  /** Armour zones per part per face: normalized face rects (u,v in 0..1) that
   *  override the face mm and tilt the effective normal by slopeDeg.
   *  First matching zone wins; unmatched areas use the plain face value. */
  hullZones?: Partial<Record<FaceName, readonly ArmorZone[]>>;
  turretZones?: Partial<Record<FaceName, readonly ArmorZone[]>>;
  /** Thin-skinned vehicles suffer immediate fuel explosions / cook-offs. */
  softSkin: boolean;
  /** Multiplies every module's max integrity (fragile soft-skins < 1). */
  integrityScale?: number;
}

export interface ArmorZone {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  mm: number;
  slopeDeg: number;
}

const HULL = 'hull' as const;
const TURRET = 'turret' as const;
const EXT = true;
const INT = false;

const nx = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, part: ModulePart = HULL, external = INT): NormBox => ({
  part,
  external,
  min: [x0, y0, z0],
  max: [x1, y1, z1],
});

/** Per-class module layouts. Normalized coords over the measured part bbox. */
const ROCKET_LAYOUT: ClassDamageLayout = {
  softSkin: true,
  hullArmor: { front: 10, side: 6, rear: 6, top: 6, bottom: 6 },
  turretArmor: { front: 6, side: 6, rear: 6, top: 6, bottom: 6 },
  modules: [
    { id: 'engine', boxes: [nx(0.3, 0.1, 0.72, 0.7, 0.55, 0.98)] },
    { id: 'fuel', boxes: [nx(0.0, 0.35, 0.25, 0.2, 0.85, 0.75), nx(0.8, 0.35, 0.25, 1.0, 0.85, 0.75)] },
    { id: 'ammo', boxes: [nx(0.15, 0.4, 0.0, 0.85, 1.0, 0.5, TURRET)] },
    {
      id: 'wheels_left',
      boxes: [nx(0.0, 0.0, 0.1, 0.15, 0.45, 0.42, HULL, EXT), nx(0.0, 0.0, 0.58, 0.15, 0.45, 0.9, HULL, EXT)],
    },
    {
      id: 'wheels_right',
      boxes: [nx(0.85, 0.0, 0.1, 1.0, 0.45, 0.42, HULL, EXT), nx(0.85, 0.0, 0.58, 1.0, 0.45, 0.9, HULL, EXT)],
    },
    { id: 'driver', crew: 'driver', boxes: [nx(0.3, 0.5, 0.75, 0.55, 0.95, 0.97)] },
    { id: 'commander', crew: 'commander', boxes: [nx(0.6, 0.5, 0.7, 0.85, 0.95, 0.95)] },
    { id: 'gunner', crew: 'gunner', boxes: [nx(0.55, 0.45, 0.75, 0.8, 0.95, 0.97)] },
    { id: 'launcher', boxes: [nx(0.08, 0.15, 0.0, 0.92, 0.95, 0.62, TURRET, EXT)] },
  ],
};

/** Both launch bays are fixed to the carrier's hull. */
const SUPPORT_LAYOUT: ClassDamageLayout = {
  ...ROCKET_LAYOUT,
  modules: ROCKET_LAYOUT.modules.map((m) =>
    m.id === 'launcher'
      ? { ...m, boxes: [nx(0.09, 0.48, 0.03, 0.91, 0.77, 0.43, HULL, EXT)] }
      : m
  ),
};

export const DAMAGE_LAYOUTS: Record<DamageClass, ClassDamageLayout> = {
  normal: {
    softSkin: false,
    hullArmor: { front: 500, side: 80, rear: 40, top: 30, bottom: 20 },
    turretArmor: { front: 600, side: 180, rear: 60, top: 40, bottom: 45 },
    hullZones: {
      front: [
        { u0: 0, v0: 0.3, u1: 1, v1: 1, mm: 500, slopeDeg: 60 },
        { u0: 0, v0: 0, u1: 1, v1: 0.3, mm: 230, slopeDeg: 25 },
      ],
    },
    turretZones: {
      front: [
        { u0: 0.38, v0: 0.2, u1: 0.62, v1: 0.8, mm: 380, slopeDeg: 0 },
        { u0: 0, v0: 0, u1: 1, v1: 1, mm: 600, slopeDeg: 20 },
      ],
    },
    modules: [
      { id: 'engine', boxes: [nx(0.28, 0.2, 0.0, 0.72, 0.85, 0.24)] },
      {
        id: 'fuel',
        boxes: [
          nx(0.15, 0.3, 0.78, 0.85, 0.95, 1.0),
          nx(0.0, 0.3, 0.3, 0.16, 0.8, 0.72),
          nx(0.84, 0.3, 0.3, 1.0, 0.8, 0.72),
        ],
      },
      {
        id: 'ammo',
        boxes: [nx(0.18, 0.08, 0.38, 0.82, 0.42, 0.72), nx(0.25, 0.15, 0.0, 0.75, 0.85, 0.22, TURRET)],
      },
      { id: 'track_left', boxes: [nx(0.0, 0.0, 0.02, 0.13, 0.6, 0.98, HULL, EXT)] },
      { id: 'track_right', boxes: [nx(0.87, 0.0, 0.02, 1.0, 0.6, 0.98, HULL, EXT)] },
      { id: 'driver', crew: 'driver', boxes: [nx(0.15, 0.4, 0.72, 0.42, 0.8, 0.92)] },
      { id: 'turret_ring', boxes: [nx(0.15, 0.0, 0.15, 0.85, 0.2, 0.85, TURRET)] },
      {
        id: 'gun',
        boxes: [
          nx(0.4, 0.4, 0.4, 0.6, 0.85, 0.62, TURRET),
          nx(0.44, 0.48, 0.55, 0.56, 0.62, 1.75, TURRET, EXT),
        ],
      },
      { id: 'gunner', crew: 'gunner', boxes: [nx(0.55, 0.55, 0.5, 0.85, 0.95, 0.8, TURRET)] },
      { id: 'commander', crew: 'commander', boxes: [nx(0.55, 0.6, 0.1, 0.85, 1.0, 0.35, TURRET)] },
      { id: 'loader', crew: 'loader', boxes: [nx(0.15, 0.4, 0.05, 0.45, 0.9, 0.3, TURRET)] },
    ],
  },
  heavy: {
    softSkin: false,
    hullArmor: { front: 650, side: 120, rear: 60, top: 40, bottom: 25 },
    turretArmor: { front: 750, side: 240, rear: 80, top: 50, bottom: 50 },
    hullZones: {
      front: [
        { u0: 0, v0: 0.35, u1: 1, v1: 1, mm: 650, slopeDeg: 60 },
        { u0: 0, v0: 0, u1: 1, v1: 0.35, mm: 560, slopeDeg: 25 },
      ],
    },
    turretZones: {
      front: [
        { u0: 0.38, v0: 0.2, u1: 0.62, v1: 0.8, mm: 480, slopeDeg: 0 },
        { u0: 0, v0: 0, u1: 1, v1: 1, mm: 750, slopeDeg: 25 },
      ],
    },
    get modules() {
      return DAMAGE_LAYOUTS.normal.modules;
    },
  },
  ifv: {
    softSkin: false,
    hullArmor: { front: 60, side: 30, rear: 20, top: 15, bottom: 10 },
    turretArmor: { front: 60, side: 30, rear: 20, top: 15, bottom: 10 },
    integrityScale: 0.85,
    hullZones: {
      front: [
        { u0: 0, v0: 0.35, u1: 1, v1: 1, mm: 60, slopeDeg: 60 },
        { u0: 0, v0: 0, u1: 1, v1: 0.35, mm: 40, slopeDeg: 25 },
      ],
    },
    turretZones: {
      front: [
        { u0: 0.38, v0: 0.2, u1: 0.62, v1: 0.8, mm: 40, slopeDeg: 0 },
        { u0: 0, v0: 0, u1: 1, v1: 1, mm: 60, slopeDeg: 20 },
      ],
    },
    modules: [
      { id: 'engine', boxes: [nx(0.28, 0.15, 0.75, 0.72, 0.8, 1.0)] },
      { id: 'fuel', boxes: [nx(0.0, 0.35, 0.35, 0.18, 0.85, 0.75), nx(0.82, 0.35, 0.35, 1.0, 0.85, 0.75)] },
      { id: 'ammo', boxes: [nx(0.2, 0.1, 0.15, 0.8, 0.75, 0.4, TURRET)] },
      { id: 'track_left', boxes: [nx(0.0, 0.0, 0.02, 0.12, 0.65, 0.98, HULL, EXT)] },
      { id: 'track_right', boxes: [nx(0.88, 0.0, 0.02, 1.0, 0.65, 0.98, HULL, EXT)] },
      { id: 'driver', crew: 'driver', boxes: [nx(0.08, 0.4, 0.72, 0.5, 0.9, 1.0)] },
      { id: 'turret_ring', boxes: [nx(0.15, 0.0, 0.15, 0.85, 0.18, 0.85, TURRET)] },
      { id: 'gun', boxes: [nx(0.42, 0.35, 0.4, 0.58, 0.8, 0.65, TURRET), nx(0.45, 0.45, 0.55, 0.55, 0.6, 1.8, TURRET, EXT)] },
      { id: 'gunner', crew: 'gunner', boxes: [nx(0.3, -0.4, 0.35, 1.0, 0.9, 0.95, TURRET)] },
      { id: 'commander', crew: 'commander', boxes: [nx(0.3, -0.35, 0.0, 1.0, 0.95, 0.55, TURRET)] },
    ],
  },
  humvee: {
    softSkin: true,
    integrityScale: 0.38,
    hullArmor: { front: 8, side: 8, rear: 8, top: 8, bottom: 8 },
    turretArmor: { front: 10, side: 8, rear: 8, top: 8, bottom: 8 },
    modules: [
      { id: 'engine', boxes: [nx(0.3, 0.15, 0.75, 0.7, 0.75, 1.0)] },
      { id: 'fuel', boxes: [nx(0.25, 0.4, 0.0, 0.75, 0.85, 0.28), nx(0.0, 0.4, 0.3, 0.18, 0.8, 0.7), nx(0.82, 0.4, 0.3, 1.0, 0.8, 0.7)] },
      { id: 'ammo', boxes: [nx(0.3, 0.15, 0.35, 0.7, 0.6, 0.65, TURRET)] },
      {
        id: 'wheels_left',
        boxes: [nx(0.0, 0.0, 0.08, 0.16, 0.5, 0.45, HULL, EXT), nx(0.0, 0.0, 0.55, 0.16, 0.5, 0.92, HULL, EXT)],
      },
      {
        id: 'wheels_right',
        boxes: [nx(0.84, 0.0, 0.08, 1.0, 0.5, 0.45, HULL, EXT), nx(0.84, 0.0, 0.55, 1.0, 0.5, 0.92, HULL, EXT)],
      },
      { id: 'driver', crew: 'driver', boxes: [nx(0.05, 0.35, 0.5, 0.5, 0.9, 1.0)] },
      { id: 'commander', crew: 'commander', boxes: [nx(0.5, 0.35, -0.15, 1.0, 0.9, 0.45)] },
      { id: 'turret_ring', boxes: [nx(0.15, 0.0, 0.1, 0.85, 0.25, 0.9, TURRET)] },
      { id: 'gun', boxes: [nx(0.4, 0.2, 0.35, 0.6, 0.7, 0.65, TURRET), nx(0.45, 0.35, 0.55, 0.55, 0.55, 1.4, TURRET, EXT)] },
      { id: 'gunner', crew: 'gunner', boxes: [nx(0.4, 0.1, 0.35, 0.6, 1.3, 0.65, TURRET, EXT)] },
    ],
  },
  rocket: ROCKET_LAYOUT,
  support: SUPPORT_LAYOUT,
  littlebird: {
    softSkin: true,
    hullArmor: { front: 10, side: 8, rear: 8, top: 6, bottom: 7 },
    turretArmor: { front: 5, side: 5, rear: 5, top: 5, bottom: 5 },
    modules: [
      { id: 'engine', boxes: [nx(0.27, 0.69, 0.46, 0.73, 1, 0.78)] },
      { id: 'fuel', boxes: [nx(0.22, 0.24, 0.52, 0.78, 0.49, 0.75)] },
      { id: 'driver', crew: 'driver', boxes: [nx(0.24, 0.42, 0.76, 0.5, 0.83, 0.96)] },
      { id: 'gunner', crew: 'gunner', boxes: [nx(0.5, 0.42, 0.76, 0.76, 0.83, 0.96)] },
      { id: 'gun', boxes: [nx(0, 0.05, 0.08, 0.2, 0.95, 1, TURRET, EXT)] },
      { id: 'launcher', boxes: [nx(0.8, 0.02, 0, 1, 0.98, 1, TURRET, EXT)] },
    ],
  },
  apache: {
    softSkin: true,
    hullArmor: { front: 30, side: 22, rear: 14, top: 16, bottom: 18 },
    turretArmor: { front: 20, side: 16, rear: 12, top: 15, bottom: 12 },
    modules: [
      { id: 'engine', boxes: [nx(0.14, 0.58, 0.48, 0.86, 0.89, 0.70)] },
      { id: 'fuel', boxes: [nx(0.32, 0.23, 0.49, 0.68, 0.51, 0.69)] },
      { id: 'driver', crew: 'driver', boxes: [nx(0.33, 0.52, 0.72, 0.67, 0.85, 0.83)] },
      { id: 'gunner', crew: 'gunner', boxes: [nx(0.34, 0.38, 0.83, 0.66, 0.70, 0.94)] },
      { id: 'gun', boxes: [nx(0, 0, 0, 1, 1, 1, TURRET, EXT)] },
      { id: 'launcher', boxes: [nx(0, 0.32, 0.44, 0.24, 0.64, 0.71, HULL, EXT), nx(0.76, 0.32, 0.44, 1, 0.64, 0.71, HULL, EXT)] },
    ],
  },
};

// ---------- runtime module state ----------

export interface ModuleRuntime {
  id: ModuleId;
  /** 0..1 nominal; ammo maxes at 1.2 */
  integrity: number;
  maxIntegrity: number;
  part: ModulePart;
  external: boolean;
  crew: CrewRole | null;
  /** Local-metre boxes per part (filled at rig measure) */
  boxes: { min: [number, number, number]; max: [number, number, number]; part: ModulePart; external: boolean }[];
}

export const MODULE_MAX_INTEGRITY: Partial<Record<ModuleId, number>> = { ammo: 1.2 };

export function integrityState(integrity: number): ModuleHealthState {
  return integrity > 0.6 ? 'ok' : integrity > 0 ? 'damaged' : 'destroyed';
}

export function moduleMaxIntegrity(id: ModuleId): number {
  return MODULE_MAX_INTEGRITY[id] ?? 1.0;
}

// ---------- timing / tuning tables ----------

export const REPAIR_TIME_S: Partial<Record<ModuleId, number>> = {
  track_left: 12,
  track_right: 12,
  wheels_left: 12,
  wheels_right: 12,
  gun: 15,
  turret_ring: 15,
  launcher: 15,
  engine: 20,
};

export const CREW_RECOVER_S = 5;
export const FIRE_DURATION_S = 15;
export const FIRE_EXTINGUISH_AT_S = 5;
export const FIRE_EXTINGUISH_CHANCE = 0.55;
export const FIRE_DPS_HULL = 0.05;
export const FIRE_COOKOFF_PER_S = 0.04;
export const FIRE_COOKOFF_PROPELLANT_PER_S = 0.12;
export const KILL_CREDIT_WINDOW_S = 20;
export const MIN_CREW_ALIVE = 2;

// ---------- pure geometry ----------

/** Slab ray-vs-AABB. Returns entry distance along unit dir, or null. maxDist caps it. */
export function rayBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minx: number, miny: number, minz: number,
  maxx: number, maxy: number, maxz: number,
  maxDist = Infinity
): number | null {
  let tmin = 0;
  let tmax = maxDist;
  // X
  if (Math.abs(dx) < 1e-9) {
    if (ox < minx || ox > maxx) return null;
  } else {
    let t1 = (minx - ox) / dx;
    let t2 = (maxx - ox) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  // Y
  if (Math.abs(dy) < 1e-9) {
    if (oy < miny || oy > maxy) return null;
  } else {
    let t1 = (miny - oy) / dy;
    let t2 = (maxy - oy) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  // Z
  if (Math.abs(dz) < 1e-9) {
    if (oz < minz || oz > maxz) return null;
  } else {
    let t1 = (minz - oz) / dz;
    let t2 = (maxz - oz) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin >= 0 ? tmin : (tmax >= 0 ? 0 : null);
}

export type FaceName = 'front' | 'side' | 'rear' | 'top' | 'bottom';

const FACES: readonly FaceName[] = ['front', 'side', 'rear', 'top', 'bottom'];

export function faceArmorMm(armor: FaceArmour, face: FaceName): number {
  return armor[face];
}

/** Effective armour: mm / max(cosθ, 0.26). cosθ = |dot(shellDir, faceNormal)| in part-local space. */
export function effectiveArmorMm(mm: number, cosTheta: number): number {
  return mm / Math.max(Math.min(1, Math.abs(cosTheta)), 0.26);
}

/** Ricochet when impact angle > 72° (cosθ < cos72 ≈ 0.309) and penMm < 2.5×face mm. */
export function isRicochet(faceMm: number, penMm: number, cosTheta: number): boolean {
  return Math.abs(cosTheta) < Math.cos((72 * Math.PI) / 180) && penMm < faceMm * 2.5;
}

export function postPenPathMm(penMm: number, effectiveMm: number): number {
  const residual = penMm - effectiveMm;
  return Math.min(3.5, Math.max(0.6, 0.6 + residual / 200));
}

export function integrityOf(crewOrModule: number): ModuleHealthState {
  return integrityState(crewOrModule);
}

export { FACES };
