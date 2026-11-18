import {
  Entity,
  LIGHTFALLOFF_INVERSESQUARED,
  PIXELFORMAT_SRGBA8,
  StandardMaterial,
  Texture,
} from 'playcanvas';
import { getDevice } from './engine/app';
import { plane } from './engine/geometry';
import { enableInstanceColor, InstancedMesh } from './engine/instancing';
import { addShaderHooks, unlit } from './engine/materials';
import { composeMat, Mat4, Quat, quatFromAxisAngle, quatFromUnitVectors, srgb, Vec3 } from './engine/math';

const SMOKE_CAPACITY = 384, FLASH_CAPACITY = 128, SPARK_CAPACITY = 192;
const RING_CAPACITY = 32, SCORCH_CAPACITY = 32, FIRE_CAPACITY = 320;
const POINT_LIGHT_POOL_SIZE = 1, COOKOFF_POOL_SIZE = 6, SHAKE_QUEUE_SIZE = 12;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Smoke {
  active: boolean; age: number; maxAge: number;
  px: number; py: number; pz: number; vx: number; vy: number; vz: number;
  drag: number; buoyancy: number; startScale: number; endScale: number; rot: number; rotSpeed: number;
  r0: number; g0: number; b0: number; rMid: number; gMid: number; bMid: number; midFrac: number;
  r1: number; g1: number; b1: number; peakAlpha: number; fadeInFrac: number;
}
interface Flash {
  active: boolean; age: number; maxAge: number; px: number; py: number; pz: number;
  vx: number; vy: number; vz: number; startScaleX: number; startScaleY: number;
  endScaleX: number; endScaleY: number; rot: number; rotSpeed: number; r: number; g: number; b: number;
}
interface Spark {
  active: boolean; age: number; maxAge: number; px: number; py: number; pz: number;
  vx: number; vy: number; vz: number; drag: number; gravity: number; width: number;
  baseLen: number; stretch: number; floorY: number; r0: number; g0: number; b0: number; r1: number; g1: number; b1: number;
}
interface Ring {
  active: boolean; age: number; maxAge: number; px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number; startRadius: number; endRadius: number;
  r: number; g: number; b: number; peakAlpha: number;
}
interface Fire {
  active: boolean; age: number; maxAge: number; px: number; py: number; pz: number;
  vx: number; vy: number; vz: number; s0: number; s1: number; seed: number;
  r0: number; g0: number; b0: number; r1: number; g1: number; b1: number; alpha0: number;
}
interface PooledLight { light: Entity; active: boolean; age: number; maxAge: number; peakIntensity: number }
interface CookoffSite { active: boolean; x: number; y: number; z: number; age: number; duration: number; emitAccum: number }
interface ShakeImpulse { x: number; y: number; z: number; strength: number }

