import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Pool capacities (zero per-frame heap/geometry/shader allocations)
// ---------------------------------------------------------------------------
const SMOKE_CAPACITY = 384;
const FLASH_CAPACITY = 128;
const SPARK_CAPACITY = 192;
const RING_CAPACITY = 32;
const SCORCH_CAPACITY = 32;
const FIRE_CAPACITY = 320;
const POINT_LIGHT_POOL_SIZE = 1;
const COOKOFF_POOL_SIZE = 6;
const SHAKE_QUEUE_SIZE = 12;

interface SmokeParticle {
  active: boolean;
  age: number;
  maxAge: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  drag: number;
  buoyancy: number;
  startScale: number;
  endScale: number;
  rot: number;
  rotSpeed: number;
  r0: number;
  g0: number;
  b0: number;
  rMid: number;
  gMid: number;
  bMid: number;
  midFrac: number;
  r1: number;
  g1: number;
  b1: number;
  peakAlpha: number;
  fadeInFrac: number;
}

interface FlashParticle {
  active: boolean;
  age: number;
  maxAge: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  startScaleX: number;
  startScaleY: number;
  endScaleX: number;
  endScaleY: number;
  rot: number;
  rotSpeed: number;
  billboard: boolean;
  // Precomputed world axes for non-billboard oriented flashes (muzzle fins)
  axX: number;
  axY: number;
  axZ: number;
  ayX: number;
  ayY: number;
  ayZ: number;
  azX: number;
  azY: number;
  azZ: number;
  r: number;
  g: number;
  b: number;
}

interface SparkParticle {
  active: boolean;
  age: number;
  maxAge: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  drag: number;
  gravity: number;
  width: number;
  baseLen: number;
  stretch: number;
  floorY: number;
  r0: number;
  g0: number;
  b0: number;
  r1: number;
  g1: number;
  b1: number;
}

interface RingParticle {
  active: boolean;
  age: number;
  maxAge: number;
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  startRadius: number;
  endRadius: number;
  r: number;
  g: number;
  b: number;
  peakAlpha: number;
}

interface PooledLight {
  light: THREE.PointLight;
  active: boolean;
  age: number;
  maxAge: number;
  peakIntensity: number;
}

interface FireParticle {
  active: boolean;
  age: number;
  maxAge: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  s0: number;
  s1: number;
  seed: number;
  r0: number;
  g0: number;
  b0: number;
  r1: number;
  g1: number;
  b1: number;
  alpha0: number;
}

interface CookoffSite {
  active: boolean;
  x: number;
  y: number;
  z: number;
  age: number;
  duration: number;
  emitAccum: number;
}

interface ShakeImpulse {
  x: number;
  y: number;
  z: number;
  strength: number;
}

