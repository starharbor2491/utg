import {
  AppBase,
  Entity,
  LIGHTFALLOFF_INVERSESQUARED,
  Material,
  MeshInstance,
  StandardMaterial,
} from 'playcanvas';
import type { EffectsManager } from './Effects';
import type { World } from './World';
import type { ObstacleCollider, Team, VehicleClass, WreckKillInfo } from './types';
import { instantiateTankRig, type LoadedGameAssets } from './AssetLoader';
import type { Tank } from './Tank';
import { cylinder, Geo, geoFromMesh, icosahedron } from './engine/geometry';
import { InstancedMesh, enableInstanceColor } from './engine/instancing';
import { addShaderHooks, cloneStandardMaterial, standard } from './engine/materials';
import {
  applyMat4,
  applyQuat,
  Box3,
  clamp,
  composeMat,
  degToRad,
  decomposeMat,
  distSq,
  Mat4,
  Quat,
  quatFromEuler,
  srgb,
  Vec3,
} from './engine/math';
import { group, meshNode } from './engine/scene';

// Box rigid bodies against the terrain heightfield. Two substeps, sequential
// normal/friction impulses, position correction and sleep. Scratch is shared.
const GRAVITY = 9.81, PHYS_SUBSTEPS = 2, SLEEP_LIN = 0.15, SLEEP_ANG = 0.2;
const SLEEP_TIME = 0.6, MU = 0.7, RESTITUTION = 0.2;

class RigidBody {
  readonly pos = new Vec3();
  readonly quat = new Quat();
  readonly vel = new Vec3();
  readonly angVel = new Vec3();
  readonly half = new Vec3();
  invMass = 0;
  readonly invInertia = new Vec3();
  asleep = false;
  sleepTimer = 0;
  active = false;
  contactPoints: Float32Array | null = null;
  readonly collideOffset = new Vec3();
  readonly collideHalf = new Vec3();
  hasCollideBox = false;
  readonly tipOffset = new Vec3();
  hasTip = false;
}

const _qi = new Quat(), _omQ = new Quat(), _dq = new Quat();
const _r = new Vec3(), _vC = new Vec3(), _n = new Vec3(), _rn = new Vec3();
const _t1 = new Vec3(), _t2 = new Vec3(), _t3 = new Vec3(), _J = new Vec3();
const _local = new Vec3(), _corner = new Vec3();
const _m1 = new Mat4(), _m2 = new Mat4();

function applyInvInertiaWorld(body: RigidBody, v: Vec3, out: Vec3): Vec3 {
  _qi.copy(body.quat).invert();
  applyQuat(v, _qi, out);
  out.x *= body.invInertia.x; out.y *= body.invInertia.y; out.z *= body.invInertia.z;
  return applyQuat(out, body.quat);
}

interface ContactAccum { jnSum: number; deepPen: boolean }
const _cacc: ContactAccum = { jnSum: 0, deepPen: false };

function applyTerrainContact(body: RigidBody, world: World, n: Vec3, lx: number, ly: number, lz: number, acc: ContactAccum): void {
  _local.set(lx, ly, lz);
  applyQuat(_local, body.quat, _corner).add(body.pos);
  const pen = world.getHeightAt(_corner.x, _corner.z) - _corner.y;
  if (pen <= 0) return;
  if (pen > 0.15) acc.deepPen = true;
  _r.sub2(_corner, body.pos);
  _vC.cross(body.angVel, _r).add(body.vel);
  const vn = _vC.dot(n);
  let jn = 0;
  if (vn < 0) {
    const e = -vn < 1 ? 0 : RESTITUTION;
    _rn.cross(_r, n);
    applyInvInertiaWorld(body, _rn, _t1);
    jn = -(1 + e) * vn / (body.invMass + _rn.dot(_t1));
    _J.copy(n).mulScalar(jn);
    body.vel.addScaled(_J, body.invMass);
    _t2.cross(_r, _J);
    applyInvInertiaWorld(body, _t2, _t3);
    body.angVel.add(_t3);
    acc.jnSum += jn;
  }
  _vC.cross(body.angVel, _r).add(body.vel);
  _t1.copy(_vC).addScaled(n, -_vC.dot(n));
  const vtLen = _t1.length();
  if (vtLen > 1e-4 && jn > 0) {
    _rn.cross(_r, _t1).normalize();
    applyInvInertiaWorld(body, _rn, _t2);
    const denomT = body.invMass + Math.abs(_rn.dot(_t2));
    const jt = Math.min(vtLen / Math.max(denomT, 1e-6), MU * jn);
    _t1.mulScalar(-jt / Math.max(vtLen, 1e-6));
    body.vel.addScaled(_t1, body.invMass);
    _t2.cross(_r, _t1);
    applyInvInertiaWorld(body, _t2, _t3);
    body.angVel.add(_t3);
  }
  const corr = Math.max(pen - 0.01, 0) * 0.4;
  if (corr > 0) body.pos.addScaled(n, corr);
}

function stepBody(body: RigidBody, world: World, h: number): void {
  if (body.asleep || !body.active) return;
  body.vel.y -= GRAVITY * h;
  body.vel.mulScalar(Math.exp(-0.35 * h));
  body.angVel.mulScalar(Math.exp(-0.9 * h));
  body.pos.addScaled(body.vel, h);
  _omQ.set(body.angVel.x, body.angVel.y, body.angVel.z, 0);
  _dq.copy(_omQ).mul(body.quat);
  const hq = 0.5 * h;
  body.quat.set(body.quat.x + _dq.x * hq, body.quat.y + _dq.y * hq,
    body.quat.z + _dq.z * hq, body.quat.w + _dq.w * hq).normalize();
  world.getNormalAt(body.pos.x, body.pos.z, _n);
  if (_n.y < 0.35) _n.set(0, 1, 0);
  _cacc.jnSum = 0; _cacc.deepPen = false;
  const cps = body.contactPoints;
  if (cps && cps.length >= 9) {
    for (let i = 0; i < cps.length; i += 3) applyTerrainContact(body, world, _n, cps[i], cps[i + 1], cps[i + 2], _cacc);
  } else {
    for (let cx = -1; cx <= 1; cx += 2) for (let cy = -1; cy <= 1; cy += 2) for (let cz = -1; cz <= 1; cz += 2) {
      applyTerrainContact(body, world, _n, cx * body.half.x, cy * body.half.y, cz * body.half.z, _cacc);
    }
  }
  if (body.hasTip) applyTerrainContact(body, world, _n, body.tipOffset.x, body.tipOffset.y, body.tipOffset.z, _cacc);
  if (body.vel.length() < SLEEP_LIN && body.angVel.length() < SLEEP_ANG) {
    body.sleepTimer += h;
    if (body.sleepTimer >= (_cacc.deepPen ? 3 : SLEEP_TIME)) {
      body.asleep = true; body.vel.set(0, 0, 0); body.angVel.set(0, 0, 0);
    }
  } else body.sleepTimer = 0;
}

function bodyTiltDeg(body: RigidBody, world: World): number {
  world.getNormalAt(body.pos.x, body.pos.z, _n);
  if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0); else _n.normalize();
  applyQuat(_t1.set(1, 0, 0), body.quat);
  applyQuat(_t2.set(0, 1, 0), body.quat);
  applyQuat(_t3.set(0, 0, 1), body.quat);
  return Math.acos(Math.min(1, Math.max(Math.abs(_t1.dot(_n)), Math.abs(_t2.dot(_n)), Math.abs(_t3.dot(_n))))) * 180 / Math.PI;
}