function texture(kind: 'smoke' | 'flash' | 'streak' | 'ring' | 'scorch'): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  if (kind === 'streak') {
    const g = ctx.createLinearGradient(0, 0, 128, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'white'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 48, 128, 32);
  } else if (kind === 'flash') {
    ctx.translate(64, 64);
    for (let i = 0; i < 8; i++) {
      ctx.rotate(Math.PI / 4);
      const g = ctx.createLinearGradient(0, 0, 62, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(62, 0); ctx.lineTo(0, 5); ctx.fill();
    }
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 26);
    core.addColorStop(0, 'white'); core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core; ctx.fillRect(-26, -26, 52, 52);
  } else {
    const g = ctx.createRadialGradient(64, 64, kind === 'ring' ? 40 : 0, 64, 64, 63);
    if (kind === 'ring') {
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.68, 'rgba(255,255,255,0.85)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    } else if (kind === 'scorch') {
      g.addColorStop(0, 'rgba(20,15,10,0.9)'); g.addColorStop(0.6, 'rgba(25,18,12,0.65)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    } else {
      g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(0.45, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    }
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new Texture(getDevice(), { width: 128, height: 128, format: PIXELFORMAT_SRGBA8, mipmaps: true });
  tex.setSource(canvas);
  return tex;
}

function batchMaterial(tex: Texture | null, additive: boolean): StandardMaterial {
  const mat = unlit({ map: tex, transparent: true, depthWrite: false, additive, doubleSided: true });
  enableInstanceColor(mat);
  addShaderHooks(mat, {
    vsDecl: '#ifdef INSTANCING\nattribute float instanceOpacity;\nvarying float vInstOpacity;\n#endif',
    vsMainEnd: '#ifdef INSTANCING\nvInstOpacity = instanceOpacity;\n#endif',
    psDecl: '#ifdef INSTANCING\nvarying float vInstOpacity;\n#endif',
    opacity: '#ifdef INSTANCING\ndAlpha *= vInstOpacity;\n#endif',
  });
  return mat;
}

export class EffectsManager {
  private readonly scene: Entity;
  private readonly textures: Texture[] = [];
  private readonly materials: StandardMaterial[] = [];
  private readonly smokeMesh: InstancedMesh;
  private readonly flashMesh: InstancedMesh;
  private readonly sparkMesh: InstancedMesh;
  private readonly ringMesh: InstancedMesh;
  private readonly fireMesh: InstancedMesh;
  private readonly scorchMesh: InstancedMesh;
  private readonly smokePool: Smoke[] = [];
  private readonly flashPool: Flash[] = [];
  private readonly sparkPool: Spark[] = [];
  private readonly ringPool: Ring[] = [];
  private readonly firePool: Fire[] = [];
  private readonly smokeActive: number[] = [];
  private readonly flashActive: number[] = [];
  private readonly sparkActive: number[] = [];
  private readonly ringActive: number[] = [];
  private readonly fireActive: number[] = [];
  private smokeCursor = 0;
  private flashCursor = 0;
  private sparkCursor = 0;
  private ringCursor = 0;
  private fireCursor = 0;
  private scorchCursor = 0;
  private readonly lightPool: PooledLight[] = [];
  private readonly cookoffSites: CookoffSite[] = [];
  private cookoffCursor = 0;
  private readonly shakeQueue: ShakeImpulse[] = [];
  private shakeCount = 0;
  private readonly _mat = new Mat4();
  private readonly _pos = new Vec3();
  private readonly _scale = new Vec3(1, 1, 1);
  private readonly _quat = new Quat();
  private readonly _v1 = new Vec3();
  private readonly _v2 = new Vec3();
  private readonly _v3 = new Vec3();
  private readonly _camRight = new Vec3();
  private readonly _camUp = new Vec3();
  private readonly _camBack = new Vec3();
  private readonly _camPos = new Vec3();
  private readonly _up = new Vec3(0, 1, 0);
  private fireTime = 0;

  constructor(scene: Entity) {
    this.scene = scene;
    const smokeTex = texture('smoke'), flashTex = texture('flash'), streakTex = texture('streak');
    const ringTex = texture('ring'), scorchTex = texture('scorch');
    this.textures.push(smokeTex, flashTex, streakTex, ringTex, scorchTex);
    this.smokeMesh = this.makeBatch('fx_smoke_instanced', smokeTex, SMOKE_CAPACITY, false);
    this.flashMesh = this.makeBatch('fx_flash_instanced', flashTex, FLASH_CAPACITY, true);
    this.sparkMesh = this.makeBatch('fx_spark_instanced', streakTex, SPARK_CAPACITY, true);
    this.ringMesh = this.makeBatch('fx_ring_instanced', ringTex, RING_CAPACITY, false);
    this.fireMesh = this.makeBatch('fx_fire_instanced', null, FIRE_CAPACITY, true, true);
    this.scorchMesh = this.makeBatch('fx_scorch_instanced', scorchTex, SCORCH_CAPACITY, false);
    this.scorchMesh.count = SCORCH_CAPACITY;
    for (let i = 0; i < SCORCH_CAPACITY; i++) {
      this.scorchMesh.setMatrixAt(i, new Mat4().setScale(0, 0, 0));
      this.scorchMesh.setColorAt(i, 1, 1, 1);
      this.scorchMesh.setAttributeAt(i, 'instanceOpacity', 0);
    }
    this.scorchMesh.update();

    for (let i = 0; i < SMOKE_CAPACITY; i++) this.smokePool.push({ active: false, age: 0, maxAge: 1,
      px: 0, py: -1000, pz: 0, vx: 0, vy: 0, vz: 0, drag: 1, buoyancy: 0, startScale: 1, endScale: 2,
      rot: 0, rotSpeed: 0, r0: 1, g0: 1, b0: 1, rMid: 1, gMid: 1, bMid: 1, midFrac: 0.3,
      r1: 1, g1: 1, b1: 1, peakAlpha: 0.5, fadeInFrac: 0.1 });
    for (let i = 0; i < FLASH_CAPACITY; i++) this.flashPool.push({ active: false, age: 0, maxAge: 0.1,
      px: 0, py: -1000, pz: 0, vx: 0, vy: 0, vz: 0, startScaleX: 1, startScaleY: 1, endScaleX: 1,
      endScaleY: 1, rot: 0, rotSpeed: 0, r: 4, g: 3, b: 1 });
    for (let i = 0; i < SPARK_CAPACITY; i++) this.sparkPool.push({ active: false, age: 0, maxAge: 0.5,
      px: 0, py: -1000, pz: 0, vx: 0, vy: 0, vz: 0, drag: 1.2, gravity: 9.81, width: 0.1,
      baseLen: 0.25, stretch: 0.045, floorY: -999, r0: 6, g0: 4, b0: 1.5, r1: 3, g1: 0.7, b1: 0.1 });
    for (let i = 0; i < RING_CAPACITY; i++) this.ringPool.push({ active: false, age: 0, maxAge: 0.4,
      px: 0, py: -1000, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, startRadius: 0.5, endRadius: 6,
      r: 1, g: 1, b: 1, peakAlpha: 0.65 });
    for (let i = 0; i < FIRE_CAPACITY; i++) this.firePool.push({ active: false, age: 0, maxAge: 0.6,
      px: 0, py: -1000, pz: 0, vx: 0, vy: 0, vz: 0, s0: 0.4, s1: 1, seed: Math.random() * 100,
      r0: 2, g0: 1.4, b0: 0.5, r1: 0.6, g1: 0.1, b1: 0.02, alpha0: 0.9 });
    for (let i = 0; i < POINT_LIGHT_POOL_SIZE; i++) {
      const light = new Entity(`fx_light_${i}`);
      light.addComponent('light', { type: 'omni', color: srgb(0xffa448), intensity: 0, range: 36,
        falloffMode: LIGHTFALLOFF_INVERSESQUARED, castShadows: false });
      light.setPosition(0, -1000, 0);
      scene.addChild(light);
      this.lightPool.push({ light, active: false, age: 0, maxAge: 0.12, peakIntensity: 0 });
    }
    for (let i = 0; i < COOKOFF_POOL_SIZE; i++) this.cookoffSites.push({ active: false, x: 0, y: 0, z: 0, age: 0, duration: 2.5, emitAccum: 0 });
    for (let i = 0; i < SHAKE_QUEUE_SIZE; i++) this.shakeQueue.push({ x: 0, y: 0, z: 0, strength: 0 });
  }

  private makeBatch(name: string, tex: Texture | null, capacity: number, additive: boolean, fire = false): InstancedMesh {
    const mat = batchMaterial(tex, additive);
    if (fire) {
      addShaderHooks(mat, {
        vsDecl: '#ifdef INSTANCING\nattribute float aSeed;\nvarying float vFireSeed;\nvarying vec2 vFireUv;\n#endif',
        vsMainEnd: '#ifdef INSTANCING\nvFireSeed = aSeed;\nvFireUv = vertex_position.xy + 0.5;\n#endif',
        psDecl: `#ifdef INSTANCING
          varying float vFireSeed;
          varying vec2 vFireUv;
          #endif
          uniform float uTime;
          float fireHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float fireNoise(vec2 p) {
            vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
            return mix(mix(fireHash(i), fireHash(i + vec2(1.0, 0.0)), u.x), mix(fireHash(i + vec2(0.0, 1.0)), fireHash(i + vec2(1.0, 1.0)), u.x), u.y);
          }`,
        emission: `
          #ifdef INSTANCING
          vec2 fc = vFireUv - 0.5;
          float fn = fireNoise(vFireUv * 7.0 + vec2(vFireSeed, -uTime * 2.4)) * 0.65 + fireNoise(vFireUv * 15.0 - uTime) * 0.35;
          float fd = length(fc) * 2.0;
          float fmask = pow(1.0 - smoothstep(0.22, 0.62, fd + (fn - 0.5) * 0.9), 1.6);
          dEmission *= (0.4 + 1.4 * fn) * (0.75 + 0.9 * (1.0 - smoothstep(0.0, 0.5, fd)));
          #endif`,
        opacity: '#ifdef INSTANCING\ndAlpha *= vInstOpacity * pow(1.0 - smoothstep(0.22, 0.62, length(vFireUv - 0.5) * 2.0 + (fireNoise(vFireUv * 7.0 + vec2(vFireSeed, -uTime * 2.4)) - 0.5) * 0.9), 1.6);\n#endif',
      });
    }
    this.materials.push(mat);
    const mesh = new InstancedMesh(plane(1, 1), mat, capacity, {
      name, parent: this.scene, color: true, attributes: [{ name: 'instanceOpacity', components: 1 }, ...(fire ? [{ name: 'aSeed', components: 1 as const }] : [])],
      castShadows: false, receiveShadows: false,
    });
    mesh.meshInstance.cull = false;
    mesh.count = 0;
    mesh.update();
    return mesh;
  }

  private alloc<T extends { active: boolean }>(pool: T[], active: number[], cursorKey: 'smokeCursor' | 'flashCursor' | 'sparkCursor' | 'ringCursor' | 'fireCursor'): T {
    let idx = -1;
    for (let n = 0; n < pool.length; n++) {
      const i = (this[cursorKey] + n) % pool.length;
      if (!pool[i].active) { idx = i; break; }
    }
    if (idx < 0) idx = this[cursorKey];
    this[cursorKey] = (idx + 1) % pool.length;
    if (!pool[idx].active) active.push(idx);
    pool[idx].active = true;
    return pool[idx];
  }

  private smoke(): Smoke { return this.alloc(this.smokePool, this.smokeActive, 'smokeCursor'); }
  private flash(): Flash { return this.alloc(this.flashPool, this.flashActive, 'flashCursor'); }
  private spark(): Spark { return this.alloc(this.sparkPool, this.sparkActive, 'sparkCursor'); }
  private ring(): Ring { return this.alloc(this.ringPool, this.ringActive, 'ringCursor'); }
  private fire(): Fire { return this.alloc(this.firePool, this.fireActive, 'fireCursor'); }

  private spawnLight(x: number, y: number, z: number, hex: number, intensity: number, range: number, duration: number): void {
    const slot = this.lightPool[0];
    slot.active = true; slot.age = 0; slot.maxAge = duration; slot.peakIntensity = intensity / Math.PI;
    slot.light.light!.color = srgb(hex);
    slot.light.light!.range = range;
    slot.light.light!.intensity = slot.peakIntensity;
    slot.light.setPosition(x, y, z);
  }

  private pushShake(x: number, y: number, z: number, strength: number): void {
    const idx = this.shakeCount < SHAKE_QUEUE_SIZE ? this.shakeCount++ : SHAKE_QUEUE_SIZE - 1;
    Object.assign(this.shakeQueue[idx], { x, y, z, strength });
  }

  private scorch(pos: Vec3, normal: Vec3, radius: number, opacity: number): void {
    const idx = this.scorchCursor;
    this.scorchCursor = (this.scorchCursor + 1) % SCORCH_CAPACITY;
    quatFromUnitVectors(this._quat, this._up, this._v1.copy(normal).normalize());
    this._quat.mul(quatFromAxisAngle(new Quat(), this._v1, Math.random() * Math.PI * 2));
    this._pos.copy(pos).addScaled(this._v1, 0.04);
    this._scale.set(radius, 1, radius);
    this.scorchMesh.setMatrixAt(idx, composeMat(this._mat, this._pos, this._quat, this._scale));
    this.scorchMesh.setColorAt(idx, 1, 1, 1);
    this.scorchMesh.setAttributeAt(idx, 'instanceOpacity', opacity);
    this.scorchMesh.update();
  }

  public spawnMuzzleFlash(pos: Vec3, dir: Vec3, scale = 1): void {
    const d = this._v1.copy(dir).normalize();
    const f = this.flash();
    Object.assign(f, { age: 0, maxAge: 0.075, px: pos.x + d.x * 0.35 * scale, py: pos.y + d.y * 0.35 * scale,
      pz: pos.z + d.z * 0.35 * scale, vx: d.x * 4, vy: d.y * 4, vz: d.z * 4,
      startScaleX: 2.6 * scale, startScaleY: 2.6 * scale, endScaleX: 4.2 * scale, endScaleY: 4.2 * scale,
      rot: Math.random() * 6.28, rotSpeed: 0, r: 9, g: 5.5, b: 1.6 });
    for (let i = 0; i < 8; i++) {
      const p = this.smoke(), a = Math.random() * Math.PI * 2, speed = rand(2, 6) * scale;
      Object.assign(p, { age: 0, maxAge: rand(0.45, 0.9), px: pos.x, py: pos.y, pz: pos.z,
        vx: Math.cos(a) * speed + d.x * 4, vy: rand(0.4, 2.2), vz: Math.sin(a) * speed + d.z * 4,
        drag: 2.5, buoyancy: 0.8, startScale: 0.3 * scale, endScale: 1.8 * scale,
        rot: a, rotSpeed: rand(-2, 2), r0: 0.75, g0: 0.67, b0: 0.51, rMid: 0.35, gMid: 0.32, bMid: 0.28,
        midFrac: 0.3, r1: 0.2, g1: 0.2, b1: 0.19, peakAlpha: 0.36, fadeInFrac: 0.08 });
    }
    this.spawnLight(pos.x, pos.y + 0.4, pos.z, 0xffb45c, 22 * scale, 24 * scale, 0.12);
    this.pushShake(pos.x, pos.y, pos.z, 0.18 * scale);
  }

  public spawnMGFlash(pos: Vec3, dir: Vec3): void {
    const f = this.flash();
    Object.assign(f, { age: 0, maxAge: 0.045, px: pos.x, py: pos.y, pz: pos.z,
      vx: dir.x, vy: dir.y, vz: dir.z, startScaleX: 0.7, startScaleY: 0.7, endScaleX: 1.3, endScaleY: 1.3,
      rot: Math.random() * 6.28, rotSpeed: 0, r: 7, g: 4.5, b: 1.4 });
  }

  public explosionsSpawned = 0;
  public spawnExplosion(pos: Vec3, normal: Vec3, scale: number, kind: 'he_ground' | 'he_armor' | 'tank_kill'): void {
    this.explosionsSpawned++;
    const n = this._v1.copy(normal).lengthSq() > 0.001 ? this._v1.normalize() : this._v1.set(0, 1, 0);
    const kill = kind === 'tank_kill', ground = kind === 'he_ground', s = Math.max(0.4, scale) * (kill ? 1.45 : 1);
    let groundY = pos.y;
    if (kill && this.groundProbe) groundY = Math.min(groundY, this.groundProbe(pos.x, pos.z));
    for (let j = 0; j < 2; j++) {
      const f = this.flash();
      Object.assign(f, { age: 0, maxAge: j ? 0.32 : kill ? 0.18 : 0.14,
        px: pos.x + n.x * 0.35, py: pos.y + n.y * 0.35 + (j ? 0.8 * s : 0.25), pz: pos.z + n.z * 0.35,
        vx: 0, vy: j ? 3 : 1.5, vz: 0, startScaleX: (j ? 2.2 : 3.8) * s, startScaleY: (j ? 2.2 : 3.8) * s,
        endScaleX: (j ? 6 : 9.2) * s, endScaleY: (j ? 6 : 9.2) * s, rot: Math.random() * 6.28,
        rotSpeed: j ? 0.6 : 0, r: kill ? 4.4 : 9, g: kill ? 2.5 : 5.6, b: kill ? 0.85 : 2 });
    }
    const fireballs = kill ? 20 : 12;
    for (let i = 0; i < fireballs; i++) {
      const p = this.smoke(), core = i < fireballs * 0.55, a = Math.random() * Math.PI * 2, r = rand(0.1, 1.3) * s;
      Object.assign(p, { age: 0, maxAge: core ? rand(1.4, 2.4) : rand(2.2, 3.8),
        px: pos.x + Math.cos(a) * r, py: pos.y + rand(0.15, 1.1) * s, pz: pos.z + Math.sin(a) * r,
        vx: Math.cos(a) * rand(2.5, 9.5) * s + n.x * 3, vy: rand(4, 11.5) * s + n.y * 3.5,
        vz: Math.sin(a) * rand(2.5, 9.5) * s + n.z * 3, drag: 2.3, buoyancy: rand(2.2, 4),
        startScale: rand(1.3, 2.3) * s, endScale: rand(4.8, 8.2) * s, rot: a, rotSpeed: rand(-1.3, 1.3),
        r0: core ? kill ? 4.4 : 6.5 : ground ? 0.52 : 1.8, g0: core ? kill ? 2.5 : 3.4 : ground ? 0.42 : 0.75,
        b0: core ? kill ? 0.62 : 0.85 : ground ? 0.30 : 0.22,
        rMid: core ? 2.8 : ground ? 0.28 : 0.14, gMid: core ? 0.72 : ground ? 0.24 : 0.13,
        bMid: core ? 0.10 : ground ? 0.19 : 0.12, midFrac: core ? 0.20 : 0.22,
        r1: ground ? 0.22 : 0.085, g1: ground ? 0.19 : 0.08, b1: ground ? 0.16 : 0.078,
        peakAlpha: core ? 0.86 : 0.72, fadeInFrac: 0.05 });
    }
    const sparkCount = kill ? 44 : 26;
    for (let i = 0; i < sparkCount; i++) {
      const p = this.spark(), a = Math.random() * Math.PI * 2, elev = rand(0.18, 1.32), speed = rand(14, kill ? 38 : 29) * Math.sqrt(scale);
      Object.assign(p, { age: 0, maxAge: rand(0.35, kill ? 1.35 : 0.88), px: pos.x, py: pos.y + 0.25, pz: pos.z,
        vx: Math.cos(a) * Math.cos(elev) * speed + n.x * 5, vy: Math.sin(elev) * speed + n.y * 5,
        vz: Math.sin(a) * Math.cos(elev) * speed + n.z * 5, drag: 0.85, gravity: 12.5,
        width: kill ? rand(0.045, 0.085) : rand(0.08, 0.16), baseLen: kill ? rand(0.13, 0.28) : rand(0.28, 0.55),
        stretch: kill ? 0.02 : 0.048, floorY: ground ? pos.y + 0.05 : -999,
        r0: kill ? 5.2 : 8, g0: kill ? 3 : 5, b0: kill ? 0.9 : 1.6, r1: kill ? 2.4 : 3.8, g1: kill ? 0.5 : 0.75, b1: 0.08 });
    }
    quatFromUnitVectors(this._quat, this._up, n);
    const r = this.ring();
    Object.assign(r, { age: 0, maxAge: kill ? 0.52 : 0.38, px: pos.x + n.x * 0.09,
      py: (kill ? groundY : pos.y) + n.y * 0.09 + 0.05, pz: pos.z + n.z * 0.09,
      qx: kill ? 0 : this._quat.x, qy: kill ? 0 : this._quat.y, qz: kill ? 0 : this._quat.z, qw: kill ? 1 : this._quat.w,
      startRadius: 0.9 * s, endRadius: (kill ? 15.5 : 9.8) * scale,
      r: kill ? 3.2 : 1.8, g: kill ? 1.6 : 1.35, b: kill ? 0.6 : 0.95, peakAlpha: 0.68 });
    if (ground || kill || n.y > 0.55) {
      this._v2.set(pos.x, kill ? groundY + 0.03 : pos.y, pos.z);
      this.scorch(kill ? this._v2 : pos, kill ? this._up : n, (kill ? 4.6 : 3.1) * scale, kill ? 0.92 : 0.82);
    }
    this.spawnLight(pos.x + n.x * 0.6, pos.y + 1.2, pos.z + n.z * 0.6, kill ? 0xff8828 : 0xff9e3d,
      (kill ? 56 : 36) * scale, (kill ? 48 : 38) * scale, kill ? 0.52 : 0.30);
    if (kill) {
      const site = this.cookoffSites[this.cookoffCursor];
      this.cookoffCursor = (this.cookoffCursor + 1) % COOKOFF_POOL_SIZE;
      Object.assign(site, { active: true, x: pos.x, y: pos.y + 0.8, z: pos.z, age: 0, duration: 2.8, emitAccum: 0 });
    }
    this.pushShake(pos.x, pos.y, pos.z, (kill ? 0.95 : kind === 'he_armor' ? 0.55 : 0.48) * scale);
  }

  public spawnSparkImpact(pos: Vec3, normal: Vec3, isArmor: boolean): void {
    const n = this._v1.copy(normal).lengthSq() > 0.001 ? this._v1.normalize() : this._v1.set(0, 1, 0);
    if (isArmor) {
      const f = this.flash();
      Object.assign(f, { age: 0, maxAge: 0.055, px: pos.x, py: pos.y, pz: pos.z, vx: 0, vy: 0, vz: 0,
        startScaleX: 0.55, startScaleY: 0.55, endScaleX: 1.15, endScaleY: 1.15, rot: 0, rotSpeed: 0, r: 7.5, g: 4.6, b: 1.5 });
    }
    for (let i = 0; i < (isArmor ? 9 : 3); i++) {
      const p = this.spark(), speed = rand(8, 21);
      Object.assign(p, { age: 0, maxAge: rand(0.16, 0.42), px: pos.x, py: pos.y, pz: pos.z,
        vx: n.x * speed + rand(-7, 7), vy: n.y * speed + rand(1, 8), vz: n.z * speed + rand(-7, 7),
        drag: 1.4, gravity: 13.5, width: 0.055, baseLen: 0.16, stretch: 0.038, floorY: isArmor ? -999 : pos.y + 0.02,
        r0: 8, g0: 5.2, b0: 1.9, r1: 4.2, g1: 1.1, b1: 0.15 });
    }
    const p = this.smoke();
    Object.assign(p, { age: 0, maxAge: rand(0.35, 0.58), px: pos.x, py: pos.y, pz: pos.z,
      vx: n.x * 2.4, vy: n.y * 2.4 + 0.9, vz: n.z * 2.4, drag: 3.2, buoyancy: isArmor ? 1 : -2.2,
      startScale: 0.3, endScale: 1.4, rot: Math.random() * 6.28, rotSpeed: rand(-1.5, 1.5),
      r0: 0.65, g0: 0.60, b0: 0.50, rMid: 0.45, gMid: 0.40, bMid: 0.32, midFrac: 0.35,
      r1: 0.35, g1: 0.31, b1: 0.25, peakAlpha: 0.36, fadeInFrac: 0.08 });
  }

  public spawnTrackDust(pos: Vec3, intensity01: number): void {
    const k = Math.max(0, Math.min(1, intensity01));
    if (k < 0.04) return;
    const p = this.smoke();
    Object.assign(p, { age: 0, maxAge: rand(0.65, 1.25) * (0.7 + 0.5 * k), px: pos.x + rand(-0.28, 0.28), py: pos.y + 0.22,
      pz: pos.z + rand(-0.28, 0.28), vx: rand(-0.9, 0.9), vy: rand(0.6, 1.65) * (0.5 + 0.7 * k), vz: rand(-0.9, 0.9),
      drag: 2.2, buoyancy: 0.35, startScale: rand(0.45, 0.78) * (0.65 + 0.55 * k),
      endScale: rand(1.8, 3.1) * (0.65 + 0.6 * k), rot: Math.random() * 6.28, rotSpeed: rand(-1.1, 1.1),
      r0: 0.54, g0: 0.46, b0: 0.34, rMid: 0.48, gMid: 0.41, bMid: 0.31, midFrac: 0.45,
      r1: 0.43, g1: 0.38, b1: 0.29, peakAlpha: 0.28 * k, fadeInFrac: 0.14 });
  }

  public spawnWaterWake(pos: Vec3, intensity01: number): void {
    const k = Math.max(0, Math.min(1, intensity01));
    if (k < 0.05) return;
    for (let i = 0; i < 2; i++) {
      const p = this.smoke();
      Object.assign(p, { age: 0, maxAge: rand(0.4, 0.75), px: pos.x + rand(-0.5, 0.5), py: pos.y + rand(0, 0.25), pz: pos.z + rand(-0.5, 0.5),
        vx: rand(-1.6, 1.6), vy: rand(1.6, 3.8) * (0.5 + 0.6 * k), vz: rand(-1.6, 1.6), drag: 2.6, buoyancy: 1.4,
        startScale: rand(0.3, 0.55), endScale: rand(1, 1.8), rot: Math.random() * 6.28, rotSpeed: rand(-1.6, 1.6),
        r0: 0.72, g0: 0.82, b0: 0.86, rMid: 0.55, gMid: 0.68, bMid: 0.72, midFrac: 0.4,
        r1: 0.40, g1: 0.52, b1: 0.58, peakAlpha: 0.4 * k, fadeInFrac: 0.1 });
    }
  }

  public spawnWaterSplash(pos: Vec3, scale = 1): void {
    const s = Math.max(0.4, scale);
    for (let i = 0; i < Math.round(9 * s) + 4; i++) {
      const p = this.smoke(), a = Math.random() * Math.PI * 2;
      Object.assign(p, { age: 0, maxAge: rand(0.5, 0.95), px: pos.x + rand(-0.5, 0.5) * s, py: pos.y + rand(0, 0.4), pz: pos.z + rand(-0.5, 0.5) * s,
        vx: Math.cos(a) * rand(0.8, 4.2) * s, vy: rand(3.5, 8.5) * s, vz: Math.sin(a) * rand(0.8, 4.2) * s,
        drag: 1.9, buoyancy: 2.2, startScale: rand(0.45, 0.85) * s, endScale: rand(1.5, 2.7) * s,
        rot: a, rotSpeed: rand(-1.4, 1.4), r0: 0.80, g0: 0.88, b0: 0.92, rMid: 0.60, gMid: 0.72, bMid: 0.78,
        midFrac: 0.4, r1: 0.4, g1: 0.52, b1: 0.58, peakAlpha: 0.55, fadeInFrac: 0.08 });
    }
  }

  public spawnRocketTrail(pos: Vec3, scaleMul = 1, bright = 0): void {
    const p = this.smoke();
    Object.assign(p, { age: 0, maxAge: rand(0.45, 0.8), px: pos.x, py: pos.y, pz: pos.z,
      vx: rand(-0.25, 0.25), vy: rand(0.2, 0.8), vz: rand(-0.25, 0.25), drag: 1.2, buoyancy: 0.3,
      startScale: 0.28 * scaleMul, endScale: 1.3 * scaleMul, rot: Math.random() * 6.28, rotSpeed: rand(-1.5, 1.5),
      r0: 0.55 + bright * 0.4, g0: 0.50 + bright * 0.4, b0: 0.44 + bright * 0.4,
      rMid: 0.28, gMid: 0.27, bMid: 0.25, midFrac: 0.35, r1: 0.18, g1: 0.18, b1: 0.17,
      peakAlpha: 0.42, fadeInFrac: 0.08 });
  }

  public spawnRocketBackblast(pos: Vec3, launchDir: Vec3): void {
    for (let i = 0; i < 7; i++) {
      const p = this.smoke(), d = this._v2.copy(launchDir).normalize();
      Object.assign(p, { age: 0, maxAge: rand(0.5, 1.1), px: pos.x, py: pos.y, pz: pos.z,
        vx: -d.x * rand(3, 8) + rand(-1, 1), vy: rand(0.2, 1.5), vz: -d.z * rand(3, 8) + rand(-1, 1),
        drag: 2.2, buoyancy: 0.5, startScale: 0.4, endScale: 2.1, rot: Math.random() * 6.28, rotSpeed: rand(-1.5, 1.5),
        r0: 0.72, g0: 0.70, b0: 0.66, rMid: 0.55, gMid: 0.54, bMid: 0.52, midFrac: 0.35,
        r1: 0.45, g1: 0.45, b1: 0.44, peakAlpha: 0.22, fadeInFrac: 0.08 });
    }
  }

  public spawnWreckFire(x: number, y: number, z: number, scale = 1): void {
    if (!this.wreckFxVisible) return;
    const f = this.fire();
    Object.assign(f, { age: 0, maxAge: rand(0.35, 0.7), px: x + rand(-0.22, 0.22) * scale,
      py: y + rand(-0.08, 0.15) * scale, pz: z + rand(-0.22, 0.22) * scale,
      vx: rand(-0.5, 0.5), vy: rand(0.9, 2) * scale, vz: rand(-0.5, 0.5),
      s0: rand(0.18, 0.32) * scale, s1: rand(0.5, 0.9) * scale, seed: Math.random() * 100,
      r0: 2, g0: 1.4, b0: 0.5, r1: 0.6, g1: 0.1, b1: 0.02, alpha0: rand(0.65, 0.95) });
    this.fireMesh.setAttributeAt(this.fireActive[this.fireActive.length - 1], 'aSeed', f.seed);
  }

  public spawnEmbers(x: number, y: number, z: number, count: number): void {
    if (!this.wreckFxVisible) return;
    for (let i = 0; i < count; i++) {
      const p = this.spark();
      Object.assign(p, { age: 0, maxAge: rand(0.5, 1.4), px: x + rand(-0.7, 0.7), py: y + rand(0, 0.5), pz: z + rand(-0.7, 0.7),
        vx: rand(-1.6, 1.6), vy: rand(2.5, 7), vz: rand(-1.6, 1.6), drag: 0.7, gravity: 6.5,
        width: 0.05, baseLen: 0.15, stretch: 0.035, floorY: -999, r0: 7, g0: 3.4, b0: 0.9, r1: 2.6, g1: 0.45, b1: 0.04 });
    }
  }

  public groundProbe: ((x: number, z: number) => number) | null = null;
  public wreckFxVisible = true;
  public setWreckFxVisible(v: boolean): void {
    this.wreckFxVisible = v;
    if (v) return;
    for (const p of this.firePool) p.active = false;
    for (const p of this.smokePool) p.active = false;
    for (const p of this.sparkPool) p.active = false;
    for (const p of this.flashPool) p.active = false;
    this.fireActive.length = this.smokeActive.length = this.sparkActive.length = this.flashActive.length = 0;
    this.fireMesh.count = this.smokeMesh.count = this.sparkMesh.count = this.flashMesh.count = 0;
    this.fireMesh.update(); this.smokeMesh.update(); this.sparkMesh.update(); this.flashMesh.update();
  }

  public spawnWreckSmoke(pos: Vec3): void {
    if (!this.wreckFxVisible) return;
    const p = this.smoke();
    Object.assign(p, { age: 0, maxAge: rand(4.5, 7), px: pos.x + rand(-0.9, 0.9), py: pos.y + rand(0.4, 1.4), pz: pos.z + rand(-0.9, 0.9),
      vx: rand(-0.3, 1.7), vy: rand(3.2, 5.2), vz: rand(-0.3, 1.3), drag: 0.5, buoyancy: 1.05,
      startScale: rand(2.4, 3.4), endScale: rand(9, 13), rot: Math.random() * 6.28, rotSpeed: rand(-0.85, 0.85),
      r0: 2.6, g0: 0.85, b0: 0.14, rMid: 0.11, gMid: 0.10, bMid: 0.095, midFrac: 0.16,
      r1: 0.065, g1: 0.065, b1: 0.07, peakAlpha: 0.8, fadeInFrac: 0.12 });
    const f = this.flash();
    Object.assign(f, { age: 0, maxAge: rand(0.18, 0.34), px: pos.x, py: pos.y + 0.8, pz: pos.z,
      vx: rand(-0.4, 0.4), vy: rand(1.2, 2.4), vz: rand(-0.4, 0.4), startScaleX: 0.7, startScaleY: 0.8,
      endScaleX: 0.5, endScaleY: 1.2, rot: Math.random() * 6.28, rotSpeed: rand(-2, 2), r: 4.5, g: 1.65, b: 0.25 });
  }

  public consumeCameraShake(listenerPos: Vec3): number {
    if (!this.shakeCount) return 0;
    let total = 0;
    for (let i = 0; i < this.shakeCount; i++) {
      const e = this.shakeQueue[i], dx = e.x - listenerPos.x, dy = e.y - listenerPos.y, dz = e.z - listenerPos.z;
      total += e.strength / (1 + (dx * dx + dy * dy + dz * dz) / (35 * 35));
    }
    this.shakeCount = 0;
    return Math.min(total, 1.5);
  }

  public update(dt: number, camera: Entity): void {
    const step = Math.min(Math.max(dt, 0), 0.08);
    if (!step) return;
    this.fireTime += step;
    this.materials.forEach((m) => m.setParameter('uTime', this.fireTime));
    this._camRight.copy(camera.right);
    this._camUp.copy(camera.up);
    this._camBack.copy(camera.forward);
    this._camPos.copy(camera.getPosition());

    for (const site of this.cookoffSites) {
      if (!site.active) continue;
      site.age += step;
      if (site.age >= site.duration) { site.active = false; continue; }
      site.emitAccum += step;
      while (site.emitAccum >= 0.13) {
        site.emitAccum -= 0.13;
        this._v1.set(site.x, site.y, site.z);
        if (this.wreckFxVisible) this.spawnWreckSmoke(this._v1);
      }
    }

    let out = 0;
    for (let k = this.fireActive.length - 1; k >= 0; k--) {
      const i = this.fireActive[k], p = this.firePool[i];
      p.age += step;
      if (p.age >= p.maxAge) { p.active = false; this.fireActive.splice(k, 1); continue; }
      const t = p.age / p.maxAge, damp = Math.exp(-1.6 * step);
      p.vx *= damp; p.vy *= damp; p.vz *= damp;
      p.px += p.vx * step; p.py += p.vy * step; p.pz += p.vz * step;
      const scale = (p.s0 + (p.s1 - p.s0) * (1 - (1 - t) ** 2)) * Math.min(1, t * 5) * (1 - t * t * 0.55);
      const fade = (t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88) * (1 - t * 0.4);
      this.billboard(p.px, p.py, p.pz, scale, scale, 0);
      const outIdx = out++;
      this.fireMesh.setMatrixAt(outIdx, this._mat);
      this.fireMesh.setColorAt(outIdx, p.r0 + (p.r1 - p.r0) * t, p.g0 + (p.g1 - p.g0) * t, p.b0 + (p.b1 - p.b0) * t);
      this.fireMesh.setAttributeAt(outIdx, 'instanceOpacity', Math.max(0, p.alpha0 * fade));
      this.fireMesh.setAttributeAt(outIdx, 'aSeed', p.seed);
    }
    this.fireMesh.count = out; this.fireMesh.update();

    out = 0;
    for (let k = this.smokeActive.length - 1; k >= 0; k--) {
      const i = this.smokeActive[k], p = this.smokePool[i];
      p.age += step;
      if (p.age >= p.maxAge) { p.active = false; this.smokeActive.splice(k, 1); continue; }
      const t = p.age / p.maxAge, damp = Math.exp(-p.drag * step);
      p.vx *= damp; p.vy = p.vy * damp + p.buoyancy * step; p.vz *= damp;
      p.px += p.vx * step; p.py += p.vy * step; p.pz += p.vz * step; p.rot += p.rotSpeed * step;
      const scale = p.startScale + (p.endScale - p.startScale) * (1 - (1 - t) ** 2);
      const alpha = t < p.fadeInFrac ? p.peakAlpha * t / Math.max(0.001, p.fadeInFrac)
        : p.peakAlpha * (1 - (t - p.fadeInFrac) / Math.max(0.001, 1 - p.fadeInFrac)) * (1 - t * 0.65);
      let cr: number, cg: number, cb: number;
      if (t < p.midFrac) {
        const u = t / Math.max(0.001, p.midFrac);
        cr = p.r0 + (p.rMid - p.r0) * u; cg = p.g0 + (p.gMid - p.g0) * u; cb = p.b0 + (p.bMid - p.b0) * u;
      } else {
        const u = Math.min(1, (t - p.midFrac) / Math.max(0.001, 1 - p.midFrac)), v = u * (2 - u);
        cr = p.rMid + (p.r1 - p.rMid) * v; cg = p.gMid + (p.g1 - p.gMid) * v; cb = p.bMid + (p.b1 - p.bMid) * v;
      }
      this.billboard(p.px, p.py, p.pz, scale, scale, p.rot);
      const outIdx = out++;
      this.smokeMesh.setMatrixAt(outIdx, this._mat);
      this.smokeMesh.setColorAt(outIdx, cr, cg, cb);
      this.smokeMesh.setAttributeAt(outIdx, 'instanceOpacity', Math.max(0, alpha));
    }
    this.smokeMesh.count = out; this.smokeMesh.update();

    out = 0;
    for (let k = this.flashActive.length - 1; k >= 0; k--) {
      const i = this.flashActive[k], p = this.flashPool[i];
      p.age += step;
      if (p.age >= p.maxAge) { p.active = false; this.flashActive.splice(k, 1); continue; }
      const t = p.age / p.maxAge, fade = (1 - t) ** 2;
      p.px += p.vx * step; p.py += p.vy * step; p.pz += p.vz * step; p.rot += p.rotSpeed * step;
      this.billboard(p.px, p.py, p.pz, p.startScaleX + (p.endScaleX - p.startScaleX) * t,
        p.startScaleY + (p.endScaleY - p.startScaleY) * t, p.rot);
      const outIdx = out++;
      this.flashMesh.setMatrixAt(outIdx, this._mat);
      this.flashMesh.setColorAt(outIdx, p.r * fade, p.g * fade, p.b * fade);
      this.flashMesh.setAttributeAt(outIdx, 'instanceOpacity', 1);
    }
    this.flashMesh.count = out; this.flashMesh.update();

    out = 0;
    for (let k = this.sparkActive.length - 1; k >= 0; k--) {
      const i = this.sparkActive[k], p = this.sparkPool[i];
      p.age += step;
      if (p.age >= p.maxAge) { p.active = false; this.sparkActive.splice(k, 1); continue; }
      const damp = Math.exp(-p.drag * step);
      p.vx *= damp; p.vy = p.vy * damp - p.gravity * step; p.vz *= damp;
      p.px += p.vx * step; p.py += p.vy * step; p.pz += p.vz * step;
      if (p.py < p.floorY && p.vy < 0) { p.py = p.floorY; p.vy = -p.vy * 0.38; p.vx *= 0.65; p.vz *= 0.65; }
      const speed = Math.hypot(p.vx, p.vy, p.vz), inv = speed > 0.001 ? 1 / speed : 0;
      const dx = p.vx * inv, dy = inv ? p.vy * inv : 1, dz = p.vz * inv;
      const cx = this._camPos.x - p.px, cy = this._camPos.y - p.py, cz = this._camPos.z - p.pz;
      this._v1.set(dy * cz - dz * cy, dz * cx - dx * cz, dx * cy - dy * cx);
      if (this._v1.lengthSq() < 1e-8) this._v1.copy(this._camRight); else this._v1.normalize();
      this._v2.set(this._v1.y * dz - this._v1.z * dy, this._v1.z * dx - this._v1.x * dz, this._v1.x * dy - this._v1.y * dx);
      const t = p.age / p.maxAge, fade = 1 - t * t, len = (p.baseLen + speed * p.stretch) * (0.55 + 0.45 * fade);
      const e = this._mat.data;
      e[0] = this._v1.x * p.width; e[1] = this._v1.y * p.width; e[2] = this._v1.z * p.width; e[3] = 0;
      e[4] = dx * len; e[5] = dy * len; e[6] = dz * len; e[7] = 0;
      e[8] = this._v2.x; e[9] = this._v2.y; e[10] = this._v2.z; e[11] = 0;
      e[12] = p.px; e[13] = p.py; e[14] = p.pz; e[15] = 1;
      const outIdx = out++;
      this.sparkMesh.setMatrixAt(outIdx, this._mat);
      this.sparkMesh.setColorAt(outIdx, (p.r0 + (p.r1 - p.r0) * t) * fade, (p.g0 + (p.g1 - p.g0) * t) * fade, (p.b0 + (p.b1 - p.b0) * t) * fade);
      this.sparkMesh.setAttributeAt(outIdx, 'instanceOpacity', 1);
    }
    this.sparkMesh.count = out; this.sparkMesh.update();

    out = 0;
    for (let k = this.ringActive.length - 1; k >= 0; k--) {
      const i = this.ringActive[k], p = this.ringPool[i];
      p.age += step;
      if (p.age >= p.maxAge) { p.active = false; this.ringActive.splice(k, 1); continue; }
      const t = p.age / p.maxAge, radius = p.startRadius + (p.endRadius - p.startRadius) * (1 - (1 - t) ** 2.4);
      this._pos.set(p.px, p.py, p.pz); this._quat.set(p.qx, p.qy, p.qz, p.qw); this._scale.set(radius, 1, radius);
      const outIdx = out++;
      this.ringMesh.setMatrixAt(outIdx, composeMat(this._mat, this._pos, this._quat, this._scale));
      this.ringMesh.setColorAt(outIdx, p.r, p.g, p.b);
      this.ringMesh.setAttributeAt(outIdx, 'instanceOpacity', p.peakAlpha * (1 - t) ** 2);
    }
    this.ringMesh.count = out; this.ringMesh.update();

    for (const slot of this.lightPool) {
      if (!slot.active) continue;
      slot.age += step;
      if (slot.age >= slot.maxAge) {
        slot.active = false; slot.light.light!.intensity = 0; slot.light.setPosition(0, -1000, 0);
      } else {
        const t = slot.age / slot.maxAge;
        slot.light.light!.intensity = slot.peakIntensity * (1 - t) ** 2;
      }
    }
  }

  private billboard(x: number, y: number, z: number, sx: number, sy: number, rot: number): void {
    const rx = this._camRight.x, ry = this._camRight.y, rz = this._camRight.z;
    const ux = this._camUp.x, uy = this._camUp.y, uz = this._camUp.z;
    const bx = this._camBack.x, by = this._camBack.y, bz = this._camBack.z;
    const c = Math.cos(rot), s = Math.sin(rot), e = this._mat.data;
    e[0] = (rx * c + ux * s) * sx; e[1] = (ry * c + uy * s) * sx; e[2] = (rz * c + uz * s) * sx; e[3] = 0;
    e[4] = (-rx * s + ux * c) * sy; e[5] = (-ry * s + uy * c) * sy; e[6] = (-rz * s + uz * c) * sy; e[7] = 0;
    e[8] = bx; e[9] = by; e[10] = bz; e[11] = 0;
    e[12] = x; e[13] = y; e[14] = z; e[15] = 1;
  }

  public dispose(): void {
    for (const mesh of [this.smokeMesh, this.flashMesh, this.sparkMesh, this.ringMesh, this.fireMesh, this.scorchMesh]) mesh.destroy();
    for (const slot of this.lightPool) slot.light.destroy();
    for (const material of this.materials) material.destroy();
    for (const tex of this.textures) tex.destroy();
  }
}
