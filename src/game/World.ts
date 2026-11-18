import { Entity, FOG_EXP2, StandardMaterial } from 'playcanvas';
import type { LoadedGameAssets } from './AssetLoader';
import { getApp } from './engine/app';
import { dodecahedron, Geo, plane } from './engine/geometry';
import { enableInstanceColor, InstancedMesh } from './engine/instancing';
import { addShaderHooks, standard } from './engine/materials';
import { applyMat4, Box3, clamp, composeMat, decomposeMat, lerp, linearColor, Mat4, negate, Quat, quatFromAxisAngle, quatFromEuler, quatFromUnitVectors, setLocalEulerRad, srgb, Vec3 } from './engine/math';
import { findByName, group, meshNode, setVisible } from './engine/scene';
import type { ObstacleCollider, ObstacleKind, TerrainQuery, WorldRayHit } from './types';

interface LandmarkPad {
  x: number;
  z: number;
  innerRadius: number;
  outerRadius: number;
  elevation: number;
}

interface FallingPropAnim {
  mesh: Entity;
  axis: Vec3;
  angle: number;
  angVel: number;
  maxAngle: number;
  sinkY: number;
  startScaleY: number;
  collapse: boolean;
  obstacle: ObstacleCollider;
  batch?: PropBatchSlot;
}

interface PropBatchSlot {
  index: number;
  world: Mat4;
  parts: readonly { mesh: InstancedMesh; local: Mat4 }[];
}

const PROP_DURABILITY: Record<ObstacleKind, number> = {
  building: 340, station: 260, tower: 210, rock: 95, barrier: 75, tree: 28, crates: 16,
};
const TERRAIN_SIZE = 1240;
const TERRAIN_SEGMENTS = 256;

interface MoundDef {
  x: number;
  z: number;
  radius: number;
  height: number;
}

interface RiverDef {
  /** Mean centreline z (metres). */
  z0: number;
  ampA: number;
  kA: number;
  phaseA: number;
  ampB: number;
  kB: number;
  phaseB: number;
  halfWBase: number;
  halfWAmp: number;
  halfWK: number;
  halfWPhase: number;
  /** Precomputed smoothed water levels, one per RIVER_SAMPLE_STEP along x. */
  levels: Float32Array;
}