// ---------------------------------------------------------------------------
// Shared wreck geometry. Mesh vertices are read back in float, baked into hull
// or turret space, merged by material and centred on the collision box.
// ---------------------------------------------------------------------------
interface BakedEntry { geo: Geo; material: StandardMaterial }
interface BakedPart {
  entries: BakedEntry[]; box: Box3; center: Vec3; half: Vec3; contacts: Float32Array;
  whipComponents: number; whipDroppedTris: number;
}
interface TurretCollide { offset: Vec3; half: Vec3; tip: Vec3 | null }
interface ClassGeo { hull: BakedPart; turret: BakedPart | null; turretCollide: TurretCollide | null; turretRestRel: Mat4 | null }

function collectMeshes(root: Entity, skip: Entity | null, out: MeshInstance[]): void {
  if (root === skip || root.name.startsWith('moving_track_')) return;
  const mis = root.render?.meshInstances;
  if (mis) for (const mi of mis) if (!mi.instancingData) out.push(mi);
  for (const child of root.children) collectMeshes(child as Entity, skip, out);
}

function isDescendantOf(node: Entity, ancestor: Entity): boolean {
  let p: typeof node.parent = node;
  while (p) { if (p === ancestor) return true; p = p.parent; }
  return false;
}

function normalizedMeshGeo(mi: MeshInstance, transform: Mat4): Geo {
  const src = geoFromMesh(mi.mesh!);
  const g = new Geo([...src.positions], [...src.normals], [...src.uvs], [...src.indices]);
  if (src.colors) g.colors = [...src.colors];
  if (!g.normals.length) g.computeNormals();
  if (!g.uvs.length) g.uvs = new Array(g.vertexCount * 2).fill(0);
  return g.applyMatrix(transform);
}

function supportContacts(entries: BakedEntry[], center: Vec3): Float32Array {
  const out = new Float32Array(98 * 3);
  let write = 0;
  // Fibonacci directions give a compact convex support set for terrain contacts.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 98; i++) {
    const y = 1 - 2 * (i + 0.5) / 98, r = Math.sqrt(Math.max(0, 1 - y * y)), a = i * golden;
    const dx = Math.cos(a) * r, dy = y, dz = Math.sin(a) * r;
    let best = -Infinity, bx = 0, by = 0, bz = 0;
    for (const e of entries) {
      const p = e.geo.positions;
      for (let j = 0; j < p.length; j += 3) {
        const dot = p[j] * dx + p[j + 1] * dy + p[j + 2] * dz;
        if (dot > best) { best = dot; bx = p[j]; by = p[j + 1]; bz = p[j + 2]; }
      }
    }
    out[write++] = bx - center.x; out[write++] = by - center.y; out[write++] = bz - center.z;
  }
  return out;
}

function bakePart(meshes: MeshInstance[], spaceWorldInv: Mat4): BakedPart {
  const groups = new Map<StandardMaterial, Geo[]>();
  for (const mi of meshes) {
    const mat = mi.material as StandardMaterial;
    _m1.copy(spaceWorldInv).mul(mi.node.getWorldTransform());
    const geo = normalizedMeshGeo(mi, _m1);
    const list = groups.get(mat);
    if (list) list.push(geo); else groups.set(mat, [geo]);
  }
  const entries: BakedEntry[] = [];
  for (const [material, geos] of groups) {
    const merged = Geo.merge(geos);
    if (merged) entries.push({ geo: merged, material });
  }
  const box = new Box3().makeEmpty();
  for (const e of entries) box.union(e.geo.bounds());
  if (box.isEmpty()) box.set(new Vec3(-0.5, 0, -0.5), new Vec3(0.5, 1, 0.5));
  const center = box.getCenter(new Vec3()), half = box.getSize(new Vec3()).mulScalar(0.5);
  for (const e of entries) e.geo.translate(-center.x, -center.y, -center.z);
  return { entries, box, center, half, contacts: supportContacts(entries, center), whipComponents: 0, whipDroppedTris: 0 };
}

function bakeBoundsOnly(meshes: MeshInstance[], inv: Mat4, out: Box3): void {
  out.makeEmpty();
  for (const mi of meshes) {
    _m1.copy(inv).mul(mi.node.getWorldTransform());
    out.expandByPositions(geoFromMesh(mi.mesh!).positions, _m1);
  }
}

interface BurnUniforms { material: StandardMaterial; uBurn: number; uHeat: number }
let SHARED_BURN_TIME = 0;
function makeWreckMaterial(src: StandardMaterial, hitLocal: Vec3, halfY: number): BurnUniforms {
  const mat = cloneStandardMaterial(src);
  mat.metalness = Math.min(0.45, mat.metalness * 0.7 + 0.08);
  mat.gloss = Math.min(mat.gloss, 0.32);
  mat.emissive = srgb(0x080201);
  mat.emissiveIntensity = 1;
  addShaderHooks(mat, {
    vsDecl: 'varying vec3 vBurnPos;',
    vsMainEnd: 'vBurnPos = vertex_position.xyz;',
    psDecl: `
      varying vec3 vBurnPos;
      uniform float uBurn;
      uniform float uHeat;
      uniform float uBurnTime;
      uniform float uHalfY;
      uniform vec3 uHitLocal;
      float burnHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float burnNoise(vec3 p) {
        vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(burnHash(i), burnHash(i + vec3(1,0,0)), u.x), mix(burnHash(i + vec3(0,1,0)), burnHash(i + vec3(1,1,0)), u.x), u.y), mix(mix(burnHash(i + vec3(0,0,1)), burnHash(i + vec3(1,0,1)), u.x), mix(burnHash(i + vec3(0,1,1)), burnHash(i + vec3(1,1,1)), u.x), u.y), u.z);
      }`,
    albedo: `
      float bn = burnNoise(vBurnPos * 5.5);
      float bh = distance(vBurnPos, uHitLocal) / max(uHalfY * 2.0, 0.5);
      float charMask = clamp(uBurn * (0.68 + 0.32 * bn) + 0.30 / (0.35 + bh * bh), 0.0, 0.96);
      dAlbedo = mix(dAlbedo * (1.0 - uBurn * 0.35), vec3(0.035, 0.030, 0.026), charMask);`,
    emission: `
      float emberMask = smoothstep(0.68, 0.92, burnNoise(vBurnPos * 13.0)) * (1.0 - smoothstep(0.1, 0.8, distance(vBurnPos, uHitLocal) / max(uHalfY * 2.0, 0.5)));
      float flick = 0.72 + 0.28 * burnHash(floor(vec3(uBurnTime * 9.0, vBurnPos.x * 3.1 + vBurnPos.z * 1.7, vBurnPos.y)));
      dEmission += vec3(1.0, 0.38, 0.10) * emberMask * uHeat * flick * 0.85;`,
  });
  mat.setParameter('uHitLocal', [hitLocal.x, hitLocal.y, hitLocal.z]);
  mat.setParameter('uHalfY', halfY);
  mat.setParameter('uBurn', 0); mat.setParameter('uHeat', 1); mat.setParameter('uBurnTime', SHARED_BURN_TIME);
  mat.update();
  return { material: mat, uBurn: 0, uHeat: 1 };
}

// ---------------------------------------------------------------------------
// Pooled debris.
// ---------------------------------------------------------------------------
const DEBRIS_MESHES = 4, DEBRIS_PER_MESH = 48, DEBRIS_CAP = DEBRIS_MESHES * DEBRIS_PER_MESH;
interface Debris {
  active: boolean; meshIdx: number; slot: number; x: number; y: number; z: number;
  vx: number; vy: number; vz: number; qx: number; qy: number; qz: number; qw: number;
  wx: number; wy: number; wz: number; sx: number; sy: number; sz: number; radius: number;
  age: number; life: number; emitAccum: number; cr: number; cg: number; cb: number;
}
const _dq2 = new Quat(), _wq = new Quat(), _sm = new Mat4();
const _sv = new Vec3(), _sq = new Quat(), _dn = new Vec3();