// ---------------------------------------------------------------------------
// Procedural Canvas2D texture generators (created once at startup)
// ---------------------------------------------------------------------------
function createSmokePuffTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  const cx = size * 0.5;
  const cy = size * 0.5;

  // Multi-lobed billowing cloud structure so smoke/dust looks volumetric
  const lobes = [
    { ox: 0, oy: 0, rad: 0.46, alpha: 0.62 },
    { ox: -0.14, oy: -0.1, rad: 0.33, alpha: 0.38 },
    { ox: 0.15, oy: -0.08, rad: 0.31, alpha: 0.36 },
    { ox: 0.09, oy: 0.14, rad: 0.34, alpha: 0.38 },
    { ox: -0.12, oy: 0.13, rad: 0.30, alpha: 0.34 },
    { ox: 0.0, oy: -0.17, rad: 0.27, alpha: 0.28 },
  ];

  ctx.globalCompositeOperation = 'lighter';
  for (const lobe of lobes) {
    const lx = cx + lobe.ox * size;
    const ly = cy + lobe.oy * size;
    const lr = lobe.rad * size;
    const g = ctx.createRadialGradient(lx, ly, lr * 0.08, lx, ly, lr);
    g.addColorStop(0.0, `rgba(255,255,255,${lobe.alpha})`);
    g.addColorStop(0.45, `rgba(245,245,245,${lobe.alpha * 0.68})`);
    g.addColorStop(0.78, `rgba(220,220,220,${lobe.alpha * 0.24})`);
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    ctx.fill();
  }

  // Soft outer radial vignette to guarantee zero hard quad edges
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(cx, cy, size * 0.12, cx, cy, size * 0.49);
  mask.addColorStop(0.0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.68, 'rgba(255,255,255,0.85)');
  mask.addColorStop(0.9, 'rgba(255,255,255,0.22)');
  mask.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createStarFlashTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  const cx = size * 0.5;
  const cy = size * 0.5;

  // Soft radial bloom halo — no diffraction spikes: they read as blown-out
  // starbursts on detonations. Muzzle flashes keep their star look via the
  // separate oriented fin quads.
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.48);
  core.addColorStop(0.0, 'rgba(255,255,255,1.0)');
  core.addColorStop(0.15, 'rgba(255,246,225,0.95)');
  core.addColorStop(0.38, 'rgba(255,205,140,0.55)');
  core.addColorStop(0.65, 'rgba(255,160,80,0.18)');
  core.addColorStop(1.0, 'rgba(255,130,60,0.0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createStreakTexture(): THREE.CanvasTexture {
  const w = 64;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  // Vertical capsule/tapered hot streak (+Y = tip of velocity, -Y = glowing tail)
  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    // v = 0 at top (+Y head), v = 1 at bottom (-Y tail)
    const v = y / (h - 1);
    const headTapering = v < 0.22 ? Math.sin((v / 0.22) * Math.PI * 0.5) : Math.pow(1 - (v - 0.22) / 0.78, 1.55);
    for (let x = 0; x < w; x++) {
      const u = Math.abs((x / (w - 1)) * 2 - 1);
      const radial = Math.max(0, 1 - u * u);
      const val = Math.min(1, Math.pow(radial, 1.8) * headTapering * 1.15);
      const idx = (y * w + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(val * 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createShockRingTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  const cx = size * 0.5;
  const cy = size * 0.5;
  const rMax = size * 0.49;

  const g = ctx.createRadialGradient(cx, cy, rMax * 0.15, cx, cy, rMax);
  g.addColorStop(0.0, 'rgba(255,255,255,0.0)');
  g.addColorStop(0.48, 'rgba(255,255,255,0.06)');
  g.addColorStop(0.76, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.88, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.96, 'rgba(255,255,255,0.28)');
  g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, rMax, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createScorchDecalTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  const cx = size * 0.5;
  const cy = size * 0.5;
  const rMax = size * 0.48;

  // Deep charred crater center
  const base = ctx.createRadialGradient(cx, cy, 0, cx, cy, rMax);
  base.addColorStop(0.0, 'rgba(12,10,9,0.94)');
  base.addColorStop(0.32, 'rgba(20,17,15,0.85)');
  base.addColorStop(0.62, 'rgba(34,29,24,0.46)');
  base.addColorStop(0.86, 'rgba(44,38,31,0.14)');
  base.addColorStop(1.0, 'rgba(44,38,31,0.0)');
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.arc(cx, cy, rMax, 0, Math.PI * 2);
  ctx.fill();

  // Radial ejecta soot streaks for realistic artillery impact crater look
  const rays = 28;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 + Math.sin(i * 7.13) * 0.14;
    const len = rMax * (0.68 + 0.3 * (0.5 + 0.5 * Math.sin(i * 3.71)));
    const w = size * (0.018 + 0.014 * (0.5 + 0.5 * Math.cos(i * 5.3)));
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    const rg = ctx.createLinearGradient(0, 0, len, 0);
    rg.addColorStop(0.0, 'rgba(15,13,11,0.55)');
    rg.addColorStop(0.65, 'rgba(28,24,20,0.28)');
    rg.addColorStop(1.0, 'rgba(28,24,20,0.0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.moveTo(0, -w);
    ctx.lineTo(len, 0);
    ctx.lineTo(0, w);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Injects per-instance `instanceOpacity` attribute into a Three.js `MeshBasicMaterial`
 * while preserving built-in ACES tone mapping, sRGB output, and scene fog.
 */
function applyInstancedOpacityShader(mat: THREE.MeshBasicMaterial, cacheKey: string): void {
  mat.customProgramCacheKey = () => cacheKey;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float instanceOpacity;\nvarying float vInstanceOpacity;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvInstanceOpacity = instanceOpacity;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vInstanceOpacity;'
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.a *= vInstanceOpacity;'
      );
  };
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export class EffectsManager {
  private readonly scene: THREE.Scene;

  // Textures & geometries (tracked for clean disposal)
  private readonly textures: THREE.Texture[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  // 1. Smoke / Fireball-to-Soot / Dust billboard InstancedMesh
  private readonly smokeMesh: THREE.InstancedMesh;
  private readonly smokeOpacityAttr: THREE.InstancedBufferAttribute;
  private readonly smokePool: SmokeParticle[] = [];
  private smokeCursor = 0;

  // 2. Additive HDR Flash / Muzzle Starburst InstancedMesh
  private readonly flashMesh: THREE.InstancedMesh;
  private readonly flashPool: FlashParticle[] = [];
  private flashCursor = 0;

  // 3. Velocity-stretched HDR Spark / Ember InstancedMesh
  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly sparkPool: SparkParticle[] = [];
  private sparkCursor = 0;

  // 4. Ground Shockwave & Dust Blast Ring InstancedMesh
  private readonly ringMesh: THREE.InstancedMesh;
  private readonly ringOpacityAttr: THREE.InstancedBufferAttribute;
  private readonly ringPool: RingParticle[] = [];
  private ringCursor = 0;

  // 4b. Procedural wreck-fire billboard InstancedMesh (camera-facing noise flames)
  private readonly fireMesh: THREE.InstancedMesh;
  private readonly fireOpacityAttr: THREE.InstancedBufferAttribute;
  private readonly fireSeedAttr: THREE.InstancedBufferAttribute;
  private readonly firePool: FireParticle[] = [];
  private fireCursor = 0;
  private readonly fireTimeUniform = { value: 0 };

  // 5. Persistent Scorch Crater Decal Ring Buffer (48 slots)
  private readonly scorchMesh: THREE.InstancedMesh;
  private readonly scorchOpacityAttr: THREE.InstancedBufferAttribute;
  private scorchCursor = 0;

  // 6. Pooled Dynamic PointLights (always visible with intensity=0 when idle -> zero shader recompiles!)
  private readonly lightPool: PooledLight[] = [];

  // 7. Secondary Cookoff Emitters for 'tank_kill'
  private readonly cookoffSites: CookoffSite[] = [];
  private cookoffCursor = 0;

  // 8. Pending Camera Shake Impulses
  private readonly shakeQueue: ShakeImpulse[] = [];
  private shakeCount = 0;
  private prevSmokeActive = -1;
  private prevFlashActive = -1;
  private prevSparkActive = -1;
  private prevRingActive = -1;

  // Dense active-slot lists: pool index → position map for O(1) swap-remove.
  // Update loops iterate only live particles instead of full capacity.
  private readonly smokeActiveIdx: number[] = [];
  private readonly smokePos = new Int32Array(SMOKE_CAPACITY).fill(-1);
  private readonly flashActiveIdx: number[] = [];
  private readonly flashPos = new Int32Array(FLASH_CAPACITY).fill(-1);
  private readonly sparkActiveIdx: number[] = [];
  private readonly sparkPos = new Int32Array(SPARK_CAPACITY).fill(-1);
  private readonly ringActiveIdx: number[] = [];
  private readonly ringPos = new Int32Array(RING_CAPACITY).fill(-1);
  private readonly fireActiveIdx: number[] = [];
  private readonly firePos = new Int32Array(FIRE_CAPACITY).fill(-1);

  // Reusable scratch math objects (zero GC pressure in update/spawn)
  private readonly _mat4 = new THREE.Matrix4();
  private readonly _hiddenMat4 = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly _quat = new THREE.Quaternion();
  private readonly _spinQuat = new THREE.Quaternion();
  private readonly _color = new THREE.Color();
  private readonly _camPos = new THREE.Vector3();
  private readonly _camRight = new THREE.Vector3();
  private readonly _camUp = new THREE.Vector3();
  private readonly _camBack = new THREE.Vector3();
  private readonly _v1 = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
  private readonly _v3 = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this._hiddenMat4.setPosition(0, 0, 0);

    // Create procedural textures once
    const smokeTex = createSmokePuffTexture();
    const flashTex = createStarFlashTexture();
    const streakTex = createStreakTexture();
    const ringTex = createShockRingTexture();
    const scorchTex = createScorchDecalTexture();
    this.textures.push(smokeTex, flashTex, streakTex, ringTex, scorchTex);

    // --- 1. Smoke / Rolling Fireball-to-Smoke / Dust Pool ---
    const smokeGeo = new THREE.PlaneGeometry(1, 1);
    const smokeOpacityArr = new Float32Array(SMOKE_CAPACITY);
    this.smokeOpacityAttr = new THREE.InstancedBufferAttribute(smokeOpacityArr, 1);
    this.smokeOpacityAttr.setUsage(THREE.DynamicDrawUsage);
    smokeGeo.setAttribute('instanceOpacity', this.smokeOpacityAttr);
    this.geometries.push(smokeGeo);

    const smokeMat = new THREE.MeshBasicMaterial({
      map: smokeTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      toneMapped: true,
    });
    applyInstancedOpacityShader(smokeMat, 'fx-instanced-opacity-smoke-v1');
    this.materials.push(smokeMat);

    this.smokeMesh = new THREE.InstancedMesh(smokeGeo, smokeMat, SMOKE_CAPACITY);
    this.smokeMesh.name = 'fx_smoke_instanced';
    this.smokeMesh.frustumCulled = false;
    this.smokeMesh.renderOrder = 4;
    this.smokeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._initInstancedMesh(this.smokeMesh, SMOKE_CAPACITY);
    this.scene.add(this.smokeMesh);

    for (let i = 0; i < SMOKE_CAPACITY; i++) {
      this.smokePool.push({
        active: false,
        age: 0,
        maxAge: 1,
        px: 0,
        py: -1000,
        pz: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        drag: 1,
        buoyancy: 0,
        startScale: 1,
        endScale: 2,
        rot: 0,
        rotSpeed: 0,
        r0: 1,
        g0: 1,
        b0: 1,
        rMid: 1,
        gMid: 1,
        bMid: 1,
        midFrac: 0.3,
        r1: 1,
        g1: 1,
        b1: 1,
        peakAlpha: 0.5,
        fadeInFrac: 0.1,
      });
    }

    // --- 2. Additive HDR Flash / Starburst Pool ---
    const flashGeo = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(flashGeo);
    const flashMat = new THREE.MeshBasicMaterial({
      map: flashTex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
    });
    this.materials.push(flashMat);

    this.flashMesh = new THREE.InstancedMesh(flashGeo, flashMat, FLASH_CAPACITY);
    this.flashMesh.name = 'fx_flash_instanced';
    this.flashMesh.frustumCulled = false;
    this.flashMesh.renderOrder = 6;
    this.flashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._initInstancedMesh(this.flashMesh, FLASH_CAPACITY);
    this.scene.add(this.flashMesh);

    for (let i = 0; i < FLASH_CAPACITY; i++) {
      this.flashPool.push({
        active: false,
        age: 0,
        maxAge: 0.1,
        px: 0,
        py: -1000,
        pz: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        startScaleX: 1,
        startScaleY: 1,
        endScaleX: 1,
        endScaleY: 1,
        rot: 0,
        rotSpeed: 0,
        billboard: true,
        axX: 1,
        axY: 0,
        axZ: 0,
        ayX: 0,
        ayY: 1,
        ayZ: 0,
        azX: 0,
        azY: 0,
        azZ: 1,
        r: 4,
        g: 3,
        b: 1,
      });
    }

    // --- 3. Velocity-Aligned HDR Spark / Ember Streak Pool ---
    const sparkGeo = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(sparkGeo);
    const sparkMat = new THREE.MeshBasicMaterial({
      map: streakTex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
    });
    this.materials.push(sparkMat);

    this.sparkMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, SPARK_CAPACITY);
    this.sparkMesh.name = 'fx_spark_instanced';
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.renderOrder = 7;
    this.sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._initInstancedMesh(this.sparkMesh, SPARK_CAPACITY);
    this.scene.add(this.sparkMesh);

    for (let i = 0; i < SPARK_CAPACITY; i++) {
      this.sparkPool.push({
        active: false,
        age: 0,
        maxAge: 0.5,
        px: 0,
        py: -1000,
        pz: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        drag: 1.2,
        gravity: 9.81,
        width: 0.1,
        baseLen: 0.25,
        stretch: 0.045,
        floorY: -999,
        r0: 6,
        g0: 4,
        b0: 1.5,
        r1: 3,
        g1: 0.7,
        b1: 0.1,
      });
    }

    // --- 4. Expanding Ground Shockwave & Blast Ring Pool ---
    const ringGeo = new THREE.PlaneGeometry(2, 2);
    ringGeo.rotateX(-Math.PI * 0.5); // Local +Y is plane normal
    const ringOpacityArr = new Float32Array(RING_CAPACITY);
    this.ringOpacityAttr = new THREE.InstancedBufferAttribute(ringOpacityArr, 1);
    this.ringOpacityAttr.setUsage(THREE.DynamicDrawUsage);
    ringGeo.setAttribute('instanceOpacity', this.ringOpacityAttr);
    this.geometries.push(ringGeo);

    const ringMat = new THREE.MeshBasicMaterial({
      map: ringTex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      toneMapped: true,
    });
    applyInstancedOpacityShader(ringMat, 'fx-instanced-opacity-ring-v1');
    this.materials.push(ringMat);

    this.ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, RING_CAPACITY);
    this.ringMesh.name = 'fx_ring_instanced';
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 3;
    this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._initInstancedMesh(this.ringMesh, RING_CAPACITY);
    this.scene.add(this.ringMesh);

    for (let i = 0; i < RING_CAPACITY; i++) {
      this.ringPool.push({
        active: false,
        age: 0,
        maxAge: 0.4,
        px: 0,
        py: -1000,
        pz: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
        startRadius: 0.5,
        endRadius: 6,
        r: 1,
        g: 1,
        b: 1,
        peakAlpha: 0.65,
      });
    }

    // --- 4b. Wreck Fire Billboard Pool (procedural scrolling-noise flames) ---
    const fireGeo = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(fireGeo);
    const fireOpacityArr = new Float32Array(FIRE_CAPACITY);
    this.fireOpacityAttr = new THREE.InstancedBufferAttribute(fireOpacityArr, 1);
    this.fireOpacityAttr.setUsage(THREE.DynamicDrawUsage);
    fireGeo.setAttribute('instanceOpacity', this.fireOpacityAttr);
    const fireSeedArr = new Float32Array(FIRE_CAPACITY);
    this.fireSeedAttr = new THREE.InstancedBufferAttribute(fireSeedArr, 1);
    fireGeo.setAttribute('aSeed', this.fireSeedAttr);
    for (let i = 0; i < FIRE_CAPACITY; i++) fireSeedArr[i] = Math.random() * 100;

    const fireMat = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    fireMat.customProgramCacheKey = () => 'fx-fire-noise-v1';
    fireMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.fireTimeUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float instanceOpacity;
          attribute float aSeed;
          varying float vFireOpacity;
          varying float vFireSeed;
          varying vec2 vFireUv;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vFireOpacity = instanceOpacity;
          vFireSeed = aSeed;
          vFireUv = uv;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime;
          varying float vFireOpacity;
          varying float vFireSeed;
          varying vec2 vFireUv;
          float fireHash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
          }
          float fireNoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(fireHash(i), fireHash(i + vec2(1.0, 0.0)), u.x),
              mix(fireHash(i + vec2(0.0, 1.0)), fireHash(i + vec2(1.0, 1.0)), u.x),
              u.y
            );
          }
          float fireFbm(vec2 p) {
            float v = 0.0;
            float a = 0.5;
            for (int o = 0; o < 3; o++) {
              v += a * fireNoise(p);
              p = p * 2.03 + vec2(17.3, 9.1);
              a *= 0.5;
            }
            return v;
          }`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          vec2 fc = vFireUv - 0.5;
          float fn = fireFbm(vFireUv * 2.6 + vec2(vFireSeed * 0.37, -uTime * 2.4 + vFireSeed * 0.11));
          float fd = length(fc) * 2.0;
          float fmask = 1.0 - smoothstep(0.22, 0.62, fd + (fn - 0.5) * 0.9);
          fmask = pow(fmask, 1.6);
          float fcore = 1.0 - smoothstep(0.0, 0.5, fd + (fn - 0.5) * 0.6);
          diffuseColor.rgb *= (0.4 + 1.4 * fn) * (0.75 + 0.9 * fcore);
          diffuseColor.a *= vFireOpacity * fmask;`
        );
    };
    this.materials.push(fireMat);
    this.fireMesh = new THREE.InstancedMesh(fireGeo, fireMat, FIRE_CAPACITY);
    this.fireMesh.name = 'fx_fire_instanced';
    this.fireMesh.frustumCulled = false;
    this.fireMesh.renderOrder = 4;
    this.fireMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._initInstancedMesh(this.fireMesh, FIRE_CAPACITY);
    this.scene.add(this.fireMesh);
    for (let i = 0; i < FIRE_CAPACITY; i++) {
      this.firePool.push({
        active: false, age: 0, maxAge: 0.6,
        px: 0, py: -1000, pz: 0, vx: 0, vy: 0, vz: 0,
        s0: 0.4, s1: 1.0, seed: Math.random() * 100,
        r0: 2, g0: 1.4, b0: 0.5, r1: 0.6, g1: 0.1, b1: 0.02,
        alpha0: 0.9,
      });
    }

    // --- 5. Persistent Scorch Crater Decals (48-slot ring buffer) ---
    const scorchGeo = new THREE.PlaneGeometry(2, 2);
    scorchGeo.rotateX(-Math.PI * 0.5); // Local +Y is surface normal
    const scorchOpacityArr = new Float32Array(SCORCH_CAPACITY);
    this.scorchOpacityAttr = new THREE.InstancedBufferAttribute(scorchOpacityArr, 1);
    this.scorchOpacityAttr.setUsage(THREE.DynamicDrawUsage);
    scorchGeo.setAttribute('instanceOpacity', this.scorchOpacityAttr);
    this.geometries.push(scorchGeo);

    const scorchMat = new THREE.MeshBasicMaterial({
      map: scorchTex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      blending: THREE.NormalBlending,
      toneMapped: true,
    });
    applyInstancedOpacityShader(scorchMat, 'fx-instanced-opacity-scorch-v1');
    this.materials.push(scorchMat);

    this.scorchMesh = new THREE.InstancedMesh(scorchGeo, scorchMat, SCORCH_CAPACITY);
    this.scorchMesh.name = 'fx_scorch_instanced';
    this.scorchMesh.frustumCulled = false;
    this.scorchMesh.renderOrder = 1;
    this.scorchMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._initInstancedMesh(this.scorchMesh, SCORCH_CAPACITY);
    // Keep all 48 slots live (unused slots stay hidden at scale 0, opacity 0)
    this.scorchMesh.count = SCORCH_CAPACITY;
    this.scene.add(this.scorchMesh);

    // --- 6. Dynamic PointLight Pool (4 warm lights permanently mounted in scene) ---
    for (let i = 0; i < POINT_LIGHT_POOL_SIZE; i++) {
      const light = new THREE.PointLight(0xffa448, 0, 36, 2);
      light.position.set(0, -1000, 0);
      light.castShadow = false;
      this.scene.add(light);
      this.lightPool.push({
        light,
        active: false,
        age: 0,
        maxAge: 0.12,
        peakIntensity: 0,
      });
    }

    // --- 7. Cookoff Site Pool ---
    for (let i = 0; i < COOKOFF_POOL_SIZE; i++) {
      this.cookoffSites.push({
        active: false,
        x: 0,
        y: 0,
        z: 0,
        age: 0,
        duration: 2.5,
        emitAccum: 0,
      });
    }

    // --- 8. Shake Impulse Ring Buffer ---
    for (let i = 0; i < SHAKE_QUEUE_SIZE; i++) {
      this.shakeQueue.push({ x: 0, y: 0, z: 0, strength: 0 });
    }
  }

  private _initInstancedMesh(mesh: THREE.InstancedMesh, capacity: number): void {
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
    // Keep count >= 1 with hidden slot 0 so WebGL compiles all particle shaders on frame 0
    mesh.count = 1;
  }

  // -------------------------------------------------------------------------
  // Internal allocation helpers
  // -------------------------------------------------------------------------
  // Swap-remove pool slot `idx` from its dense active list (pos = slot→list-pos map).
  private _listRemove(list: number[], pos: Int32Array, idx: number): void {
    const p = pos[idx];
    const last = list.pop()!;
    if (p < list.length) {
      list[p] = last;
      pos[last] = p;
    }
    pos[idx] = -1;
  }

  private _allocSmoke(): SmokeParticle {
    let idx = -1;
    for (let n = 0; n < SMOKE_CAPACITY; n++) {
      const i = (this.smokeCursor + n) % SMOKE_CAPACITY;
      if (!this.smokePool[i].active) { idx = i; break; }
    }
    if (idx < 0) idx = this.smokeCursor;
    this.smokeCursor = (idx + 1) % SMOKE_CAPACITY;
    if (this.smokePos[idx] < 0) {
      this.smokePos[idx] = this.smokeActiveIdx.length;
      this.smokeActiveIdx.push(idx);
    }
    return this.smokePool[idx];
  }

  private _allocFlash(): FlashParticle {
    let idx = -1;
    for (let n = 0; n < FLASH_CAPACITY; n++) {
      const i = (this.flashCursor + n) % FLASH_CAPACITY;
      if (!this.flashPool[i].active) { idx = i; break; }
    }
    if (idx < 0) idx = this.flashCursor;
    this.flashCursor = (idx + 1) % FLASH_CAPACITY;
    if (this.flashPos[idx] < 0) {
      this.flashPos[idx] = this.flashActiveIdx.length;
      this.flashActiveIdx.push(idx);
    }
    return this.flashPool[idx];
  }

  private _allocSpark(): SparkParticle {
    let idx = -1;
    for (let n = 0; n < SPARK_CAPACITY; n++) {
      const i = (this.sparkCursor + n) % SPARK_CAPACITY;
      if (!this.sparkPool[i].active) { idx = i; break; }
    }
    if (idx < 0) idx = this.sparkCursor;
    this.sparkCursor = (idx + 1) % SPARK_CAPACITY;
    if (this.sparkPos[idx] < 0) {
      this.sparkPos[idx] = this.sparkActiveIdx.length;
      this.sparkActiveIdx.push(idx);
    }
    return this.sparkPool[idx];
  }

  private _allocFire(): FireParticle {
    let idx = -1;
    for (let n = 0; n < FIRE_CAPACITY; n++) {
      const i = (this.fireCursor + n) % FIRE_CAPACITY;
      if (!this.firePool[i].active) { idx = i; break; }
    }
    if (idx < 0) idx = this.fireCursor;
    this.fireCursor = (idx + 1) % FIRE_CAPACITY;
    if (this.firePos[idx] < 0) {
      this.firePos[idx] = this.fireActiveIdx.length;
      this.fireActiveIdx.push(idx);
    }
    return this.firePool[idx];
  }

  private _allocRing(): RingParticle {
    let idx = -1;
    for (let n = 0; n < RING_CAPACITY; n++) {
      const i = (this.ringCursor + n) % RING_CAPACITY;
      if (!this.ringPool[i].active) { idx = i; break; }
    }
    if (idx < 0) idx = this.ringCursor;
    this.ringCursor = (idx + 1) % RING_CAPACITY;
    if (this.ringPos[idx] < 0) {
      this.ringPos[idx] = this.ringActiveIdx.length;
      this.ringActiveIdx.push(idx);
    }
    return this.ringPool[idx];
  }

  private _spawnPointLight(
    x: number,
    y: number,
    z: number,
    hexColor: number,
    intensity: number,
    distance: number,
    duration: number
  ): void {
    let best = this.lightPool[0];
    let lowestRemaining = Infinity;
    for (const slot of this.lightPool) {
      if (!slot.active) {
        best = slot;
        break;
      }
      const rem = (1 - slot.age / slot.maxAge) * slot.peakIntensity;
      if (rem < lowestRemaining) {
        lowestRemaining = rem;
        best = slot;
      }
    }
    best.active = true;
    best.age = 0;
    best.maxAge = duration;
    best.peakIntensity = intensity;
    best.light.color.setHex(hexColor);
    best.light.distance = distance;
    best.light.intensity = intensity;
    best.light.position.set(x, y, z);
  }

  private _pushShake(x: number, y: number, z: number, strength: number): void {
    const idx = this.shakeCount < SHAKE_QUEUE_SIZE ? this.shakeCount++ : SHAKE_QUEUE_SIZE - 1;
    const slot = this.shakeQueue[idx];
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.strength = strength;
  }

  private _placeScorchDecal(pos: THREE.Vector3, normal: THREE.Vector3, radius: number, opacity: number): void {
    const idx = this.scorchCursor;
    this.scorchCursor = (this.scorchCursor + 1) % SCORCH_CAPACITY;

    this._v1.copy(normal).normalize();
    this._quat.setFromUnitVectors(this._up, this._v1);
    this._spinQuat.setFromAxisAngle(this._v1, Math.random() * Math.PI * 2);
    this._quat.premultiply(this._spinQuat);

    // Offset +0.04 along surface normal to eliminate z-fighting
    this._v2.copy(pos).addScaledVector(this._v1, 0.04);
    this._v3.set(radius, 1, radius);
    this._mat4.compose(this._v2, this._quat, this._v3);

    this.scorchMesh.setMatrixAt(idx, this._mat4);
    this._color.setRGB(1, 1, 1);
    this.scorchMesh.setColorAt(idx, this._color);
    this.scorchOpacityAttr.setX(idx, opacity);

    this.scorchMesh.instanceMatrix.needsUpdate = true;
    if (this.scorchMesh.instanceColor) this.scorchMesh.instanceColor.needsUpdate = true;
    this.scorchOpacityAttr.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Public Effect Spawners
  // -------------------------------------------------------------------------

  /**
   * 120mm cannon blast: multi-lobe axial & starburst HDR flash + warm pooled PointLight
   * + billowing propellant smoke cone + ground concussion dust shockwave ring.
   */
  public spawnMuzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, scale = 1): void {
    const d = this._v1.copy(dir).normalize();

    // Build orthonormal basis around barrel direction `d`
    if (Math.abs(d.y) < 0.92) {
      this._v2.crossVectors(d, this._up).normalize();
    } else {
      this._v2.set(1, 0, 0).cross(d).normalize();
    }
    this._v3.crossVectors(this._v2, d).normalize();

    // 1. Billboard starburst core right at muzzle brake
    const core = this._allocFlash();
    core.active = true;
    core.age = 0;
    core.maxAge = 0.075;
    core.px = pos.x + d.x * 0.35 * scale;
    core.py = pos.y + d.y * 0.35 * scale;
    core.pz = pos.z + d.z * 0.35 * scale;
    core.vx = d.x * 4;
    core.vy = d.y * 4;
    core.vz = d.z * 4;
    core.startScaleX = 2.6 * scale;
    core.startScaleY = 2.6 * scale;
    core.endScaleX = 4.2 * scale;
    core.endScaleY = 4.2 * scale;
    core.rot = Math.random() * Math.PI * 2;
    core.rotSpeed = 0;
    core.billboard = true;
    core.r = 7.5;
    core.g = 4.8;
    core.b = 1.6;

    // 2. Two crossed 3D axial muzzle flame lobes (0 deg and 90 deg around barrel)
    for (let lobe = 0; lobe < 2; lobe++) {
      const fin = this._allocFlash();
      fin.active = true;
      fin.age = 0;
      fin.maxAge = 0.085;
      fin.px = pos.x + d.x * 1.45 * scale;
      fin.py = pos.y + d.y * 1.45 * scale;
      fin.pz = pos.z + d.z * 1.45 * scale;
      fin.vx = d.x * 6;
      fin.vy = d.y * 6;
      fin.vz = d.z * 6;
      fin.startScaleX = 3.1 * scale;
      fin.startScaleY = 1.55 * scale;
      fin.endScaleX = 4.4 * scale;
      fin.endScaleY = 2.1 * scale;
      fin.billboard = false;
      // Local +X along barrel dir `d`, local +Y along side/up
      fin.axX = d.x;
      fin.axY = d.y;
      fin.axZ = d.z;
      if (lobe === 0) {
        fin.ayX = this._v2.x;
        fin.ayY = this._v2.y;
        fin.ayZ = this._v2.z;
        fin.azX = this._v3.x;
        fin.azY = this._v3.y;
        fin.azZ = this._v3.z;
      } else {
        fin.ayX = this._v3.x;
        fin.ayY = this._v3.y;
        fin.ayZ = this._v3.z;
        fin.azX = -this._v2.x;
        fin.azY = -this._v2.y;
        fin.azZ = -this._v2.z;
      }
      fin.r = 6.8;
      fin.g = 3.9;
      fin.b = 1.15;
    }

    // 3. Muzzle brake side-vent lobes (T-brake blast plumes)
    for (let side = -1; side <= 1; side += 2) {
      const sPuff = this._allocSmoke();
      sPuff.active = true;
      sPuff.age = 0;
      sPuff.maxAge = randRange(0.55, 0.85);
      sPuff.px = pos.x + this._v2.x * side * 0.45 * scale;
      sPuff.py = pos.y + this._v2.y * side * 0.45 * scale;
      sPuff.pz = pos.z + this._v2.z * side * 0.45 * scale;
      const sideSpd = randRange(6.5, 10.5) * scale;
      sPuff.vx = this._v2.x * side * sideSpd + d.x * 2.5;
      sPuff.vy = this._v2.y * side * sideSpd + 0.8;
      sPuff.vz = this._v2.z * side * sideSpd + d.z * 2.5;
      sPuff.drag = 4.6;
      sPuff.buoyancy = 1.2;
      sPuff.startScale = 0.75 * scale;
      sPuff.endScale = 3.2 * scale;
      sPuff.rot = Math.random() * Math.PI * 2;
      sPuff.rotSpeed = randRange(-1.4, 1.4);
      sPuff.r0 = 2.6;
      sPuff.g0 = 1.65;
      sPuff.b0 = 0.85;
      sPuff.rMid = 0.62;
      sPuff.gMid = 0.60;
      sPuff.bMid = 0.57;
      sPuff.midFrac = 0.18;
      sPuff.r1 = 0.48;
      sPuff.g1 = 0.47;
      sPuff.b1 = 0.45;
      sPuff.peakAlpha = 0.46;
      sPuff.fadeInFrac = 0.06;
    }

    // 4. Forward propellant smoke puffs
    const puffCount = 6;
    for (let i = 0; i < puffCount; i++) {
      const p = this._allocSmoke();
      p.active = true;
      p.age = 0;
      p.maxAge = randRange(0.75, 1.35);
      p.px = pos.x + d.x * (0.4 + i * 0.35) * scale;
      p.py = pos.y + d.y * (0.4 + i * 0.35) * scale;
      p.pz = pos.z + d.z * (0.4 + i * 0.35) * scale;
      const spd = randRange(7, 16) * scale;
      p.vx = d.x * spd + randRange(-2.0, 2.0);
      p.vy = d.y * spd + randRange(-1.0, 2.2);
      p.vz = d.z * spd + randRange(-2.0, 2.0);
      p.drag = 4.8;
      p.buoyancy = 1.5;
      p.startScale = randRange(0.7, 1.1) * scale;
      p.endScale = randRange(3.2, 5.0) * scale;
      p.rot = Math.random() * Math.PI * 2;
      p.rotSpeed = randRange(-1.2, 1.2);
      p.r0 = 3.2;
      p.g0 = 2.0;
      p.b0 = 0.95;
      p.rMid = 0.66;
      p.gMid = 0.64;
      p.bMid = 0.61;
      p.midFrac = 0.14;
      p.r1 = 0.50;
      p.g1 = 0.49;
      p.b1 = 0.48;
      p.peakAlpha = 0.44;
      p.fadeInFrac = 0.06;
    }

    // 5. Few unburnt propellant sparks flying forward
    for (let i = 0; i < 8; i++) {
      const sp = this._allocSpark();
      sp.active = true;
      sp.age = 0;
      sp.maxAge = randRange(0.16, 0.32);
      sp.px = pos.x + d.x * 0.5;
      sp.py = pos.y + d.y * 0.5;
      sp.pz = pos.z + d.z * 0.5;
      const spd = randRange(22, 42) * scale;
      sp.vx = d.x * spd + randRange(-6, 6);
      sp.vy = d.y * spd + randRange(-4, 6);
      sp.vz = d.z * spd + randRange(-6, 6);
      sp.drag = 3.0;
      sp.gravity = 9.81;
      sp.width = 0.08 * scale;
      sp.baseLen = 0.25 * scale;
      sp.stretch = 0.03;
      sp.floorY = -999;
      sp.r0 = 6.5;
      sp.g0 = 4.2;
      sp.b0 = 1.4;
      sp.r1 = 3.5;
      sp.g1 = 1.1;
      sp.b1 = 0.2;
    }

    // 6. Ground dust concussion shockwave ring beneath muzzle
    const groundApproxY = pos.y - 1.85;
    const ring = this._allocRing();
    ring.active = true;
    ring.age = 0;
    ring.maxAge = 0.34;
    ring.px = pos.x + d.x * 1.6;
    ring.py = groundApproxY;
    ring.pz = pos.z + d.z * 1.6;
    ring.qx = 0;
    ring.qy = 0;
    ring.qz = 0;
    ring.qw = 1;
    ring.startRadius = 0.8 * scale;
    ring.endRadius = 6.2 * scale;
    ring.r = 0.64;
    ring.g = 0.56;
    ring.b = 0.44;
    ring.peakAlpha = 0.38;

    // 7. Pooled dynamic warm PointLight
    this._spawnPointLight(
      pos.x + d.x * 0.8,
      pos.y + d.y * 0.8 + 0.4,
      pos.z + d.z * 0.8,
      0xffaa4c,
      28 * scale,
      34 * scale,
      0.095
    );

    // 8. Camera concussion impulse
    this._pushShake(pos.x, pos.y, pos.z, 0.24 * scale);
  }

  /**
   * Coaxial 7.62mm MG muzzle glint + light gas wisp.
   */
  public spawnMGFlash(pos: THREE.Vector3, dir: THREE.Vector3): void {
    const d = this._v1.copy(dir).normalize();

    const glint = this._allocFlash();
    glint.active = true;
    glint.age = 0;
    glint.maxAge = 0.042;
    glint.px = pos.x + d.x * 0.16;
    glint.py = pos.y + d.y * 0.16;
    glint.pz = pos.z + d.z * 0.16;
    glint.vx = d.x * 2;
    glint.vy = d.y * 2;
    glint.vz = d.z * 2;
    glint.startScaleX = 0.58;
    glint.startScaleY = 0.58;
    glint.endScaleX = 0.92;
    glint.endScaleY = 0.92;
    glint.rot = Math.random() * Math.PI * 2;
    glint.rotSpeed = 0;
    glint.billboard = true;
    glint.r = 6.0;
    glint.g = 3.8;
    glint.b = 1.2;

    if (Math.random() < 0.45) {
      const wisp = this._allocSmoke();
      wisp.active = true;
      wisp.age = 0;
      wisp.maxAge = randRange(0.28, 0.45);
      wisp.px = pos.x + d.x * 0.25;
      wisp.py = pos.y + d.y * 0.25;
      wisp.pz = pos.z + d.z * 0.25;
      wisp.vx = d.x * 3.5 + randRange(-0.6, 0.6);
      wisp.vy = d.y * 3.5 + 0.8;
      wisp.vz = d.z * 3.5 + randRange(-0.6, 0.6);
      wisp.drag = 4.0;
      wisp.buoyancy = 1.1;
      wisp.startScale = 0.26;
      wisp.endScale = 0.95;
      wisp.rot = Math.random() * Math.PI * 2;
      wisp.rotSpeed = randRange(-1.5, 1.5);
      wisp.r0 = 0.72;
      wisp.g0 = 0.70;
      wisp.b0 = 0.66;
      wisp.rMid = 0.55;
      wisp.gMid = 0.54;
      wisp.bMid = 0.52;
      wisp.midFrac = 0.35;
      wisp.r1 = 0.45;
      wisp.g1 = 0.45;
      wisp.b1 = 0.44;
      wisp.peakAlpha = 0.22;
      wisp.fadeInFrac = 0.08;
    }
  }

  /** Dev/bench counter: total spawnExplosion calls. */
  public explosionsSpawned = 0;

  /**
   * High-impact War Thunder-grade HE detonation or catastrophic tank kill cookoff!
   */
  public spawnExplosion(
    pos: THREE.Vector3,
    normal: THREE.Vector3,
    scale: number,
    kind: 'he_ground' | 'he_armor' | 'tank_kill'
  ): void {
    this.explosionsSpawned++;
    const nrm = this._v1.copy(normal).lengthSq() > 0.001 ? this._v1.normalize() : this._v1.set(0, 1, 0);
    const isKill = kind === 'tank_kill';
    const isGround = kind === 'he_ground';
    const s = Math.max(0.4, scale) * (isKill ? 1.45 : 1.0);

    // Ground-aligned kill FX (rings + scorch) snap to terrain, not the armor hit point
    let killGroundY = pos.y;
    if (isKill && this.groundProbe) {
      const gy = this.groundProbe(pos.x, pos.z);
      if (gy < pos.y - 0.2) killGroundY = gy;
    }

    // 1. Searing initial HDR detonation flash core
    const core = this._allocFlash();
    core.active = true;
    core.age = 0;
    core.maxAge = isKill ? 0.18 : 0.14;
    core.px = pos.x + nrm.x * 0.35;
    core.py = pos.y + nrm.y * 0.35 + 0.25;
    core.pz = pos.z + nrm.z * 0.35;
    core.vx = 0;
    core.vy = 1.5;
    core.vz = 0;
    core.startScaleX = isKill ? 2.2 * s : 3.8 * s;
    core.startScaleY = isKill ? 2.2 * s : 3.8 * s;
    core.endScaleX = (isKill ? 6.8 : 9.2) * s;
    core.endScaleY = (isKill ? 6.8 : 9.2) * s;
    core.rot = Math.random() * Math.PI * 2;
    core.rotSpeed = 0;
    core.billboard = true;
    core.r = isKill ? 4.4 : 9.0;
    core.g = isKill ? 2.5 : 5.6;
    core.b = isKill ? 0.85 : 2.0;

    // Secondary lingering warm fireball glow
    const glow = this._allocFlash();
    glow.active = true;
    glow.age = 0;
    glow.maxAge = isKill ? 0.34 : 0.32;
    glow.px = pos.x;
    glow.py = pos.y + 0.8 * s;
    glow.pz = pos.z;
    glow.vx = 0;
    glow.vy = 3.0;
    glow.vz = 0;
    glow.startScaleX = isKill ? 1.5 * s : 2.5 * s;
    glow.startScaleY = isKill ? 1.5 * s : 2.5 * s;
    glow.endScaleX = (isKill ? 3.6 : 7.4) * s;
    glow.endScaleY = (isKill ? 3.6 : 7.4) * s;
    glow.rot = Math.random() * Math.PI * 2;
    glow.rotSpeed = 0.6;
    glow.billboard = true;
    glow.r = 3.4;
    glow.g = 1.4;
    glow.b = 0.28;

    // 2. Rolling orange-to-charcoal fireball spheres rising into a dark smoke column
    const fireballCount = isKill ? 20 : 12;
    for (let i = 0; i < fireballCount; i++) {
      const fb = this._allocSmoke();
      fb.active = true;
      fb.age = 0;
      const coreBall = i < fireballCount * 0.55;
      fb.maxAge = coreBall ? randRange(1.4, 2.4) * (isKill ? 1.25 : 1.0) : randRange(2.2, 3.8);
      const jitterR = randRange(0.1, 1.3) * s;
      const theta = Math.random() * Math.PI * 2;
      fb.px = pos.x + Math.cos(theta) * jitterR;
      fb.py = pos.y + randRange(0.15, 1.1) * s;
      fb.pz = pos.z + Math.sin(theta) * jitterR;

      const outSpd = randRange(2.5, 9.5) * s;
      fb.vx = Math.cos(theta) * outSpd + nrm.x * 3.0;
      fb.vy = randRange(4.0, 11.5) * s + nrm.y * 3.5;
      fb.vz = Math.sin(theta) * outSpd + nrm.z * 3.0;
      fb.drag = 2.3;
      fb.buoyancy = randRange(2.2, 4.0);
      fb.startScale = randRange(1.3, 2.3) * s;
      fb.endScale = randRange(4.8, 8.2) * s;
      fb.rot = Math.random() * Math.PI * 2;
      fb.rotSpeed = randRange(-1.3, 1.3);

      if (coreBall) {
        // White-gold HDR -> fiery orange -> oily charcoal smoke
        fb.r0 = isKill ? 4.4 : 6.5;
        fb.g0 = isKill ? 2.5 : 3.4;
        fb.b0 = isKill ? 0.62 : 0.85;
        fb.rMid = 2.8;
        fb.gMid = 0.72;
        fb.bMid = 0.10;
        fb.midFrac = 0.20;
        fb.r1 = 0.085;
        fb.g1 = 0.08;
        fb.b1 = 0.078;
        fb.peakAlpha = 0.86;
      } else {
        // Outer soot & dirt plume
        fb.r0 = isGround ? 0.52 : 1.8;
        fb.g0 = isGround ? 0.42 : 0.75;
        fb.b0 = isGround ? 0.30 : 0.22;
        fb.rMid = isGround ? 0.28 : 0.14;
        fb.gMid = isGround ? 0.24 : 0.13;
        fb.bMid = isGround ? 0.19 : 0.12;
        fb.midFrac = 0.22;
        fb.r1 = isGround ? 0.22 : 0.09;
        fb.g1 = isGround ? 0.19 : 0.085;
        fb.b1 = isGround ? 0.16 : 0.085;
        fb.peakAlpha = 0.72;
      }
      fb.fadeInFrac = 0.05;
    }

    // If ground impact, throw an upward dirt/earth fountain skirt
    if (isGround) {
      for (let i = 0; i < 8; i++) {
        const dirt = this._allocSmoke();
        dirt.active = true;
        dirt.age = 0;
        dirt.maxAge = randRange(1.0, 1.75);
        const a = (i / 8) * Math.PI * 2 + randRange(-0.2, 0.2);
        dirt.px = pos.x + Math.cos(a) * 0.6 * s;
        dirt.py = pos.y + 0.25;
        dirt.pz = pos.z + Math.sin(a) * 0.6 * s;
        const hSpd = randRange(5.5, 11.0) * s;
        dirt.vx = Math.cos(a) * hSpd;
        dirt.vy = randRange(5.5, 12.0) * s;
        dirt.vz = Math.sin(a) * hSpd;
        dirt.drag = 2.6;
        dirt.buoyancy = -3.8; // Heavy earth settles back down
        dirt.startScale = randRange(0.9, 1.5) * s;
        dirt.endScale = randRange(3.2, 5.2) * s;
        dirt.rot = Math.random() * Math.PI * 2;
        dirt.rotSpeed = randRange(-1.6, 1.6);
        dirt.r0 = 0.38;
        dirt.g0 = 0.31;
        dirt.b0 = 0.22;
        dirt.rMid = 0.32;
        dirt.gMid = 0.26;
        dirt.bMid = 0.19;
        dirt.midFrac = 0.4;
        dirt.r1 = 0.28;
        dirt.g1 = 0.24;
        dirt.b1 = 0.18;
        dirt.peakAlpha = 0.64;
        dirt.fadeInFrac = 0.06;
      }
    }

    // 3. High-velocity glowing ember & shrapnel spark streaks with gravity
    const sparkCount = isKill ? 44 : 26;
    for (let i = 0; i < sparkCount; i++) {
      const sp = this._allocSpark();
      sp.active = true;
      sp.age = 0;
      sp.maxAge = randRange(0.35, isKill ? 1.35 : 0.88);
      sp.px = pos.x + nrm.x * 0.2;
      sp.py = pos.y + nrm.y * 0.2 + 0.25;
      sp.pz = pos.z + nrm.z * 0.2;

      const az = Math.random() * Math.PI * 2;
      const elev = randRange(0.18, 1.32);
      const spd = randRange(14, isKill ? 38 : 29) * Math.sqrt(scale);
      const cosE = Math.cos(elev);
      sp.vx = Math.cos(az) * cosE * spd + nrm.x * 5;
      sp.vy = Math.sin(elev) * spd + nrm.y * 5;
      sp.vz = Math.sin(az) * cosE * spd + nrm.z * 5;
      sp.drag = 0.85;
      sp.gravity = 12.5;
      // Kill sparks: thin and short — long white streaks read as white-out
      sp.width = isKill ? randRange(0.045, 0.085) : randRange(0.08, 0.16);
      sp.baseLen = isKill ? randRange(0.13, 0.28) : randRange(0.28, 0.55);
      sp.stretch = isKill ? 0.02 : 0.048;
      sp.floorY = isGround ? pos.y + 0.05 : -999;
      sp.r0 = isKill ? 5.2 : 8.0;
      sp.g0 = isKill ? 3.0 : 5.0;
      sp.b0 = isKill ? 0.9 : 1.6;
      sp.r1 = isKill ? 2.4 : 3.8;
      sp.g1 = isKill ? 0.5 : 0.75;
      sp.b1 = isKill ? 0.05 : 0.08;
    }

    // 4. Expanding supersonic ground shockwave ring(s)
    this._quat.setFromUnitVectors(this._up, nrm);
    const ring = this._allocRing();
    ring.active = true;
    ring.age = 0;
    ring.maxAge = isKill ? 0.52 : 0.38;
    ring.px = pos.x + nrm.x * 0.09;
    ring.py = (isKill ? killGroundY : pos.y) + nrm.y * 0.09 + 0.05;
    ring.pz = pos.z + nrm.z * 0.09;
    if (isKill) {
      ring.qx = 0;
      ring.qy = 0;
      ring.qz = 0;
      ring.qw = 1;
    } else {
      ring.qx = this._quat.x;
      ring.qy = this._quat.y;
      ring.qz = this._quat.z;
      ring.qw = this._quat.w;
    }
    ring.startRadius = 0.9 * s;
    ring.endRadius = (isKill ? 15.5 : 9.8) * scale;
    ring.r = isKill ? 3.2 : 1.8;
    ring.g = isKill ? 1.6 : 1.35;
    ring.b = isKill ? 0.6 : 0.95;
    ring.peakAlpha = 0.68;

    if (isKill) {
      // Secondary wide dust blast wave on flat ground plane
      const wave2 = this._allocRing();
      wave2.active = true;
      wave2.age = 0;
      wave2.maxAge = 0.72;
      wave2.px = pos.x;
      wave2.py = killGroundY + 0.12;
      wave2.pz = pos.z;
      wave2.qx = 0;
      wave2.qy = 0;
      wave2.qz = 0;
      wave2.qw = 1;
      wave2.startRadius = 1.5;
      wave2.endRadius = 21.0 * scale;
      wave2.r = 0.65;
      wave2.g = 0.56;
      wave2.b = 0.44;
      wave2.peakAlpha = 0.5;
    }

    // 5. Persistent blackened scorch crater decal if near upward-facing ground/surface
    if (isGround || isKill || nrm.y > 0.55) {
      const decalNormal = isKill ? this._up : nrm;
      const scorchRadius = (isKill ? 4.6 : 3.1) * scale;
      if (isKill) {
        this._v2.set(pos.x, killGroundY + 0.03, pos.z);
        this._placeScorchDecal(this._v2, decalNormal, scorchRadius, 0.92);
      } else {
        this._placeScorchDecal(pos, decalNormal, scorchRadius, 0.82);
      }
    }

    // 6. Dynamic warm blast PointLight
    this._spawnPointLight(
      pos.x + nrm.x * 0.6,
      pos.y + 1.2,
      pos.z + nrm.z * 0.6,
      isKill ? 0xff8828 : 0xff9e3d,
      (isKill ? 56 : 36) * scale,
      (isKill ? 48 : 38) * scale,
      isKill ? 0.52 : 0.30
    );

    // 7. Sustained secondary ammo cookoff fountain for 'tank_kill'
    if (isKill) {
      const site = this.cookoffSites[this.cookoffCursor];
      this.cookoffCursor = (this.cookoffCursor + 1) % COOKOFF_POOL_SIZE;
      site.active = true;
      site.x = pos.x;
      site.y = pos.y + 0.8;
      site.z = pos.z;
      site.age = 0;
      site.duration = 2.8;
      site.emitAccum = 0;
    }

    // 8. Distance-attenuated camera trauma impulse
    const shakePower = isKill ? 0.95 : kind === 'he_armor' ? 0.55 : 0.48;
    this._pushShake(pos.x, pos.y, pos.z, shakePower * scale);
  }

  /**
   * Coaxial MG / ricochet impact: hot metallic armor sparks or kicked-up dirt puff.
   */
  public spawnSparkImpact(pos: THREE.Vector3, normal: THREE.Vector3, isArmor: boolean): void {
    const nrm = this._v1.copy(normal).lengthSq() > 0.001 ? this._v1.normalize() : this._v1.set(0, 1, 0);

    if (isArmor) {
      const flash = this._allocFlash();
      flash.active = true;
      flash.age = 0;
      flash.maxAge = 0.055;
      flash.px = pos.x + nrm.x * 0.08;
      flash.py = pos.y + nrm.y * 0.08;
      flash.pz = pos.z + nrm.z * 0.08;
      flash.vx = 0;
      flash.vy = 0;
      flash.vz = 0;
      flash.startScaleX = 0.55;
      flash.startScaleY = 0.55;
      flash.endScaleX = 1.15;
      flash.endScaleY = 1.15;
      flash.rot = Math.random() * Math.PI * 2;
      flash.rotSpeed = 0;
      flash.billboard = true;
      flash.r = 7.5;
      flash.g = 4.6;
      flash.b = 1.5;

      const count = 9;
      for (let i = 0; i < count; i++) {
        const sp = this._allocSpark();
        sp.active = true;
        sp.age = 0;
        sp.maxAge = randRange(0.16, 0.42);
        sp.px = pos.x + nrm.x * 0.06;
        sp.py = pos.y + nrm.y * 0.06;
        sp.pz = pos.z + nrm.z * 0.06;
        const spd = randRange(8, 21);
        sp.vx = nrm.x * spd + randRange(-7, 7);
        sp.vy = nrm.y * spd + randRange(1, 8);
        sp.vz = nrm.z * spd + randRange(-7, 7);
        sp.drag = 1.4;
        sp.gravity = 13.5;
        sp.width = 0.055;
        sp.baseLen = 0.16;
        sp.stretch = 0.038;
        sp.floorY = -999;
        sp.r0 = 8.0;
        sp.g0 = 5.2;
        sp.b0 = 1.9;
        sp.r1 = 4.2;
        sp.g1 = 1.1;
        sp.b1 = 0.15;
      }

      const puff = this._allocSmoke();
      puff.active = true;
      puff.age = 0;
      puff.maxAge = randRange(0.35, 0.58);
      puff.px = pos.x + nrm.x * 0.12;
      puff.py = pos.y + nrm.y * 0.12;
      puff.pz = pos.z + nrm.z * 0.12;
      puff.vx = nrm.x * 2.4 + randRange(-0.8, 0.8);
      puff.vy = nrm.y * 2.4 + 0.9;
      puff.vz = nrm.z * 2.4 + randRange(-0.8, 0.8);
      puff.drag = 3.2;
      puff.buoyancy = 1.0;
      puff.startScale = 0.30;
      puff.endScale = 1.15;
      puff.rot = Math.random() * Math.PI * 2;
      puff.rotSpeed = randRange(-1.5, 1.5);
      puff.r0 = 0.65;
      puff.g0 = 0.63;
      puff.b0 = 0.60;
      puff.rMid = 0.45;
      puff.gMid = 0.44;
      puff.bMid = 0.43;
      puff.midFrac = 0.35;
      puff.r1 = 0.35;
      puff.g1 = 0.35;
      puff.b1 = 0.35;
      puff.peakAlpha = 0.32;
      puff.fadeInFrac = 0.08;
    } else {
      // Terrain dirt kickup + occasional pebble ricochet spark
      for (let i = 0; i < 2; i++) {
        const dirt = this._allocSmoke();
        dirt.active = true;
        dirt.age = 0;
        dirt.maxAge = randRange(0.48, 0.85);
        dirt.px = pos.x + nrm.x * 0.1;
        dirt.py = pos.y + nrm.y * 0.1;
        dirt.pz = pos.z + nrm.z * 0.1;
        dirt.vx = nrm.x * randRange(1.5, 3.8) + randRange(-1.4, 1.4);
        dirt.vy = nrm.y * randRange(2.4, 5.2) + randRange(0.5, 2.0);
        dirt.vz = nrm.z * randRange(1.5, 3.8) + randRange(-1.4, 1.4);
        dirt.drag = 2.8;
        dirt.buoyancy = -2.2;
        dirt.startScale = randRange(0.32, 0.52);
        dirt.endScale = randRange(1.35, 2.1);
        dirt.rot = Math.random() * Math.PI * 2;
        dirt.rotSpeed = randRange(-1.8, 1.8);
        dirt.r0 = 0.44;
        dirt.g0 = 0.36;
        dirt.b0 = 0.25;
        dirt.rMid = 0.38;
        dirt.gMid = 0.31;
        dirt.bMid = 0.22;
        dirt.midFrac = 0.4;
        dirt.r1 = 0.32;
        dirt.g1 = 0.27;
        dirt.b1 = 0.20;
        dirt.peakAlpha = 0.48;
        dirt.fadeInFrac = 0.07;
      }

      for (let i = 0; i < 3; i++) {
        const sp = this._allocSpark();
        sp.active = true;
        sp.age = 0;
        sp.maxAge = randRange(0.12, 0.26);
        sp.px = pos.x + nrm.x * 0.08;
        sp.py = pos.y + nrm.y * 0.08;
        sp.pz = pos.z + nrm.z * 0.08;
        sp.vx = nrm.x * 8 + randRange(-5, 5);
        sp.vy = nrm.y * 8 + randRange(2, 6);
        sp.vz = nrm.z * 8 + randRange(-5, 5);
        sp.drag = 1.8;
        sp.gravity = 13;
        sp.width = 0.045;
        sp.baseLen = 0.12;
        sp.stretch = 0.03;
        sp.floorY = pos.y + 0.02;
        sp.r0 = 5.5;
        sp.g0 = 3.2;
        sp.b0 = 0.9;
        sp.r1 = 2.5;
        sp.g1 = 0.8;
        sp.b1 = 0.15;
      }
    }
  }

  /**
   * Kicked-up earthy dust billboards behind moving tank tracks.
   */
  public spawnTrackDust(pos: THREE.Vector3, intensity01: number): void {
    const k = Math.max(0, Math.min(1, intensity01));
    if (k < 0.04) return;

    const p = this._allocSmoke();
    p.active = true;
    p.age = 0;
    p.maxAge = randRange(0.65, 1.25) * (0.7 + 0.5 * k);
    p.px = pos.x + randRange(-0.28, 0.28);
    p.py = pos.y + 0.22;
    p.pz = pos.z + randRange(-0.28, 0.28);
    p.vx = randRange(-0.9, 0.9);
    p.vy = randRange(0.6, 1.65) * (0.5 + 0.7 * k);
    p.vz = randRange(-0.9, 0.9);
    p.drag = 2.2;
    p.buoyancy = 0.35;
    p.startScale = randRange(0.45, 0.78) * (0.65 + 0.55 * k);
    p.endScale = randRange(1.8, 3.1) * (0.65 + 0.6 * k);
    p.rot = Math.random() * Math.PI * 2;
    p.rotSpeed = randRange(-1.1, 1.1);
    p.r0 = 0.54;
    p.g0 = 0.46;
    p.b0 = 0.34;
    p.rMid = 0.48;
    p.gMid = 0.41;
    p.bMid = 0.31;
    p.midFrac = 0.45;
    p.r1 = 0.43;
    p.g1 = 0.38;
    p.b1 = 0.29;
    p.peakAlpha = 0.28 * k;
    p.fadeInFrac = 0.14;
  }

  /**
   * Track/wheel spray trailing behind a fording vehicle: a few pale,
   * short-lived droplets arcing off the water surface.
   */
  public spawnWaterWake(pos: THREE.Vector3, intensity01: number): void {
    const k = Math.max(0, Math.min(1, intensity01));
    if (k < 0.05) return;

    for (let i = 0; i < 2; i++) {
      const p = this._allocSmoke();
      p.active = true;
      p.age = 0;
      p.maxAge = randRange(0.4, 0.75);
      p.px = pos.x + randRange(-0.5, 0.5);
      p.py = pos.y + randRange(0.0, 0.25);
      p.pz = pos.z + randRange(-0.5, 0.5);
      p.vx = randRange(-1.6, 1.6);
      p.vy = randRange(1.6, 3.8) * (0.5 + 0.6 * k);
      p.vz = randRange(-1.6, 1.6);
      p.drag = 2.6;
      p.buoyancy = 1.4;
      p.startScale = randRange(0.3, 0.55) * (0.6 + 0.6 * k);
      p.endScale = randRange(1.0, 1.8) * (0.6 + 0.6 * k);
      p.rot = Math.random() * Math.PI * 2;
      p.rotSpeed = randRange(-1.6, 1.6);
      p.r0 = 0.72;
      p.g0 = 0.82;
      p.b0 = 0.86;
      p.rMid = 0.55;
      p.gMid = 0.68;
      p.bMid = 0.72;
      p.midFrac = 0.4;
      p.r1 = 0.40;
      p.g1 = 0.52;
      p.b1 = 0.58;
      p.peakAlpha = 0.4 * k;
      p.fadeInFrac = 0.1;
    }
  }

  /**
   * Projectile/ordnance water impact: pale column of spray + droplets + a
   * small foam flash at the surface point.
   */
  public spawnWaterSplash(pos: THREE.Vector3, scale = 1): void {
    const s = Math.max(0.4, scale);

    const sprayCount = Math.round(9 * s) + 4;
    for (let i = 0; i < sprayCount; i++) {
      const p = this._allocSmoke();
      p.active = true;
      p.age = 0;
      p.maxAge = randRange(0.5, 0.95);
      p.px = pos.x + randRange(-0.5, 0.5) * s;
      p.py = pos.y + randRange(0.0, 0.4);
      p.pz = pos.z + randRange(-0.5, 0.5) * s;
      const theta = Math.random() * Math.PI * 2;
      const outSpd = randRange(0.8, 4.2) * s;
      p.vx = Math.cos(theta) * outSpd;
      p.vy = randRange(3.5, 8.5) * s;
      p.vz = Math.sin(theta) * outSpd;
      p.drag = 1.9;
      p.buoyancy = 2.2;
      p.startScale = randRange(0.45, 0.85) * s;
      p.endScale = randRange(1.5, 2.7) * s;
      p.rot = Math.random() * Math.PI * 2;
      p.rotSpeed = randRange(-1.4, 1.4);
      p.r0 = 0.80;
      p.g0 = 0.88;
      p.b0 = 0.92;
      p.rMid = 0.60;
      p.gMid = 0.72;
      p.bMid = 0.77;
      p.midFrac = 0.4;
      p.r1 = 0.42;
      p.g1 = 0.55;
      p.b1 = 0.62;
      p.peakAlpha = 0.62;
      p.fadeInFrac = 0.05;
    }

    // Droplets: short ballistic sparks
    const dropCount = Math.round(6 * s) + 2;
    for (let i = 0; i < dropCount; i++) {
      const sp = this._allocSpark();
      sp.active = true;
      sp.age = 0;
      sp.maxAge = randRange(0.3, 0.6);
      sp.px = pos.x + randRange(-0.3, 0.3) * s;
      sp.py = pos.y + 0.15;
      sp.pz = pos.z + randRange(-0.3, 0.3) * s;
      const theta = Math.random() * Math.PI * 2;
      const outSpd = randRange(2.5, 7.5) * s;
      sp.vx = Math.cos(theta) * outSpd;
      sp.vy = randRange(4.0, 9.0) * s;
      sp.vz = Math.sin(theta) * outSpd;
      sp.drag = 0.6;
      sp.gravity = 12.5;
      sp.width = 0.05;
      sp.baseLen = 0.14;
      sp.stretch = 0.035;
      sp.floorY = -999;
      sp.r0 = 1.5;
      sp.g0 = 1.8;
      sp.b0 = 1.9;
      sp.r1 = 0.5;
      sp.g1 = 0.65;
      sp.b1 = 0.72;
    }

    // Foam crown flash
    const flash = this._allocFlash();
    flash.active = true;
    flash.age = 0;
    flash.maxAge = 0.14;
    flash.px = pos.x;
    flash.py = pos.y + 0.3;
    flash.pz = pos.z;
    flash.vx = 0;
    flash.vy = 0.8;
    flash.vz = 0;
    flash.startScaleX = 1.6 * s;
    flash.startScaleY = 1.6 * s;
    flash.endScaleX = 3.4 * s;
    flash.endScaleY = 3.4 * s;
    flash.rot = Math.random() * Math.PI * 2;
    flash.rotSpeed = 0;
    flash.billboard = true;
    flash.r = 1.6;
    flash.g = 1.9;
    flash.b = 2.0;
  }

  /**
   * Dense grey exhaust smoke + flickering motor flare emitted at a burning
   * rocket's tail while `rocket.burnTime` is active.
   */
  public spawnRocketTrail(pos: THREE.Vector3): void {
    const p = this._allocSmoke();
    p.active = true;
    p.age = 0;
    p.maxAge = randRange(0.8, 1.5);
    p.px = pos.x + randRange(-0.05, 0.05);
    p.py = pos.y + randRange(-0.05, 0.05);
    p.pz = pos.z + randRange(-0.05, 0.05);
    p.vx = randRange(-0.35, 0.35);
    p.vy = randRange(0.15, 0.7);
    p.vz = randRange(-0.35, 0.35);
    p.drag = 1.5;
    p.buoyancy = 0.55;
    p.startScale = randRange(0.34, 0.55);
    p.endScale = randRange(1.7, 2.6);
    p.rot = Math.random() * Math.PI * 2;
    p.rotSpeed = randRange(-1.4, 1.4);
    p.r0 = 0.74;
    p.g0 = 0.73;
    p.b0 = 0.7;
    p.rMid = 0.62;
    p.gMid = 0.61;
    p.bMid = 0.59;
    p.midFrac = 0.4;
    p.r1 = 0.52;
    p.g1 = 0.52;
    p.b1 = 0.52;
    p.peakAlpha = 0.62;
    p.fadeInFrac = 0.1;

    // Motor flare: ~1 m bright nozzle glow, modest HDR (tracer-head level)
    if (Math.random() < 0.55) {
      const f = this._allocFlash();
      f.active = true;
      f.age = 0;
      f.maxAge = randRange(0.08, 0.15);
      f.px = pos.x;
      f.py = pos.y;
      f.pz = pos.z;
      f.vx = 0;
      f.vy = 0;
      f.vz = 0;
      f.startScaleX = randRange(0.8, 1.15);
      f.startScaleY = randRange(0.8, 1.15);
      f.endScaleX = randRange(0.25, 0.4);
      f.endScaleY = randRange(0.25, 0.4);
      f.rot = 0;
      f.rotSpeed = 0;
      f.billboard = true;
      f.r = 2.3;
      f.g = 1.45;
      f.b = 0.5;
    }
  }

  /**
   * Backblast: dark smoke + dust thrown backwards off the launch pod on firing.
   */
  public spawnRocketBackblast(pos: THREE.Vector3, launchDir: THREE.Vector3): void {
    for (let i = 0; i < 4; i++) {
      const p = this._allocSmoke();
      p.active = true;
      p.age = 0;
      p.maxAge = randRange(0.7, 1.3);
      const back = 1.6 + i * 0.7;
      p.px = pos.x - launchDir.x * back + randRange(-0.4, 0.4);
      p.py = pos.y - launchDir.y * back + randRange(-0.2, 0.5);
      p.pz = pos.z - launchDir.z * back + randRange(-0.4, 0.4);
      p.vx = -launchDir.x * randRange(6, 11) + randRange(-1.5, 1.5);
      p.vy = randRange(0.8, 2.4);
      p.vz = -launchDir.z * randRange(6, 11) + randRange(-1.5, 1.5);
      p.drag = 2.4;
      p.buoyancy = 0.4;
      p.startScale = randRange(0.7, 1.2);
      p.endScale = randRange(2.6, 4.2);
      p.rot = Math.random() * Math.PI * 2;
      p.rotSpeed = randRange(-1.2, 1.2);
      p.r0 = 0.32;
      p.g0 = 0.3;
      p.b0 = 0.27;
      p.rMid = 0.26;
      p.gMid = 0.25;
      p.bMid = 0.23;
      p.midFrac = 0.4;
      p.r1 = 0.2;
      p.g1 = 0.19;
      p.b1 = 0.18;
      p.peakAlpha = 0.6;
      p.fadeInFrac = 0.08;
    }
  }

  /**
   * One procedural flame lick for a burning wreck (white-yellow core -> deep red).
   */
  public spawnWreckFire(x: number, y: number, z: number, scale = 1): void {
    if (!this.wreckFxVisible) return;
    const f = this._allocFire();
    f.active = true;
    f.age = 0;
    f.maxAge = randRange(0.35, 0.7);
    f.px = x + randRange(-0.22, 0.22) * scale;
    f.py = y + randRange(-0.08, 0.15) * scale;
    f.pz = z + randRange(-0.22, 0.22) * scale;
    f.vx = randRange(-0.5, 0.5);
    f.vy = randRange(0.9, 2.0) * scale;
    f.vz = randRange(-0.5, 0.5);
    f.s0 = randRange(0.18, 0.32) * scale;
    f.s1 = randRange(0.5, 0.9) * scale;
    f.seed = Math.random() * 100;
    f.alpha0 = randRange(0.65, 0.95);
  }

  /** Rising orange ember/spark shower from a burning wreck. */
  public spawnEmbers(x: number, y: number, z: number, count: number): void {
    if (!this.wreckFxVisible) return;
    for (let i = 0; i < count; i++) {
      const sp = this._allocSpark();
      sp.active = true;
      sp.age = 0;
      sp.maxAge = randRange(0.5, 1.4);
      sp.px = x + randRange(-0.7, 0.7);
      sp.py = y + randRange(0, 0.5);
      sp.pz = z + randRange(-0.7, 0.7);
      sp.vx = randRange(-1.6, 1.6);
      sp.vy = randRange(2.5, 7.0);
      sp.vz = randRange(-1.6, 1.6);
      sp.drag = 0.7;
      sp.gravity = 6.5;
      sp.width = 0.05;
      sp.baseLen = 0.15;
      sp.stretch = 0.035;
      sp.floorY = -999;
      sp.r0 = 7.0;
      sp.g0 = 3.4;
      sp.b0 = 0.9;
      sp.r1 = 2.6;
      sp.g1 = 0.45;
      sp.b1 = 0.04;
    }
  }

  /** Terrain height probe for snapping ground-aligned FX (set by main.ts). */
  public groundProbe: ((x: number, z: number) => number) | null = null;
  /** QA flag: hide wreck fire/smoke/ember/flare emission + clear live pools. */
  public wreckFxVisible = true;

  public setWreckFxVisible(v: boolean): void {
    this.wreckFxVisible = v;
    if (v) return;
    for (const p of this.firePool) { p.active = false; }
    for (const p of this.smokePool) { p.active = false; }
    for (const p of this.sparkPool) { p.active = false; }
    for (const p of this.flashPool) { p.active = false; }
    this.fireActiveIdx.length = 0; this.firePos.fill(-1);
    this.smokeActiveIdx.length = 0; this.smokePos.fill(-1);
    this.sparkActiveIdx.length = 0; this.sparkPos.fill(-1);
    this.flashActiveIdx.length = 0; this.flashPos.fill(-1);
    this.fireMesh.visible = false;
    this.smokeMesh.visible = false;
    this.sparkMesh.visible = false;
    this.flashMesh.visible = false;
  }

  /**
   * Called periodically by dead tank wrecks for rising black oil smoke + flickering ember glow.
   */
  public spawnWreckSmoke(pos: THREE.Vector3): void {
    if (!this.wreckFxVisible) return;
    // Rising thick black oil smoke puff — big, long-lived, billowing column
    const smoke = this._allocSmoke();
    smoke.active = true;
    smoke.age = 0;
    smoke.maxAge = randRange(4.5, 7.0);
    smoke.px = pos.x + randRange(-0.9, 0.9);
    smoke.py = pos.y + randRange(0.4, 1.4);
    smoke.pz = pos.z + randRange(-0.9, 0.9);
    smoke.vx = randRange(-0.3, 1.7);
    smoke.vy = randRange(3.2, 5.2);
    smoke.vz = randRange(-0.3, 1.3);
    smoke.drag = 0.5;
    smoke.buoyancy = 1.05;
    smoke.startScale = randRange(2.4, 3.4);
    smoke.endScale = randRange(9.0, 13.0);
    smoke.rot = Math.random() * Math.PI * 2;
    smoke.rotSpeed = randRange(-0.85, 0.85);
    smoke.r0 = 2.6;
    smoke.g0 = 0.85;
    smoke.b0 = 0.14;
    smoke.rMid = 0.11;
    smoke.gMid = 0.10;
    smoke.bMid = 0.095;
    smoke.midFrac = 0.16;
    smoke.r1 = 0.065;
    smoke.g1 = 0.065;
    smoke.b1 = 0.07;
    smoke.peakAlpha = 0.8;
    smoke.fadeInFrac = 0.12;

    // Flickering turret-ring fire tongue
    const ember = this._allocFlash();
    ember.active = true;
    ember.age = 0;
    ember.maxAge = randRange(0.18, 0.34);
    ember.px = pos.x + randRange(-0.35, 0.35);
    ember.py = pos.y + randRange(0.55, 1.05);
    ember.pz = pos.z + randRange(-0.35, 0.35);
    ember.vx = randRange(-0.4, 0.4);
    ember.vy = randRange(1.2, 2.4);
    ember.vz = randRange(-0.4, 0.4);
    ember.startScaleX = randRange(0.5, 0.9);
    ember.startScaleY = randRange(0.6, 1.0);
    ember.endScaleX = randRange(0.3, 0.6);
    ember.endScaleY = randRange(0.9, 1.4);
    ember.rot = Math.random() * Math.PI * 2;
    ember.rotSpeed = randRange(-2, 2);
    ember.billboard = true;
    ember.r = 4.5;
    ember.g = 1.65;
    ember.b = 0.25;

    if (Math.random() < 0.45) {
      const sp = this._allocSpark();
      sp.active = true;
      sp.age = 0;
      sp.maxAge = randRange(0.4, 0.85);
      sp.px = pos.x + randRange(-0.3, 0.3);
      sp.py = pos.y + 0.9;
      sp.pz = pos.z + randRange(-0.3, 0.3);
      sp.vx = randRange(-2.5, 2.5);
      sp.vy = randRange(4.5, 9.0);
      sp.vz = randRange(-2.5, 2.5);
      sp.drag = 0.9;
      sp.gravity = 6.5;
      sp.width = 0.06;
      sp.baseLen = 0.14;
      sp.stretch = 0.03;
      sp.floorY = -999;
      sp.r0 = 6.0;
      sp.g0 = 2.8;
      sp.b0 = 0.5;
      sp.r1 = 2.8;
      sp.g1 = 0.5;
      sp.b1 = 0.05;
    }
  }

  /**
   * Accumulates distance-attenuated camera shake impulses `1 / (1 + (d/35)^2)`
   * since the previous frame and clears the queue.
   */
  public consumeCameraShake(listenerPos: THREE.Vector3): number {
    if (this.shakeCount === 0) return 0;
    let total = 0;
    const invRefSq = 1 / (35 * 35);
    for (let i = 0; i < this.shakeCount; i++) {
      const ev = this.shakeQueue[i];
      const dx = ev.x - listenerPos.x;
      const dy = ev.y - listenerPos.y;
      const dz = ev.z - listenerPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const atten = 1 / (1 + d2 * invRefSq);
      total += ev.strength * atten;
    }
    this.shakeCount = 0;
    return Math.min(total, 1.5);
  }

  // -------------------------------------------------------------------------
  // Per-frame GPU Instance Buffer Update
  // -------------------------------------------------------------------------
  /** Camera-facing procedural fire licks for burning wrecks. */
  private _updateFire(stepDt: number): void {
    this.fireTimeUniform.value += stepDt;
    const rx = this._camRight.x;
    const ry = this._camRight.y;
    const rz = this._camRight.z;
    const ux = this._camUp.x;
    const uy = this._camUp.y;
    const uz = this._camUp.z;
    const bx = this._camBack.x;
    const by = this._camBack.y;
    const bz = this._camBack.z;
    const matE = this._mat4.elements;

    let fireActive = 0;
    const fireList = this.fireActiveIdx;
    for (let k = fireList.length - 1; k >= 0; k--) {
      const i = fireList[k];
      const p = this.firePool[i];
      p.age += stepDt;
      if (!p.active || p.age >= p.maxAge) {
        p.active = false;
        this._listRemove(fireList, this.firePos, i);
        continue;
      }
      const t = p.age / p.maxAge;
      const damp = Math.exp(-1.6 * stepDt);
      p.vx *= damp;
      p.vy *= damp;
      p.vz *= damp;
      p.px += p.vx * stepDt;
      p.py += p.vy * stepDt;
      p.pz += p.vz * stepDt;

      // Fast attack, slow shrink
      const grow = Math.min(1, t * 5);
      const shrink = 1 - t * t * 0.55;
      const scale = (p.s0 + (p.s1 - p.s0) * (1 - (1 - t) * (1 - t))) * grow * shrink;

      // White-yellow core -> orange -> deep red
      let cr: number;
      let cg: number;
      let cb: number;
      if (t < 0.35) {
        const k = t / 0.35;
        cr = p.r0 + (1.9 - p.r0) * k;
        cg = p.g0 + (0.85 - p.g0) * k;
        cb = p.b0 + (0.22 - p.b0) * k;
      } else {
        const k = (t - 0.35) / 0.65;
        cr = 1.9 + (p.r1 - 1.9) * k;
        cg = 0.85 + (p.g1 - 0.85) * k;
        cb = 0.22 + (p.b1 - 0.22) * k;
      }
      const fade = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
      const alpha = p.alpha0 * Math.max(0, fade) * (1 - t * 0.4);

      matE[0] = rx * scale;
      matE[1] = ry * scale;
      matE[2] = rz * scale;
      matE[3] = 0;
      matE[4] = ux * scale;
      matE[5] = uy * scale;
      matE[6] = uz * scale;
      matE[7] = 0;
      matE[8] = bx * scale;
      matE[9] = by * scale;
      matE[10] = bz * scale;
      matE[11] = 0;
      matE[12] = p.px;
      matE[13] = p.py;
      matE[14] = p.pz;
      matE[15] = 1;

      const outIdx = fireActive++;
      this.fireMesh.setMatrixAt(outIdx, this._mat4);
      this._color.setRGB(cr, cg, cb);
      this.fireMesh.setColorAt(outIdx, this._color);
      this.fireOpacityAttr.setX(outIdx, alpha);
    }

    if (fireActive === 0) {
      this.fireMesh.visible = false;
    } else {
      this.fireMesh.visible = true;
      this.fireMesh.count = fireActive;
      this.fireMesh.instanceMatrix.clearUpdateRanges();
      this.fireMesh.instanceMatrix.addUpdateRange(0, fireActive * 16);
      this.fireMesh.instanceMatrix.needsUpdate = true;
      if (this.fireMesh.instanceColor) {
        this.fireMesh.instanceColor.clearUpdateRanges();
        this.fireMesh.instanceColor.addUpdateRange(0, fireActive * 3);
        this.fireMesh.instanceColor.needsUpdate = true;
      }
      this.fireOpacityAttr.clearUpdateRanges();
      this.fireOpacityAttr.addUpdateRange(0, fireActive);
      this.fireOpacityAttr.needsUpdate = true;
    }
  }

  public update(dt: number, camera: THREE.Camera): void {
    const stepDt = Math.min(Math.max(dt, 0), 0.08);
    if (stepDt === 0) return;

    // Extract camera basis in world space for ultra-fast billboard construction
    camera.updateMatrixWorld();
    camera.matrixWorld.extractBasis(this._camRight, this._camUp, this._camBack);
    this._camPos.setFromMatrixPosition(camera.matrixWorld);

    // 0. Step active tank-kill secondary cookoff sites
    for (let i = 0; i < COOKOFF_POOL_SIZE; i++) {
      const site = this.cookoffSites[i];
      if (!site.active) continue;
      site.age += stepDt;
      if (site.age >= site.duration) {
        site.active = false;
        continue;
      }
      site.emitAccum += stepDt;
      while (site.emitAccum >= 0.13) {
        site.emitAccum -= 0.13;
        this._v1.set(site.x, site.y, site.z);
        if (this.wreckFxVisible) this.spawnWreckSmoke(this._v1);
        // Extra molten cookoff sparks shooting out of turret ring
        for (let k = 0; this.wreckFxVisible && k < 3; k++) {
          const sp = this._allocSpark();
          sp.active = true;
          sp.age = 0;
          sp.maxAge = randRange(0.35, 0.78);
          sp.px = site.x + randRange(-0.4, 0.4);
          sp.py = site.y + 0.4;
          sp.pz = site.z + randRange(-0.4, 0.4);
          sp.vx = randRange(-6.5, 6.5);
          sp.vy = randRange(8.0, 17.5);
          sp.vz = randRange(-6.5, 6.5);
          sp.drag = 1.0;
          sp.gravity = 11.5;
          sp.width = 0.085;
          sp.baseLen = 0.22;
          sp.stretch = 0.04;
          sp.floorY = -999;
          sp.r0 = 7.5;
          sp.g0 = 4.2;
          sp.b0 = 1.1;
          sp.r1 = 3.5;
          sp.g1 = 0.7;
          sp.b1 = 0.08;
        }
      }
    }

    this._updateFire(stepDt);

    // 1. Update Smoke / Fireball-to-Smoke / Dust Pool
    let smokeActive = 0;
    const matE = this._mat4.elements;
    const rx = this._camRight.x;
    const ry = this._camRight.y;
    const rz = this._camRight.z;
    const ux = this._camUp.x;
    const uy = this._camUp.y;
    const uz = this._camUp.z;
    const bx = this._camBack.x;
    const by = this._camBack.y;
    const bz = this._camBack.z;

    const smokeList = this.smokeActiveIdx;
    for (let k = smokeList.length - 1; k >= 0; k--) {
      const i = smokeList[k];
      const p = this.smokePool[i];
      p.age += stepDt;
      if (!p.active || p.age >= p.maxAge) {
        p.active = false;
        this._listRemove(smokeList, this.smokePos, i);
        continue;
      }

      const t = p.age / p.maxAge;
      const damp = Math.exp(-p.drag * stepDt);
      p.vx *= damp;
      p.vy = p.vy * damp + p.buoyancy * stepDt;
      p.vz *= damp;

      p.px += p.vx * stepDt;
      p.py += p.vy * stepDt;
      p.pz += p.vz * stepDt;
      p.rot += p.rotSpeed * stepDt;

      // Smooth ease-out expansion
      const easeOut = 1 - (1 - t) * (1 - t);
      const scale = p.startScale + (p.endScale - p.startScale) * easeOut;

      // Smooth fade-in then cosine/smoothstep fade-out
      let alpha: number;
      if (t < p.fadeInFrac) {
        alpha = p.peakAlpha * (t / Math.max(0.001, p.fadeInFrac));
      } else {
        const u = (t - p.fadeInFrac) / Math.max(0.001, 1 - p.fadeInFrac);
        alpha = p.peakAlpha * (1 - u) * (1 - u * 0.65);
      }

      // 3-stop color ramp (HDR plasma -> flame -> charcoal smoke)
      let cr: number;
      let cg: number;
      let cb: number;
      if (t < p.midFrac) {
        const k = t / Math.max(0.001, p.midFrac);
        cr = p.r0 + (p.rMid - p.r0) * k;
        cg = p.g0 + (p.gMid - p.g0) * k;
        cb = p.b0 + (p.bMid - p.b0) * k;
      } else {
        const k = Math.min(1, (t - p.midFrac) / Math.max(0.001, 1 - p.midFrac));
        const ks = k * (2 - k);
        cr = p.rMid + (p.r1 - p.rMid) * ks;
        cg = p.gMid + (p.g1 - p.gMid) * ks;
        cb = p.bMid + (p.b1 - p.bMid) * ks;
      }

      const c = Math.cos(p.rot) * scale;
      const s = Math.sin(p.rot) * scale;

      matE[0] = rx * c + ux * s;
      matE[1] = ry * c + uy * s;
      matE[2] = rz * c + uz * s;
      matE[3] = 0;
      matE[4] = -rx * s + ux * c;
      matE[5] = -ry * s + uy * c;
      matE[6] = -rz * s + uz * c;
      matE[7] = 0;
      matE[8] = bx * scale;
      matE[9] = by * scale;
      matE[10] = bz * scale;
      matE[11] = 0;
      matE[12] = p.px;
      matE[13] = p.py;
      matE[14] = p.pz;
      matE[15] = 1;

      const outIdx = smokeActive++;
      this.smokeMesh.setMatrixAt(outIdx, this._mat4);
      this._color.setRGB(cr, cg, cb);
      this.smokeMesh.setColorAt(outIdx, this._color);
      this.smokeOpacityAttr.setX(outIdx, alpha);
    }

    if (smokeActive === 0) {
      this.smokeMesh.visible = false;
    } else {
      this.smokeMesh.visible = true;
      this.smokeMesh.count = smokeActive;
      this.smokeMesh.instanceMatrix.clearUpdateRanges();
      this.smokeMesh.instanceMatrix.addUpdateRange(0, smokeActive * 16);
      this.smokeMesh.instanceMatrix.needsUpdate = true;
      if (this.smokeMesh.instanceColor) {
        this.smokeMesh.instanceColor.clearUpdateRanges();
        this.smokeMesh.instanceColor.addUpdateRange(0, smokeActive * 3);
        this.smokeMesh.instanceColor.needsUpdate = true;
      }
      this.smokeOpacityAttr.clearUpdateRanges();
      this.smokeOpacityAttr.addUpdateRange(0, smokeActive);
      this.smokeOpacityAttr.needsUpdate = true;
    }
    this.prevSmokeActive = smokeActive;
    void this.prevSmokeActive;

    // 2. Update Additive HDR Flash Pool
    let flashActive = 0;
    const flashList = this.flashActiveIdx;
    for (let k = flashList.length - 1; k >= 0; k--) {
      const i = flashList[k];
      const f = this.flashPool[i];
      f.age += stepDt;
      if (!f.active || f.age >= f.maxAge) {
        f.active = false;
        this._listRemove(flashList, this.flashPos, i);
        continue;
      }

      const t = f.age / f.maxAge;
      f.px += f.vx * stepDt;
      f.py += f.vy * stepDt;
      f.pz += f.vz * stepDt;
      f.rot += f.rotSpeed * stepDt;

      const sx = f.startScaleX + (f.endScaleX - f.startScaleX) * t;
      const sy = f.startScaleY + (f.endScaleY - f.startScaleY) * t;
      const fade = (1 - t) * (1 - t);

      if (f.billboard) {
        const c = Math.cos(f.rot);
        const s = Math.sin(f.rot);
        matE[0] = (rx * c + ux * s) * sx;
        matE[1] = (ry * c + uy * s) * sx;
        matE[2] = (rz * c + uz * s) * sx;
        matE[3] = 0;
        matE[4] = (-rx * s + ux * c) * sy;
        matE[5] = (-ry * s + uy * c) * sy;
        matE[6] = (-rz * s + uz * c) * sy;
        matE[7] = 0;
        matE[8] = bx;
        matE[9] = by;
        matE[10] = bz;
        matE[11] = 0;
      } else {
        matE[0] = f.axX * sx;
        matE[1] = f.axY * sx;
        matE[2] = f.axZ * sx;
        matE[3] = 0;
        matE[4] = f.ayX * sy;
        matE[5] = f.ayY * sy;
        matE[6] = f.ayZ * sy;
        matE[7] = 0;
        matE[8] = f.azX;
        matE[9] = f.azY;
        matE[10] = f.azZ;
        matE[11] = 0;
      }
      matE[12] = f.px;
      matE[13] = f.py;
      matE[14] = f.pz;
      matE[15] = 1;

      const outIdx = flashActive++;
      this.flashMesh.setMatrixAt(outIdx, this._mat4);
      this._color.setRGB(f.r * fade, f.g * fade, f.b * fade);
      this.flashMesh.setColorAt(outIdx, this._color);
    }

    if (flashActive === 0) {
      this.flashMesh.visible = false;
    } else {
      this.flashMesh.visible = true;
      this.flashMesh.count = flashActive;
      this.flashMesh.instanceMatrix.clearUpdateRanges();
      this.flashMesh.instanceMatrix.addUpdateRange(0, flashActive * 16);
      this.flashMesh.instanceMatrix.needsUpdate = true;
      if (this.flashMesh.instanceColor) {
        this.flashMesh.instanceColor.clearUpdateRanges();
        this.flashMesh.instanceColor.addUpdateRange(0, flashActive * 3);
        this.flashMesh.instanceColor.needsUpdate = true;
      }
    }
    this.prevFlashActive = flashActive;
    void this.prevFlashActive;

    // 3. Update Velocity-Aligned HDR Spark / Ember Pool
    let sparkActive = 0;
    const sparkList = this.sparkActiveIdx;
    for (let k = sparkList.length - 1; k >= 0; k--) {
      const i = sparkList[k];
      const sp = this.sparkPool[i];
      sp.age += stepDt;
      if (!sp.active || sp.age >= sp.maxAge) {
        sp.active = false;
        this._listRemove(sparkList, this.sparkPos, i);
        continue;
      }

      const damp = Math.exp(-sp.drag * stepDt);
      sp.vx *= damp;
      sp.vy = sp.vy * damp - sp.gravity * stepDt;
      sp.vz *= damp;

      sp.px += sp.vx * stepDt;
      sp.py += sp.vy * stepDt;
      sp.pz += sp.vz * stepDt;

      if (sp.py < sp.floorY && sp.vy < 0) {
        sp.py = sp.floorY;
        sp.vy = -sp.vy * 0.38;
        sp.vx *= 0.65;
        sp.vz *= 0.65;
      }

      const speed = Math.sqrt(sp.vx * sp.vx + sp.vy * sp.vy + sp.vz * sp.vz);
      const invSpeed = speed > 0.001 ? 1 / speed : 0;
      const dirX = invSpeed > 0 ? sp.vx * invSpeed : 0;
      const dirY = invSpeed > 0 ? sp.vy * invSpeed : 1;
      const dirZ = invSpeed > 0 ? sp.vz * invSpeed : 0;

      // Camera-facing ribbon cross axis: normalize(dir x toCam)
      const toCamX = this._camPos.x - sp.px;
      const toCamY = this._camPos.y - sp.py;
      const toCamZ = this._camPos.z - sp.pz;

      let sideX = dirY * toCamZ - dirZ * toCamY;
      let sideY = dirZ * toCamX - dirX * toCamZ;
      let sideZ = dirX * toCamY - dirY * toCamX;
      const sideLen = Math.sqrt(sideX * sideX + sideY * sideY + sideZ * sideZ);
      if (sideLen > 0.0001) {
        const invSide = 1 / sideLen;
        sideX *= invSide;
        sideY *= invSide;
        sideZ *= invSide;
      } else {
        sideX = rx;
        sideY = ry;
        sideZ = rz;
      }

      const normX = sideY * dirZ - sideZ * dirY;
      const normY = sideZ * dirX - sideX * dirZ;
      const normZ = sideX * dirY - sideY * dirX;

      const t = sp.age / sp.maxAge;
      const fade = 1 - t * t;
      const len = (sp.baseLen + speed * sp.stretch) * (0.55 + 0.45 * fade);
      const w = sp.width;

      matE[0] = sideX * w;
      matE[1] = sideY * w;
      matE[2] = sideZ * w;
      matE[3] = 0;
      matE[4] = dirX * len;
      matE[5] = dirY * len;
      matE[6] = dirZ * len;
      matE[7] = 0;
      matE[8] = normX;
      matE[9] = normY;
      matE[10] = normZ;
      matE[11] = 0;
      matE[12] = sp.px;
      matE[13] = sp.py;
      matE[14] = sp.pz;
      matE[15] = 1;

      const cr = (sp.r0 + (sp.r1 - sp.r0) * t) * fade;
      const cg = (sp.g0 + (sp.g1 - sp.g0) * t) * fade;
      const cb = (sp.b0 + (sp.b1 - sp.b0) * t) * fade;

      const outIdx = sparkActive++;
      this.sparkMesh.setMatrixAt(outIdx, this._mat4);
      this._color.setRGB(cr, cg, cb);
      this.sparkMesh.setColorAt(outIdx, this._color);
    }

    if (sparkActive === 0) {
      this.sparkMesh.visible = false;
    } else {
      this.sparkMesh.visible = true;
      this.sparkMesh.count = sparkActive;
      this.sparkMesh.instanceMatrix.clearUpdateRanges();
      this.sparkMesh.instanceMatrix.addUpdateRange(0, sparkActive * 16);
      this.sparkMesh.instanceMatrix.needsUpdate = true;
      if (this.sparkMesh.instanceColor) {
        this.sparkMesh.instanceColor.clearUpdateRanges();
        this.sparkMesh.instanceColor.addUpdateRange(0, sparkActive * 3);
        this.sparkMesh.instanceColor.needsUpdate = true;
      }
    }
    this.prevSparkActive = sparkActive;
    void this.prevSparkActive;

    // 4. Update Ground Shockwave Rings
    let ringActive = 0;
    const ringList = this.ringActiveIdx;
    for (let k = ringList.length - 1; k >= 0; k--) {
      const i = ringList[k];
      const r = this.ringPool[i];
      r.age += stepDt;
      if (!r.active || r.age >= r.maxAge) {
        r.active = false;
        this._listRemove(ringList, this.ringPos, i);
        continue;
      }

      const t = r.age / r.maxAge;
      const ease = 1 - Math.pow(1 - t, 2.4);
      const rad = r.startRadius + (r.endRadius - r.startRadius) * ease;
      const alpha = r.peakAlpha * (1 - t) * (1 - t);

      this._v1.set(r.px, r.py, r.pz);
      this._quat.set(r.qx, r.qy, r.qz, r.qw);
      this._v2.set(rad, 1, rad);
      this._mat4.compose(this._v1, this._quat, this._v2);

      const outIdx = ringActive++;
      this.ringMesh.setMatrixAt(outIdx, this._mat4);
      this._color.setRGB(r.r, r.g, r.b);
      this.ringMesh.setColorAt(outIdx, this._color);
      this.ringOpacityAttr.setX(outIdx, alpha);
    }

    if (ringActive === 0) {
      this.ringMesh.visible = false;
    } else {
      this.ringMesh.visible = true;
      this.ringMesh.count = ringActive;
      this.ringMesh.instanceMatrix.clearUpdateRanges();
      this.ringMesh.instanceMatrix.addUpdateRange(0, ringActive * 16);
      this.ringMesh.instanceMatrix.needsUpdate = true;
      if (this.ringMesh.instanceColor) {
        this.ringMesh.instanceColor.clearUpdateRanges();
        this.ringMesh.instanceColor.addUpdateRange(0, ringActive * 3);
        this.ringMesh.instanceColor.needsUpdate = true;
      }
      this.ringOpacityAttr.clearUpdateRanges();
      this.ringOpacityAttr.addUpdateRange(0, ringActive);
      this.ringOpacityAttr.needsUpdate = true;
    }
    this.prevRingActive = ringActive;
    void this.prevRingActive;

    // 5. Update Dynamic PointLight Pool
    for (let i = 0; i < POINT_LIGHT_POOL_SIZE; i++) {
      const slot = this.lightPool[i];
      if (!slot.active) continue;
      slot.age += stepDt;
      if (slot.age >= slot.maxAge) {
        slot.active = false;
        slot.light.intensity = 0;
        slot.light.position.set(0, -1000, 0);
      } else {
        const t = slot.age / slot.maxAge;
        slot.light.intensity = slot.peakIntensity * (1 - t) * (1 - t);
      }
    }
  }

  public dispose(): void {
    this.scene.remove(this.smokeMesh, this.flashMesh, this.sparkMesh, this.ringMesh, this.scorchMesh);
    for (const slot of this.lightPool) {
      this.scene.remove(slot.light);
      slot.light.dispose();
    }
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
