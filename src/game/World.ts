import * as THREE from 'three';
import type { LoadedGameAssets } from './AssetLoader';
import type { ObstacleCollider, ObstacleKind, TerrainQuery, WorldRayHit } from './types';

interface LandmarkPad {
  x: number;
  z: number;
  innerRadius: number;
  outerRadius: number;
  elevation: number;
}

interface FallingPropAnim {
  mesh: THREE.Object3D;
  axis: THREE.Vector3;
  angle: number;
  angVel: number;
  maxAngle: number;
  sinkY: number;
}

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
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export class World implements TerrainQuery {
  public readonly worldHalfSize = 520;
  public readonly root = new THREE.Group();
  public readonly sunLight: THREE.DirectionalLight;
  public readonly hemiLight: THREE.HemisphereLight;

  private readonly pads: LandmarkPad[] = [];
  private readonly obstacles: ObstacleCollider[] = [];
  private readonly fallingProps: FallingPropAnim[] = [];
  private grassMesh: THREE.InstancedMesh | null = null;
  private grassTimeUniform = { value: 0 };
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

  private readonly _rayPt = new THREE.Vector3();
  private readonly _rayNorm = new THREE.Vector3();
  private readonly _rayHitResult: WorldRayHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    hitKind: 'terrain',
  };
  private lastShadowSnapX = Infinity;
  private lastShadowSnapZ = Infinity;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly assets: LoadedGameAssets
  ) {
    this.root.name = 'battlefield_world';
    this.scene.add(this.root);

    // Calibrated atmospheric sky & environment reflections
    this.scene.background = assets.skyBackground;
    this.scene.environment = assets.skyEnvMap;
    this.scene.environmentIntensity = 0.92;
    this.scene.fog = new THREE.FogExp2('#9eb0ba', 0.0011);

    // Warm golden-afternoon directional sun + cool sky bounce hemisphere
    this.hemiLight = new THREE.HemisphereLight('#c6dcff', '#5b6344', 0.52);
    this.root.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight('#fff1d6', 2.65);
    this.sunLight.position.set(110, 145, -85);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1536, 1536);
    this.sunLight.shadow.camera.near = 20;
    this.sunLight.shadow.camera.far = 340;
    const shadowHalf = 80;
    this.sunLight.shadow.camera.left = -shadowHalf;
    this.sunLight.shadow.camera.right = shadowHalf;
    this.sunLight.shadow.camera.top = shadowHalf;
    this.sunLight.shadow.camera.bottom = -shadowHalf;
    this.sunLight.shadow.bias = -0.00045;
    this.sunLight.shadow.normalBias = 0.025;
    this.root.add(this.sunLight);
    this.root.add(this.sunLight.target);

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
      h = THREE.MathUtils.lerp(h, 0.0, w * 0.85);
    }
    const dRed = Math.hypot(x - 0, z - 420);
    if (dRed < 46) {
      const w = 1 - smoothstep(14, 46, dRed);
      h = THREE.MathUtils.lerp(h, 0.0, w * 0.85);
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
        h = THREE.MathUtils.lerp(h, p.elevation, w);
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
      // Channel profile: bed sits ~1.05 m under the surface with ±0.1 m ripple,
      // so depth never exceeds ~1.15 m. Lerp (not min) also fills terrain
      // hollows inside the corridor instead of leaving them over-deep.
      const bed = level - 1.05 + (valueNoise(x * 0.11 + 7.7, z * 0.11 - 3.1) - 0.5) * 0.2;
      const carveT = 1 - smoothstep(hw, hw + 6, lat);
      h = THREE.MathUtils.lerp(h, bed, carveT);
      // Hard cap: no point inside the corridor may sit more than ~1.18 m under
      // the surface, even where a terrain hollow reaches into the bank blend.
      const floorY = level - 1.18;
      if (h < floorY) h = floorY;
    }
    return h;
  }

  /** Water depth in metres at (x,z); 0 outside river corridors. */
  public getWaterDepthAt(x: number, z: number): number {
    let depth = 0;
    for (let i = 0; i < this.rivers.length; i++) {
      const r = this.rivers[i];
      const lat = Math.abs(z - this.riverCentreZ(r, x));
      if (lat >= this.riverHalfWidth(r, x) + 6) continue;
      const level = this.riverLevelAt(r, x);
      const d = level - this.getHeightAt(x, z);
      if (d > depth) depth = d;
    }
    return depth > 0 ? depth : 0;
  }

  /** River surface level at (x,z); 0 when the point is outside every corridor. */
  public getWaterLevelAt(x: number, z: number): number {
    for (let i = 0; i < this.rivers.length; i++) {
      const r = this.rivers[i];
      const lat = Math.abs(z - this.riverCentreZ(r, x));
      if (lat < this.riverHalfWidth(r, x) + 6) {
        return this.riverLevelAt(r, x);
      }
    }
    return 0;
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
    const fx = THREE.MathUtils.clamp(
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

  public getNormalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
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
    if (this.sunLight.shadow.mapSize.x !== targetShadow) {
      this.sunLight.shadow.mapSize.set(targetShadow, targetShadow);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
  }

  private buildTerrainMesh(): void {
    const terrainSize = 1240;
    const segs = 256;
    const geo = new THREE.PlaneGeometry(terrainSize, terrainSize, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position as THREE.BufferAttribute;
    const roadAttr = new Float32Array(pos.count);
    const meadowAttr = new Float32Array(pos.count);

    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vz = pos.getZ(i);
      const vy = this.getHeightAt(vx, vz);
      pos.setY(i, vy);

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

    geo.setAttribute('aRoadMask', new THREE.BufferAttribute(roadAttr, 1));
    geo.setAttribute('aMeadowDry', new THREE.BufferAttribute(meadowAttr, 1));
    geo.computeVertexNormals();

    const tex = this.assets.terrainTextures;
    const mat = new THREE.MeshStandardMaterial({
      map: tex.grassColor,
      normalMap: tex.grassNormal,
      roughness: 0.90,
      metalness: 0.02,
      envMapIntensity: 0.55,
    });

    // Fast 4-tap splat + wet-puddle specular + drifting cumulus cloud shadows + directional Mie aerial perspective
    mat.customProgramCacheKey = () => 'steppe-terrain-hyper-v2';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDirtColor = { value: tex.dirtColor };
      shader.uniforms.uDirtNormal = { value: tex.dirtNormal };
      shader.uniforms.uTime = this.grassTimeUniform;
      shader.uniforms.uSunDir = { value: new THREE.Vector3(110, 145, -85).normalize() };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aRoadMask;
          attribute float aMeadowDry;
          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;
          varying float vRoadMask;
          varying float vMeadowDry;`
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vTerrainWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
          vRoadMask = aRoadMask;
          vMeadowDry = aMeadowDry;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D uDirtColor;
          uniform sampler2D uDirtNormal;
          uniform float uTime;
          uniform vec3 uSunDir;
          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;
          varying float vRoadMask;
          varying float vMeadowDry;

          float fastCloudNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
            float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
            float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
            float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
          }`
        )
        .replace(
          '#include <map_fragment>',
          `
          vec2 detailUV = vTerrainWorldPos.xz * 0.145;
          vec3 grassCol = texture2D(map, detailUV).rgb;
          grassCol *= mix(vec3(0.74, 0.85, 0.60), vec3(1.05, 0.96, 0.72), vMeadowDry * 0.74);

          vec3 dirtCol = texture2D(uDirtColor, detailUV * 1.15).rgb * vec3(0.90, 0.83, 0.74);

          float slopeFactor = smoothstep(0.11, 0.34, 1.0 - clamp(vTerrainWorldNormal.y, 0.0, 1.0));
          float splatDirt = clamp(max(vRoadMask * 0.96, slopeFactor * 0.88) + (vMeadowDry - 0.62) * 0.22, 0.0, 1.0);

          // Wet mud wheel-ruts & rain puddles along flat road stretches
          float rutWave = sin(vTerrainWorldPos.x * 0.85 + vTerrainWorldPos.z * 0.65);
          float puddleMask = smoothstep(0.62, 0.92, vRoadMask)
                           * smoothstep(0.56, 0.80, vMeadowDry + rutWave * 0.18)
                           * smoothstep(0.94, 0.995, vTerrainWorldNormal.y);

          vec3 baseAlbedo = mix(grassCol, dirtCol, splatDirt);
          baseAlbedo = mix(baseAlbedo, dirtCol * vec3(0.46, 0.44, 0.42), puddleMask * 0.78);

          // Drifting overhead cumulus cloud shadows across the 520m valley
          vec2 cloudUV = vTerrainWorldPos.xz * 0.0085 + vec2(uTime * 0.011, uTime * 0.005);
          float cloudN = fastCloudNoise(cloudUV) * 0.65 + fastCloudNoise(cloudUV * 2.3 + 4.1) * 0.35;
          float cloudLight = mix(0.68, 1.06, smoothstep(0.34, 0.68, cloudN));

          diffuseColor.rgb *= baseAlbedo * cloudLight;
          `
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `
          float roughnessFactor = roughness;
          float rutWaveR = sin(vTerrainWorldPos.x * 0.85 + vTerrainWorldPos.z * 0.65);
          float puddleR = smoothstep(0.62, 0.92, vRoadMask)
                        * smoothstep(0.56, 0.80, vMeadowDry + rutWaveR * 0.18)
                        * smoothstep(0.94, 0.995, vTerrainWorldNormal.y);
          // Mirror-smooth wet puddle specular glints (0.13) vs matte grass/soil (0.90)
          roughnessFactor = mix(mix(0.92, 0.76, vRoadMask), 0.13, puddleR);
          `
        )
        .replace(
          '#include <normal_fragment_maps>',
          `
          vec2 nUV = vTerrainWorldPos.xz * 0.145;
          vec3 gN = texture2D(normalMap, nUV).xyz * 2.0 - 1.0;
          vec3 dN = texture2D(uDirtNormal, nUV * 1.15).xyz * 2.0 - 1.0;
          float slopeN = smoothstep(0.11, 0.34, 1.0 - clamp(vTerrainWorldNormal.y, 0.0, 1.0));
          float splatN = clamp(max(vRoadMask * 0.96, slopeN * 0.88), 0.0, 1.0);
          float rutWaveN = sin(vTerrainWorldPos.x * 0.85 + vTerrainWorldPos.z * 0.65);
          float puddleN = smoothstep(0.62, 0.92, vRoadMask)
                        * smoothstep(0.56, 0.80, vMeadowDry + rutWaveN * 0.18)
                        * smoothstep(0.94, 0.995, vTerrainWorldNormal.y);
          vec3 blendedTangentN = normalize(mix(gN, dN, splatN));
          // Flatten surface normal across standing water puddles for razor-sharp sky speculars
          float bumpAmp = mix(0.42, 0.04, puddleN);
          vec3 worldPerturb = normalize(vTerrainWorldNormal + vec3(blendedTangentN.x * bumpAmp, 0.0, blendedTangentN.y * bumpAmp));
          normal = normalize((viewMatrix * vec4(worldPerturb, 0.0)).xyz);
          `
        )
        .replace(
          '#include <fog_fragment>',
          `#ifdef USE_FOG
            vec3 viewToFrag = normalize(vTerrainWorldPos - cameraPosition);
            float sunAlign = max(dot(viewToFrag, uSunDir), 0.0);
            vec3 rayleighSky = vec3(0.58, 0.69, 0.80);
            vec3 mieSunHaze  = vec3(0.96, 0.86, 0.70);
            vec3 scatterColor = mix(rayleighSky, mieSunHaze, pow(sunAlign, 3.0) * 0.72);
            float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, scatterColor, clamp(fogFactor, 0.0, 1.0));
          #endif`
        );
    };

    const terrainMesh = new THREE.Mesh(geo, mat);
    terrainMesh.name = 'steppe_terrain';
    terrainMesh.receiveShadow = true;
    terrainMesh.updateMatrix();
    terrainMesh.matrixAutoUpdate = false;
    this.root.add(terrainMesh);
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
    const wallTransforms: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    let wallIdx = 0;
    for (const c of bermClusters) {
      const cosY = Math.cos(c.yaw);
      const sinY = Math.sin(c.yaw);
      for (let i = 0; i < c.count; i++) {
        const offset = (i - (c.count - 1) * 0.5) * 3.05;
        const wx = c.cx + cosY * offset;
        const wz = c.cz - sinY * offset;
        const wy = this.getHeightAt(wx, wz) - 0.04;
        dummy.position.set(wx, wy, wz);
        dummy.rotation.set(0, c.yaw, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        wallTransforms.push(dummy.matrix.clone());
        this.obstacles.push({
          id: `hesco_${wallIdx++}`,
          kind: 'barrier',
          x: wx,
          y: wy,
          z: wz,
          radius: 1.42,
          height: 1.43,
          destructible: false,
          destroyed: false,
        });
      }
    }
    this.addBatchedStaticModel(this.assets.models.barrier_wall, wallTransforms, false);

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
      const crate = this.assets.models.supply_crates.clone(true);
      crate.position.set(cx, cy, cz);
      crate.rotation.y = yaw;
      this.root.add(crate);
      this.obstacles.push({
        id: `crate_${idx}`,
        kind: 'crates',
        x: cx,
        y: cy,
        z: cz,
        radius: 1.38,
        height: 2.6,
        destructible: true,
        destroyed: false,
        mesh: crate,
      });
    });

    // 6. Deterministic Limestone Boulder Outcrops — batched into TWO InstancedMeshes (1 draw call each)!
    const largeRockTransforms: THREE.Matrix4[] = [];
    const medRockTransforms: THREE.Matrix4[] = [];
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
      dummy.position.set(rx, ry, rz);
      dummy.rotation.set(0, hash2(i, 19.3) * Math.PI * 2, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      if (isLarge) largeRockTransforms.push(dummy.matrix.clone());
      else medRockTransforms.push(dummy.matrix.clone());

      this.obstacles.push({
        id: `rock_${rockIdx++}`,
        kind: 'rock',
        x: rx,
        y: ry,
        z: rz,
        radius: (isLarge ? 1.32 : 0.74) * scale,
        height: (isLarge ? 1.38 : 0.74) * scale,
        destructible: false,
        destroyed: false,
      });
    }
    this.addBatchedStaticModel(this.assets.models.boulder_large, largeRockTransforms, true);
    this.addBatchedStaticModel(this.assets.models.boulder_medium, medRockTransforms, false);

    // 7. Aspen Tree Clusters — 10 groves of 4-9 trees batched into shared InstancedMeshes
    //    (trunk colliders stay solid obstacles; instancing keeps draw calls flat)
    const treeRng = mulberry32(0x7ee5);
    const treeTransforms: THREE.Matrix4[] = [];
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
        dummy.position.set(tx, ty, tz);
        dummy.rotation.set(0, treeRng() * Math.PI * 2, 0);
        dummy.scale.setScalar(scale); // Strictly uniform scale!
        dummy.updateMatrix();
        treeTransforms.push(dummy.matrix.clone());

        this.obstacles.push({
          id: `tree_${treeIdx++}`,
          kind: 'tree',
          x: tx,
          y: ty,
          z: tz,
          radius: 0.48 * scale, // Trunk collision cylinder
          height: 14.2 * scale,
          destructible: false,
          destroyed: false,
        });
      }
    }
    this.addBatchedStaticModel(this.assets.models.tree, treeTransforms, true);
  }

  /**
   * One translucent strip mesh per river: vertex y follows the smoothed water
   * level, banks get a foam/silt tint attribute, and the material scrolls
   * procedural ripple normals along the flow. Two draw calls total.
   */
  private buildRiverWaterMeshes(): void {
    const ACROSS = [-1, -0.55, 0, 0.55, 1]; // lat fractions of (halfWidth - 0.4)
    const BANK = [1, 0.4, 0, 0.4, 1];
    const COLS = 161; // every 8 m over the 1280 m river span
    const X0 = -640;
    const STEP = 8;

    for (const r of this.rivers) {
      const vertCount = (COLS + 1) * ACROSS.length;
      const positions = new Float32Array(vertCount * 3);
      const uvs = new Float32Array(vertCount * 2);
      const banks = new Float32Array(vertCount);
      const indices: number[] = [];
      const rows = ACROSS.length;

      for (let c = 0; c <= COLS; c++) {
        const x = X0 + c * STEP;
        const cz = this.riverCentreZ(r, x);
        const hw = Math.max(4, this.riverHalfWidth(r, x) - 0.4);
        const level = this.riverLevelAt(r, x);
        const u = x * 0.06;
        for (let j = 0; j < rows; j++) {
          const vi = (c * rows + j) * 3;
          positions[vi] = x;
          positions[vi + 1] = level;
          positions[vi + 2] = cz + ACROSS[j] * hw;
          const ti = c * rows + j;
          uvs[ti * 2] = u;
          uvs[ti * 2 + 1] = j / (rows - 1);
          banks[ti] = BANK[j];
        }
      }
      for (let c = 0; c < COLS; c++) {
        for (let j = 0; j < rows - 1; j++) {
          const a = c * rows + j;
          const b = (c + 1) * rows + j;
          const d = c * rows + j + 1;
          const e = (c + 1) * rows + j + 1;
          indices.push(a, d, b, b, d, e);
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('aWaterUv', new THREE.BufferAttribute(uvs, 2));
      geo.setAttribute('aBank', new THREE.BufferAttribute(banks, 1));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setRGB(0.04, 0.05, 0.032),
        roughness: 0.18,
        metalness: 0.0,
        envMapIntensity: 1.0,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        side: THREE.FrontSide,
      });
      mat.customProgramCacheKey = () => 'river-water-v1';
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.grassTimeUniform;
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            `#include <common>
            attribute vec2 aWaterUv;
            attribute float aBank;
            varying vec2 vWaterUv;
            varying float vWaterBank;
            varying vec3 vWaterWorld;`
          )
          .replace(
            '#include <worldpos_vertex>',
            `#include <worldpos_vertex>
            vWaterUv = aWaterUv;
            vWaterBank = aBank;
            vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
            uniform float uTime;
            varying vec2 vWaterUv;
            varying float vWaterBank;
            varying vec3 vWaterWorld;`
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
            // Murky silt-laden steppe water: olive-brown, darker in the channel
            vec3 deepWater = vec3(0.020, 0.028, 0.022);
            vec3 shallowWater = vec3(0.048, 0.058, 0.036);
            vec3 siltWater = vec3(0.105, 0.095, 0.058);
            float siltBand = smoothstep(0.30, 0.95, vWaterBank);
            diffuseColor.rgb = mix(mix(deepWater, shallowWater, vWaterBank * 0.4), siltWater, siltBand * 0.55);`
          )
          .replace(
            '#include <normal_fragment_maps>',
            `
            // Gentle scrolling ripple field along the flow (+x), ~40% calmer
            float wt = uTime;
            vec2 wp = vWaterWorld.xz * vec2(0.55, 0.85);
            float w1 = sin(wp.x * 1.7 - wt * 1.9 + wp.y * 0.8);
            float w2 = sin(wp.y * 2.3 + wt * 1.4 - wp.x * 0.6);
            float w3 = sin((wp.x + wp.y) * 3.1 - wt * 2.6);
            float w4 = sin(wp.x * 4.2 + wt * 3.4);
            vec3 worldWaterN = normalize(vec3(
              -(w1 * 0.55 + w3 * 0.30 + w4 * 0.15) * 0.10,
              1.0,
              -(w2 * 0.60 + w3 * 0.25) * 0.10
            ));
            normal = normalize((viewMatrix * vec4(worldWaterN, 0.0)).xyz);
            `
          )
          .replace(
            '#include <roughnessmap_fragment>',
            `float roughnessFactor = roughness;
            // Dull silt foam streaks drifting along the banks
            float foamT = uTime;
            float foamN = sin(vWaterUv.x * 55.0 - foamT * 3.2 + sin(vWaterUv.y * 14.0) * 2.4) * 0.5 + 0.5;
            foamN *= sin(vWaterUv.x * 23.0 + foamT * 1.7) * 0.5 + 0.5;
            float foam = smoothstep(0.55, 0.9, vWaterBank) * smoothstep(0.45, 0.85, foamN);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.24, 0.215, 0.14), foam * 0.5);
            roughnessFactor = mix(roughnessFactor, 0.6, foam * 0.5);`
          )
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
            // Fresnel-gated sky reflection: grazing angles mirror the sky,
            // near-vertical views stay dark and opaque (no swimming-pool sheen)
            vec3 waterViewDir = normalize(cameraPosition - vWaterWorld);
            float waterNdotV = saturate(dot(worldWaterN, waterViewDir));
            float waterFres = pow(1.0 - waterNdotV, 4.0);
            reflectedLight.indirectSpecular *= mix(0.12, 1.0, waterFres);`
          );
      };

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'river_water';
      mesh.renderOrder = 2;
      mesh.receiveShadow = false;
      mesh.castShadow = false;
      mesh.frustumCulled = false; // 1.3 km strip; cheap enough to always draw
      this.root.add(mesh);
    }
  }

  private addBatchedStaticModel(
    template: THREE.Object3D,
    worldMatrices: readonly THREE.Matrix4[],
    castShadow: boolean
  ): void {
    if (worldMatrices.length === 0) return;
    template.updateMatrixWorld(true);
    const invRoot = new THREE.Matrix4().copy(template.matrixWorld).invert();
    const localMat = new THREE.Matrix4();
    const finalMat = new THREE.Matrix4();

    template.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      localMat.multiplyMatrices(invRoot, mesh.matrixWorld);
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, worldMatrices.length);
      inst.castShadow = castShadow;
      inst.receiveShadow = true;
      inst.matrixAutoUpdate = false;
      for (let i = 0; i < worldMatrices.length; i++) {
        finalMat.multiplyMatrices(worldMatrices[i], localMat);
        inst.setMatrixAt(i, finalMat);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      this.root.add(inst);
    });
  }

  private placeRuinedBuilding(id: string, x: number, z: number, yaw: number): void {
    const y = this.getHeightAt(x, z);
    const bldg = this.assets.models.ruined_building.clone(true);
    bldg.position.set(x, y, z);
    bldg.rotation.y = yaw;
    bldg.updateMatrixWorld(true);
    bldg.traverse((o) => {
      o.matrixAutoUpdate = false;
    });
    this.root.add(bldg);

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
      destructible: false,
      destroyed: false,
      mesh: bldg,
    });
  }

  private placeFuelStation(id: string, x: number, z: number, yaw: number): void {
    const y = this.getHeightAt(x, z);
    const station = this.assets.models.fuel_station.clone(true);
    station.position.set(x, y, z);
    station.rotation.y = yaw;
    station.updateMatrixWorld(true);
    station.traverse((o) => {
      o.matrixAutoUpdate = false;
    });
    this.root.add(station);

    this.obstacles.push({
      id,
      kind: 'station',
      x,
      y,
      z,
      radius: 8.8,
      height: 6.0,
      destructible: false,
      destroyed: false,
      mesh: station,
    });
  }

  private placeGuardTower(id: string, x: number, z: number, yaw: number): void {
    const y = this.getHeightAt(x, z);
    const towerAssembly = this.assets.models.guard_tower.clone(true);
    towerAssembly.position.set(x, y, z);
    towerAssembly.rotation.y = yaw;
    towerAssembly.updateMatrixWorld(true);
    towerAssembly.traverse((o) => {
      if (o.name !== 'barrier_gate') o.matrixAutoUpdate = false;
    });
    this.root.add(towerAssembly);

    // Main 5.8x5.8m tower at local [0, 0, 0]
    this.obstacles.push({
      id,
      kind: 'tower',
      x,
      y,
      z,
      radius: 3.05,
      height: 10.45,
      destructible: false,
      destroyed: false,
      mesh: towerAssembly,
    });

    // Checkpoint barrier gate sub-assembly at local [+7.5, 0, 0] (destructible if rammed!)
    const gateNode = towerAssembly.getObjectByName('barrier_gate');
    if (gateNode) {
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
    const bladeCount = 4;
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];

    const rootCol = new THREE.Color('#2d381d');
    const tipCol = new THREE.Color('#778348');

    for (let b = 0; b < bladeCount; b++) {
      const ang = (b / bladeCount) * Math.PI * 2 + b * 0.43;
      const lean = 0.09 + (b % 3) * 0.055;
      const h = 0.24 + (b % 4) * 0.065;
      const hw = 0.024;

      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);
      const offX = cosA * 0.06;
      const offZ = sinA * 0.06;

      const lx = offX - sinA * hw;
      const lz = offZ + cosA * hw;
      const rx = offX + sinA * hw;
      const rz = offZ - cosA * hw;
      const tx = offX + cosA * lean;
      const tz = offZ + sinA * lean;

      positions.push(lx, 0, lz, rx, 0, rz, tx, h, tz);
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      colors.push(rootCol.r, rootCol.g, rootCol.b, rootCol.r, rootCol.g, rootCol.b, tipCol.r, tipCol.g, tipCol.b);
    }

    const tuftGeo = new THREE.BufferGeometry();
    tuftGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    tuftGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    tuftGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    tuftGeo.computeBoundingSphere();

    const tuftMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    tuftMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.grassTimeUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec3 instWorld = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float swayWeight = clamp(position.y * 2.4, 0.0, 1.0);
          float gust = sin(uTime * 2.0 + instWorld.x * 0.14 + instWorld.z * 0.11) * 0.07;
          transformed.x += gust * swayWeight;
          transformed.z += gust * 0.5 * swayWeight;`
        );
    };

    const inst = new THREE.InstancedMesh(tuftGeo, tuftMat, World.GRASS_CAPACITY);
    inst.name = 'steppe_grass_instanced';
    inst.receiveShadow = false;
    inst.castShadow = false;
    inst.count = 0;
    inst.frustumCulled = false; // instance disc follows the camera; geometry bounds are meaningless
    inst.setColorAt(0, new THREE.Color(1, 1, 1)); // allocate instanceColor buffer once
    this.grassMesh = inst;
    this.root.add(inst);
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
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
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
      dummy.position.set(gx, gy - 0.015, gz);
      dummy.rotation.set(0, hash2(cx * 9.7 + i, cz * 4.1 + i * 3.3) * Math.PI * 2, 0);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      const e = dummy.matrix.elements;
      for (let j = 0; j < 16; j++) mats[count * 16 + j] = e[j];

      const dry = valueNoise(gx * 0.055 + 11.3, gz * 0.055 + 11.3);
      tint.setRGB(
        THREE.MathUtils.lerp(0.82, 1.12, dry),
        THREE.MathUtils.lerp(0.92, 1.00, dry),
        THREE.MathUtils.lerp(0.74, 0.80, dry)
      );
      cols[count * 3] = tint.r;
      cols[count * 3 + 1] = tint.g;
      cols[count * 3 + 2] = tint.b;
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
    const matArr = inst.instanceMatrix.array as Float32Array;
    const colArr = (inst.instanceColor?.array ?? null) as Float32Array | null;
    let out = 0;
    const cap = World.GRASS_CAPACITY;

    for (const k of this.grassNeeded) {
      const ch = this.grassChunks.get(k);
      if (!ch) continue;
      for (let i = 0; i < ch.count && out < cap; i += stride) {
        const so = i * 16;
        const dof = out * 16;
        for (let j = 0; j < 16; j++) matArr[dof + j] = ch.mats[so + j];
        if (colArr) {
          const sc = i * 3;
          const dc = out * 3;
          colArr[dc] = ch.cols[sc];
          colArr[dc + 1] = ch.cols[sc + 1];
          colArr[dc + 2] = ch.cols[sc + 2];
        }
        out++;
      }
      if (out >= cap) break;
    }

    inst.count = out;
    inst.instanceMatrix.clearUpdateRanges();
    inst.instanceMatrix.addUpdateRange(0, out * 16);
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) {
      inst.instanceColor.clearUpdateRanges();
      inst.instanceColor.addUpdateRange(0, out * 3);
      inst.instanceColor.needsUpdate = true;
    }
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

  public crushObstacle(obstacle: ObstacleCollider, impactDirXZ?: THREE.Vector2): void {
    if (obstacle.destroyed || !obstacle.destructible) return;
    obstacle.destroyed = true;
    if (!obstacle.mesh) return;

    const dirX = impactDirXZ && impactDirXZ.lengthSq() > 0.001 ? impactDirXZ.x : 0.7;
    const dirZ = impactDirXZ && impactDirXZ.lengthSq() > 0.001 ? impactDirXZ.y : 0.7;
    const len = Math.hypot(dirX, dirZ) || 1;
    // Rotation axis perpendicular to impact direction in world XZ (`up × impactDir`)
    const axis = new THREE.Vector3(dirZ / len, 0, -dirX / len).normalize();

    this.fallingProps.push({
      mesh: obstacle.mesh,
      axis,
      angle: 0,
      angVel: obstacle.kind === 'tree' ? 1.35 : 3.2,
      maxAngle: obstacle.kind === 'tree' ? Math.PI * 0.47 : Math.PI * 0.48,
      sinkY: obstacle.kind === 'crates' ? 0.55 : 0.05,
    });
  }

  /** Dev/bench counter: total raycastWorld calls (reset via bench tooling). */
  public raycastCount = 0;

  public raycastWorld(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): WorldRayHit | null {
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

    if (horizLenSq > 1e-7) {
      for (let i = 0; i < this.obstacles.length; i++) {
        const obs = this.obstacles[i];
        if (obs.destroyed) continue;
        const ox = origin.x - obs.x;
        const oz = origin.z - obs.z;
        const b = ox * dx + oz * dz;
        const c = ox * ox + oz * oz - obs.radius * obs.radius;
        if (c > 0 && b > 0) continue;

        const disc = b * b - horizLenSq * c;
        if (disc < 0) continue;

        const t = Math.max(0, (-b - Math.sqrt(disc)) / horizLenSq);
        if (t >= bestDist) continue;

        const py = origin.y + dy * t;
        if (py >= obs.y && py <= obs.y + obs.height) {
          bestDist = t;
          hitKind = 'obstacle';
          hitObs = obs;
          hitPoint.set(origin.x + dx * t, py, origin.z + dz * t);
          hitNormal.set(hitPoint.x - obs.x, 0, hitPoint.z - obs.z).normalize();
        }
      }
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
    avoidPoints: readonly THREE.Vector3[],
    center?: { x: number; z: number }
  ): THREE.Vector3 {
    const cx0 = center?.x ?? 0;
    const cz0 = center?.z ?? 0;
    const best = new THREE.Vector3(cx0, 0, cz0);
    let bestScore = -Infinity;

    for (let attempt = 0; attempt < 42; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = THREE.MathUtils.lerp(preferRadiusMin, preferRadiusMax, Math.random());
      const cx = THREE.MathUtils.clamp(cx0 + Math.cos(ang) * rad, -this.worldHalfSize + 24, this.worldHalfSize - 24);
      const cz = THREE.MathUtils.clamp(cz0 + Math.sin(ang) * rad, -this.worldHalfSize + 24, this.worldHalfSize - 24);

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

  public update(dt: number, shadowFocusPos: THREE.Vector3, grassFocusPos?: THREE.Vector3): void {
    this.elapsedTime += dt;
    this.grassTimeUniform.value = this.elapsedTime;
    this.updateGrass((grassFocusPos ?? shadowFocusPos).x, (grassFocusPos ?? shadowFocusPos).z);

    // Only update sun shadow frustum when player moves onto a new 3m cell
    const snap = 3.0;
    const fx = Math.round(shadowFocusPos.x / snap) * snap;
    const fz = Math.round(shadowFocusPos.z / snap) * snap;
    if (fx !== this.lastShadowSnapX || fz !== this.lastShadowSnapZ) {
      this.lastShadowSnapX = fx;
      this.lastShadowSnapZ = fz;
      const fy = this.getHeightAt(fx, fz);
      this.sunLight.target.position.set(fx, fy, fz);
      this.sunLight.position.set(fx + 110, fy + 145, fz - 85);
      this.sunLight.target.updateMatrixWorld();
    }

    // Animate toppling trees / crushed crates
    for (let i = this.fallingProps.length - 1; i >= 0; i--) {
      const fp = this.fallingProps[i];
      fp.angVel += 4.2 * dt;
      const step = Math.min(fp.angVel * dt, fp.maxAngle - fp.angle);
      fp.angle += step;
      fp.mesh.rotateOnWorldAxis(fp.axis, step);
      fp.mesh.position.y -= fp.sinkY * (step / fp.maxAngle);
      if (fp.angle >= fp.maxAngle - 0.001) {
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