function makeShardGeometry(seed: number): Geo {
  const geo = icosahedron(1, 1), v = new Vec3();
  for (let i = 0; i < geo.positions.length; i += 3) {
    v.set(geo.positions[i], geo.positions[i + 1], geo.positions[i + 2]);
    const n = Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719 + seed) * 43758.5453;
    v.mulScalar(1 + (n - Math.floor(n) - 0.5) * 0.55);
    geo.positions[i] = v.x; geo.positions[i + 1] = v.y * 0.42; geo.positions[i + 2] = v.z;
  }
  return geo.computeNormals();
}

interface Wreck {
  active: boolean; group: Entity; hullNode: Entity; turretNode: Entity | null;
  hullBody: RigidBody; turretBody: RigidBody | null; burnEntries: BurnUniforms[];
  age: number; sinkT: number; state: 'flight' | 'burning' | 'dying' | 'smoke' | 'sinking' | 'dead';
  catastrophic: boolean; emitters: Vec3[]; fireAccum: number; smokeAccum: number; emberAccum: number;
  cookoffPops: number[]; cookoffIdx: number; obstacle: ObstacleCollider | null;
  cls: VehicleClass; seed: number; emitWorld: Vec3[];
}
const WRECK_POOL_MAX = 10, WRECK_LIFETIME = 75, BURN_TIME = 2.5, HEAT_TIME = 25;
const HULL_MASS: Record<VehicleClass, number> = { normal: 42, heavy: 58, ifv: 33, humvee: 11, rocket: 15, support: 15, littlebird: 5 };

export class DestructionManager {
  private readonly scene: Entity;
  private readonly world: World;
  private readonly effects: EffectsManager;
  private readonly geoCache = new Map<string, ClassGeo>();
  private readonly wrecks: Wreck[] = [];
  private wreckIdCounter = 0;
  private mergeCount = 0;
  private mergeTotalMs = 0;
  private readonly debrisMeshes: InstancedMesh[] = [];
  private readonly debrisPool: Debris[] = [];
  private debrisCursor = 0;
  private readonly debrisActiveIdx: number[] = [];
  private readonly debrisPos = new Int32Array(DEBRIS_CAP).fill(-1);
  private readonly debrisMat4 = new Mat4();
  private readonly debrisDiam: number[] = [];
  private readonly wreckLights: Entity[] = [];
  private readonly lightTargets: (Wreck | null)[] = [null, null];
  private lightScanTimer = 0;

  constructor(scene: Entity, world: World, effects: EffectsManager) {
    this.scene = scene; this.world = world; this.effects = effects;
    const geos = [makeShardGeometry(3.7), makeShardGeometry(9.1), makeShardGeometry(15.3), cylinder(0.55, 0.55, 0.34, 12).rotateZ(Math.PI / 2)];
    for (let i = 0; i < DEBRIS_MESHES; i++) {
      const mat = standard({ color: '#ffffff', roughness: 0.55, metalness: 0.55, flatShading: true });
      enableInstanceColor(mat);
      const im = new InstancedMesh(geos[i], mat, DEBRIS_PER_MESH, { name: `wreck_debris_${i}`, parent: scene, color: true, castShadows: false, receiveShadows: false });
      im.meshInstance.cull = false;
      im.count = 0; im.update();
      this.debrisMeshes.push(im);
      this.debrisDiam.push(geos[i].bounds().getSize(new Vec3()).length() * 0.5);
    }
    for (let i = 0; i < DEBRIS_CAP; i++) this.debrisPool.push({ active: false, meshIdx: i % DEBRIS_MESHES, slot: Math.floor(i / DEBRIS_MESHES),
      x: 0, y: -1000, z: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, wx: 0, wy: 0, wz: 0,
      sx: 1, sy: 1, sz: 1, radius: 0.3, age: 0, life: 8, emitAccum: 0, cr: 0.05, cg: 0.045, cb: 0.04 });
    for (let i = 0; i < 2; i++) {
      const light = new Entity(`wreck_light_${i}`);
      light.addComponent('light', { type: 'omni', color: srgb(0xff8830), intensity: 0, range: 20, falloffMode: LIGHTFALLOFF_INVERSESQUARED, castShadows: false });
      light.setPosition(0, -1000, 0); scene.addChild(light); this.wreckLights.push(light);
    }
  }

  public spawnWreck(info: WreckKillInfo): void {
    const tank = info.tank as Tank, cls = tank.stats.vehicleClass, team = tank.team;
    let wreck = this.wrecks.find((w) => !w.active);
    if (!wreck) {
      if (this.wrecks.filter((w) => w.active).length >= WRECK_POOL_MAX) {
        let oldest: Wreck | null = null;
        for (const w of this.wrecks) if (w.active && (!oldest || w.age > oldest.age)) oldest = w;
        if (oldest) this._beginSink(oldest);
      }
      wreck = this._createWreckRecord(); this.wrecks.push(wreck);
    }
    const t0 = performance.now();
    const geo = this._ensureGeoCached(cls, team, tank);
    this.mergeCount++; this.mergeTotalMs += performance.now() - t0;
    this._buildWreckMeshes(wreck, geo, info);
    this._initBodies(wreck, tank, info, geo);
    this._spawnDebrisAndEffects(wreck, tank, info);
  }

  public update(dt: number, cameraPos: Vec3): void {
    const safeDt = Math.min(Math.max(dt, 0.0001), 0.05);
    SHARED_BURN_TIME += safeDt;
    for (const wreck of this.wrecks) {
      if (!wreck.active) continue;
      wreck.age += safeDt;
      const burn01 = Math.min(1, wreck.age / BURN_TIME), heat01 = Math.max(0, 1 - wreck.age / HEAT_TIME);
      for (const b of wreck.burnEntries) {
        b.uBurn = burn01; b.uHeat = heat01;
        b.material.setParameter('uBurn', burn01); b.material.setParameter('uHeat', heat01); b.material.setParameter('uBurnTime', SHARED_BURN_TIME);
      }
      if (wreck.state === 'sinking') {
        wreck.sinkT += safeDt;
        wreck.group.setLocalPosition(0, -Math.min(1, wreck.sinkT / 5) * 0.6, 0);
        if (wreck.sinkT >= 5) { this._recycle(wreck); continue; }
      } else {
        const h = safeDt / PHYS_SUBSTEPS;
        for (let s = 0; s < PHYS_SUBSTEPS; s++) {
          stepBody(wreck.hullBody, this.world, h);
          if (wreck.turretBody) { stepBody(wreck.turretBody, this.world, h); this._collideTurretHull(wreck); }
        }
        wreck.hullNode.setPosition(wreck.hullBody.pos); wreck.hullNode.setRotation(wreck.hullBody.quat);
        if (wreck.turretBody && wreck.turretNode) { wreck.turretNode.setPosition(wreck.turretBody.pos); wreck.turretNode.setRotation(wreck.turretBody.quat); }
        if (!wreck.obstacle && wreck.hullBody.asleep) this._registerObstacle(wreck);
        if (wreck.age > WRECK_LIFETIME) { this._beginSink(wreck); continue; }
        wreck.state = wreck.age < 20 ? 'burning' : wreck.age < 35 ? 'dying' : 'smoke';
        this._emitEffects(wreck, safeDt, cameraPos);
      }
    }
    this._updateDebris(safeDt); this._updateWreckLights(safeDt, cameraPos);
  }

  public applyBlast(point: Vec3, impulse: number, radius: number): void {
    for (const wreck of this.wrecks) {
      if (!wreck.active) continue;
      for (const body of [wreck.hullBody, wreck.turretBody]) {
        if (!body?.active || body.pos.distance(point) >= radius) continue;
        const d = body.pos.distance(point);
        body.asleep = false; body.sleepTimer = 0;
        _t1.sub2(body.pos, point); if (_t1.lengthSq() < 1e-4) _t1.set(0, 0, 1); else _t1.normalize();
        const fall = 1 - d / radius;
        body.vel.addScaled(_t1, impulse * fall); body.vel.y += impulse * fall * 0.6;
        body.angVel.x += (Math.random() - 0.5) * impulse * 0.4 * fall;
        body.angVel.z += (Math.random() - 0.5) * impulse * 0.4 * fall;
      }
    }
  }