/** Deterministic PRNG for mound/prop placement (never Math.random). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);

  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm(x: number, z: number): number {
  let v = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < 4; i++) {
    v += amp * (valueNoise(x * freq, z * freq) * 2 - 1);
    freq *= 2.03;
    amp *= 0.5;
  }
  return v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export class World implements TerrainQuery {
  public readonly worldHalfSize = 520;
  public readonly root = group('battlefield_world');
  public readonly sunLight: Entity;

  private readonly pads: LandmarkPad[] = [];
  private readonly obstacles: ObstacleCollider[] = [];
  private readonly fallingProps: FallingPropAnim[] = [];
  private readonly propBatchSlots = new Map<ObstacleCollider, PropBatchSlot>();
  private readonly propInstanceMatrix = new Mat4();
  private rubble: InstancedMesh | null = null;
  private rubbleIndex = 0;
  public onObstacleDestroyed?: (obstacle: ObstacleCollider) => void;
  private grassMesh: InstancedMesh | null = null;
  private terrainPositions!: Geo;
  private grassTimeUniform = { value: 0 };
  private readonly animatedMaterials: StandardMaterial[] = [];
  private elapsedTime = 0;

  private readonly mounds: MoundDef[] = [];
  private readonly rivers: RiverDef[] = [];

  // Grass chunk streaming: 40 m cells, lazily computed tuft caches; the
  // InstancedMesh is refilled from chunks within GRASS_VIEW of the camera.
  private static readonly GRASS_CHUNK = 40;
  private static readonly GRASS_VIEW = 150;
  private static readonly GRASS_CAPACITY = 6200;
  private grassDensity = 1;
  private grassDirty = true;
  private grassChunks = new Map<number, { mats: Float32Array; cols: Float32Array; count: number } | null>();
  private grassNeeded = new Set<number>();
  private grassComputeQueue: number[] = [];
  private _grassCellKey = -1;

  private readonly _rayPt = new Vec3();
  private readonly _rayNorm = new Vec3();
  private readonly _rayHitResult: WorldRayHit = {
    point: new Vec3(),
    normal: new Vec3(0, 1, 0),
    distance: 0,
    hitKind: 'terrain',
  };
  private lastShadowSnapX = Infinity;
  private lastShadowSnapZ = Infinity;

  constructor(
    private readonly scene: Entity,
    private readonly assets: LoadedGameAssets
  ) {
    this.scene.addChild(this.root);

    const appScene = getApp().scene;
    appScene.skybox = assets.skyBox;
    appScene.envAtlas = assets.skyEnvAtlas;
    appScene.skyboxIntensity = 0.92;
    appScene.ambientLight = srgb('#3d4638');
    appScene.fog.type = FOG_EXP2;
    appScene.fog.color = srgb('#9eb0ba');
    appScene.fog.density = 0.0011;

    this.sunLight = new Entity('afternoon_sun');
    this.sunLight.addComponent('light', {
      type: 'directional', color: srgb('#fff1d6'), intensity: 2.65 / Math.PI,
      castShadows: true, shadowResolution: 1536, shadowDistance: 340, numCascades: 2,
      shadowBias: -0.00045, normalOffsetBias: 0.025,
    });
    this.sunLight.setPosition(110, 145, -85);
    this.sunLight.setRotation(quatFromUnitVectors(new Quat(), Vec3.DOWN, new Vec3(-110, -145, 85).normalize()));
    this.root.addChild(this.sunLight);

    this.initLandmarkPads();
    this.initMounds();
    this.initRivers();
    this.buildTerrainMesh();
    this.populateBattlefieldProps();
    this.buildRiverWaterMeshes();
    this.buildInstancedSteppeGrass();
  }

  private rawSteppeHeight(x: number, z: number): number {
    // Rolling central steppe hills (+/- 6.4m) with gentle tank hull-down defilade hollows
    const macro = fbm(x * 0.0052 + 3.1, z * 0.0052 - 1.7) * 6.4;
    const mid = fbm(x * 0.016 - 5.4, z * 0.016 + 2.8) * 1.65;
    let h = macro + mid;

    // Slightly flatten main roads so driving roads feels graded & engineered
    const road = this.getRoadFactorAt(x, z);
    h *= 1 - road * 0.32;

    // Base staging meadows: flatten around both team bases (0, ±420)
    const dBlue = Math.hypot(x - 0, z + 420);
    if (dBlue < 46) {
      const w = 1 - smoothstep(14, 46, dBlue);
      h = lerp(h, 0.0, w * 0.85);
    }
    const dRed = Math.hypot(x - 0, z - 420);
    if (dRed < 46) {
      const w = 1 - smoothstep(14, 46, dRed);
      h = lerp(h, 0.0, w * 0.85);
    }

    // Outer perimeter ridge beyond the playable ~470 m square, rising toward the 620 m terrain edge
    const boxDist = Math.max(Math.abs(x), Math.abs(z));
    if (boxDist > 470) {
      const ridgeT = smoothstep(470, 600, boxDist);
      const ridgeDetail = 0.7 + 0.6 * valueNoise(x * 0.025, z * 0.025);
      h += ridgeT * 21.0 * ridgeDetail;
    }

    return h;
  }

  /** Cosine-falloff hull-down mounds (34 deterministic bumps across the steppe). */
  private moundHeightAt(x: number, z: number): number {
    let h = 0;
    for (let i = 0; i < this.mounds.length; i++) {
      const m = this.mounds[i];
      const dx = x - m.x;
      const dz = z - m.z;
      const rr = m.radius * m.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr) continue;
      const t = Math.sqrt(d2) / m.radius;
      h += m.height * 0.5 * (1 + Math.cos(Math.PI * t));
    }
    return h;
  }

  /** Terrain height before river carving (raw steppe + mounds + landmark pads). */
  private heightBeforeRivers(x: number, z: number): number {
    let h = this.rawSteppeHeight(x, z) + this.moundHeightAt(x, z);
    for (let i = 0; i < this.pads.length; i++) {
      const p = this.pads[i];
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.outerRadius) {
        const w = 1 - smoothstep(p.innerRadius, p.outerRadius, d);
        h = lerp(h, p.elevation, w);
      }
    }
    return h;
  }

  private initLandmarkPads(): void {
    const padSpecs: Omit<LandmarkPad, 'elevation'>[] = [
      // Central crossroads ruined apartment blocks
      { x: 38, z: 28, innerRadius: 15, outerRadius: 28 },
      { x: -46, z: -18, innerRadius: 15, outerRadius: 28 },
      // Northern abandoned fuel depot
      { x: 14, z: 126, innerRadius: 15, outerRadius: 28 },
      // Guard tower checkpoints
      { x: -94, z: 96, innerRadius: 10, outerRadius: 20 },
      { x: 106, z: -88, innerRadius: 10, outerRadius: 20 },
      // Outer-map ruined compounds
      { x: -210, z: -60, innerRadius: 15, outerRadius: 28 },
      { x: 190, z: -30, innerRadius: 15, outerRadius: 28 },
      { x: -160, z: 280, innerRadius: 15, outerRadius: 28 },
      // Outer guard towers
      { x: -250, z: 40, innerRadius: 10, outerRadius: 20 },
      { x: 260, z: -50, innerRadius: 10, outerRadius: 20 },
      // Supply crate depots
      { x: -120, z: -55, innerRadius: 8, outerRadius: 16 },
      { x: 130, z: 45, innerRadius: 8, outerRadius: 16 },
    ];

    for (const p of padSpecs) {
      this.pads.push({
        ...p,
        elevation: this.rawSteppeHeight(p.x, p.z),
      });
    }
  }

  public getHeightAt(x: number, z: number): number {
    let h = this.heightBeforeRivers(x, z);
    for (let i = 0; i < this.rivers.length; i++) {
      const r = this.rivers[i];
      const cz = this.riverCentreZ(r, x);
      const lat = Math.abs(z - cz);
      const hw = this.riverHalfWidth(r, x);
      // Bank blend zone ends ~6 m past the waterline; beyond it terrain is untouched
      if (lat >= hw + 6) continue;
      const level = this.riverLevelAt(r, x);
      const silt = valueNoise(x * 0.11 + 7.7, z * 0.11 - 3.1) - 0.5;
      const shelf = smoothstep(hw * 0.48, hw + 1.9, lat + silt * 1.2);
      const bed = level + lerp(-1.04 + silt * 0.19, 0.58, shelf);
      h = lerp(bed, h, smoothstep(hw + 1.6, hw + 6, lat));
    }
    return h;
  }

  /** Water depth in metres at (x,z); 0 outside river corridors. */
  public getWaterDepthAt(x: number, z: number): number {
    const surface = this.riverSurfaceAt(x, z);
    return surface === undefined ? 0 : Math.max(0, surface - this.getHeightAt(x, z));
  }

  /** River surface level at (x,z); 0 when the point is outside every corridor. */
  public getWaterLevelAt(x: number, z: number): number {
    return this.riverSurfaceAt(x, z) ?? 0;
  }

  private riverSurfaceAt(x: number, z: number): number | undefined {
    for (let i = 0; i < this.rivers.length; i++) {
      const r = this.rivers[i];
      const lat = Math.abs(z - this.riverCentreZ(r, x));
      if (lat < this.riverHalfWidth(r, x) + 1.6) return this.riverLevelAt(r, x);
    }
    return undefined;
  }

  private riverCentreZ(r: RiverDef, x: number): number {
    return r.z0 + r.ampA * Math.sin(r.kA * x + r.phaseA) + r.ampB * Math.sin(r.kB * x + r.phaseB);
  }

  private riverHalfWidth(r: RiverDef, x: number): number {
    return r.halfWBase + r.halfWAmp * Math.sin(r.halfWK * x + r.halfWPhase);
  }

  /** River x-extent covered by the level lookup tables. */
  private static readonly RIVER_X_MIN = -660;
  private static readonly RIVER_X_MAX = 660;
  private static readonly RIVER_SAMPLE_STEP = 8;

  private riverLevelAt(r: RiverDef, x: number): number {
    const fx = clamp(
      (x - World.RIVER_X_MIN) / World.RIVER_SAMPLE_STEP,
      0,
      r.levels.length - 1.001
    );
    const i0 = Math.floor(fx);
    const t = fx - i0;
    return r.levels[i0] + (r.levels[i0 + 1] - r.levels[i0]) * t;
  }

  /** Deterministic hull-down mounds: cosine domes kept off bases, roads, rivers, pads. */
  private initMounds(): void {
    const rng = mulberry32(0x5eed2024);
    const placed: { x: number; z: number; r: number }[] = [];

    const spotOk = (x: number, z: number, r: number): boolean => {
      if (Math.abs(x) > 452 || Math.abs(z) > 452) return false;
      // >= 60 m from either base centre
      if (Math.hypot(x, z + 420) < 60 + r * 0.5) return false;
      if (Math.hypot(x, z - 420) < 60 + r * 0.5) return false;
      // Off roads
      if (this.getRoadFactorAt(x, z) > 0.15) return false;
      // Out of river corridors (water + 6 m banks + mound radius margin)
      for (const rv of this.riverProtos) {
        const lat = Math.abs(z - this.riverCentreZProto(rv, x));
        if (lat < this.riverHalfWidthProto(rv, x) + 6 + r * 0.6) return false;
      }
      // Clear of landmark pads
      for (const p of this.pads) {
        if (Math.hypot(x - p.x, z - p.z) < p.outerRadius + r * 0.5) return false;
      }
      // Min spacing between mound centres
      for (const q of placed) {
        if (Math.hypot(x - q.x, z - q.z) < 48) return false;
      }
      return true;
    };

    const tryAdd = (x: number, z: number, r: number, h: number): void => {
      if (this.mounds.length >= 34 || !spotOk(x, z, r)) return;
      this.mounds.push({ x, z, radius: r, height: h });
      placed.push({ x, z, r });
    };

    // River-flank mounds first: hull-down cover beside each crossing reach
    let flank = 0;
    for (let i = 0; i < 300 && flank < 8; i++) {
      const rv = this.riverProtos[i % this.riverProtos.length];
      const x = -420 + rng() * 840;
      const side = rng() < 0.5 ? -1 : 1;
      const cz = this.riverCentreZProto(rv, x);
      const hw = this.riverHalfWidthProto(rv, x);
      const z = cz + side * (hw + 15 + rng() * 20);
      const r = 13 + rng() * 10;
      const before = this.mounds.length;
      tryAdd(x, z, r, 3 + rng() * 3.5);
      if (this.mounds.length > before) flank++;
    }

    // Remaining mounds scattered across the steppe
    for (let i = 0; i < 900 && this.mounds.length < 34; i++) {
      const x = (rng() * 2 - 1) * 448;
      const z = (rng() * 2 - 1) * 448;
      const r = 12 + rng() * 23;
      const h = 2.5 + rng() * 5.5;
      tryAdd(x, z, r, h);
    }
  }

  /** River definitions before level sampling (levels need heightBeforeRivers). */
  private readonly riverProtos: Omit<RiverDef, 'levels'>[] = [
    // Southern river (~z = -170), meanders ±46 m
    { z0: -170, ampA: 32, kA: (Math.PI * 2) / 420, phaseA: 0.7, ampB: 14, kB: (Math.PI * 2) / 190, phaseB: 2.1, halfWBase: 11, halfWAmp: 2.0, halfWK: (Math.PI * 2) / 260, halfWPhase: 1.3 },
    // Northern river (~z = +170)
    { z0: 170, ampA: 30, kA: (Math.PI * 2) / 460, phaseA: 3.9, ampB: 15, kB: (Math.PI * 2) / 210, phaseB: 0.4, halfWBase: 11, halfWAmp: 2.0, halfWK: (Math.PI * 2) / 300, halfWPhase: 4.0 },
  ];

  private riverCentreZProto(r: Omit<RiverDef, 'levels'>, x: number): number {
    return r.z0 + r.ampA * Math.sin(r.kA * x + r.phaseA) + r.ampB * Math.sin(r.kB * x + r.phaseB);
  }

  private riverHalfWidthProto(r: Omit<RiverDef, 'levels'>, x: number): number {
    return r.halfWBase + r.halfWAmp * Math.sin(r.halfWK * x + r.halfWPhase);
  }

  /** Sample terrain along each centreline and smooth into a flowing water level. */
  private initRivers(): void {
    const n = Math.floor((World.RIVER_X_MAX - World.RIVER_X_MIN) / World.RIVER_SAMPLE_STEP) + 1;
    for (const proto of this.riverProtos) {
      const r: RiverDef = { ...proto, levels: new Float32Array(n) };
      for (let i = 0; i < n; i++) {
        const x = World.RIVER_X_MIN + i * World.RIVER_SAMPLE_STEP;
        r.levels[i] = this.heightBeforeRivers(x, this.riverCentreZ(r, x));
      }
      // Two box-blur passes (~±80 m each) -> low-frequency level that follows the land
      const radius = 10;
      const tmp = new Float32Array(n);
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < n; i++) {
          let sum = 0;
          let cnt = 0;
          for (let j = -radius; j <= radius; j++) {
            const k = i + j;
            if (k < 0 || k >= n) continue;
            sum += r.levels[k];
            cnt++;
          }
          tmp[i] = sum / cnt;
        }
        r.levels.set(tmp);
      }
      this.rivers.push(r);
    }
  }

  public getNormalAt(x: number, z: number, out = new Vec3()): Vec3 {
    const eps = 0.6;
    const hL = this.getHeightAt(x - eps, z);
    const hR = this.getHeightAt(x + eps, z);
    const hD = this.getHeightAt(x, z - eps);
    const hU = this.getHeightAt(x, z + eps);
    return out.set(hL - hR, 2 * eps, hD - hU).normalize();
  }

  public getRoadFactorAt(x: number, z: number): number {
    // Primary North-South winding steppe road
    const nsCenterX = 16 * Math.sin(z * 0.0135) + 6 * Math.cos(z * 0.031);
    const dNS = Math.abs(x - nsCenterX);
    const roadNS = 1 - smoothstep(4.2, 8.8, dNS);

    // Secondary East-West tactical crossroad
    const ewCenterZ = 8 + 15 * Math.sin(x * 0.0145);
    const dEW = Math.abs(z - ewCenterZ);
    const roadEW = 1 - smoothstep(3.8, 8.2, dEW);

    // Outer patrol track loop at radius ~300m
    const r = Math.hypot(x * 0.96, z * 1.04);
    const dLoop = Math.abs(r - 300 + 12 * Math.sin(Math.atan2(z, x) * 3));
    const roadLoop = (1 - smoothstep(3.4, 7.5, dLoop)) * 0.88;

    return Math.max(roadNS, roadEW, roadLoop);
  }

  /** Register a runtime obstacle (e.g. a settled wreck). Returns nothing; pass the same object to removeObstacle. */
  public addObstacle(obs: ObstacleCollider): void {
    this.obstacles.push(obs);
  }

  public removeObstacle(obs: ObstacleCollider): void {
    const idx = this.obstacles.indexOf(obs);
    if (idx >= 0) this.obstacles.splice(idx, 1);
  }

  public getObstacles(): readonly ObstacleCollider[] {
    return this.obstacles;
  }

  public setQuality(quality: 'high' | 'medium' | 'default'): void {
    const density = quality === 'medium' ? 0.45 : 1;
    if (density !== this.grassDensity) {
      this.grassDensity = density;
      this.grassDirty = true;
    }
    const targetShadow = quality === 'high' ? 2048 : quality === 'medium' ? 1024 : 1536;
    if (this.sunLight.light!.shadowResolution !== targetShadow) {
      this.sunLight.light!.shadowResolution = targetShadow;
    }
  }

  private buildTerrainMesh(): void {
    const geo = plane(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS).rotateX(-Math.PI / 2);

    const pos = geo.positions, count = geo.vertexCount;
    this.terrainPositions = geo;
    const roadAttr = new Float32Array(count);
    const meadowAttr = new Float32Array(count);
    const wetAttr = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const vx = pos[i * 3];
      const vz = pos[i * 3 + 2];
      const vy = this.getHeightAt(vx, vz);
      pos[i * 3 + 1] = vy;
      const surface = this.riverSurfaceAt(vx, vz);
      wetAttr[i] = surface === undefined ? 0 : 1 - smoothstep(0.08, 0.64, vy - surface);

      let dirtMask = this.getRoadFactorAt(vx, vz);
      for (const pad of this.pads) {
        const dp = Math.hypot(vx - pad.x, vz - pad.z);
        if (dp < pad.outerRadius * 0.82) {
          dirtMask = Math.max(dirtMask, (1 - smoothstep(pad.innerRadius * 0.5, pad.outerRadius * 0.82, dp)) * 0.78);
        }
      }
      roadAttr[i] = dirtMask;
      meadowAttr[i] = valueNoise(vx * 0.048 + 11.3, vz * 0.048 + 11.3);
    }

    geo.setAttribute('aRoadMask', roadAttr, 1, 'ATTR7');
    geo.setAttribute('aMeadowDry', meadowAttr, 1, 'ATTR8');
    geo.setAttribute('aRiverWet', wetAttr, 1, 'ATTR9');
    geo.computeNormals();

    const tex = this.assets.terrainTextures;
    const mat = standard({ roughness: 0.90, metalness: 0.02, envIntensity: 0.55 });
    mat.setAttribute('aRoadMask', 'ATTR7');
    mat.setAttribute('aMeadowDry', 'ATTR8');
    mat.setAttribute('aRiverWet', 'ATTR9');
    mat.setParameter('uGrassColor', tex.grassColor);
    mat.setParameter('uDirtColor', tex.dirtColor);
    mat.setParameter('uTime', this.grassTimeUniform.value);
    this.animatedMaterials.push(mat);

    // Fast 4-tap splat + wet-puddle specular + drifting cumulus cloud shadows + directional Mie aerial perspective
    addShaderHooks(mat, {
      vsDecl: `
        attribute float aRoadMask;
        attribute float aMeadowDry;
        attribute float aRiverWet;
        varying vec3 vTerrainWorldPos;
        varying vec3 vTerrainWorldNormal;
        varying float vRoadMask;
        varying float vMeadowDry;
        varying float vRiverWet;`,
      vsMainEnd: `
        vTerrainWorldPos = vPositionW;
        vTerrainWorldNormal = normalize(vNormalW);
        vRoadMask = aRoadMask;
        vMeadowDry = aMeadowDry;
        vRiverWet = aRiverWet;`,
      psDecl: `
        uniform sampler2D uGrassColor;
        uniform sampler2D uDirtColor;
        uniform float uTime;
        varying vec3 vTerrainWorldPos;
        varying vec3 vTerrainWorldNormal;
        varying float vRoadMask;
        varying float vMeadowDry;
        varying float vRiverWet;
        float fastCloudNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
          float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
          float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
          float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }`,
      albedo: `
        vec2 detailUV = vTerrainWorldPos.xz * 0.145;
        vec3 grassCol = texture2D(uGrassColor, detailUV).rgb;
        grassCol *= mix(vec3(0.74, 0.85, 0.60), vec3(1.05, 0.96, 0.72), vMeadowDry * 0.74);
        vec3 dirtCol = texture2D(uDirtColor, detailUV * 1.15).rgb * vec3(0.90, 0.83, 0.74);
        float slopeFactor = smoothstep(0.11, 0.34, 1.0 - clamp(vTerrainWorldNormal.y, 0.0, 1.0));
        float splatDirt = clamp(max(vRoadMask * 0.96, slopeFactor * 0.88) + (vMeadowDry - 0.62) * 0.22, 0.0, 1.0);
        float rutWave = sin(vTerrainWorldPos.x * 0.85 + vTerrainWorldPos.z * 0.65);
        float puddleMask = smoothstep(0.62, 0.92, vRoadMask) * smoothstep(0.56, 0.80, vMeadowDry + rutWave * 0.18) * smoothstep(0.94, 0.995, vTerrainWorldNormal.y);
        vec3 baseAlbedo = mix(grassCol, dirtCol, splatDirt);
        baseAlbedo = mix(baseAlbedo, dirtCol * vec3(0.46, 0.44, 0.42), puddleMask * 0.78);
        baseAlbedo = mix(baseAlbedo, dirtCol * vec3(0.52, 0.47, 0.39), vRiverWet * 0.85);
        vec2 cloudUV = vTerrainWorldPos.xz * 0.0085 + vec2(uTime * 0.011, uTime * 0.005);
        float cloudN = fastCloudNoise(cloudUV) * 0.65 + fastCloudNoise(cloudUV * 2.3 + 4.1) * 0.35;
        dAlbedo = baseAlbedo * mix(0.68, 1.06, smoothstep(0.34, 0.68, cloudN));`,
      gloss: `
        float rutWaveR = sin(vTerrainWorldPos.x * 0.85 + vTerrainWorldPos.z * 0.65);
        float puddleR = smoothstep(0.62, 0.92, vRoadMask) * smoothstep(0.56, 0.80, vMeadowDry + rutWaveR * 0.18) * smoothstep(0.94, 0.995, vTerrainWorldNormal.y);
        float terrainRoughness = mix(mix(0.92, 0.76, vRoadMask), 0.13, puddleR);
        terrainRoughness = mix(terrainRoughness, 0.35, vRiverWet * 0.8);
        dGlossiness = 1.0 - terrainRoughness;`,
    });

    const terrainMesh = meshNode(geo, mat, this.root, { name: 'steppe_terrain', castShadows: false, receiveShadows: true });
    terrainMesh.setLocalPosition(0, 0, 0);
  }

  private populateBattlefieldProps(): void {
    // 1. Ruined Apartment Compounds (with foundation skirt sitting flush on flattened pads)
    this.placeRuinedBuilding('bldg_east', 38, 28, -0.35);
    this.placeRuinedBuilding('bldg_west', -46, -18, 2.65);
    this.placeRuinedBuilding('bldg_nw', -210, -60, 0.9);
    this.placeRuinedBuilding('bldg_ne', 190, -30, -0.55);
    this.placeRuinedBuilding('bldg_sw', -160, 280, 2.2);

    // 2. Northern Abandoned Fuel Station Depot
    this.placeFuelStation('fuel_north', 14, 126, 0.18);

    // 3. Guard Tower Checkpoints (tower + destructible gate boom)
    this.placeGuardTower('tower_nw', -94, 96, 0.72);
    this.placeGuardTower('tower_se', 106, -88, -2.15);
    this.placeGuardTower('tower_w', -250, 40, 1.15);
    this.placeGuardTower('tower_e', 260, -50, -0.8);

    // 4. Tactical Hesco Defensive Berms — batched into ONE InstancedMesh!
    const bermClusters: { cx: number; cz: number; yaw: number; count: number }[] = [
      { cx: 12, cz: -34, yaw: 0.12, count: 4 },
      { cx: -18, cz: 46, yaw: -0.45, count: 4 },
      { cx: 68, cz: 10, yaw: 1.35, count: 3 },
      { cx: -76, cz: -58, yaw: 0.65, count: 3 },
      { cx: -4, cz: 102, yaw: 0.08, count: 4 },
      { cx: 64, cz: -115, yaw: -0.5, count: 3 },
      { cx: -150, cz: -85, yaw: 0.3, count: 4 },
      { cx: 150, cz: 80, yaw: -1.2, count: 4 },
      { cx: -280, cz: -30, yaw: 1.9, count: 3 },
      { cx: 280, cz: 60, yaw: 0.55, count: 3 },
      { cx: -60, cz: -300, yaw: -0.9, count: 4 },
      { cx: 80, cz: 320, yaw: 2.4, count: 3 },
      { cx: -330, cz: 95, yaw: 0.15, count: 3 },
      { cx: 330, cz: -95, yaw: -2.6, count: 3 },
    ];
    const wallTransforms: Mat4[] = [];
    const wallColliders: ObstacleCollider[] = [];
    const dummy = new Entity();
    let wallIdx = 0;
    for (const c of bermClusters) {
      const cosY = Math.cos(c.yaw);
      const sinY = Math.sin(c.yaw);
      for (let i = 0; i < c.count; i++) {
        const offset = (i - (c.count - 1) * 0.5) * 3.05;
        const wx = c.cx + cosY * offset;
        const wz = c.cz - sinY * offset;
        const wy = this.getHeightAt(wx, wz) - 0.04;
        dummy.setLocalPosition(wx, wy, wz);
        setLocalEulerRad(dummy, 0, c.yaw, 0);
        dummy.setLocalScale(1, 1, 1);
        wallTransforms.push(dummy.getWorldTransform().clone());
        wallColliders.push({
          id: `hesco_${wallIdx++}`,
          kind: 'barrier',
          x: wx,
          y: wy,
          z: wz,
          radius: 1.42,
          height: 1.43,
          destructible: true,
          destroyed: false,
        });
      }
    }
    this.addBatchedStaticModel(this.assets.models.barrier_wall, wallTransforms, false, wallColliders);

    // 5. Destructible Supply Crate Stacks near compounds & checkpoints
    const crateCoords: [number, number, number][] = [
      [25, 22, 0.3],
      [28, 34, 1.1],
      [-33, -22, -0.4],
      [-55, -8, 0.8],
      [26, 120, -0.2],
      [-2, 122, 0.6],
      [-88, 88, 0.5],
      [98, -80, -0.7],
      [15, -39, 0.2],
      [-22, 51, 1.0],
      [72, 14, -0.3],
      [-72, -52, 0.4],
      // Supply depots: loose stacks around the two depot pads
      [-126, -50, 0.4], [-118, -52, 1.2], [-122, -60, 2.1], [-130, -58, 0.9],
      [126, 40, -0.6], [134, 42, 0.8], [130, 50, 1.9], [124, 52, 0.2],
      [138, 36, 2.6], [-114, -62, 1.7],
    ];
    crateCoords.forEach(([cx, cz, yaw], idx) => {
      const cy = this.getHeightAt(cx, cz) - 0.03;
      const crate = this.assets.models.supply_crates.clone();
      crate.setLocalPosition(cx, cy, cz);
      setLocalEulerRad(crate, 0, yaw, 0);
      this.root.addChild(crate);
      this.obstacles.push({
        id: `crate_${idx}`,
        kind: 'crates',
        x: cx,
        y: cy,
        z: cz,
        radius: 1.38,
        height: 2.6,
        destructible: true,
        lightCover: true,
        destroyed: false,
        mesh: crate,
      });
    });

    // 6. Deterministic Limestone Boulder Outcrops — batched into TWO InstancedMeshes (1 draw call each)!
    const largeRockTransforms: Mat4[] = [];
    const medRockTransforms: Mat4[] = [];
    const largeRockColliders: ObstacleCollider[] = [];
    const medRockColliders: ObstacleCollider[] = [];
    let rockIdx = 0;
    for (let i = 0; i < 120; i++) {
      const angle = i * 2.399963 + 0.5;
      const rad = 34 + ((i * 47) % 400);
      const rx = Math.cos(angle) * rad;
      const rz = Math.sin(angle) * rad;
      if (!this.isClearForScatter(rx, rz, 8.5)) continue;

      const isLarge = i % 3 !== 0;
      const scale = isLarge ? 0.95 + hash2(i, 7.1) * 0.65 : 0.9 + hash2(i, 3.3) * 0.55;
      const ry = this.getHeightAt(rx, rz) - 0.08 * scale;
      dummy.setLocalPosition(rx, ry, rz);
      setLocalEulerRad(dummy, 0, hash2(i, 19.3) * Math.PI * 2, 0);
      dummy.setLocalScale(scale, scale, scale);
      if (isLarge) largeRockTransforms.push(dummy.getWorldTransform().clone());
      else medRockTransforms.push(dummy.getWorldTransform().clone());

      (isLarge ? largeRockColliders : medRockColliders).push({
        id: `rock_${rockIdx++}`,
        kind: 'rock',
        x: rx,
        y: ry,
        z: rz,
        radius: (isLarge ? 1.32 : 0.74) * scale,
        height: (isLarge ? 1.38 : 0.74) * scale,
        destructible: true,
        destroyed: false,
      });
    }
    this.addBatchedStaticModel(this.assets.models.boulder_large, largeRockTransforms, true, largeRockColliders);
    this.addBatchedStaticModel(this.assets.models.boulder_medium, medRockTransforms, false, medRockColliders);

    // 7. Aspen Tree Clusters — 10 groves of 4-9 trees batched into shared InstancedMeshes
    //    (trunk colliders stay solid obstacles; instancing keeps draw calls flat)
    const treeRng = mulberry32(0x7ee5);
    const treeTransforms: Mat4[] = [];
    const treeColliders: ObstacleCollider[] = [];
    let treeIdx = 0;
    const clusterCount = 10;
    for (let c = 0; c < clusterCount; c++) {
      // Find a clear cluster centre
      let cx = 0;
      let cz = 0;
      let centreOk = false;
      for (let attempt = 0; attempt < 60 && !centreOk; attempt++) {
        cx = (treeRng() * 2 - 1) * 400;
        cz = (treeRng() * 2 - 1) * 400;
        centreOk = this.isClearForScatter(cx, cz, 14);
      }
      if (!centreOk) continue;

      const treeCount = 4 + Math.floor(treeRng() * 6); // 4..9
      for (let t = 0; t < treeCount; t++) {
        const ta = treeRng() * Math.PI * 2;
        const tr = 3 + treeRng() * 15;
        const tx = cx + Math.cos(ta) * tr;
        const tz = cz + Math.sin(ta) * tr;
        if (Math.abs(tx) > this.worldHalfSize - 12 || Math.abs(tz) > this.worldHalfSize - 12) continue;
        if (this.getWaterDepthAt(tx, tz) > 0.02) continue;
        if (this.getRoadFactorAt(tx, tz) > 0.3) continue;

        const scale = 0.82 + treeRng() * 0.42;
        const ty = this.getHeightAt(tx, tz) - 0.08 * scale;
        dummy.setLocalPosition(tx, ty, tz);
        setLocalEulerRad(dummy, 0, treeRng() * Math.PI * 2, 0);
        dummy.setLocalScale(scale, scale, scale); // Strictly uniform scale!
        treeTransforms.push(dummy.getWorldTransform().clone());

        treeColliders.push({
          id: `tree_${treeIdx++}`,
          kind: 'tree',
          x: tx,
          y: ty,
          z: tz,
          radius: 0.48 * scale, // Trunk collision cylinder
          height: 14.2 * scale,
          destructible: true,
          lightCover: true,
          destroyed: false,
        });
      }
    }
    this.addBatchedStaticModel(this.assets.models.tree, treeTransforms, true, treeColliders);
  }

  /** Match the terrain triangles at the shore, not just the driving height query. */
  private renderedGroundAt(x: number, z: number): number {
    const toGrid = (v: number) => clamp((v / TERRAIN_SIZE + 0.5) * TERRAIN_SEGMENTS, 0, TERRAIN_SEGMENTS);
    const gx = toGrid(x), gz = toGrid(z);
    const ix = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(gx));
    const iz = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(gz));
    const fx = gx - ix, fz = gz - iz;
    const stride = TERRAIN_SEGMENTS + 1;
    const i = iz * stride + ix;
    const pos = this.terrainPositions.positions;
    const east = pos[(i + 1) * 3 + 1], south = pos[(i + stride) * 3 + 1];
    if (fx + fz <= 1) return east * fx + south * fz + pos[i * 3 + 1] * (1 - fx - fz);
    return east * (1 - fz) + south * (1 - fx) + pos[(i + stride + 1) * 3 + 1] * (fx + fz - 1);
  }

  /** Two strips, with no reflection or refraction render passes. */
  private buildRiverWaterMeshes(): void {
    const COLS = 310;
    const ROWS = 21;
    const STEP = TERRAIN_SIZE / COLS;

    for (const r of this.rivers) {
      const vertCount = (COLS + 1) * ROWS;
      const positions = new Float32Array(vertCount * 3);
      const uvs = new Float32Array(vertCount * 2);
      const depths = new Float32Array(vertCount);
      const indices: number[] = [];

      for (let c = 0; c <= COLS; c++) {
        const x = -TERRAIN_SIZE * 0.5 + c * STEP;
        const cz = this.riverCentreZ(r, x);
        const hw = this.riverHalfWidth(r, x) + 4.5;
        const level = this.riverLevelAt(r, x);
        for (let j = 0; j < ROWS; j++) {
          const i = c * ROWS + j;
          const lateral = (2 * j / (ROWS - 1) - 1) * hw;
          const z = cz + lateral;
          positions.set([x, level, z], i * 3);
          uvs.set([x, lateral], i * 2);
          const edgeFade = 1 - smoothstep(0.82, 1, Math.abs(lateral / hw));
          depths[i] = Math.min(level - this.renderedGroundAt(x, z), 2 * edgeFade - 0.015);
        }
      }
      for (let c = 0; c < COLS; c++) {
        for (let j = 0; j < ROWS - 1; j++) {
          const a = c * ROWS + j;
          const b = a + ROWS;
          const d = a + 1;
          const e = b + 1;
          indices.push(a, d, b, b, d, e);
        }
      }

      const geo = new Geo(Array.from(positions), [], [], indices);
      geo.setAttribute('aWaterUv', uvs, 2, 'ATTR7');
      geo.setAttribute('aWaterDepth', depths, 1, 'ATTR8');
      geo.computeNormals();

      const mat = standard({ roughness: 0.13, metalness: 0, envIntensity: 1.1, transparent: true, depthWrite: false, doubleSided: true });
      mat.setAttribute('aWaterUv', 'ATTR7');
      mat.setAttribute('aWaterDepth', 'ATTR8');
      mat.setParameter('uTime', this.grassTimeUniform.value);
      this.animatedMaterials.push(mat);
      addShaderHooks(mat, {
        vsDecl: `
          attribute vec2 aWaterUv;
          attribute float aWaterDepth;
          varying vec2 vWaterUv;
          varying float vWaterDepth;
          varying vec3 vWaterWorld;`,
        vsMainEnd: `
          vWaterUv = aWaterUv;
          vWaterDepth = aWaterDepth;
          vWaterWorld = vPositionW;`,
        psDecl: `
          uniform float uTime;
          uniform vec3 view_position;
          varying vec2 vWaterUv;
          varying float vWaterDepth;
          varying vec3 vWaterWorld;
          float waterEddy(vec2 flow) { return sin(flow.x * 0.48 + flow.y * 0.63) + sin(flow.x * 0.29 - flow.y * 0.84); }
          float waterFoam(vec2 flow, float eddy, float depth) {
            float shore = smoothstep(0.025, 0.09, depth) * (1.0 - smoothstep(0.09, 0.27, depth));
            float flecks = sin(flow.x * 2.2 + eddy) * sin(flow.x * 0.9 - flow.y * 3.6);
            return shore * smoothstep(0.23, 0.83, flecks + eddy * 0.16) * 0.42;
          }`,
        albedo: `
          if (vWaterDepth <= 0.0) discard;
          vec2 flow = vWaterUv - vec2(uTime * 0.92, 0.0);
          float eddy = waterEddy(flow);
          float foam = waterFoam(flow, eddy, vWaterDepth);
          vec3 silt = mix(vec3(0.072, 0.083, 0.049), vec3(0.025, 0.054, 0.045), smoothstep(0.0, 1.08, vWaterDepth));
          dAlbedo = mix(silt * (1.0 + eddy * 0.035), vec3(0.52, 0.55, 0.49), foam);`,
        opacity: `
          vec2 flow = vWaterUv - vec2(uTime * 0.92, 0.0);
          float eddy = waterEddy(flow);
          float foam = waterFoam(flow, eddy, vWaterDepth);
          vec3 waterView = view_position - vWaterWorld;
          float waterNoV = clamp(abs(normalize(vNormalW).y), 0.0, 1.0);
          float fresnel = 0.0204 + 0.9796 * pow(1.0 - waterNoV, 5.0);
          float absorption = 1.0 - exp(-1.6 * vWaterDepth / max(0.25, waterNoV));
          dAlpha = (1.0 - (1.0 - absorption) * (1.0 - fresnel)) * smoothstep(0.0, 0.12, vWaterDepth);
          dAlpha = max(dAlpha, foam);`,
        gloss: `
          vec2 flow = vWaterUv - vec2(uTime * 0.92, 0.0);
          float eddy = waterEddy(flow);
          float foam = waterFoam(flow, eddy, vWaterDepth);
          dGlossiness = clamp(0.87 - 0.021 * eddy - foam * 0.34, 0.0, 1.0);`,
      });

      const mesh = meshNode(geo, mat, this.root, { name: 'river_water', castShadows: false, receiveShadows: true });
      mesh.render!.meshInstances[0].drawOrder = 2;
      mesh.render!.meshInstances[0].cull = false;
    }
  }

  private addBatchedStaticModel(
    template: Entity,
    worldMatrices: readonly Mat4[],
    castShadow: boolean,
    colliders: readonly ObstacleCollider[]
  ): void {
    if (worldMatrices.length === 0) return;
    const invRoot = new Mat4().copy(template.getWorldTransform()).invert();
    const localMat = new Mat4();
    const finalMat = new Mat4();
    const parts: { mesh: InstancedMesh; local: Mat4 }[] = [];

    template.forEach((obj) => {
      for (const mi of (obj as Entity).render?.meshInstances ?? []) {
        if (!mi.mesh || !mi.material) continue;
        localMat.mul2(invRoot, (obj as Entity).getWorldTransform());
        const inst = new InstancedMesh(mi.mesh, mi.material, worldMatrices.length, {
          parent: this.root, castShadows: castShadow, receiveShadows: true,
        });
        for (let i = 0; i < worldMatrices.length; i++) {
          finalMat.mul2(worldMatrices[i], localMat);
          inst.setMatrixAt(i, finalMat);
        }
        inst.update();
        parts.push({ mesh: inst, local: localMat.clone() });
      }
    });
    for (let i = 0; i < colliders.length; i++) {
      this.obstacles.push(colliders[i]);
      this.propBatchSlots.set(colliders[i], { index: i, world: worldMatrices[i], parts });
    }
  }

  private placeRuinedBuilding(id: string, x: number, z: number, yaw: number): void {
    const y = this.getHeightAt(x, z);
    const bldg = this.assets.models.ruined_building.clone();
    bldg.setLocalPosition(x, y, z);
    setLocalEulerRad(bldg, 0, yaw, 0);
    this.root.addChild(bldg);

    // Verified from asset_report.json: ruined_building bounds center is [+1.56, 6.43, +2.47]
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const localCx = 1.56;
    const localCz = 2.47;
    const worldCx = x + localCx * cosY + localCz * sinY;
    const worldCz = z - localCx * sinY + localCz * cosY;

    this.obstacles.push({
      id,
      kind: 'building',
      x: worldCx,
      y,
      z: worldCz,
      radius: 9.6,
      height: 13.0,
      destructible: true,
      destroyed: false,
      mesh: bldg,
    });
  }

  private placeFuelStation(id: string, x: number, z: number, yaw: number): void {
    const y = this.getHeightAt(x, z);
    const station = this.assets.models.fuel_station.clone();
    station.setLocalPosition(x, y, z);
    setLocalEulerRad(station, 0, yaw, 0);
    this.root.addChild(station);

    this.obstacles.push({
      id,
      kind: 'station',
      x,
      y,
      z,
      radius: 8.8,
      height: 6.0,
      destructible: true,
      destroyed: false,
      mesh: station,
    });
  }

  private placeGuardTower(id: string, x: number, z: number, yaw: number): void {
    const y = this.getHeightAt(x, z);
    const towerAssembly = this.assets.models.guard_tower.clone();
    towerAssembly.setLocalPosition(x, y, z);
    setLocalEulerRad(towerAssembly, 0, yaw, 0);
    this.root.addChild(towerAssembly);

    // Main 5.8x5.8m tower at local [0, 0, 0]
    this.obstacles.push({
      id,
      kind: 'tower',
      x,
      y,
      z,
      radius: 3.05,
      height: 10.45,
      destructible: true,
      destroyed: false,
      mesh: towerAssembly,
    });

    // Checkpoint barrier gate sub-assembly at local [+7.5, 0, 0] (destructible if rammed!)
    const gateNode = findByName(towerAssembly, 'barrier_gate');
    if (gateNode) {
      // Reparent without changing the gate's world pose so it can fall independently.
      const world = gateNode.getWorldTransform().clone();
      this.root.addChild(gateNode);
      const p = new Vec3(), q = new Quat(), s = new Vec3();
      decomposeMat(world, p, q, s);
      gateNode.setLocalPosition(p);
      gateNode.setLocalRotation(q);
      gateNode.setLocalScale(s);
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const gx = x + 7.5 * cosY;
      const gz = z - 7.5 * sinY;
      this.obstacles.push({
        id: `${id}_gate`,
        kind: 'barrier',
        x: gx,
        y,
        z: gz,
        radius: 2.3,
        height: 2.3,
        destructible: true,
        lightCover: true,
        destroyed: false,
        mesh: gateNode,
      });
    }
  }

  private isClearForScatter(x: number, z: number, clearance: number): boolean {
    // Stay inside the playable square (ridge begins ~470)
    if (Math.abs(x) > this.worldHalfSize - 20 || Math.abs(z) > this.worldHalfSize - 20) return false;
    // Keep both base staging meadows clear
    if (Math.hypot(x - 0, z + 420) < 44) return false;
    if (Math.hypot(x - 0, z - 420) < 44) return false;
    // Keep roads clear
    if (this.getRoadFactorAt(x, z) > 0.35) return false;
    // Keep out of the rivers
    if (this.getWaterDepthAt(x, z) > 0.02) return false;
    // Keep landmark pads clear
    for (const pad of this.pads) {
      if (Math.hypot(x - pad.x, z - pad.z) < pad.innerRadius + 4) return false;
    }
    // Keep existing obstacles clear
    for (const obs of this.obstacles) {
      const minD = obs.radius + clearance * 0.45;
      if ((x - obs.x) * (x - obs.x) + (z - obs.z) * (z - obs.z) < minD * minD) return false;
    }
    return true;
  }

  /**
   * Builds 7,500 lightweight GPU-instanced 4-blade grass clumps in a single fast draw call.
   */
  private buildInstancedSteppeGrass(): void {
    const bladeCount = 4, positions: number[] = [], normals: number[] = [], colors: number[] = [];
    const rootCol = linearColor('#2d381d'), tipCol = linearColor('#778348');
    for (let b = 0; b < bladeCount; b++) {
      const ang = b / bladeCount * Math.PI * 2 + b * 0.43;
      const lean = 0.09 + (b % 3) * 0.055, h = 0.24 + (b % 4) * 0.065, hw = 0.024;
      const cosA = Math.cos(ang), sinA = Math.sin(ang), offX = cosA * 0.06, offZ = sinA * 0.06;
      const lx = offX - sinA * hw, lz = offZ + cosA * hw;
      const rx = offX + sinA * hw, rz = offZ - cosA * hw;
      const tx = offX + cosA * lean, tz = offZ + sinA * lean;
      positions.push(lx, 0, lz, rx, 0, rz, tx, h, tz);
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      colors.push(rootCol.r, rootCol.g, rootCol.b, 1, rootCol.r, rootCol.g, rootCol.b, 1, tipCol.r, tipCol.g, tipCol.b, 1);
    }
    const tuftGeo = new Geo(positions, normals);
    tuftGeo.colors = colors;
    const tuftMat = standard({ vertexColors: true, doubleSided: true });
    enableInstanceColor(tuftMat);
    tuftMat.setParameter('uTime', 0);
    this.animatedMaterials.push(tuftMat);
    addShaderHooks(tuftMat, {
      vsDecl: 'uniform float uTime;',
      vsLocalPosition: `
        vec3 instWorld = getModelMatrix()[3].xyz;
        float swayWeight = clamp(vertex_position.y * 2.4, 0.0, 1.0);
        float gust = sin(uTime * 2.0 + instWorld.x * 0.14 + instWorld.z * 0.11) * 0.07;
        localPos.x += gust * swayWeight;
        localPos.z += gust * 0.5 * swayWeight;`,
    });
    const inst = new InstancedMesh(tuftGeo, tuftMat, World.GRASS_CAPACITY, {
      name: 'steppe_grass_instanced', parent: this.root, color: true, castShadows: false, receiveShadows: false,
    });
    inst.count = 0;
    inst.update();
    this.grassMesh = inst;
  }

  /** Deterministic tuft candidates for one 40 m chunk; null when the chunk is bare. */
  private computeGrassChunk(
    cx: number,
    cz: number
  ): { mats: Float32Array; cols: Float32Array; count: number } | null {
    const CH = World.GRASS_CHUNK;
    const x0 = cx * CH;
    const z0 = cz * CH;
    const maxTufts = 90;
    const mats = new Float32Array(maxTufts * 16);
    const cols = new Float32Array(maxTufts * 3);
    const dummy = new Entity();
    let count = 0;

    for (let i = 0; i < 240 && count < maxTufts; i++) {
      const gx = x0 + hash2(cx * 12.9898 + i * 0.731, cz * 78.233) * CH;
      const gz = z0 + hash2(cx * 39.346 + i * 1.913, cz * 11.135 + i * 0.377) * CH;
      if (Math.abs(gx) > 500 || Math.abs(gz) > 500) continue;
      if (this.getRoadFactorAt(gx, gz) > 0.22) continue;
      // Cluster into natural organic meadow patches instead of uniform isolated dots
      if (valueNoise(gx * 0.07 + 4.2, gz * 0.07 - 2.9) < 0.34) continue;
      if (this.getWaterDepthAt(gx, gz) > 0.02) continue;

      let insidePad = false;
      for (const pad of this.pads) {
        if (Math.hypot(gx - pad.x, gz - pad.z) < pad.innerRadius + 1.5) {
          insidePad = true;
          break;
        }
      }
      if (insidePad) continue;

      const gy = this.getHeightAt(gx, gz);
      const n = this.getNormalAt(gx, gz, this._rayNorm);
      if (n.y < 0.84) continue;

      const sc = 0.75 + hash2(cx * 3.1 + i * 7.7, cz * 5.3 + i * 2.9) * 0.72;
      dummy.setLocalPosition(gx, gy - 0.015, gz);
      setLocalEulerRad(dummy, 0, hash2(cx * 9.7 + i, cz * 4.1 + i * 3.3) * Math.PI * 2, 0);
      dummy.setLocalScale(sc, sc, sc);
      const e = dummy.getWorldTransform().data;
      for (let j = 0; j < 16; j++) mats[count * 16 + j] = e[j];

      const dry = valueNoise(gx * 0.055 + 11.3, gz * 0.055 + 11.3);
      cols[count * 3] = lerp(0.82, 1.12, dry);
      cols[count * 3 + 1] = lerp(0.92, 1.00, dry);
      cols[count * 3 + 2] = lerp(0.74, 0.80, dry);
      count++;
    }

    if (count === 0) return null;
    return {
      mats: mats.slice(0, count * 16),
      cols: cols.slice(0, count * 3),
      count,
    };
  }

  /** Refill the single grass InstancedMesh from cached chunks in view. */
  private rebuildGrassInstances(): void {
    const inst = this.grassMesh;
    if (!inst) return;
    const stride = this.grassDensity >= 0.99 ? 1 : Math.max(1, Math.round(1 / this.grassDensity));
    const data = inst.data, instanceStride = inst.stride;
    let out = 0;
    const cap = World.GRASS_CAPACITY;

    for (const k of this.grassNeeded) {
      const ch = this.grassChunks.get(k);
      if (!ch) continue;
      for (let i = 0; i < ch.count && out < cap; i += stride) {
        const so = i * 16, dof = out * instanceStride;
        for (let j = 0; j < 16; j++) data[dof + j] = ch.mats[so + j];
        data[dof + 16] = ch.cols[i * 3];
        data[dof + 17] = ch.cols[i * 3 + 1];
        data[dof + 18] = ch.cols[i * 3 + 2];
        data[dof + 19] = 1;
        out++;
      }
      if (out >= cap) break;
    }

    inst.count = out;
    inst.markDirty();
    inst.update();
  }

  /** Camera-following grass streaming: one new chunk computed per frame max. */
  private updateGrass(focusX: number, focusZ: number): void {
    const inst = this.grassMesh;
    if (!inst) return;

    const CH = World.GRASS_CHUNK;
    const ccx = Math.floor(focusX / CH);
    const ccz = Math.floor(focusZ / CH);
    const cellKey = (ccx + 512) * 2048 + (ccz + 512);
    if (cellKey !== this._grassCellKey) {
      this._grassCellKey = cellKey;
      this.grassNeeded.clear();
      const reach = World.GRASS_VIEW + CH * 0.75;
      const reachSq = reach * reach;
      for (let dx = -5; dx <= 5; dx++) {
        for (let dz = -5; dz <= 5; dz++) {
          const cx = ccx + dx;
          const cz = ccz + dz;
          const mx = (cx + 0.5) * CH - focusX;
          const mz = (cz + 0.5) * CH - focusZ;
          if (mx * mx + mz * mz > reachSq) continue;
          this.grassNeeded.add((cx + 32) * 128 + (cz + 32));
        }
      }
      this.grassComputeQueue.length = 0;
      this.grassDirty = true;
    }

    if (this.grassComputeQueue.length === 0) {
      // Rebuild the compute queue (nearest chunks first) when the needed set changed
      if (this.grassDirty) {
        const pending: { k: number; d: number }[] = [];
        for (const k of this.grassNeeded) {
          if (this.grassChunks.has(k)) continue;
          const cx = Math.floor(k / 128) - 32;
          const cz = (k % 128) - 32;
          const mx = (cx + 0.5) * CH - focusX;
          const mz = (cz + 0.5) * CH - focusZ;
          pending.push({ k, d: mx * mx + mz * mz });
        }
        if (pending.length > 0) {
          pending.sort((a, b) => a.d - b.d);
          this.grassComputeQueue = pending.map((p) => p.k);
        }
      }
    }

    if (this.grassComputeQueue.length > 0) {
      const k = this.grassComputeQueue.shift()!;
      const cx = Math.floor(k / 128) - 32;
      const cz = (k % 128) - 32;
      this.grassChunks.set(k, this.computeGrassChunk(cx, cz));
      this.grassDirty = true;
    }

    if (this.grassDirty) {
      this.rebuildGrassInstances();
      this.grassDirty = false;
    }
  }

  public damageObstacle(obstacle: ObstacleCollider, amount: number, dirX = 0, dirZ = 0): boolean {
    if (obstacle.destroyed || !obstacle.destructible || amount <= 0) return false;
    obstacle.damage = (obstacle.damage ?? 0) + amount;
    const durability = obstacle.lightCover && obstacle.kind === 'barrier' ? 24 : PROP_DURABILITY[obstacle.kind];
    if (obstacle.damage < durability) return false;
    obstacle.destroyed = true;
    const batch = this.propBatchSlots.get(obstacle);
    const mesh = obstacle.mesh ?? (batch ? new Entity() : null);
    if (mesh) {
      if (batch) {
        const p = new Vec3(), q = new Quat(), s = new Vec3();
        decomposeMat(batch.world, p, q, s);
        mesh.setLocalPosition(p);
        mesh.setLocalRotation(q);
        mesh.setLocalScale(s);
      }
      const axis = dirX * dirX + dirZ * dirZ > 0.001
        ? new Vec3(dirZ, 0, -dirX).normalize()
        : new Vec3(1, 0, 0);
      const collapse = !obstacle.lightCover;
      this.fallingProps.push({
        mesh,
        axis,
        angle: 0,
        angVel: collapse ? 0.1 : obstacle.kind === 'tree' ? 1.35 : 3.2,
        maxAngle: collapse ? 0.3 : Math.PI * 0.48,
        sinkY: collapse ? Math.min(0.6, obstacle.height * 0.1) : obstacle.kind === 'crates' ? 0.55 : 0.05,
        startScaleY: mesh.getLocalScale().y,
        collapse,
        obstacle,
        batch,
      });
    }
    this.onObstacleDestroyed?.(obstacle);
    return true;
  }

  public blastObstacles(x: number, y: number, z: number, radius: number, amount: number): void {
    if (radius <= 0 || amount <= 0) return;
    for (const o of this.obstacles) {
      if (o.destroyed || !o.destructible) continue;
      const dx = o.x - x, dz = o.z - z;
      const edge = Math.max(0, Math.hypot(dx, dz) - o.radius);
      const dy = Math.max(o.y - y, y - o.y - o.height, 0);
      const dist = Math.hypot(edge, dy);
      if (dist < radius) this.damageObstacle(o, amount * (1 - dist / radius), dx, dz);
    }
  }

  private scatterRubble(o: ObstacleCollider): void {
    const capacity = 800;
    if (!this.rubble) {
      const material = standard({ roughness: 0.94 });
      enableInstanceColor(material);
      this.rubble = new InstancedMesh(dodecahedron(1, 0), material, capacity, {
        name: 'scenery_rubble', parent: this.root, color: true, castShadows: false, receiveShadows: true,
      });
      this.rubble.count = 0;
    }
    const count = Math.min(18, 5 + Math.ceil(o.radius));
    for (let i = 0; i < count; i++) {
      const a = i * 2.39996 + o.x;
      const r = o.radius * Math.sqrt((i + 0.5) / count) * 0.97;
      const x = o.x + Math.sin(a) * r, z = o.z + Math.cos(a) * r;
      const size = Math.min(1.6, o.radius * 0.38) * (0.63 + 0.75 * hash2(i, o.x));
      const shade = 0.39 + hash2(i, o.z) * 0.16;
      const matrix = composeMat(new Mat4(), new Vec3(x, this.getHeightAt(x, z) + size * 0.17, z),
        quatFromEuler(new Quat(), i * 1.7, a, i * 0.54), new Vec3(size, size * 0.58, size * 0.83));
      this.rubble.setMatrixAt(this.rubbleIndex, matrix);
      this.rubble.setColorAt(this.rubbleIndex, shade, shade * 0.92, shade * 0.79);
      this.rubbleIndex = (this.rubbleIndex + 1) % capacity;
    }
    this.rubble.count = Math.min(capacity, this.rubble.count + count);
    this.rubble.update();
  }

  /** Dev/bench counter: total raycastWorld calls (reset via bench tooling). */
  public raycastCount = 0;

  public raycastWorld(origin: Vec3, dir: Vec3, maxDist: number): WorldRayHit | null {
    this.raycastCount++;
    let bestDist = maxDist;
    let hitKind: 'terrain' | 'obstacle' | null = null;
    let hitObs: ObstacleCollider | undefined;
    const hitPoint = this._rayPt;
    const hitNormal = this._rayNorm.set(0, 1, 0);

    // 1. Analytical vertical cylinder intersection against non-destroyed obstacles
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;
    const horizLenSq = dx * dx + dz * dz;

    for (let i = 0; i < this.obstacles.length; i++) {
      const obs = this.obstacles[i];
      if (obs.destroyed) continue;
      const ox = origin.x - obs.x;
      const oz = origin.z - obs.z;
      const c = ox * ox + oz * oz - obs.radius * obs.radius;
      let first = 0, last = bestDist;
      if (horizLenSq > 1e-7) {
        const b = ox * dx + oz * dz;
        if (c > 0 && b > 0) continue;
        const disc = b * b - horizLenSq * c;
        if (disc < 0) continue;
        const root = Math.sqrt(disc);
        first = (-b - root) / horizLenSq;
        last = (-b + root) / horizLenSq;
      } else if (c > 0) continue;

      let cap = false;
      if (Math.abs(dy) > 1e-7) {
        const t1 = (obs.y - origin.y) / dy;
        const t2 = (obs.y + obs.height - origin.y) / dy;
        const enter = Math.min(t1, t2);
        if (enter > first) { first = enter; cap = true; }
        last = Math.min(last, Math.max(t1, t2));
      } else if (origin.y < obs.y || origin.y > obs.y + obs.height) continue;

      const t = Math.max(0, first);
      if (t > last || t >= bestDist) continue;
      bestDist = t;
      hitKind = 'obstacle';
      hitObs = obs;
      hitPoint.set(origin.x + dx * t, origin.y + dy * t, origin.z + dz * t);
      if (t === 0) negate(hitNormal.copy(dir));
      else if (cap) hitNormal.set(0, -Math.sign(dy), 0);
      else hitNormal.set(hitPoint.x - obs.x, 0, hitPoint.z - obs.z).normalize();
    }

    // 2. Fast adaptive heightmap march + 4-step binary refinement
    const stepBase = 3.6;
    let prevT = 0;

    for (let t = stepBase; t <= bestDist + stepBase; t += stepBase) {
      const clampedT = Math.min(t, bestDist);
      const px = origin.x + dx * clampedT;
      const py = origin.y + dy * clampedT;
      const pz = origin.z + dz * clampedT;

      if (py <= this.getHeightAt(px, pz)) {
        let lo = prevT;
        let hi = clampedT;
        for (let iter = 0; iter < 4; iter++) {
          const mid = 0.5 * (lo + hi);
          if (origin.y + dy * mid <= this.getHeightAt(origin.x + dx * mid, origin.z + dz * mid)) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        if (hi <= bestDist) {
          bestDist = hi;
          hitKind = 'terrain';
          hitObs = undefined;
          hitPoint.set(origin.x + dx * hi, origin.y + dy * hi, origin.z + dz * hi);
          hitPoint.y = this.getHeightAt(hitPoint.x, hitPoint.z);
          this.getNormalAt(hitPoint.x, hitPoint.z, hitNormal);
        }
        break;
      }

      prevT = clampedT;
      if (clampedT >= bestDist) break;
    }

    if (!hitKind) return null;

    this._rayHitResult.point.copy(hitPoint);
    this._rayHitResult.normal.copy(hitNormal);
    this._rayHitResult.distance = bestDist;
    this._rayHitResult.hitKind = hitKind;
    this._rayHitResult.obstacle = hitObs;
    return this._rayHitResult;
  }

  public getSafeSpawnPoint(
    preferRadiusMin: number,
    preferRadiusMax: number,
    avoidPoints: readonly Vec3[],
    center?: { x: number; z: number }
  ): Vec3 {
    const cx0 = center?.x ?? 0;
    const cz0 = center?.z ?? 0;
    const best = new Vec3(cx0, 0, cz0);
    let bestScore = -Infinity;

    for (let attempt = 0; attempt < 42; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = lerp(preferRadiusMin, preferRadiusMax, Math.random());
      const cx = clamp(cx0 + Math.cos(ang) * rad, -this.worldHalfSize + 24, this.worldHalfSize - 24);
      const cz = clamp(cz0 + Math.sin(ang) * rad, -this.worldHalfSize + 24, this.worldHalfSize - 24);

      // Must be clear of solid obstacles
      let blocked = false;
      for (const obs of this.obstacles) {
        if (obs.destroyed) continue;
        const dSq = (cx - obs.x) * (cx - obs.x) + (cz - obs.z) * (cz - obs.z);
        const need = obs.radius + 5.5;
        if (dSq < need * need) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      // Never spawn in water or on slopes tanks cannot climb
      if (this.getWaterDepthAt(cx, cz) > 0.02) continue;
      const n = this.getNormalAt(cx, cz, this._rayNorm);
      if (n.y < 0.72) continue;

      let minDistToAvoid = 999;
      for (const p of avoidPoints) {
        const d = Math.hypot(cx - p.x, cz - p.z);
        if (d < minDistToAvoid) minDistToAvoid = d;
      }

      if (minDistToAvoid > bestScore) {
        bestScore = minDistToAvoid;
        best.set(cx, this.getHeightAt(cx, cz), cz);
      }
      if (minDistToAvoid > 165) break;
    }

    best.y = this.getHeightAt(best.x, best.z);
    return best;
  }

  public update(dt: number, shadowFocusPos: Vec3, grassFocusPos?: Vec3): void {
    this.elapsedTime += dt;
    this.grassTimeUniform.value = this.elapsedTime;
    for (const material of this.animatedMaterials) material.setParameter('uTime', this.elapsedTime);
    this.updateGrass((grassFocusPos ?? shadowFocusPos).x, (grassFocusPos ?? shadowFocusPos).z);

    // Only update sun shadow frustum when player moves onto a new 3m cell
    const snap = 3.0;
    const fx = Math.round(shadowFocusPos.x / snap) * snap;
    const fz = Math.round(shadowFocusPos.z / snap) * snap;
    if (fx !== this.lastShadowSnapX || fz !== this.lastShadowSnapZ) {
      this.lastShadowSnapX = fx;
      this.lastShadowSnapZ = fz;
      const fy = this.getHeightAt(fx, fz);
      this.sunLight.setPosition(fx + 110, fy + 145, fz - 85);
    }

    // Animate toppling trees / crushed crates
    for (let i = this.fallingProps.length - 1; i >= 0; i--) {
      const fp = this.fallingProps[i];
      fp.angVel += 4.2 * dt;
      const step = Math.min(fp.angVel * dt, fp.maxAngle - fp.angle);
      fp.angle += step;
      fp.mesh.setRotation(quatFromAxisAngle(new Quat(), fp.axis, step).mul(fp.mesh.getRotation()));
      const position = fp.mesh.getLocalPosition();
      fp.mesh.setLocalPosition(position.x, position.y - fp.sinkY * (step / fp.maxAngle), position.z);
      if (fp.collapse) {
        const scale = fp.mesh.getLocalScale();
        fp.mesh.setLocalScale(scale.x, fp.startScaleY * (1 - 0.91 * fp.angle / fp.maxAngle), scale.z);
      }
      if (fp.batch) {
        for (const { mesh, local } of fp.batch.parts) {
          this.propInstanceMatrix.mul2(fp.mesh.getWorldTransform(), local);
          mesh.setMatrixAt(fp.batch.index, this.propInstanceMatrix);
          mesh.update();
        }
      }
      if (fp.angle >= fp.maxAngle - 0.001) {
        if (fp.collapse) this.scatterRubble(fp.obstacle);
        this.fallingProps.splice(i, 1);
      }
    }
  }

  /** River centreline polylines for the tactical radar (built once at load). */
  public getRiverRadarSamples(): { x: number; z: number; halfWidth: number }[][] {
    const out: { x: number; z: number; halfWidth: number }[][] = [];
    for (const r of this.rivers) {
      const line: { x: number; z: number; halfWidth: number }[] = [];
      for (let x = -500; x <= 500; x += 12) {
        line.push({ x, z: this.riverCentreZ(r, x), halfWidth: this.riverHalfWidth(r, x) });
      }
      out.push(line);
    }
    return out;
  }

  /** Mound footprints for the tactical radar. */
  public getMoundRadarSamples(): { x: number; z: number; radius: number; height: number }[] {
    return this.mounds.map((m) => ({ x: m.x, z: m.z, radius: m.radius, height: m.height }));
  }

  /** Debug counters for QA probes. */
  public get moundCount(): number {
    return this.mounds.length;
  }
  public get riverCount(): number {
    return this.rivers.length;
  }
  public get grassStats(): { cached: number; needed: number; instances: number } {
    return {
      cached: this.grassChunks.size,
      needed: this.grassNeeded.size,
      instances: this.grassMesh?.count ?? 0,
    };
  }
  public get obstacleCount(): number {
    return this.obstacles.length;
  }

  /**
   * Side of each river centreline a point sits on: -1 south, +1 north,
   * 0 when comfortably outside the corridor. Used for ford telemetry.
   */
  public getRiverSides(x: number, z: number, out: number[]): void {
    out.length = 0;
    for (const r of this.rivers) {
      const lat = z - this.riverCentreZ(r, x);
      if (Math.abs(lat) > this.riverHalfWidth(r, x) + 30) {
        out.push(0);
      } else {
        out.push(lat >= 0 ? 1 : -1);
      }
    }
  }
}