  public get activeWreckCount(): number { let n = 0; for (const w of this.wrecks) if (w.active) n++; return n; }
  public readonly decoyPoints: { x: number; y: number; z: number }[] = [];
  private readonly _decoyObjPool: { x: number; y: number; z: number }[] = [];
  public getDecoyPoints(): readonly { x: number; y: number; z: number }[] {
    let i = 0;
    for (const w of this.wrecks) {
      if (!w.active || (w.state !== 'flight' && w.state !== 'burning')) continue;
      const p = this._decoyObjPool[i] ?? (this._decoyObjPool[i] = { x: 0, y: 0, z: 0 });
      p.x = w.hullBody.pos.x; p.y = w.hullBody.pos.y + 1.2; p.z = w.hullBody.pos.z;
      this.decoyPoints[i++] = p;
    }
    this.decoyPoints.length = i; return this.decoyPoints;
  }

  public getWreckState(): { count: number; mergeMsAvg: number; mergeCount: number; wrecks: { cls: string; age: number; state: string; x: number; y: number; z: number; tx?: number; ty?: number; tz?: number; tvx?: number; tvy?: number; tvz?: number }[] } {
    return { count: this.activeWreckCount, mergeMsAvg: this.mergeCount ? this.mergeTotalMs / this.mergeCount : 0, mergeCount: this.mergeCount,
      wrecks: this.wrecks.filter((w) => w.active).map((w) => ({ cls: w.cls, age: Math.round(w.age * 10) / 10, state: w.state,
        x: Math.round(w.hullBody.pos.x * 10) / 10, y: Math.round(w.hullBody.pos.y * 10) / 10, z: Math.round(w.hullBody.pos.z * 10) / 10,
        gy: Math.round(this.world.getHeightAt(w.hullBody.pos.x, w.hullBody.pos.z) * 100) / 100, hy: Math.round(w.hullBody.half.y * 100) / 100,
        tx: w.turretBody ? Math.round(w.turretBody.pos.x * 10) / 10 : undefined, ty: w.turretBody ? Math.round(w.turretBody.pos.y * 10) / 10 : undefined,
        tz: w.turretBody ? Math.round(w.turretBody.pos.z * 10) / 10 : undefined, tvy: w.turretBody ? Math.round(w.turretBody.vel.y * 10) / 10 : undefined,
        tvx: w.turretBody ? Math.round(w.turretBody.vel.x * 10) / 10 : undefined, tvz: w.turretBody ? Math.round(w.turretBody.vel.z * 10) / 10 : undefined })) };
  }

  public probeClearance(): { cls: string; part: string; minGap: number; belowFrac: number; asleep: boolean; tiltDeg: number }[] {
    const out: { cls: string; part: string; minGap: number; belowFrac: number; asleep: boolean; tiltDeg: number }[] = [];
    for (const w of this.wrecks) {
      if (!w.active) continue;
      const parts: [string, Entity | null, RigidBody | null][] = [['hull', w.hullNode, w.hullBody], ['turret', w.turretNode, w.turretBody]];
      for (const [name, node, body] of parts) {
        if (!node || !body) continue;
        let minGap = Infinity, below = 0, total = 0;
        const meshes: MeshInstance[] = []; collectMeshes(node, null, meshes);
        for (const mi of meshes) {
          if (name === 'hull' && w.turretNode && isDescendantOf(mi.node as Entity, w.turretNode)) continue;
          const p = geoFromMesh(mi.mesh!).positions, step = Math.max(1, Math.floor(p.length / 3 / 500));
          for (let i = 0; i < p.length / 3; i += step) {
            applyMat4(_pv.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]), mi.node.getWorldTransform());
            const gap = _pv.y - this.world.getHeightAt(_pv.x, _pv.z);
            minGap = Math.min(minGap, gap); if (gap < -0.05) below++; total++;
          }
        }
        if (minGap !== Infinity) out.push({ cls: w.cls, part: name, minGap: Math.round(minGap * 100) / 100,
          belowFrac: total ? Math.round(below / total * 100) / 100 : 0, asleep: body.asleep, tiltDeg: Math.round(bodyTiltDeg(body, this.world) * 10) / 10 });
      }
    }
    return out;
  }

  public selfTest(): { ok: boolean; ms: number; drop: { ok: boolean; restGap: number; tiltDeg: number; asleep: boolean; nan: boolean }; edge: { ok: boolean; restGap: number; tiltDeg: number; asleep: boolean; nan: boolean } } {
    const t0 = performance.now(), drop = this._selfTestCase(false), edge = this._selfTestCase(true);
    return { ok: drop.ok && edge.ok, ms: Math.round(performance.now() - t0), drop, edge };
  }

  private _selfTestCase(edgeDrop: boolean): { ok: boolean; restGap: number; tiltDeg: number; asleep: boolean; nan: boolean } {
    const body = new RigidBody(); body.active = true;
    const cx = 30, cz = -30, ground = this.world.getHeightAt(cx, cz);
    body.half.set(0.6, 0.3, 0.45); body.invMass = 1 / 20;
    body.invInertia.set(12 / (20 * (0.6 ** 2 + 0.9 ** 2)), 12 / (20 * (1.2 ** 2 + 0.9 ** 2)), 12 / (20 * (1.2 ** 2 + 0.6 ** 2)));
    if (!edgeDrop) {
      body.pos.set(cx, ground + 3.3, cz); quatFromEuler(body.quat, 0.4, 0.7, 0.2);
      body.vel.set(0.5, 0, -0.3); body.angVel.set(2.5, 1.2, -1.8);
    } else {
      quatFromEuler(body.quat, 0, 0, degToRad(50));
      let lo = Infinity;
      for (let sx = -1; sx <= 1; sx += 2) for (let sy = -1; sy <= 1; sy += 2) for (let sz = -1; sz <= 1; sz += 2) {
        applyQuat(_local.set(sx * 0.6, sy * 0.3, sz * 0.45), body.quat); lo = Math.min(lo, _local.y);
      }
      body.pos.set(cx, ground + 1 - lo, cz);
    }
    const seconds = edgeDrop ? 8 : 6, h = 1 / 60 / PHYS_SUBSTEPS;
    for (let i = 0; i < seconds * 60 * PHYS_SUBSTEPS; i++) { stepBody(body, this.world, h); if (!isFinite(body.pos.x + body.pos.y + body.pos.z)) break; }
    let minY = Infinity;
    for (let sx = -1; sx <= 1; sx += 2) for (let sy = -1; sy <= 1; sy += 2) for (let sz = -1; sz <= 1; sz += 2) {
      applyQuat(_local.set(sx * 0.6, sy * 0.3, sz * 0.45), body.quat);
      minY = Math.min(minY, body.pos.y + _local.y - this.world.getHeightAt(body.pos.x + _local.x, body.pos.z + _local.z));
    }
    const nan = !isFinite(body.pos.x + body.pos.y + body.pos.z + body.quat.w), restGap = Math.abs(minY), tiltDeg = Math.round(bodyTiltDeg(body, this.world) * 10) / 10;
    const ok = edgeDrop ? !nan && body.asleep && tiltDeg < 5 && restGap <= 0.02 : !nan && restGap <= 0.02 && body.asleep;
    return { ok, restGap: Math.round(restGap * 1000) / 1000, tiltDeg, asleep: body.asleep, nan };
  }

  private _createWreckRecord(): Wreck {
    const root = group('wreck', this.scene);
    return { active: false, group: root, hullNode: group('wreck_hull'), turretNode: null, hullBody: new RigidBody(), turretBody: null,
      burnEntries: [], age: 0, sinkT: 0, state: 'flight', catastrophic: false, emitters: [], fireAccum: 0, smokeAccum: 0, emberAccum: 0,
      cookoffPops: [], cookoffIdx: 0, obstacle: null, cls: 'normal', seed: Math.random() * 100,
      emitWorld: [new Vec3(), new Vec3(), new Vec3(), new Vec3()] };
  }

  private _ensureGeoCached(cls: VehicleClass, team: Team, tank: Tank): ClassGeo {
    const key = `${cls}:${team}`, cached = this.geoCache.get(key); if (cached) return cached;
    const rigRootInv = new Mat4().copy(tank.root.getWorldTransform()).invert();
    const turretInv = new Mat4().copy(tank.rig.turretPivot.getWorldTransform()).invert();
    const hullMeshes: MeshInstance[] = [], turretMeshes: MeshInstance[] = [];
    collectMeshes(tank.root, tank.rig.turretPivot, hullMeshes); collectMeshes(tank.rig.turretPivot, null, turretMeshes);
    const hull = bakePart(hullMeshes, rigRootInv), turret = turretMeshes.length ? bakePart(turretMeshes, turretInv) : null;
    let turretCollide: TurretCollide | null = null;
    const gunRoot = tank.rig.gunPivot;
    if (turret && gunRoot && isDescendantOf(gunRoot, tank.rig.turretPivot)) {
      const turretOnly: MeshInstance[] = [], gunMeshes: MeshInstance[] = [];
      collectMeshes(tank.rig.turretPivot, gunRoot, turretOnly); collectMeshes(gunRoot, null, gunMeshes);
      if (turretOnly.length && gunMeshes.length) {
        const tbox = new Box3(), gbox = new Box3(); bakeBoundsOnly(turretOnly, turretInv, tbox); bakeBoundsOnly(gunMeshes, turretInv, gbox);
        if (!tbox.isEmpty() && !gbox.isEmpty()) {
          const ts = tbox.getSize(_t1), gs = gbox.getSize(_t2), gh = gbox.getSize(_t3).mulScalar(0.5);
          const barrelLike = Math.max(gs.x, gs.y, gs.z) > Math.max(ts.x, ts.y, ts.z) * 1.35 && Math.min(gh.x, gh.y, gh.z) < 0.6;
          const tc = tbox.getCenter(new Vec3()), th = tbox.getSize(new Vec3()).mulScalar(0.5);
          applyMat4(tank.rig.muzzleNode.getPosition(), turretInv, _t2);
          const tip = _t2.clone().sub(turret.center);
          turretCollide = barrelLike ? { offset: tc.sub(turret.center), half: th, tip } : { offset: new Vec3(), half: turret.half.clone(), tip };
        }
      }
    }
    const geo: ClassGeo = { hull, turret, turretCollide, turretRestRel: turret ? new Mat4().copy(rigRootInv).mul(tank.rig.turretPivot.getWorldTransform()) : null };
    this.geoCache.set(key, geo); return geo;
  }

  public async prewarmWrecksAndVehicles(app: AppBase, scene: Entity, camera: Entity, assets: LoadedGameAssets): Promise<void> {
    const classes: VehicleClass[] = ['normal', 'heavy', 'ifv', 'humvee', 'rocket', 'support', 'littlebird'];
    const warm = group('shader_prewarm', scene);
    let slot = 0;
    for (const cls of classes) for (const team of ['blue', 'red'] as Team[]) {
      if (cls === 'littlebird' && team === 'red') continue;
      const rig = instantiateTankRig(assets, cls, team);
      const fake = { root: rig.root, rig, team, stats: { vehicleClass: cls } } as unknown as Tank;
      const geo = this._ensureGeoCached(cls, team, fake), wreck = this._createWreckRecord();
      this._buildWreckMeshes(wreck, geo, { tank: fake, hitPoint: new Vec3(0, 1.1, 0), shellDir: null, weapon: 'cannon', damage: 999, catastrophic: true } as WreckKillInfo);
      const ox = (slot % 5) * 7 - 14, oz = Math.floor(slot / 5) * 7 - 10;
      rig.root.setLocalPosition(ox, 0, oz); wreck.group.setLocalPosition(ox + 3.5, 0, oz + 3.5);
      warm.addChild(rig.root); warm.addChild(wreck.group); slot++;
    }
    applyQuat(_t1.set(0, 0, -26), camera.getRotation());
    warm.setPosition(_t1.add(camera.getPosition()));
    for (const im of this.debrisMeshes) { im.count = 1; im.update(); }
    app.renderNextFrame = true; app.render();
    for (const im of this.debrisMeshes) { im.count = 0; im.update(); }
    warm.destroy();
    await Promise.resolve();
  }

  private _buildWreckMeshes(wreck: Wreck, geo: ClassGeo, info: WreckKillInfo): void {
    const tank = info.tank as Tank;
    for (const child of [...wreck.group.children]) child.destroy();
    wreck.burnEntries.length = 0; wreck.hullNode = group('wreck_hull', wreck.group);
    const rootInv = _m1.copy(tank.root.getWorldTransform()).invert(), turretInv = new Mat4().copy(tank.rig.turretPivot.getWorldTransform()).invert();
    const hullHit = applyMat4(new Vec3(info.hitPoint.x, info.hitPoint.y, info.hitPoint.z), rootInv);
    const turretHit = applyMat4(new Vec3(info.hitPoint.x, info.hitPoint.y, info.hitPoint.z), turretInv);
    const makeMeshes = (part: BakedPart, hitLocal: Vec3, parent: Entity) => {
      const hitC = _t3.copy(hitLocal).sub(part.center);
      for (const e of part.entries) {
        const burn = makeWreckMaterial(e.material, hitC, part.half.y);
        meshNode(e.geo, burn.material, parent, { castShadows: true, receiveShadows: true });
        wreck.burnEntries.push(burn);
      }
    };
    makeMeshes(geo.hull, hullHit, wreck.hullNode);
    const hasTurret = geo.turret !== null;
    const volume = hasTurret ? 8 * geo.turret!.half.x * geo.turret!.half.y * geo.turret!.half.z : 0;
    const maxDim = hasTurret ? Math.max(geo.turret!.half.x, geo.turret!.half.y, geo.turret!.half.z) * 2 : 0;
    const launch = info.catastrophic && hasTurret && volume > 3 && maxDim > 1.1;
    wreck.turretNode = null;
    if (geo.turret && geo.turretRestRel) {
      wreck.turretNode = group('wreck_turret');
      makeMeshes(geo.turret, turretHit, wreck.turretNode);
      if (launch) wreck.group.addChild(wreck.turretNode);
      else {
        const droop = new Quat().setFromEulerAngles(0.14 * 180 / Math.PI, 0, 0);
        const recenter = new Mat4().setTranslate(geo.turret.center.x, geo.turret.center.y, geo.turret.center.z);
        _m2.copy(geo.turretRestRel).mul(new Mat4().setTRS(Vec3.ZERO, droop, Vec3.ONE)).mul(recenter);
        const p = new Vec3(), q = new Quat(), s = new Vec3(); decomposeMat(_m2, p, q, s);
        wreck.turretNode.setLocalPosition(p); wreck.turretNode.setLocalRotation(q); wreck.turretNode.setLocalScale(s);
        wreck.hullNode.addChild(wreck.turretNode);
      }
    }
  }

  private _initBodies(wreck: Wreck, tank: Tank, info: WreckKillInfo, geo: ClassGeo): void {
    const cls = tank.stats.vehicleClass, wheeled = tank.stats.drive === 'wheeled', hull = wreck.hullBody, part = geo.hull;
    hull.active = true; hull.asleep = false; hull.sleepTimer = 0;
    decomposeMat(tank.root.getWorldTransform(), _sv, hull.quat, _sv2);
    applyQuat(part.center, hull.quat, hull.pos).add(tank.root.getPosition());
    hull.half.copy(part.half); hull.half.x = Math.max(hull.half.x, 0.7); hull.half.y = Math.max(hull.half.y, 0.5); hull.half.z = Math.max(hull.half.z, 0.9);
    hull.contactPoints = part.contacts; hull.hasTip = false; hull.hasCollideBox = false;
    const m = HULL_MASS[cls]; hull.invMass = 1 / m;
    const sx = hull.half.x * 2, sy = hull.half.y * 2, sz = hull.half.z * 2;
    hull.invInertia.set(12 / (m * (sy * sy + sz * sz)), 12 / (m * (sx * sx + sz * sz)), 12 / (m * (sx * sx + sy * sy)));
    _t1.copy(tank.root.getPosition()); _t1.y += 1.2; _t2.sub2(_t1, info.hitPoint); _t2.y = 0;
    if (_t2.lengthSq() < 0.01) _t2.set(-Math.sin(tank.hullYaw), 0, -Math.cos(tank.hullYaw)); else _t2.normalize();
    const kick = _t3.set(_t2.x * 0.55, 0.85, _t2.z * 0.55).normalize();
    if (wheeled) {
      hull.vel.copy(kick).mulScalar(2 + Math.random() * 1.5); hull.vel.y = 5 + Math.random() * 3;
      hull.angVel.copy(Math.random() < 0.5 ? _t1.set(1, 0, 0) : _t1.set(0, 0, 1)).mulScalar((Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 3));
      hull.angVel.y += (Math.random() - 0.5) * 2;
    } else if (info.catastrophic) {
      hull.vel.copy(kick).mulScalar(1.5 + Math.random() * 1.5); hull.angVel.set((Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.6);
    } else {
      hull.vel.copy(kick).mulScalar(0.9 + Math.random() * 0.6); hull.angVel.set((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.8);
    }
    wreck.turretBody = null;
    const tp = geo.turret;
    if (tp && wreck.turretNode?.parent === wreck.group) {
      const tb = new RigidBody(); tb.active = true;
      decomposeMat(tank.rig.turretPivot.getWorldTransform(), tb.pos, tb.quat, _sv);
      tb.pos.add(applyQuat(tp.center, tb.quat, _t1)); tb.half.copy(tp.half);
      tb.half.x = Math.max(tb.half.x, 0.25); tb.half.y = Math.max(tb.half.y, 0.2); tb.half.z = Math.max(tb.half.z, 0.25);
      tb.contactPoints = tp.contacts;
      const tc = geo.turretCollide;
      tb.hasCollideBox = !!tc; tb.hasTip = !!tc?.tip;
      if (tc) { tb.collideOffset.copy(tc.offset); tb.collideHalf.copy(tc.half); if (tc.tip) tb.tipOffset.copy(tc.tip); }
      const tm = clamp(8 * tb.half.x * tb.half.y * tb.half.z * 0.12, 2.5, 14); tb.invMass = 1 / tm;
      const tx = tb.half.x * 2, ty = tb.half.y * 2, tz = tb.half.z * 2;
      tb.invInertia.set(12 / (tm * (ty * ty + tz * tz)), 12 / (tm * (tx * tx + tz * tz)), 12 / (tm * (tx * tx + ty * ty)));
      tb.vel.set(0, 9 + Math.random() * 6, 0).addScaled(kick, 1.5 + Math.random() * 1.5);
      applyMat4(info.hitPoint, turretWorldMatrixInv(tank), _t1).sub(tp.center);
      const side = Math.sign(_t1.x) || 1;
      applyQuat(_t2.set(-side * (1.5 + Math.random()), 0, -0.5), tb.quat); tb.vel.add(_t2);
      tb.angVel.set((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5).normalize().mulScalar(2 + Math.random() * 3);
      wreck.turretBody = tb;
    }
    const ex = hull.half.x * 0.55, ey = hull.half.y * 0.85, ez = hull.half.z;
    wreck.emitters = [new Vec3(0, ey, -ez * 0.45), new Vec3(ex * 0.7, ey * 0.8, ez * 0.15), new Vec3(-ex * 0.7, ey * 0.8, ez * 0.15), new Vec3(0, ey * 0.6, ez * 0.55)];
    wreck.cookoffPops = []; wreck.cookoffIdx = 0;
    if (info.catastrophic) { const pops = 3 + Math.floor(Math.random() * 4); for (let i = 0; i < pops; i++) wreck.cookoffPops.push(0.6 + Math.random() * 3.4); wreck.cookoffPops.sort((a, b) => a - b); }
    wreck.age = 0; wreck.sinkT = 0; wreck.state = 'flight'; wreck.catastrophic = info.catastrophic; wreck.cls = cls; wreck.active = true; wreck.obstacle = null;
    wreck.group.setLocalPosition(0, 0, 0); wreck.group.enabled = true; wreck.fireAccum = wreck.smokeAccum = wreck.emberAccum = 0;
  }

  private _spawnDebrisAndEffects(wreck: Wreck, tank: Tank, info: WreckKillInfo): void {
    const wheeled = tank.stats.drive === 'wheeled', catastrophic = info.catastrophic;
    _t2.sub2(_t1.copy(tank.root.getPosition()).add(_sv.set(0, 1.2, 0)), info.hitPoint); _t2.y = 0;
    if (_t2.lengthSq() < 0.01) _t2.set(0, 0, 1); else _t2.normalize();
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2 + Math.random() * 0.4;
      _t3.set(tank.root.getPosition().x + Math.cos(a) * (2.5 + Math.random() * 3), tank.root.getPosition().y + 0.4, tank.root.getPosition().z + Math.sin(a) * (2.5 + Math.random() * 3));
      this.effects.spawnTrackDust(_t3, catastrophic ? 0.9 : 0.55);
    }
    for (let i = 0; i < 6; i++) {
      _t3.set(tank.root.getPosition().x + (Math.random() - 0.5) * 3, tank.root.getPosition().y + 1 + Math.random() * 2, tank.root.getPosition().z + (Math.random() - 0.5) * 3);
      this.effects.spawnWreckSmoke(_t3);
    }
    this.effects.spawnEmbers(tank.root.getPosition().x, tank.root.getPosition().y + 1.5, tank.root.getPosition().z, catastrophic ? 14 : 7);
    const count = catastrophic ? 20 + Math.floor(Math.random() * 9) : 12 + Math.floor(Math.random() * 7);
    let spawned = 0;
    for (let i = 0; i < count * 3 && spawned < count; i++) {
      const d = this._allocDebris(); if (!d) break;
      const wheel = wheeled && catastrophic && spawned >= count - 2; d.meshIdx = wheel ? 3 : Math.floor(Math.random() * 3);
      const big = Math.random() < 0.1, target = big ? 0.4 + Math.random() * 0.18 : 0.09 + Math.random() * 0.33;
      const a = Math.random() * Math.PI * 2, spd = 3 + Math.random() * (catastrophic ? 9 : 6);
      d.x = tank.root.getPosition().x + Math.cos(a) * Math.random() * 2; d.y = tank.root.getPosition().y + 0.8 + Math.random() * 1.8; d.z = tank.root.getPosition().z + Math.sin(a) * Math.random() * 2;
      d.vx = Math.cos(a) * spd * 0.7 + _t2.x * spd * 0.5; d.vy = 2.5 + Math.random() * (catastrophic ? 8 : 5); d.vz = Math.sin(a) * spd * 0.7 + _t2.z * spd * 0.5;
      d.qx = Math.random() - 0.5; d.qy = Math.random() - 0.5; d.qz = Math.random() - 0.5; d.qw = Math.random();
      const ql = Math.hypot(d.qx, d.qy, d.qz, d.qw) || 1; d.qx /= ql; d.qy /= ql; d.qz /= ql; d.qw /= ql;
      d.wx = (Math.random() - 0.5) * 14; d.wy = (Math.random() - 0.5) * 14; d.wz = (Math.random() - 0.5) * 14;
      if (wheel) {
        const diam = 0.5 + Math.random() * 0.25; d.sx = (0.22 + Math.random() * 0.14) / 0.34; d.sy = d.sz = diam / 1.1; d.radius = diam * 0.5; d.cr = d.cg = 0.1; d.cb = 0.11;
      } else {
        const k = target / this.debrisDiam[d.meshIdx]; d.sx = k * (0.7 + Math.random() * 0.6); d.sy = k * (0.3 + Math.random() * 0.25); d.sz = k * (0.7 + Math.random() * 0.6); d.radius = Math.max(d.sx, d.sy, d.sz) * 0.8;
        const roll = Math.random();
        if (roll < 0.45) { d.cr = 0.05 + Math.random() * 0.03; d.cg = 0.045 + Math.random() * 0.025; d.cb = 0.04 + Math.random() * 0.02; }
        else if (roll < 0.75) {
          if (tank.team === 'blue') { d.cr = 0.26 + Math.random() * 0.1; d.cg = 0.3 + Math.random() * 0.1; d.cb = 0.16 + Math.random() * 0.07; }
          else { d.cr = 0.48 + Math.random() * 0.12; d.cg = 0.38 + Math.random() * 0.1; d.cb = 0.24 + Math.random() * 0.08; }
        } else { d.cr = 0.34 + Math.random() * 0.14; d.cg = 0.35 + Math.random() * 0.14; d.cb = 0.37 + Math.random() * 0.14; }
      }
      d.age = 0; d.life = 6 + Math.random() * 6; d.emitAccum = 0; d.active = true; spawned++;
    }
    void wreck; void info;
  }

  private _listRemove(list: number[], pos: Int32Array, idx: number): void {
    const p = pos[idx], last = list.pop()!;
    if (p < list.length) { list[p] = last; pos[last] = p; }
    pos[idx] = -1;
  }
  private _allocDebris(): Debris | null {
    for (let n = 0; n < DEBRIS_CAP; n++) {
      const idx = (this.debrisCursor + n) % DEBRIS_CAP;
      if (!this.debrisPool[idx].active) {
        this.debrisCursor = (idx + 1) % DEBRIS_CAP;
        if (this.debrisPos[idx] < 0) { this.debrisPos[idx] = this.debrisActiveIdx.length; this.debrisActiveIdx.push(idx); }
        return this.debrisPool[idx];
      }
    }
    return null;
  }

  private _updateDebris(dt: number): void {
    const counts = [0, 0, 0, 0], slots = [0, 0, 0, 0], q = _sq;
    for (let k = this.debrisActiveIdx.length - 1; k >= 0; k--) {
      const i = this.debrisActiveIdx[k], d = this.debrisPool[i]; d.age += dt;
      if (!d.active || d.age >= d.life) { d.active = false; this._listRemove(this.debrisActiveIdx, this.debrisPos, i); continue; }
      const ground = this.world.getHeightAt(d.x, d.z);
      if (d.y - d.radius < ground) {
        d.y = ground + d.radius; this.world.getNormalAt(d.x, d.z, _dn); if (_dn.y < 0.35) _dn.set(0, 1, 0);
        const vn = d.vx * _dn.x + d.vy * _dn.y + d.vz * _dn.z;
        if (vn < 0) {
          const e = -vn < 1.2 ? 0.1 : 0.35;
          d.vx -= (1 + e) * vn * _dn.x; d.vy -= (1 + e) * vn * _dn.y; d.vz -= (1 + e) * vn * _dn.z;
          const dot = d.vx * _dn.x + d.vy * _dn.y + d.vz * _dn.z;
          const tx = (d.vx - _dn.x * dot) * 0.72 + _dn.x * dot, ty = (d.vy - _dn.y * dot) * 0.72 + _dn.y * dot, tz = (d.vz - _dn.z * dot) * 0.72 + _dn.z * dot;
          d.vx = tx; d.vy = ty; d.vz = tz; d.wx *= 0.7; d.wy *= 0.7; d.wz *= 0.7;
        }
      }
      d.vy -= GRAVITY * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      const wl = Math.hypot(d.wx, d.wy, d.wz);
      if (wl > 1e-5) {
        const ang = wl * dt, s = Math.sin(ang / 2);
        _wq.set(d.wx / wl * s, d.wy / wl * s, d.wz / wl * s, Math.cos(ang / 2));
        q.set(d.qx, d.qy, d.qz, d.qw); q.mul2(_wq, q).normalize(); d.qx = q.x; d.qy = q.y; d.qz = q.z; d.qw = q.w;
        const damp = Math.exp(-0.8 * dt); d.wx *= damp; d.wy *= damp; d.wz *= damp;
      }
      if (d.meshIdx < 3 && d.vx * d.vx + d.vy * d.vy + d.vz * d.vz < 1.2 && d.y - d.radius < ground + 0.2) {
        _dq2.set(0, 0, 0, 1); q.set(d.qx, d.qy, d.qz, d.qw).slerp(q, _dq2, Math.min(1, dt * 5)).normalize();
        d.qx = q.x; d.qy = q.y; d.qz = q.z; d.qw = q.w;
        const damp = Math.exp(-6 * dt); d.wx *= damp; d.wy *= damp; d.wz *= damp;
      }
      if (d.age < 1.5 && d.vx * d.vx + d.vy * d.vy + d.vz * d.vz > 1) {
        d.emitAccum += dt; if (d.emitAccum > 0.14) { d.emitAccum = 0; this.effects.spawnWreckSmoke(_t3.set(d.x, d.y, d.z)); }
      }
      const slot = slots[d.meshIdx]++; if (slot >= DEBRIS_PER_MESH) continue;
      _sv.set(d.sx, d.sy, d.sz); q.set(d.qx, d.qy, d.qz, d.qw); _t3.set(d.x, d.y, d.z);
      const im = this.debrisMeshes[d.meshIdx]; im.setMatrixAt(slot, composeMat(this.debrisMat4, _t3, q, _sv)); im.setColorAt(slot, d.cr, d.cg, d.cb); counts[d.meshIdx]++;
    }
    for (let m = 0; m < DEBRIS_MESHES; m++) { const im = this.debrisMeshes[m]; im.count = counts[m]; im.update(); }
  }

  private _collideTurretHull(wreck: Wreck): void {
    const tb = wreck.turretBody!, hb = wreck.hullBody; if (tb.asleep && hb.asleep) return;
    _qi.copy(hb.quat).invert();
    const ex = tb.hasCollideBox ? tb.collideHalf.x : tb.half.x, ey = tb.hasCollideBox ? tb.collideHalf.y : tb.half.y, ez = tb.hasCollideBox ? tb.collideHalf.z : tb.half.z;
    const ox = tb.hasCollideBox ? tb.collideOffset.x : 0, oy = tb.hasCollideBox ? tb.collideOffset.y : 0, oz = tb.hasCollideBox ? tb.collideOffset.z : 0;
    let maxPen = 0; _t3.set(0, 0, 0);
    for (let cx = -1; cx <= 1; cx += 2) for (let cy = -1; cy <= 1; cy += 2) for (let cz = -1; cz <= 1; cz += 2) {
      applyQuat(_local.set(cx * ex + ox, cy * ey + oy, cz * ez + oz), tb.quat, _corner).add(tb.pos);
      applyQuat(_t1.sub2(_corner, hb.pos), _qi);
      const px = clamp(_t1.x, -hb.half.x, hb.half.x), py = clamp(_t1.y, -hb.half.y, hb.half.y), pz = clamp(_t1.z, -hb.half.z, hb.half.z);
      const dx = _t1.x - px, dy = _t1.y - py, dz = _t1.z - pz, d2 = dx * dx + dy * dy + dz * dz, margin = 0.03;
      if (d2 < margin * margin && d2 > 1e-9) {
        const pen = margin - Math.sqrt(d2); if (pen > maxPen) { maxPen = pen; _t3.set(dx, dy, dz).normalize(); }
      } else if (d2 <= 1e-9) {
        const pdx = hb.half.x - Math.abs(_t1.x), pdy = hb.half.y - Math.abs(_t1.y), pdz = hb.half.z - Math.abs(_t1.z);
        let best = pdx, ax = Math.sign(_t1.x) || 1, ay = 0, az = 0;
        if (pdy < best) { best = pdy; ax = 0; ay = Math.sign(_t1.y) || 1; }
        if (pdz < best) { best = pdz; ax = 0; ay = 0; az = Math.sign(_t1.z) || 1; }
        _t3.set(ax, ay, az); maxPen = Math.max(maxPen, best + margin);
      }
    }
    if (maxPen > 0 && _t3.lengthSq() > 0.5) {
      applyQuat(_t3, hb.quat, _t1).mulScalar(maxPen * 0.8); tb.pos.add(_t1);
      const inv = 1 / Math.max(_t1.length(), 1e-6), rel = tb.vel.dot(_t1) * inv;
      if (rel < 0) tb.vel.addScaled(_t1, -rel * 1.2 * inv);
    }
    if (tb.hasTip) {
      applyQuat(tb.tipOffset, tb.quat, _corner).add(tb.pos); applyQuat(_t1.sub2(_corner, hb.pos), _qi);
      const dx = _t1.x - clamp(_t1.x, -hb.half.x, hb.half.x), dy = _t1.y - clamp(_t1.y, -hb.half.y, hb.half.y), dz = _t1.z - clamp(_t1.z, -hb.half.z, hb.half.z);
      const d = Math.hypot(dx, dy, dz), r = 0.14;
      if (d < r) {
        if (d > 1e-6) _t2.set(dx, dy, dz).normalize(); else _t2.set(0, 1, 0);
        applyQuat(_t2, hb.quat, _t3).mulScalar((r - d) * 0.8); tb.pos.add(_t3);
        const inv = 1 / Math.max(_t3.length(), 1e-6), rel = tb.vel.dot(_t3) * inv;
        if (rel < 0) tb.vel.addScaled(_t3, -rel * 1.2 * inv);
      }
    }
  }

  private _registerObstacle(wreck: Wreck): void {
    const hb = wreck.hullBody;
    const obs: ObstacleCollider = { id: `wreck_${this.wreckIdCounter++}`, kind: 'barrier', x: hb.pos.x, z: hb.pos.z,
      y: this.world.getHeightAt(hb.pos.x, hb.pos.z) - 0.4, radius: Math.max(hb.half.x, hb.half.z) * 0.85,
      height: hb.half.y * 2 + 0.6, destructible: false, destroyed: false };
    wreck.obstacle = obs; this.world.addObstacle(obs);
  }
  private _beginSink(wreck: Wreck): void {
    if (wreck.state === 'sinking' || wreck.state === 'dead') return;
    wreck.state = 'sinking'; wreck.sinkT = 0; wreck.hullBody.asleep = true; wreck.hullBody.vel.set(0, 0, 0);
    if (wreck.turretBody) { wreck.turretBody.asleep = true; wreck.turretBody.vel.set(0, 0, 0); }
  }
  private _recycle(wreck: Wreck): void {
    wreck.active = false; wreck.state = 'dead'; wreck.group.enabled = false;
    if (wreck.obstacle) { this.world.removeObstacle(wreck.obstacle); wreck.obstacle = null; }
  }

  public fxRateMul = 1;
  public maxFireWrecks = Infinity;
  private _emitEffects(wreck: Wreck, dt: number, _cameraPos: Vec3): void {
    const burning = wreck.age < 20, dying = wreck.age >= 20 && wreck.age < 35;
    let emitCount = 0;
    for (const e of wreck.emitters) { if (emitCount >= wreck.emitWorld.length) break; applyQuat(e, wreck.hullBody.quat, wreck.emitWorld[emitCount++]).add(wreck.hullBody.pos); }
    const fxDt = dt * this.fxRateMul;
    wreck.fireAccum += fxDt;
    let fireRate = burning ? 0.055 : dying ? 0.16 : 0;
    if (fireRate > 0 && this.maxFireWrecks < Infinity) {
      let younger = 0; for (const w of this.wrecks) if (w !== wreck && w.active && w.age < 35 && w.age < wreck.age) younger++;
      if (younger >= this.maxFireWrecks) fireRate = 0;
    }
    if (fireRate > 0 && wreck.fireAccum >= fireRate) {
      wreck.fireAccum = 0;
      for (let i = 0; i < (burning ? emitCount : Math.min(2, emitCount)); i++) for (let k = 0; k < (burning ? 2 : 1); k++) {
        const p = wreck.emitWorld[i]; this.effects.spawnWreckFire(p.x, p.y, p.z, burning ? 1 : 0.55);
      }
    }
    wreck.smokeAccum += fxDt;
    if (wreck.smokeAccum >= (wreck.age < 35 ? 0.15 : 0.3)) {
      wreck.smokeAccum = 0; _t3.copy(wreck.emitWorld[Math.floor(Math.random() * emitCount)]); _t3.y += 0.8; this.effects.spawnWreckSmoke(_t3);
    }
    wreck.emberAccum += fxDt;
    if (burning && wreck.emberAccum >= 0.45) {
      wreck.emberAccum = 0; const p = wreck.emitWorld[Math.floor(Math.random() * emitCount)]; this.effects.spawnEmbers(p.x, p.y + 0.4, p.z, 4);
    }
    while (wreck.cookoffIdx < wreck.cookoffPops.length && wreck.age >= wreck.cookoffPops[wreck.cookoffIdx]) {
      wreck.cookoffIdx++; const p = wreck.emitWorld[0]; if (!p || !this.effects.wreckFxVisible) continue;
      _t3.set(p.x, p.y + 0.6, p.z); this.effects.spawnExplosion(_t3, _dn.set(0, 1, 0), 0.55, 'he_armor'); this.effects.spawnEmbers(p.x, p.y + 0.8, p.z, 8);
      for (let k = 0; k < 4; k++) this.effects.spawnWreckFire(p.x + Math.random() - 0.5, p.y + 0.8 + Math.random() * 0.6, p.z + Math.random() - 0.5, 1.6);
      this.applyBlast(_t3, 4, 7);
    }
  }

  private _updateWreckLights(dt: number, cameraPos: Vec3): void {
    this.lightScanTimer -= dt;
    if (this.lightScanTimer <= 0) {
      this.lightScanTimer = 0.35;
      let b0: Wreck | null = null, b1: Wreck | null = null, d0 = Infinity, d1 = Infinity;
      for (const w of this.wrecks) {
        if (!w.active || w.age >= 35) continue;
        const d = distSq(w.hullBody.pos, cameraPos);
        if (d < d0) { d1 = d0; b1 = b0; d0 = d; b0 = w; } else if (d < d1) { d1 = d; b1 = w; }
      }
      this.lightTargets[0] = b0; this.lightTargets[1] = b1;
    }
    for (let i = 0; i < 2; i++) {
      const light = this.wreckLights[i], w = this.lightTargets[i];
      if (!w || !w.active || w.age >= 40) { light.light!.intensity = 0; continue; }
      const flick = 0.72 + 0.28 * Math.sin(SHARED_BURN_TIME * 11 + w.seed * 7) * Math.sin(SHARED_BURN_TIME * 23 + w.seed * 3);
      light.light!.intensity = 34 * flick * Math.max(0, 1 - w.age / 40) / Math.PI;
      light.setPosition(w.hullBody.pos.x, w.hullBody.pos.y + w.hullBody.half.y + 0.8, w.hullBody.pos.z);
    }
  }
}

const _turretInvScratch = new Mat4();
function turretWorldMatrixInv(tank: Tank): Mat4 { return _turretInvScratch.copy(tank.rig.turretPivot.getWorldTransform()).invert(); }
const _sv2 = new Vec3(), _pv = new Vec3();
