import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { EffectsManager } from './Effects';
import type { World } from './World';
import type { ObstacleCollider, Team, VehicleClass, WreckKillInfo } from './types';
import { denormalizeGeo, instantiateTankRig, type LoadedGameAssets } from './AssetLoader';
import type { Tank } from './Tank';

// ---------------------------------------------------------------------------
// Rigid-body wreck physics: box bodies vs the terrain heightfield.
// 2 substeps/frame, sequential impulses (normal + Coulomb friction), Baumgarte
// position correction, sleep/wake. All scratch objects are module-level so the
// hot loop allocates nothing.
// ---------------------------------------------------------------------------

const GRAVITY = 9.81;
const PHYS_SUBSTEPS = 2;
const SLEEP_LIN = 0.15;
const SLEEP_ANG = 0.2;
const SLEEP_TIME = 0.6;
const MU = 0.7;
const RESTITUTION = 0.2;

class RigidBody {
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly vel = new THREE.Vector3();
  readonly angVel = new THREE.Vector3();
  readonly half = new THREE.Vector3();
  invMass = 0;
  readonly invInertia = new THREE.Vector3(); // body-space diagonal
  asleep = false;
  sleepTimer = 0;
  active = false;
  /** Real surface vertices (box-centred space) used as terrain contacts.
   *  Null → fall back to the 8 OBB corners. */
  contactPoints: Float32Array | null = null;
  /** Turret-vs-hull collision box (excludes the gun barrel), body-space. */
  readonly collideOffset = new THREE.Vector3();
  readonly collideHalf = new THREE.Vector3();
  hasCollideBox = false;
  /** Barrel/muzzle tip as a thin extra contact point, body-space. */
  readonly tipOffset = new THREE.Vector3();
  hasTip = false;
}

const _qi = new THREE.Quaternion();
const _omQ = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _cw = new THREE.Vector3();
const _r = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _n = new THREE.Vector3();
const _rn = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _J = new THREE.Vector3();
const _local = new THREE.Vector3();
const _corner = new THREE.Vector3();

function applyInvInertiaWorld(body: RigidBody, v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  _qi.copy(body.quat).invert();
  out.copy(v).applyQuaternion(_qi);
  out.x *= body.invInertia.x;
  out.y *= body.invInertia.y;
  out.z *= body.invInertia.z;
  return out.applyQuaternion(body.quat);
}

interface ContactAccum {
  jnSum: number;
  deepPen: boolean;
}
const _cacc: ContactAccum = { jnSum: 0, deepPen: false };

// One terrain contact at a body-space point (box corner or real surface vertex).
function applyTerrainContact(
  body: RigidBody,
  world: World,
  n: THREE.Vector3,
  lx: number,
  ly: number,
  lz: number,
  acc: ContactAccum
): void {
  _local.set(lx, ly, lz);
  _corner.copy(_local).applyQuaternion(body.quat).add(body.pos);
  const ground = world.getHeightAt(_corner.x, _corner.z);
  const pen = ground - _corner.y;
  if (pen <= 0) return;
  // Only genuinely buried contacts (>15cm) block sleep — on rough terrain a
  // rigid wreck always has some vertex dipped into a hollow, and blocking
  // sleep on that kept wrecks jittering forever.
  if (pen > 0.15) acc.deepPen = true;

  _r.subVectors(_corner, body.pos);
  // vContact = vel + angVel × r
  _vC.copy(body.angVel).cross(_r).add(body.vel);
  const vn = _vC.dot(n);
  let jn = 0;
  if (vn < 0) {
    const e = -vn < 1.0 ? 0 : RESTITUTION;
    _rn.crossVectors(_r, n);
    applyInvInertiaWorld(body, _rn, _t1);
    const denom = body.invMass + _rn.dot(_t1);
    jn = (-(1 + e) * vn) / denom;
    _J.copy(n).multiplyScalar(jn);
    body.vel.addScaledVector(_J, body.invMass);
    _t2.crossVectors(_r, _J);
    applyInvInertiaWorld(body, _t2, _t3);
    body.angVel.add(_t3);
    acc.jnSum += jn;
  }

  // Coulomb friction along the contact tangent (clamped by accumulated normal impulse)
  _vC.copy(body.angVel).cross(_r).add(body.vel);
  const vn2 = _vC.dot(n);
  _t1.copy(_vC).addScaledVector(n, -vn2);
  const vtLen = _t1.length();
  if (vtLen > 1e-4 && jn > 0) {
    // Per-contact Coulomb clamp: this contact's own normal impulse only.
    // (Clamping by the substep-wide jnSum let later contacts grab absurd
    // friction and froze wrecks mid-tumble.)
    const maxF = MU * jn;
    _rn.crossVectors(_r, _t1).normalize();
    applyInvInertiaWorld(body, _rn, _t2);
    const denomT = body.invMass + Math.abs(_rn.dot(_t2));
    const jtMag = Math.min(vtLen / Math.max(denomT, 1e-6), maxF);
    _t1.multiplyScalar(-jtMag / Math.max(vtLen, 1e-6));
    body.vel.addScaledVector(_t1, body.invMass);
    _t2.crossVectors(_r, _t1);
    applyInvInertiaWorld(body, _t2, _t3);
    body.angVel.add(_t3);
  }

  // Baumgarte position correction (slop 0.01, factor 0.4)
  const corr = Math.max(pen - 0.01, 0) * 0.4;
  if (corr > 0) body.pos.addScaledVector(n, corr);
}

function stepBody(body: RigidBody, world: World, h: number): void {
  if (body.asleep || !body.active) return;

  body.vel.y -= GRAVITY * h;
  const linDamp = Math.exp(-0.35 * h);
  const angDamp = Math.exp(-0.9 * h);
  body.vel.multiplyScalar(linDamp);
  body.angVel.multiplyScalar(angDamp);

  body.pos.addScaledVector(body.vel, h);

  // Quaternion integration: q += 0.5 * h * (omega ⊗ q)
  _omQ.set(body.angVel.x, body.angVel.y, body.angVel.z, 0);
  _dq.copy(_omQ).multiply(body.quat);
  const hq = 0.5 * h;
  body.quat.set(
    body.quat.x + _dq.x * hq,
    body.quat.y + _dq.y * hq,
    body.quat.z + _dq.z * hq,
    body.quat.w + _dq.w * hq
  ).normalize();

  // --- Terrain contacts ---
  // Real surface vertices when available (wrecks rest on actual armor
  // contours, not empty OBB corners); else the 8 box corners.
  world.getNormalAt(body.pos.x, body.pos.z, _n);
  if (_n.y < 0.35) _n.set(0, 1, 0); // steep face: treat as flat to stay stable
  const acc = _cacc;
  acc.jnSum = 0;
  acc.deepPen = false;

  const cps = body.contactPoints;
  if (cps && cps.length >= 9) {
    for (let i = 0; i < cps.length; i += 3) {
      applyTerrainContact(body, world, _n, cps[i], cps[i + 1], cps[i + 2], acc);
    }
  } else {
    const hx = body.half.x;
    const hy = body.half.y;
    const hz = body.half.z;
    for (let cx = -1; cx <= 1; cx += 2) {
      for (let cy = -1; cy <= 1; cy += 2) {
        for (let cz = -1; cz <= 1; cz += 2) {
          applyTerrainContact(body, world, _n, cx * hx, cy * hy, cz * hz, acc);
        }
      }
    }
  }
  // Thin barrel/muzzle tip — guarantees the gun tip never sinks even if the
  // surface sampling missed that vertex.
  if (body.hasTip) {
    applyTerrainContact(body, world, _n, body.tipOffset.x, body.tipOffset.y, body.tipOffset.z, acc);
  }

  // Sleep / wake bookkeeping — a penetrating contact delays sleep (the body
  // gets more time to climb out), but a body that stays slow anyway eventually
  // sleeps: on rough terrain some vertex always sits in a hollow, and blocking
  // sleep on that kept wrecks jittering forever.
  const linSpeed = body.vel.length();
  const angSpeed = body.angVel.length();
  if (linSpeed < SLEEP_LIN && angSpeed < SLEEP_ANG) {
    body.sleepTimer += h;
    const need = acc.deepPen ? 3.0 : SLEEP_TIME;
    if (body.sleepTimer >= need) {
      body.asleep = true;
      body.vel.set(0, 0, 0);
      body.angVel.set(0, 0, 0);
    }
  } else {
    body.sleepTimer = 0;
  }
}

// Smallest angle (deg) between any of the body's local axes and the terrain
// normal under it: 0 = resting flat on a face, 45 = balanced on an edge.
function bodyTiltDeg(body: RigidBody, world: World): number {
  world.getNormalAt(body.pos.x, body.pos.z, _n);
  if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
  _n.normalize();
  _t1.set(1, 0, 0).applyQuaternion(body.quat);
  _t2.set(0, 1, 0).applyQuaternion(body.quat);
  _t3.set(0, 0, 1).applyQuaternion(body.quat);
  const d = Math.max(
    Math.abs(_t1.dot(_n)),
    Math.abs(_t2.dot(_n)),
    Math.abs(_t3.dot(_n))
  );
  return Math.acos(Math.min(1, d)) * (180 / Math.PI);
}

// ---------------------------------------------------------------------------
// Geometry baking: clone source meshes, bake world matrices into part-local
// space, group by material, merge. Cached per vehicle class+team so repeat
// kills only re-pose shared geometry (zero bake cost after first kill).
// ---------------------------------------------------------------------------

interface BakedEntry {
  geo: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}

interface BakedPart {
  entries: BakedEntry[];
  /** Part-local bounding box of the merged result */
  box: THREE.Box3;
  /** Box centre in part-local space (geometry is re-centred on it) */
  center: THREE.Vector3;
  half: THREE.Vector3;
  /** Real surface vertices near the bbox extremes (box-centred xyz triples).
   *  Used as terrain contact points so wrecks rest on actual armor, not on
   *  empty OBB corners (e.g. the space beside a long gun barrel). */
  contacts: Float32Array;
  /** Connected components removed as whips by the bake filter (diagnostics) */
  whipComponents: number;
  /** Triangles dropped with those components (diagnostics) */
  whipDroppedTris: number;
}

interface TurretCollide {
  /** Turret-only (no gun barrel) box centre, body-space (relative to the
   *  full-part box centre) */
  offset: THREE.Vector3;
  half: THREE.Vector3;
  /** Muzzle/barrel tip, body-space — thin extra contact vs hull & terrain */
  tip: THREE.Vector3 | null;
}

interface ClassGeo {
  hull: BakedPart;
  turret: BakedPart | null;
  /** Turret collision box excluding the gun subtree, body-space */
  turretCollide: TurretCollide | null;
  /** restRel = root^-1 * turretPivot (turret-local -> hull-local) for merged pose */
  turretRestRel: THREE.Matrix4 | null;
}

const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

function normalizeGeo(geo: THREE.BufferGeometry): void {
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') {
      geo.deleteAttribute(name);
    }
  }
  const count = geo.attributes.position.count;
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
}

function collectMeshes(root: THREE.Object3D, skip: THREE.Object3D | null, out: THREE.Mesh[]): void {
  if (skip && root === skip) return;
  const mesh = root as THREE.Mesh;
  if (mesh.isMesh && mesh.geometry && !(mesh as THREE.InstancedMesh).isInstancedMesh) out.push(mesh);
  for (const child of root.children) collectMeshes(child, skip, out);
}

function isDescendantOf(node: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let p: THREE.Object3D | null = node;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
}

function bakePart(
  meshes: THREE.Mesh[],
  spaceWorldInv: THREE.Matrix4
): BakedPart {
  // Group cloned geometries by material key
  const groups = new Map<string, { mat: THREE.Material | THREE.Material[]; geos: THREE.BufferGeometry[] }>();
  for (const mesh of meshes) {
    _m1.copy(spaceWorldInv).multiply(mesh.matrixWorld);
    const geo = mesh.geometry.clone();
    denormalizeGeo(geo);
    geo.applyMatrix4(_m1);
    normalizeGeo(geo);
    const mat = mesh.material;
    const key = Array.isArray(mat) ? `multi:${mesh.uuid}` : mat.uuid;
    let g = groups.get(key);
    if (!g) {
      g = { mat, geos: [] };
      groups.set(key, g);
    }
    g.geos.push(geo);
  }

  const entries: BakedEntry[] = [];
  for (const g of groups.values()) {
    let geos = g.geos;
    // mergeGeometries requires uniform index-ness
    const anyIndexed = geos.some((x) => !!x.index);
    const allIndexed = geos.every((x) => !!x.index);
    if (anyIndexed && !allIndexed) {
      geos = geos.map((x) => (x.index ? x.toNonIndexed() : x));
    }
    if (Array.isArray(g.mat)) {
      // Multi-material source meshes stay unmerged (groups preserved by applyMatrix4)
      for (const geo of geos) entries.push({ geo, material: g.mat });
      continue;
    }
    const merged = mergeGeometries(geos, false);
    if (merged) {
      entries.push({ geo: merged, material: g.mat });
    } else {
      for (const geo of geos) entries.push({ geo, material: g.mat });
    }
  }

  // Whip filter, then bounds from surviving vertices only
  const filter = computeWhipFilter(entries);
  for (let i = 0; i < entries.length; i++) {
    const flags = filter.dropTris[i];
    if (flags) dropTrianglesByFlag(entries[i].geo, flags);
  }
  const box = filter.box;
  const center = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  // Re-centre geometry on the box centre so bodies rotate about their middle
  for (const e of entries) e.geo.translate(-center.x, -center.y, -center.z);
  return {
    entries,
    box,
    center,
    half,
    contacts: supportContactPoints(filter.reps, center),
    whipComponents: filter.whipComponents,
    whipDroppedTris: filter.droppedTriangles,
  };
}

// ---------------------------------------------------------------------------
// Whip filter (topological). Vertices are welded by position (1 mm) across all
// of a part's merged entries and union-find over shared welded vertices yields
// connected components. A component is a whip iff its bbox has its two smallest
// dimensions < 0.08 m and its largest > 0.4 m — thin antennas and rods only.
// Armour panels stay connected to the hull no matter how sparse their vertex
// layout, so nothing else is ever removed. Whip triangles are dropped from the
// render geometry and excluded from bounds/contact reps so wrecks neither show
// nor balance on antenna tips. Runs once per class+team — geometry is cached.
// ---------------------------------------------------------------------------

const WHIP_CELL = 0.25;
const WHIP_OFF = 4096;
const WHIP_SPAN = 8192;
const WHIP_VOL = WHIP_SPAN * WHIP_SPAN;

function whipKeyIdx(ix: number, iy: number, iz: number): number {
  return (ix + WHIP_OFF) * WHIP_VOL + (iy + WHIP_OFF) * WHIP_SPAN + (iz + WHIP_OFF);
}

function whipKeyPos(x: number, y: number, z: number): number {
  return whipKeyIdx(
    Math.floor(x / WHIP_CELL),
    Math.floor(y / WHIP_CELL),
    Math.floor(z / WHIP_CELL)
  );
}

// Weld quantization: 1 mm cells. Part-local coords stay well inside ±40 m, so
// the packed key fits in a JS-safe integer (< 2^53).
const WELD_Q = 1000;
const WELD_OFF = 40000;
const WELD_SPAN = 80000; // 2 * WELD_OFF

function weldKey(x: number, y: number, z: number): number {
  const qx = Math.round(x * WELD_Q) + WELD_OFF;
  const qy = Math.round(y * WELD_Q) + WELD_OFF;
  const qz = Math.round(z * WELD_Q) + WELD_OFF;
  return (qx * WELD_SPAN + qy) * WELD_SPAN + qz;
}

interface WhipFilter {
  /** Per-entry triangle drop flags, parallel to entries (null = keep all) */
  dropTris: (Uint8Array | null)[];
  /** One representative vertex per occupied 0.25 m cell of surviving verts, part-local xyz */
  reps: Float32Array;
  /** Bounds over surviving verts, part-local */
  box: THREE.Box3;
  whipComponents: number;
  droppedTriangles: number;
}

function computeWhipFilter(entries: BakedEntry[]): WhipFilter {
  const dropTris: (Uint8Array | null)[] = new Array(entries.length).fill(null);

  // Union-find over welded vertex positions across every entry of the part.
  const parent = new Map<number, number>();
  const find = (k: number): number => {
    let root = k;
    for (;;) {
      const p = parent.get(root);
      if (p === undefined || p === root) break;
      root = p;
    }
    let c = k;
    while (c !== root) {
      const p = parent.get(c);
      if (p === undefined) break;
      parent.set(c, root);
      c = p;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  interface EntryTris {
    entryIdx: number;
    pos: THREE.BufferAttribute;
    index: ArrayLike<number> | null;
    triCount: number;
    /** Welded key of each triangle's first vertex (component lookup) */
    triK0: number[];
  }
  const parts: EntryTris[] = [];
  const keepVerts: Uint8Array[] = [];

  // Pass 1: weld vertices and union every triangle's corners into components
  for (let ei = 0; ei < entries.length; ei++) {
    const geo = entries[ei].geo;
    const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    const index = geo.index ? (geo.index.array as ArrayLike<number>) : null;
    const triCount = index
      ? Math.floor(index.length / 3)
      : Math.floor(pos.count / 3);
    // Welded key per vertex slot, lazily filled (-1 = unset; keys are >= 0 for
    // any part-local coord inside ±40 m, which vehicle parts always are)
    const vkeys = new Array<number>(pos.count).fill(-1);
    const keyOf = (vi: number): number => {
      let k = vkeys[vi];
      if (k < 0) {
        k = weldKey(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
        vkeys[vi] = k;
        if (!parent.has(k)) parent.set(k, k);
      }
      return k;
    };
    const triK0 = new Array<number>(triCount);
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index[t * 3] : t * 3;
      const i1 = index ? index[t * 3 + 1] : t * 3 + 1;
      const i2 = index ? index[t * 3 + 2] : t * 3 + 2;
      const k0 = keyOf(i0);
      const k1 = keyOf(i1);
      const k2 = keyOf(i2);
      union(k0, k1);
      union(k1, k2);
      triK0[t] = k0;
    }
    parts.push({ entryIdx: ei, pos, index, triCount, triK0 });
    keepVerts.push(new Uint8Array(pos.count));
  }

  // Pass 2: bounding box per connected component
  const compBounds = new Map<number, number[]>(); // root -> [minx,miny,minz,maxx,maxy,maxz]
  for (const pt of parts) {
    const { pos, index, triCount, triK0 } = pt;
    for (let t = 0; t < triCount; t++) {
      const root = find(triK0[t]);
      let b = compBounds.get(root);
      if (!b) {
        b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        compBounds.set(root, b);
      }
      for (let c = 0; c < 3; c++) {
        const vi = index ? index[t * 3 + c] : t * 3 + c;
        const x = pos.getX(vi);
        const y = pos.getY(vi);
        const z = pos.getZ(vi);
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (z < b[2]) b[2] = z;
        if (x > b[3]) b[3] = x;
        if (y > b[4]) b[4] = y;
        if (z > b[5]) b[5] = z;
      }
    }
  }

  // Pass 3: a component is a whip iff two smallest bbox dims < 0.08 m and the
  // largest > 0.4 m (antennas, whips, thin rods). Nothing else qualifies.
  const whipRoots = new Set<number>();
  let compCount = 0;
  for (const [root, b] of compBounds) {
    compCount++;
    const dx = b[3] - b[0];
    const dy = b[4] - b[1];
    const dz = b[5] - b[2];
    const dMin = Math.min(dx, dy, dz);
    const dMax = Math.max(dx, dy, dz);
    const dMid = dx + dy + dz - dMin - dMax;
    if (dMin < 0.08 && dMid < 0.08 && dMax > 0.4) whipRoots.add(root);
  }
  // Degenerate guard: never filter away an entire part
  if (whipRoots.size === compCount) whipRoots.clear();

  // Pass 4: flag whip triangles; mark vertices of surviving triangles
  let droppedTriangles = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const pt = parts[pi];
    const drop = new Uint8Array(pt.triCount);
    const keep = keepVerts[pi];
    let anyDrop = false;
    for (let t = 0; t < pt.triCount; t++) {
      if (whipRoots.size > 0 && whipRoots.has(find(pt.triK0[t]))) {
        drop[t] = 1;
        anyDrop = true;
        droppedTriangles++;
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const vi = pt.index ? pt.index[t * 3 + c] : t * 3 + c;
        keep[vi] = 1;
      }
    }
    dropTris[pt.entryIdx] = anyDrop ? drop : null;
  }

  // Pass 5: bounds + one 0.25 m cell representative per surviving vertex
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const repsArr: number[] = [];
  const seenCells = new Set<number>();
  for (let pi = 0; pi < parts.length; pi++) {
    const pt = parts[pi];
    const keep = keepVerts[pi];
    const { pos } = pt;
    for (let vi = 0; vi < pos.count; vi++) {
      if (!keep[vi]) continue;
      const x = pos.getX(vi);
      const y = pos.getY(vi);
      const z = pos.getZ(vi);
      if (x < min.x) min.x = x;
      if (y < min.y) min.y = y;
      if (z < min.z) min.z = z;
      if (x > max.x) max.x = x;
      if (y > max.y) max.y = y;
      if (z > max.z) max.z = z;
      const cell = whipKeyPos(x, y, z);
      if (!seenCells.has(cell)) {
        seenCells.add(cell);
        repsArr.push(x, y, z);
      }
    }
  }
  const box = new THREE.Box3(min, max);
  if (box.isEmpty()) {
    box.min.set(-0.5, -0.5, -0.5);
    box.max.set(0.5, 0.5, 0.5);
  }
  return {
    dropTris,
    reps: new Float32Array(repsArr),
    box,
    whipComponents: whipRoots.size,
    droppedTriangles,
  };
}

// Drop flagged triangles and compact vertices/attributes so dead whip tips
// are never seen by probes or queries. Indexed geos keep an index buffer;
// non-indexed geos stay non-indexed.
function dropTrianglesByFlag(geo: THREE.BufferGeometry, drop: Uint8Array): void {
  const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
  if (!pos) return;
  const idx = geo.index;
  const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
  const remap = new Int32Array(pos.count).fill(-1);
  let newCount = 0;
  let newIndex: number[] | null = null;

  if (idx) {
    const arr = idx.array;
    newIndex = [];
    for (let t = 0; t < triCount; t++) {
      if (drop[t]) continue;
      const a = arr[t * 3];
      const b = arr[t * 3 + 1];
      const c = arr[t * 3 + 2];
      if (remap[a] < 0) remap[a] = newCount++;
      if (remap[b] < 0) remap[b] = newCount++;
      if (remap[c] < 0) remap[c] = newCount++;
      newIndex.push(remap[a], remap[b], remap[c]);
    }
  } else {
    for (let t = 0; t < triCount; t++) {
      if (drop[t]) continue;
      const v = t * 3;
      remap[v] = newCount++;
      remap[v + 1] = newCount++;
      remap[v + 2] = newCount++;
    }
  }

  // Rebuild every attribute keeping only remapped vertices
  for (const name of Object.keys(geo.attributes)) {
    const attr = geo.attributes[name] as THREE.BufferAttribute;
    const is = attr.itemSize;
    const src = attr.array as unknown as { [k: number]: number; constructor: new (n: number) => typeof attr.array };
    const outArr = new src.constructor(newCount * is);
    for (let v = 0; v < pos.count; v++) {
      const nv = remap[v];
      if (nv < 0) continue;
      const s = v * is;
      const d = nv * is;
      for (let c = 0; c < is; c++) outArr[d + c] = src[s + c];
    }
    geo.setAttribute(name, new THREE.BufferAttribute(outArr, is, attr.normalized));
  }
  if (newIndex) geo.setIndex(newIndex);
  else geo.index = null;
}

// ---------------------------------------------------------------------------
// Contact sampling: 98 Fibonacci-sphere directions; per direction the surviving
// cell representative with max dot product becomes a contact point (deduped).
// These are the body's true support extremes — wrecks rest on real armor
// contours instead of empty OBB corners (the classic long-barrel turret float).
// ---------------------------------------------------------------------------

const SUPPORT_DIR_COUNT = 98;
const SUPPORT_DIRS = new Float32Array(SUPPORT_DIR_COUNT * 3);
(function initSupportDirs(): void {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < SUPPORT_DIR_COUNT; i++) {
    const y = 1 - (2 * i + 1) / SUPPORT_DIR_COUNT;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * golden;
    SUPPORT_DIRS[i * 3] = Math.cos(th) * r;
    SUPPORT_DIRS[i * 3 + 1] = y;
    SUPPORT_DIRS[i * 3 + 2] = Math.sin(th) * r;
  }
})();

function supportContactPoints(reps: Float32Array, center: THREE.Vector3): Float32Array {
  const out: number[] = [];
  const seen = new Set<number>();
  const n = reps.length / 3;
  for (let d = 0; d < SUPPORT_DIR_COUNT; d++) {
    const dx = SUPPORT_DIRS[d * 3];
    const dy = SUPPORT_DIRS[d * 3 + 1];
    const dz = SUPPORT_DIRS[d * 3 + 2];
    let best = -Infinity;
    let bestI = -1;
    for (let i = 0; i < n; i++) {
      const dot = dx * reps[i * 3] + dy * reps[i * 3 + 1] + dz * reps[i * 3 + 2];
      if (dot > best) {
        best = dot;
        bestI = i;
      }
    }
    if (bestI >= 0 && !seen.has(bestI)) {
      seen.add(bestI);
      out.push(
        reps[bestI * 3] - center.x,
        reps[bestI * 3 + 1] - center.y,
        reps[bestI * 3 + 2] - center.z
      );
    }
  }
  return new Float32Array(out);
}

// Bounding box of a mesh list in a target space, without cloning geometry.
// Used for the turret-only collision box (gun barrel excluded).
function bakeBoundsOnly(meshes: THREE.Mesh[], spaceWorldInv: THREE.Matrix4, out: THREE.Box3): void {
  out.makeEmpty();
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) continue;
    _m1.copy(spaceWorldInv).multiply(mesh.matrixWorld);
    for (let cx = 0; cx <= 1; cx++) {
      for (let cy = 0; cy <= 1; cy++) {
        for (let cz = 0; cz <= 1; cz++) {
          _corner.set(
            cx ? bb.max.x : bb.min.x,
            cy ? bb.max.y : bb.min.y,
            cz ? bb.max.z : bb.min.z
          ).applyMatrix4(_m1);
          out.expandByPoint(_corner);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Burnt-material shader: char mask (fbm biased to upper hull + hit point),
// rust/ash palette, roughness/metalness shift, cooling ember emissive.
// One program for every wreck material (shared cache key).
// ---------------------------------------------------------------------------

interface BurnUniforms {
  uBurn: { value: number };
  uHeat: { value: number };
  uHit: { value: THREE.Vector3 };
  uHalfY: { value: number };
}

const SHARED_BURN_TIME = { value: 0 };

function isGlassMaterial(mat: THREE.Material): boolean {
  const m = mat as THREE.MeshStandardMaterial;
  return (
    m.transparent ||
    /glass|window|lens/i.test(m.name ?? '')
  );
}

function makeWreckMaterial(src: THREE.Material, hitLocal: THREE.Vector3, halfY: number): { mat: THREE.Material; burn: BurnUniforms | null } {
  const clone = src.clone() as THREE.MeshStandardMaterial;
  clone.name = `wreck_${src.name || 'mat'}`;

  if (isGlassMaterial(clone)) {
    // Glass goes black/opaque on the burnt wreck
    clone.color.setRGB(0.015, 0.02, 0.028);
    clone.metalness = 0.85;
    clone.roughness = 0.35;
    clone.transparent = false;
    clone.opacity = 1;
    clone.emissive.setRGB(0, 0, 0);
    return { mat: clone, burn: null };
  }

  const burn: BurnUniforms = {
    uBurn: { value: 0 },
    uHeat: { value: 1 },
    uHit: { value: hitLocal.clone() },
    uHalfY: { value: Math.max(halfY, 0.05) },
  };
  clone.customProgramCacheKey = () => 'wreck-burn-v3';
  clone.onBeforeCompile = (shader) => {
    shader.uniforms.uBurn = burn.uBurn;
    shader.uniforms.uHeat = burn.uHeat;
    shader.uniforms.uHit = burn.uHit;
    shader.uniforms.uHalfY = burn.uHalfY;
    shader.uniforms.uBurnTime = SHARED_BURN_TIME;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBurnPos;
        varying vec3 vBurnNorm;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vBurnPos = position;
        vBurnNorm = normalize(mat3(modelMatrix) * objectNormal);`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uBurn;
        uniform float uHeat;
        uniform vec3 uHit;
        uniform float uHalfY;
        uniform float uBurnTime;
        varying vec3 vBurnPos;
        varying vec3 vBurnNorm;
        float gEmberMask = 0.0;
        float burnHash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float burnNoise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          vec3 u = f * f * (3.0 - 2.0 * f);
          float n000 = burnHash(i);
          float n100 = burnHash(i + vec3(1.0, 0.0, 0.0));
          float n010 = burnHash(i + vec3(0.0, 1.0, 0.0));
          float n110 = burnHash(i + vec3(1.0, 1.0, 0.0));
          float n001 = burnHash(i + vec3(0.0, 0.0, 1.0));
          float n101 = burnHash(i + vec3(1.0, 0.0, 1.0));
          float n011 = burnHash(i + vec3(0.0, 1.0, 1.0));
          float n111 = burnHash(i + vec3(1.0, 1.0, 1.0));
          return mix(
            mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
            mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
            u.z
          );
        }
        float burnFbm(vec3 p) {
          float v = 0.0;
          float a = 0.5;
          for (int o = 0; o < 3; o++) {
            v += a * burnNoise(p);
            p = p * 2.13 + vec3(11.3, 5.7, 3.1);
            a *= 0.5;
          }
          return v;
        }
        float gBurnMask = 0.0;`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          // Height 0=bottom .. 1=top of this part's box-centred geometry
          float h01 = clamp(vBurnPos.y / uHalfY * 0.5 + 0.5, 0.0, 1.0);
          float bn = burnFbm(vBurnPos * 1.35 + vec3(4.7));
          float fine = burnNoise(vBurnPos * 6.1 + vec3(2.2));
          // Vertically-stretched noise -> rust streaks bleeding down the hull
          float streak = burnNoise(vec3(vBurnPos.x * 2.4, vBurnPos.y * 0.5, vBurnPos.z * 2.4) + vec3(9.2));
          float hitD = distance(vBurnPos, uHit);
          float hitBias = 1.0 - smoothstep(0.0, 1.7, hitD);
          float scorchN = burnNoise(vBurnPos * 4.0);
          // Burnt almost everywhere; original paint survives only in small
          // patches low on the hull.
          float lowZone = smoothstep(0.5, 0.15, h01);
          float paintPatch = smoothstep(0.55, 0.8, bn * 0.6 + fine * 0.4);
          float coverage = 0.97 + bn * 0.08 + hitBias * 0.3 + (scorchN - 0.5) * 0.06;
          float burnRaw = clamp(coverage - lowZone * paintPatch * 0.4, 0.0, 1.0);
          gBurnMask = burnRaw * uBurn;
          // Palette is linear: soot-black steel with faint value variation,
          // blistered brown-black paint at the burn front, dark oxide runs
          // down the flanks, thin grey ash only on up-facing plates.
          vec3 burnCol = vec3(0.016, 0.015, 0.014) * (0.75 + fine * 0.6 + bn * 0.35);
          float front = 1.0 - smoothstep(0.55, 0.95, burnRaw);
          burnCol = mix(burnCol, vec3(0.045, 0.030, 0.019), front * 0.85);
          float flank = 1.0 - abs(vBurnNorm.y);
          float rustM = smoothstep(0.6, 0.85, streak) * flank * (1.0 - h01 * 0.6);
          burnCol = mix(burnCol, vec3(0.062, 0.026, 0.011), rustM * 0.7);
          float upFace = smoothstep(0.55, 0.9, vBurnNorm.y);
          float ashM = upFace * smoothstep(0.45, 0.75, bn + (fine - 0.5) * 0.3);
          burnCol = mix(burnCol, vec3(0.085, 0.082, 0.078), ashM * 0.75);
          diffuseColor.rgb = mix(diffuseColor.rgb, burnCol, gBurnMask);
          // Ember seams: narrow high-frequency cracks only
          gEmberMask = smoothstep(0.78, 0.95, fine) * gBurnMask;
        }`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.96, gBurnMask);`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.12, gBurnMask);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float flick = 0.72 + 0.28 * burnHash(floor(vec3(uBurnTime * 9.0, vBurnPos.x * 3.1 + vBurnPos.z * 1.7, vBurnPos.y)));
          float ember = gEmberMask * uHeat * flick;
          totalEmissiveRadiance += vec3(1.0, 0.38, 0.10) * ember * 0.85;
        }`
      );
  };
  clone.userData.burn = burn;
  return { mat: clone, burn };
}

// ---------------------------------------------------------------------------
// Debris: instanced jagged fragments + wheel chunks, sphere-vs-terrain.
// ---------------------------------------------------------------------------

const DEBRIS_MESHES = 4; // 3 shards + 1 wheel cylinder
const DEBRIS_PER_MESH = 48;
const DEBRIS_CAP = DEBRIS_MESHES * DEBRIS_PER_MESH;

interface Debris {
  active: boolean;
  meshIdx: number;
  slot: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  wx: number;
  wy: number;
  wz: number;
  sx: number;
  sy: number;
  sz: number;
  radius: number;
  age: number;
  life: number;
  emitAccum: number;
  cr: number;
  cg: number;
  cb: number;
}

const _dq2 = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _sm = new THREE.Matrix4();
const _dc = new THREE.Color();
const _sv = new THREE.Vector3();
const _sq = new THREE.Quaternion();
const _dn = new THREE.Vector3();

function makeShardGeometry(seed: number, detail: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n =
      Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719 + seed) * 43758.5453;
    const d = 1 + (n - Math.floor(n) - 0.5) * 0.55;
    v.multiplyScalar(d);
    pos.setXYZ(i, v.x, v.y * 0.42, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Wreck record + manager
// ---------------------------------------------------------------------------

interface WreckMeshEntry {
  mesh: THREE.Mesh;
  burn: BurnUniforms | null;
}

interface Wreck {
  active: boolean;
  group: THREE.Group;
  hullNode: THREE.Group;
  turretNode: THREE.Group | null;
  hullBody: RigidBody;
  turretBody: RigidBody | null;
  burnEntries: WreckMeshEntry[];
  age: number;
  sinkT: number;
  state: 'flight' | 'burning' | 'dying' | 'smoke' | 'sinking' | 'dead';
  catastrophic: boolean;
  emitters: THREE.Vector3[]; // hull-local points
  fireAccum: number;
  smokeAccum: number;
  emberAccum: number;
  cookoffPops: number[];
  cookoffIdx: number;
  obstacle: ObstacleCollider | null;
  cls: VehicleClass;
  seed: number;
  /** Preallocated emitter world positions (no per-frame alloc) */
  emitWorld: THREE.Vector3[];
}

const WRECK_POOL_MAX = 10;
const WRECK_LIFETIME = 75;
const BURN_TIME = 2.5;
const HEAT_TIME = 25;

const HULL_MASS: Record<VehicleClass, number> = {
  normal: 42,
  heavy: 58,
  ifv: 33,
  humvee: 11,
  rocket: 15,
  support: 15,
  littlebird: 5,
};

export class DestructionManager {
  private readonly scene: THREE.Scene;
  private readonly world: World;
  private readonly effects: EffectsManager;

  private readonly geoCache = new Map<string, ClassGeo>();
  private readonly wrecks: Wreck[] = [];
  private wreckIdCounter = 0;
  private mergeCount = 0;
  private mergeTotalMs = 0;

  // Debris instancing
  private readonly debrisMeshes: THREE.InstancedMesh[] = [];
  private readonly debrisPool: Debris[] = [];
  private debrisCursor = 0;
  private readonly debrisActiveIdx: number[] = [];
  private readonly debrisPos = new Int32Array(DEBRIS_CAP).fill(-1);
  private readonly debrisMat4 = new THREE.Matrix4();
  private readonly debrisDiam: number[] = [];

  // Burning wreck point lights (nearest 2 to camera)
  private readonly wreckLights: THREE.PointLight[] = [];
  private readonly lightTargets: (Wreck | null)[] = [null, null];
  private lightScanTimer = 0;

  constructor(scene: THREE.Scene, world: World, effects: EffectsManager) {
    this.scene = scene;
    this.world = world;
    this.effects = effects;

    // Debris geometries: 3 perturbed icosahedra + 1 wheel cylinder
    const shardMats: THREE.Material[] = [];
    const shardGeos: THREE.BufferGeometry[] = [
      makeShardGeometry(3.7, 1),
      makeShardGeometry(9.1, 1),
      makeShardGeometry(15.3, 1),
    ];
    const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.34, 12);
    wheelGeo.rotateZ(Math.PI / 2); // axle along X
    shardGeos.push(wheelGeo);
    for (let i = 0; i < DEBRIS_MESHES; i++) {
      // White base — per-instance colors carry char/paint/steel tints
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.55,
        metalness: 0.55,
        flatShading: true,
      });
      shardMats.push(mat);
      const im = new THREE.InstancedMesh(shardGeos[i], mat, DEBRIS_PER_MESH);
      im.name = `wreck_debris_${i}`;
      im.frustumCulled = false;
      im.castShadow = false;
      im.receiveShadow = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this._initDebrisMesh(im);
      this.debrisMeshes.push(im);
      shardGeos[i].computeBoundingSphere();
      this.debrisDiam.push((shardGeos[i].boundingSphere?.radius ?? 0.5) * 2);
      scene.add(im);
    }
    for (let i = 0; i < DEBRIS_CAP; i++) {
      this.debrisPool.push({
        active: false, meshIdx: i % DEBRIS_MESHES, slot: Math.floor(i / DEBRIS_MESHES),
        x: 0, y: -1000, z: 0, vx: 0, vy: 0, vz: 0,
        qx: 0, qy: 0, qz: 0, qw: 1, wx: 0, wy: 0, wz: 0,
        sx: 1, sy: 1, sz: 1, radius: 0.3, age: 0, life: 8, emitAccum: 0,
        cr: 0.05, cg: 0.045, cb: 0.04,
      });
    }

    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xff8830, 0, 20, 2);
      light.castShadow = false;
      light.position.set(0, -1000, 0);
      scene.add(light);
      this.wreckLights.push(light);
    }
  }

  private _initDebrisMesh(im: THREE.InstancedMesh): void {
    _sm.makeScale(0, 0, 0);
    for (let i = 0; i < DEBRIS_PER_MESH; i++) {
      im.setMatrixAt(i, _sm);
    }
    im.instanceMatrix.needsUpdate = true;
    im.count = 0;
    im.visible = false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  public spawnWreck(info: WreckKillInfo): void {
    const tank = info.tank as Tank;
    const cls = tank.stats.vehicleClass;
    const team = tank.team;

    // Pool management: reuse inactive, else create, else force-sink oldest
    let wreck = this.wrecks.find((w) => !w.active);
    if (!wreck) {
      if (this.wrecks.filter((w) => w.active).length >= WRECK_POOL_MAX) {
        let oldest: Wreck | null = null;
        for (const w of this.wrecks) {
          if (w.active && (!oldest || w.age > oldest.age)) oldest = w;
        }
        if (oldest) this._beginSink(oldest);
      }
      wreck = this._createWreckRecord();
      this.wrecks.push(wreck);
    }

    const t0 = performance.now();
    tank.root.updateMatrixWorld(true);

    const geo = this._ensureGeoCached(cls, team, tank);
    this.mergeCount++;
    this.mergeTotalMs += performance.now() - t0;

    this._buildWreckMeshes(wreck, geo, info);
    this._initBodies(wreck, tank, info, geo);
    this._spawnDebrisAndEffects(wreck, tank, info);
  }

  public update(dt: number, cameraPos: THREE.Vector3): void {
    const safeDt = Math.min(Math.max(dt, 0.0001), 0.05);
    SHARED_BURN_TIME.value += safeDt;

    for (const wreck of this.wrecks) {
      if (!wreck.active) continue;
      wreck.age += safeDt;
      const burn01 = Math.min(1, wreck.age / BURN_TIME);
      const heat01 = Math.max(0, 1 - wreck.age / HEAT_TIME);

      // Material uniforms
      for (const e of wreck.burnEntries) {
        if (e.burn) {
          e.burn.uBurn.value = burn01;
          e.burn.uHeat.value = heat01;
        }
      }

      if (wreck.state === 'sinking') {
        wreck.sinkT += safeDt;
        const sink = Math.min(1, wreck.sinkT / 5);
        wreck.group.position.y = -sink * 0.6;
        if (wreck.sinkT >= 5) {
          this._recycle(wreck);
          continue;
        }
      } else {
        // Physics (skip once fully settled — bodies asleep anyway)
        const h = safeDt / PHYS_SUBSTEPS;
        for (let s = 0; s < PHYS_SUBSTEPS; s++) {
          stepBody(wreck.hullBody, this.world, h);
          if (wreck.turretBody) stepBody(wreck.turretBody, this.world, h);
          if (wreck.turretBody) this._collideTurretHull(wreck);
        }

        // Sync meshes to bodies
        wreck.hullNode.position.copy(wreck.hullBody.pos);
        wreck.hullNode.quaternion.copy(wreck.hullBody.quat);
        if (wreck.turretBody && wreck.turretNode) {
          wreck.turretNode.position.copy(wreck.turretBody.pos);
          wreck.turretNode.quaternion.copy(wreck.turretBody.quat);
        }

        // Register obstacle once the hull settles
        if (!wreck.obstacle && wreck.hullBody.asleep) {
          this._registerObstacle(wreck);
        }

        // State transitions by age
        if (wreck.age > WRECK_LIFETIME) {
          this._beginSink(wreck);
          continue;
        }
        wreck.state = wreck.age < 20 ? 'burning' : wreck.age < 35 ? 'dying' : 'smoke';

        this._emitEffects(wreck, safeDt, cameraPos);
      }
    }

    this._updateDebris(safeDt);
    this._updateWreckLights(safeDt, cameraPos);
  }

  /** Wake nearby wreck bodies from a blast (secondary cook-off pops). */
  public applyBlast(point: THREE.Vector3, impulse: number, radius: number): void {
    for (const wreck of this.wrecks) {
      if (!wreck.active) continue;
      for (const body of [wreck.hullBody, wreck.turretBody]) {
        if (!body || !body.active) continue;
        const d = body.pos.distanceTo(point);
        if (d >= radius) continue;
        body.asleep = false;
        body.sleepTimer = 0;
        _t1.subVectors(body.pos, point);
        if (_t1.lengthSq() < 1e-4) _t1.set(0, 0, 1);
        _t1.normalize();
        const fall = 1 - d / radius;
        body.vel.addScaledVector(_t1, impulse * fall);
        body.vel.y += impulse * fall * 0.6;
        body.angVel.x += (Math.random() - 0.5) * impulse * 0.4 * fall;
        body.angVel.z += (Math.random() - 0.5) * impulse * 0.4 * fall;
      }
    }
  }

  public get activeWreckCount(): number {
    let n = 0;
    for (const w of this.wrecks) if (w.active) n++;
    return n;
  }

  /** Burning wreck positions for guided-munition decoys (reused, zero-alloc). */
  public readonly decoyPoints: { x: number; y: number; z: number }[] = [];
  private readonly _decoyObjPool: { x: number; y: number; z: number }[] = [];

  public getDecoyPoints(): readonly { x: number; y: number; z: number }[] {
    const out = this.decoyPoints;
    let i = 0;
    for (const w of this.wrecks) {
      if (!w.active || (w.state !== 'flight' && w.state !== 'burning')) continue;
      let p = this._decoyObjPool[i];
      if (!p) {
        p = { x: 0, y: 0, z: 0 };
        this._decoyObjPool[i] = p;
      }
      p.x = w.hullBody.pos.x;
      p.y = w.hullBody.pos.y + 1.2;
      p.z = w.hullBody.pos.z;
      out[i] = p;
      i++;
    }
    out.length = i;
    return out;
  }

  public getWreckState(): { count: number; mergeMsAvg: number; mergeCount: number; wrecks: { cls: string; age: number; state: string; x: number; y: number; z: number; tx?: number; ty?: number; tz?: number; tvx?: number; tvy?: number; tvz?: number }[] } {
    return {
      count: this.activeWreckCount,
      mergeMsAvg: this.mergeCount ? this.mergeTotalMs / this.mergeCount : 0,
      mergeCount: this.mergeCount,
      wrecks: this.wrecks
        .filter((w) => w.active)
        .map((w) => ({
          cls: w.cls,
          age: Math.round(w.age * 10) / 10,
          state: w.state,
          x: Math.round(w.hullBody.pos.x * 10) / 10,
          y: Math.round(w.hullBody.pos.y * 10) / 10,
          z: Math.round(w.hullBody.pos.z * 10) / 10,
          gy: Math.round(this.world.getHeightAt(w.hullBody.pos.x, w.hullBody.pos.z) * 100) / 100,
          hy: Math.round(w.hullBody.half.y * 100) / 100,
          tx: w.turretBody ? Math.round(w.turretBody.pos.x * 10) / 10 : undefined,
          ty: w.turretBody ? Math.round(w.turretBody.pos.y * 10) / 10 : undefined,
          tz: w.turretBody ? Math.round(w.turretBody.pos.z * 10) / 10 : undefined,
          tvy: w.turretBody ? Math.round(w.turretBody.vel.y * 10) / 10 : undefined,
          tvx: w.turretBody ? Math.round(w.turretBody.vel.x * 10) / 10 : undefined,
          tvz: w.turretBody ? Math.round(w.turretBody.vel.z * 10) / 10 : undefined,
        })),
    };
  }

  /**
   * QA probe: for each wreck part, the minimum (worldY - terrainHeight) over
   * sampled mesh vertices. ~0 means the part rests on the ground; a large
   * positive value means it floats (or rests on the other wreck part).
   */
  public probeClearance(): { cls: string; part: string; minGap: number; belowFrac: number; asleep: boolean; tiltDeg: number }[] {
    const out: { cls: string; part: string; minGap: number; belowFrac: number; asleep: boolean; tiltDeg: number }[] = [];
    for (const w of this.wrecks) {
      if (!w.active) continue;
      w.group.updateMatrixWorld(true);
      const parts: [string, THREE.Object3D | null, RigidBody | null][] = [
        ['hull', w.hullNode, w.hullBody],
        ['turret', w.turretNode, w.turretBody],
      ];
      for (const [name, node, body] of parts) {
        if (!node || !body) continue;
        let minGap = Infinity;
        let below = 0;
        let total = 0;
        node.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          // Skip turret meshes when probing the hull (they may be nested)
          if (name === 'hull' && w.turretNode && isDescendantOf(mesh, w.turretNode)) return;
          const pos = mesh.geometry.attributes.position as THREE.BufferAttribute | undefined;
          if (!pos) return;
          const step = Math.max(1, Math.floor(pos.count / 500));
          for (let i = 0; i < pos.count; i += step) {
            _pv.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
            const gap = _pv.y - this.world.getHeightAt(_pv.x, _pv.z);
            if (gap < minGap) minGap = gap;
            if (gap < -0.05) below++;
            total++;
          }
        });
        if (minGap === Infinity) continue;
        out.push({
          cls: w.cls,
          part: name,
          minGap: Math.round(minGap * 100) / 100,
          belowFrac: total ? Math.round((below / total) * 100) / 100 : 0,
          asleep: body.asleep,
          tiltDeg: Math.round(bodyTiltDeg(body, this.world) * 10) / 10,
        });
      }
    }
    return out;
  }

  /** Physics self-check: drop + edge-balance cases must settle flat and asleep. */
  public selfTest(): {
    ok: boolean;
    ms: number;
    drop: { ok: boolean; restGap: number; tiltDeg: number; asleep: boolean; nan: boolean };
    edge: { ok: boolean; restGap: number; tiltDeg: number; asleep: boolean; nan: boolean };
  } {
    const t0 = performance.now();
    const drop = this._selfTestCase(false);
    const edge = this._selfTestCase(true);
    return {
      ok: drop.ok && edge.ok,
      ms: Math.round(performance.now() - t0),
      drop,
      edge,
    };
  }

  private _selfTestCase(edgeDrop: boolean): {
    ok: boolean;
    restGap: number;
    tiltDeg: number;
    asleep: boolean;
    nan: boolean;
  } {
    const body = new RigidBody();
    body.active = true;
    const cx = 30;
    const cz = -30;
    const ground = this.world.getHeightAt(cx, cz);
    body.half.set(0.6, 0.3, 0.45);
    const m = 20;
    body.invMass = 1 / m;
    body.invInertia.set(
      12 / (m * (0.6 * 0.6 + 0.9 * 0.9)),
      12 / (m * (1.2 * 1.2 + 0.9 * 0.9)),
      12 / (m * (1.2 * 1.2 + 0.6 * 0.6))
    );

    if (!edgeDrop) {
      // Case 1: dropped from 3 m with spin — must settle on flat ground
      body.pos.set(cx, ground + 3 + 0.3, cz);
      body.quat.setFromEuler(new THREE.Euler(0.4, 0.7, 0.2));
      body.vel.set(0.5, 0, -0.3);
      body.angVel.set(2.5, 1.2, -1.8);
    } else {
      // Case 2: released 1 m up, rotated 50° about local Z — lands on an edge
      // with the COM just past it; must rock flat, not balance on the edge.
      body.quat.setFromEuler(new THREE.Euler(0, 0, THREE.MathUtils.degToRad(50)));
      let lo = Infinity;
      for (let sx = -1; sx <= 1; sx += 2) {
        for (let sy = -1; sy <= 1; sy += 2) {
          for (let sz = -1; sz <= 1; sz += 2) {
            _local.set(sx * 0.6, sy * 0.3, sz * 0.45).applyQuaternion(body.quat);
            if (_local.y < lo) lo = _local.y;
          }
        }
      }
      body.pos.set(cx, ground + 1.0 - lo, cz);
      // zero velocity / zero spin
    }

    const seconds = edgeDrop ? 8 : 6;
    const h = 1 / 60 / PHYS_SUBSTEPS;
    for (let i = 0; i < seconds * 60 * PHYS_SUBSTEPS; i++) {
      stepBody(body, this.world, h);
      if (!isFinite(body.pos.x + body.pos.y + body.pos.z)) break;
    }

    // Lowest corner height above local ground
    let minY = Infinity;
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          _local.set(sx * 0.6, sy * 0.3, sz * 0.45).applyQuaternion(body.quat);
          const wy = body.pos.y + _local.y;
          const gx = this.world.getHeightAt(body.pos.x + _local.x, body.pos.z + _local.z);
          minY = Math.min(minY, wy - gx);
        }
      }
    }
    const nan = !isFinite(body.pos.x + body.pos.y + body.pos.z + body.quat.w);
    const restGap = Math.abs(minY);
    const tiltDeg = Math.round(bodyTiltDeg(body, this.world) * 10) / 10;
    const ok = edgeDrop
      ? !nan && body.asleep && tiltDeg < 5 && restGap <= 0.02
      : !nan && restGap <= 0.02 && body.asleep;
    return { ok, restGap: Math.round(restGap * 1000) / 1000, tiltDeg, asleep: body.asleep, nan };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _createWreckRecord(): Wreck {
    const group = new THREE.Group();
    group.name = 'wreck';
    this.scene.add(group);
    return {
      active: false,
      group,
      hullNode: new THREE.Group(),
      turretNode: null,
      hullBody: new RigidBody(),
      turretBody: null,
      burnEntries: [],
      age: 0,
      sinkT: 0,
      state: 'flight',
      catastrophic: false,
      emitters: [],
      fireAccum: 0,
      smokeAccum: 0,
      emberAccum: 0,
      cookoffPops: [],
      cookoffIdx: 0,
      obstacle: null,
      cls: 'normal',
      seed: Math.random() * 100,
      emitWorld: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
    };
  }

  /** Bake (or fetch) the shared hull/turret geometry for a class×team pair. */
  private _ensureGeoCached(cls: VehicleClass, team: Team, tank: Tank): ClassGeo {
    const cacheKey = `${cls}:${team}`;
    const cached = this.geoCache.get(cacheKey);
    if (cached) return cached;
    tank.root.updateMatrixWorld(true);

    // Clone: bakePart uses _m1 as scratch, so passing _m1/_m2 themselves would
    // alias the inverse-space matrix and corrupt every mesh after the first.
    const rigRootInv = _m2.copy(tank.root.matrixWorld).invert().clone();
    const turretInv = _m1.copy(tank.rig.turretPivot.matrixWorld).invert().clone();
    const hullMeshes: THREE.Mesh[] = [];
    const turretMeshes: THREE.Mesh[] = [];
    collectMeshes(tank.root, tank.rig.turretPivot, hullMeshes);
    collectMeshes(tank.rig.turretPivot, null, turretMeshes);
    const hull = bakePart(hullMeshes, rigRootInv);
    const turret = turretMeshes.length > 0 ? bakePart(turretMeshes, turretInv) : null;
    console.info(
      `[wreck-bake] ${cls}:${team} whipComponents=${hull.whipComponents + (turret?.whipComponents ?? 0)} droppedTris=${hull.whipDroppedTris + (turret?.whipDroppedTris ?? 0)}`
    );

    // Turret collision box excludes the gun subtree only when the gun is
    // barrel-like (long and thin — e.g. the MBT/IFV cannon): a long barrel
    // inflates the OBB with empty space and makes settled wrecks float.
    // Chunky gun pods (rocket launcher) stay in the collision box. The
    // muzzle tip always becomes a thin extra contact point.
    let turretCollide: TurretCollide | null = null;
    const gunRoot = tank.rig.gunPivot;
    if (turret && gunRoot && isDescendantOf(gunRoot, tank.rig.turretPivot)) {
      const turretOnly: THREE.Mesh[] = [];
      const gunMeshes: THREE.Mesh[] = [];
      collectMeshes(tank.rig.turretPivot, gunRoot, turretOnly);
      collectMeshes(gunRoot, null, gunMeshes);
      if (turretOnly.length > 0 && gunMeshes.length > 0) {
        const tbox = new THREE.Box3();
        const gbox = new THREE.Box3();
        bakeBoundsOnly(turretOnly, turretInv, tbox);
        bakeBoundsOnly(gunMeshes, turretInv, gbox);
        if (!tbox.isEmpty() && !gbox.isEmpty()) {
          const ts = tbox.getSize(_t1);
          const gs = gbox.getSize(_t2);
          const gh = gbox.getSize(_t3).multiplyScalar(0.5);
          const tDim = Math.max(ts.x, ts.y, ts.z);
          const gDim = Math.max(gs.x, gs.y, gs.z);
          const gMinHalf = Math.min(gh.x, gh.y, gh.z);
          const barrelLike = gDim > tDim * 1.35 && gMinHalf < 0.6;
          const tc = tbox.getCenter(new THREE.Vector3());
          const th = tbox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
          const tipPivot = tank.rig.muzzleNode.getWorldPosition(_t2).applyMatrix4(turretInv);
          if (barrelLike) {
            turretCollide = {
              offset: tc.sub(turret.center),
              half: th,
              tip: tipPivot.clone().sub(turret.center),
            };
          } else {
            // Keep the full box (pod is the bulk of the wreck) + tip contact
            turretCollide = {
              offset: new THREE.Vector3(),
              half: turret.half.clone(),
              tip: tipPivot.clone().sub(turret.center),
            };
          }
        }
      }
    }
    const geo: ClassGeo = {
      hull,
      turret,
      turretCollide,
      turretRestRel: turret
        ? _m1.copy(rigRootInv).multiply(tank.rig.turretPivot.matrixWorld).clone()
        : null,
    };
    this.geoCache.set(cacheKey, geo);
    return geo;
  }

  /**
   * Loading-time warm-up: bake the wreck geometry cache for every class×team,
   * build wreck materials, and compile all vehicle/wreck shader programs so the
   * first kill in a real fight doesn't hitch. Warm objects are removed after
   * `renderer.compileAsync`; materials stay undisposed so programs remain cached.
   */
  public async prewarmWrecksAndVehicles(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    assets: LoadedGameAssets
  ): Promise<void> {
    const vcls: VehicleClass[] = ['normal', 'heavy', 'ifv', 'humvee', 'rocket', 'support', 'littlebird'];
    const teams: Team[] = ['blue', 'red'];
    const warm = new THREE.Group();
    warm.name = 'shader_prewarm';
    let slot = 0;
    for (const cls of vcls) {
      for (const team of teams) {
        if (cls === 'littlebird' && team === 'red') continue;
        const rig = instantiateTankRig(assets, cls, team);
        const fakeTank = {
          root: rig.root,
          rig,
          team,
          stats: { vehicleClass: cls },
        } as unknown as Tank;
        fakeTank.root.updateMatrixWorld(true);
        const geo = this._ensureGeoCached(cls, team, fakeTank);
        const wreck = this._createWreckRecord();
        const info = {
          tank: fakeTank,
          hitPoint: new THREE.Vector3(0, 1.1, 0),
          shellDir: null,
          weapon: 'cannon',
          damage: 999,
          catastrophic: true,
        } as WreckKillInfo;
        this._buildWreckMeshes(wreck, geo, info);
        // Loose grid in front of the camera so nothing is frustum-culled
        const ox = (slot % 5) * 7 - 14;
        const oz = Math.floor(slot / 5) * 7 - 10;
        rig.root.position.set(ox, 0, oz);
        wreck.group.position.set(ox + 3.5, 0, oz + 3.5);
        warm.add(rig.root, wreck.group);
        slot++;
      }
    }
    scene.add(warm);
    warm.updateMatrixWorld(true);
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    warm.position.copy(camera.position).addScaledVector(fwd, 26);
    warm.updateMatrixWorld(true);
    // compile()/render() frustum-cull: force every warm object to "intersect" so
    // edge-of-frustum wreck/vehicle variants still get their programs compiled.
    warm.traverse((o) => {
      o.frustumCulled = false;
    });

    // Debris instanced meshes start count=0/visible=false — force one instance
    // each so their programs compile during warm-up too.
    for (const im of this.debrisMeshes) {
      im.count = 1;
      im.visible = true;
    }
    // compileAsync never resolves on some backends (SwiftShader, some Safari
    // GPUs); cap the wait — the real render below compiles anything left.
    await Promise.race([
      renderer.compileAsync(scene, camera),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
    // One real render while warm objects are live: compiles shadow-depth and
    // any program variants compileAsync skips, so the first play frame is clean.
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    for (const im of this.debrisMeshes) {
      im.count = 0;
      im.visible = false;
    }
    scene.remove(warm);
    warm.clear();
  }

  private _buildWreckMeshes(wreck: Wreck, geo: ClassGeo, info: WreckKillInfo): void {
    const tank = info.tank as Tank;
    // Clear previous contents
    while (wreck.group.children.length) wreck.group.remove(wreck.group.children[0]);
    wreck.burnEntries.length = 0;

    // Hit point in each part's local space (geometry positions are part-local)
    tank.root.updateMatrixWorld(true);
    const rootInv = _m1.copy(tank.root.matrixWorld).invert();
    const hullHit = new THREE.Vector3(info.hitPoint.x, info.hitPoint.y, info.hitPoint.z).applyMatrix4(rootInv);
    const turretWorldInv = tank.rig.turretPivot.matrixWorld.clone().invert();
    const turretHit = new THREE.Vector3(info.hitPoint.x, info.hitPoint.y, info.hitPoint.z).applyMatrix4(turretWorldInv);

    const makeMeshes = (part: BakedPart, hitLocal: THREE.Vector3, parent: THREE.Object3D): WreckMeshEntry[] => {
      const out: WreckMeshEntry[] = [];
      // Geometry is box-centred; bring the hit point into the same frame
      const hitC = _t3.copy(hitLocal).sub(part.center);
      for (const e of part.entries) {
        const mats = Array.isArray(e.material)
          ? e.material.map((m) => makeWreckMaterial(m, hitC, part.half.y))
          : [makeWreckMaterial(e.material, hitC, part.half.y)];
        const mesh = new THREE.Mesh(e.geo, Array.isArray(e.material) ? mats.map((x) => x.mat) : mats[0].mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
        for (const m of mats) {
          if (m.burn) out.push({ mesh, burn: m.burn });
        }
      }
      return out;
    };

    wreck.burnEntries.push(...makeMeshes(geo.hull, hullHit, wreck.hullNode));
    wreck.group.add(wreck.hullNode);

    const hasTurret = geo.turret !== null;
    const turretVolume = hasTurret ? 8 * geo.turret!.half.x * geo.turret!.half.y * geo.turret!.half.z : 0;
    const turretMaxDim = hasTurret ? Math.max(geo.turret!.half.x, geo.turret!.half.y, geo.turret!.half.z) * 2 : 0;
    const launchTurret = info.catastrophic && hasTurret && turretVolume > 3 && turretMaxDim > 1.1;

    if (hasTurret && geo.turretRestRel) {
      wreck.turretNode = new THREE.Group();
      if (launchTurret) {
        wreck.burnEntries.push(...makeMeshes(geo.turret!, turretHit, wreck.turretNode));
        wreck.group.add(wreck.turretNode);
      } else {
        // Turret stays with the hull, gun drooped. Geometry is box-centred, so
        // re-translate by the part centre before the rest-relative pose.
        wreck.burnEntries.push(...makeMeshes(geo.turret!, turretHit, wreck.turretNode));
        const droop = new THREE.Matrix4().makeRotationX(0.14);
        const reCenter = new THREE.Matrix4().makeTranslation(
          geo.turret!.center.x, geo.turret!.center.y, geo.turret!.center.z
        );
        wreck.turretNode.matrixAutoUpdate = false;
        wreck.turretNode.matrix.copy(geo.turretRestRel).multiply(droop).multiply(reCenter);
        wreck.hullNode.add(wreck.turretNode);
      }
    }
  }

  private _initBodies(wreck: Wreck, tank: Tank, info: WreckKillInfo, geo: ClassGeo): void {
    const cls = tank.stats.vehicleClass;
    const wheeled = tank.stats.drive === 'wheeled';

    // --- Hull body ---
    const hull = wreck.hullBody;
    hull.active = true;
    hull.asleep = false;
    hull.sleepTimer = 0;
    const hullPart = geo.hull;
    // Body frame = box-centred geometry; world pos of box centre
    tank.root.matrixWorld.decompose(_sv, hull.quat, _sv2);
    hull.pos.copy(hullPart.center).applyQuaternion(hull.quat).add(tank.root.position);
    hull.half.copy(hullPart.half);
    hull.half.x = Math.max(hull.half.x, 0.7);
    hull.half.y = Math.max(hull.half.y, 0.5);
    hull.half.z = Math.max(hull.half.z, 0.9);
    hull.contactPoints = hullPart.contacts.length >= 9 ? hullPart.contacts : null;
    const m = HULL_MASS[cls];
    hull.invMass = 1 / m;
    const sx = hull.half.x * 2;
    const sy = hull.half.y * 2;
    const sz = hull.half.z * 2;
    hull.invInertia.set(
      12 / (m * (sy * sy + sz * sz)),
      12 / (m * (sx * sx + sz * sz)),
      12 / (m * (sx * sx + sy * sy))
    );

    // Blast direction: away from hit point + up
    _t1.copy(tank.root.position).setY(tank.root.position.y + 1.2);
    _t2.subVectors(_t1, info.hitPoint);
    _t2.y = 0;
    if (_t2.lengthSq() < 0.01) {
      _t2.set(-Math.sin(tank.hullYaw), 0, -Math.cos(tank.hullYaw));
    }
    _t2.normalize();
    const kick = _t3.set(_t2.x * 0.55, 0.85, _t2.z * 0.55).normalize();

    if (wheeled) {
      // Wheeled hulls can flip and roll
      hull.vel.copy(kick).multiplyScalar(2 + Math.random() * 1.5);
      hull.vel.y = 5 + Math.random() * 3;
      const axis = Math.random() < 0.5 ? _t1.set(1, 0, 0) : _t1.set(0, 0, 1);
      const spin = (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 3);
      hull.angVel.copy(axis).multiplyScalar(spin);
      hull.angVel.y += (Math.random() - 0.5) * 2;
    } else if (info.catastrophic) {
      hull.vel.copy(kick).multiplyScalar(1.5 + Math.random() * 1.5);
      hull.angVel.set(
        (Math.random() - 0.5) * 1.6,
        (Math.random() - 0.5) * 1.2,
        (Math.random() - 0.5) * 1.6
      );
    } else {
      hull.vel.copy(kick).multiplyScalar(0.9 + Math.random() * 0.6);
      hull.angVel.set(
        (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.8
      );
    }

    // --- Turret body (catastrophic + launched) ---
    wreck.turretBody = null;
    const turretPart = geo.turret;
    if (turretPart && wreck.turretNode && wreck.turretNode.parent === wreck.group) {
      const tb = new RigidBody();
      tb.active = true;
      tank.rig.turretPivot.matrixWorld.decompose(tb.pos, tb.quat, _sv);
      // pos is turret-local origin; body rotates about box centre:
      tb.pos.add(_t1.copy(turretPart.center).applyQuaternion(tb.quat));
      tb.half.copy(turretPart.half);
      tb.half.x = Math.max(tb.half.x, 0.25);
      tb.half.y = Math.max(tb.half.y, 0.2);
      tb.half.z = Math.max(tb.half.z, 0.25);
      tb.contactPoints = turretPart.contacts.length >= 9 ? turretPart.contacts : null;
      // Barrel-excluded collision box + muzzle tip contact
      const tc = geo.turretCollide;
      if (tc) {
        tb.hasCollideBox = true;
        tb.collideOffset.copy(tc.offset);
        tb.collideHalf.copy(tc.half);
        tb.hasTip = tc.tip !== null;
        if (tc.tip) tb.tipOffset.copy(tc.tip);
      } else {
        tb.hasCollideBox = false;
        tb.hasTip = false;
      }
      const tVol = 8 * tb.half.x * tb.half.y * tb.half.z;
      const tm = THREE.MathUtils.clamp(tVol * 0.12, 2.5, 14);
      tb.invMass = 1 / tm;
      const tx = tb.half.x * 2;
      const ty = tb.half.y * 2;
      const tz = tb.half.z * 2;
      tb.invInertia.set(
        12 / (tm * (ty * ty + tz * tz)),
        12 / (tm * (tx * tx + tz * tz)),
        12 / (tm * (tx * tx + ty * ty))
      );
      // Launch up + away from hit side + tumble
      tb.vel.set(0, 9 + Math.random() * 6, 0);
      tb.vel.addScaledVector(kick, 1.5 + Math.random() * 1.5);
      // lateral kick away from the hit side in turret space
      _t1.copy(info.hitPoint).applyMatrix4(turretWorldMatrixInv(tank)).sub(turretPart.center);
      const side = Math.sign(_t1.x) || 1;
      _t2.set(-side * (1.5 + Math.random()), 0, -0.5).applyQuaternion(tb.quat);
      tb.vel.add(_t2);
      tb.angVel.set(
        (Math.random() - 0.5) * 5,
        (Math.random() - 0.5) * 5,
        (Math.random() - 0.5) * 5
      );
      const w = 2 + Math.random() * 3;
      tb.angVel.normalize().multiplyScalar(w);
      wreck.turretBody = tb;
    }

    // Emitters: engine deck, turret ring, rear — hull-local
    const ex = hull.half.x * 0.55;
    const ey = hull.half.y * 0.85;
    const ez = hull.half.z;
    wreck.emitters.length = 0;
    wreck.emitters.push(new THREE.Vector3(0, ey, -ez * 0.45));
    wreck.emitters.push(new THREE.Vector3(ex * 0.7, ey * 0.8, ez * 0.15));
    wreck.emitters.push(new THREE.Vector3(-ex * 0.7, ey * 0.8, ez * 0.15));
    wreck.emitters.push(new THREE.Vector3(0, ey * 0.6, ez * 0.55));

    // Cook-off schedule for catastrophic kills
    wreck.cookoffPops.length = 0;
    wreck.cookoffIdx = 0;
    if (info.catastrophic) {
      const pops = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < pops; i++) {
        wreck.cookoffPops.push(0.6 + Math.random() * 3.4);
      }
      wreck.cookoffPops.sort((a, b) => a - b);
    }

    wreck.age = 0;
    wreck.sinkT = 0;
    wreck.state = 'flight';
    wreck.catastrophic = info.catastrophic;
    wreck.cls = cls;
    wreck.active = true;
    wreck.obstacle = null;
    wreck.group.position.set(0, 0, 0);
    wreck.group.visible = true;
    wreck.fireAccum = 0;
    wreck.smokeAccum = 0;
    wreck.emberAccum = 0;
  }

  private _spawnDebrisAndEffects(wreck: Wreck, tank: Tank, info: WreckKillInfo): void {
    const wheeled = tank.stats.drive === 'wheeled';
    const catastrophic = info.catastrophic;

    // Impact point + away direction for debris
    const center = _t1.set(tank.root.position.x, tank.root.position.y + 1.2, tank.root.position.z);
    _t2.subVectors(center, info.hitPoint);
    _t2.y = 0;
    if (_t2.lengthSq() < 0.01) _t2.set(0, 0, 1);
    _t2.normalize();

    // Ground dust ring + clods
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
      _t3.set(
        tank.root.position.x + Math.cos(a) * (2.5 + Math.random() * 3),
        tank.root.position.y + 0.4,
        tank.root.position.z + Math.sin(a) * (2.5 + Math.random() * 3)
      );
      this.effects.spawnTrackDust(_t3, catastrophic ? 0.9 : 0.55);
    }
    // Dark smoke column kick-off
    for (let i = 0; i < 6; i++) {
      _t3.set(
        tank.root.position.x + (Math.random() - 0.5) * 3,
        tank.root.position.y + 1 + Math.random() * 2,
        tank.root.position.z + (Math.random() - 0.5) * 3
      );
      this.effects.spawnWreckSmoke(_t3);
    }
    this.effects.spawnEmbers(tank.root.position.x, tank.root.position.y + 1.5, tank.root.position.z, catastrophic ? 14 : 7);

    // Fragments
    const count = catastrophic ? 20 + Math.floor(Math.random() * 9) : 12 + Math.floor(Math.random() * 7);
    let spawned = 0;
    for (let i = 0; i < count * 3 && spawned < count; i++) {
      const d = this._allocDebris();
      if (!d) break;
      const isWheel = wheeled && catastrophic && spawned >= count - 2;
      d.meshIdx = isWheel ? 3 : Math.floor(Math.random() * 3);
      // World-space max dimension: mostly small plate shards, a few larger,
      // hard-capped under ~0.8 m (the old scale produced ~2 m planks).
      const big = Math.random() < 0.1;
      const targetDim = big ? 0.4 + Math.random() * 0.18 : 0.09 + Math.random() * 0.33;
      const a = Math.random() * Math.PI * 2;
      const spd = 3 + Math.random() * (catastrophic ? 9 : 6);
      d.x = tank.root.position.x + Math.cos(a) * Math.random() * 2;
      d.y = tank.root.position.y + 0.8 + Math.random() * 1.8;
      d.z = tank.root.position.z + Math.sin(a) * Math.random() * 2;
      d.vx = Math.cos(a) * spd * 0.7 + _t2.x * spd * 0.5;
      d.vy = 2.5 + Math.random() * (catastrophic ? 8 : 5);
      d.vz = Math.sin(a) * spd * 0.7 + _t2.z * spd * 0.5;
      d.qx = Math.random() - 0.5;
      d.qy = Math.random() - 0.5;
      d.qz = Math.random() - 0.5;
      d.qw = Math.random();
      const ql = Math.hypot(d.qx, d.qy, d.qz, d.qw) || 1;
      d.qx /= ql; d.qy /= ql; d.qz /= ql; d.qw /= ql;
      d.wx = (Math.random() - 0.5) * 14;
      d.wy = (Math.random() - 0.5) * 14;
      d.wz = (Math.random() - 0.5) * 14;
      if (isWheel) {
        // Wheel chunk ~0.5-0.75 m diameter, ~0.25 m thick (geo: r=0.55, h=0.34)
        const wDiam = 0.5 + Math.random() * 0.25;
        d.sx = (0.22 + Math.random() * 0.14) / 0.34;
        d.sy = wDiam / 1.1;
        d.sz = d.sy;
        d.radius = wDiam * 0.5;
        d.cr = 0.1; d.cg = 0.1; d.cb = 0.11;
      } else {
        // Thin armour-plate shards, irregular rectangular footprints
        const k = targetDim / this.debrisDiam[d.meshIdx];
        d.sx = k * (0.7 + Math.random() * 0.6);
        d.sy = k * (0.3 + Math.random() * 0.25);
        d.sz = k * (0.7 + Math.random() * 0.6);
        d.radius = Math.max(d.sx, d.sy, d.sz) * 0.8;
        const roll = Math.random();
        if (roll < 0.45) {
          // Charcoal
          d.cr = 0.05 + Math.random() * 0.03;
          d.cg = 0.045 + Math.random() * 0.025;
          d.cb = 0.04 + Math.random() * 0.02;
        } else if (roll < 0.75) {
          // Surviving team paint patches
          if (tank.team === 'blue') {
            d.cr = 0.26 + Math.random() * 0.1;
            d.cg = 0.3 + Math.random() * 0.1;
            d.cb = 0.16 + Math.random() * 0.07;
          } else {
            d.cr = 0.48 + Math.random() * 0.12;
            d.cg = 0.38 + Math.random() * 0.1;
            d.cb = 0.24 + Math.random() * 0.08;
          }
        } else {
          // Bare steel catching the env map
          d.cr = 0.34 + Math.random() * 0.14;
          d.cg = 0.35 + Math.random() * 0.14;
          d.cb = 0.37 + Math.random() * 0.14;
        }
      }
      d.age = 0;
      d.life = 6 + Math.random() * 6;
      d.emitAccum = 0;
      d.active = true;
      spawned++;
    }
  }

  private _listRemove(list: number[], pos: Int32Array, idx: number): void {
    const p = pos[idx];
    const last = list.pop()!;
    if (p < list.length) {
      list[p] = last;
      pos[last] = p;
    }
    pos[idx] = -1;
  }

  private _allocDebris(): Debris | null {
    for (let n = 0; n < DEBRIS_CAP; n++) {
      const idx = (this.debrisCursor + n) % DEBRIS_CAP;
      if (!this.debrisPool[idx].active) {
        this.debrisCursor = (idx + 1) % DEBRIS_CAP;
        if (this.debrisPos[idx] < 0) {
          this.debrisPos[idx] = this.debrisActiveIdx.length;
          this.debrisActiveIdx.push(idx);
        }
        return this.debrisPool[idx];
      }
    }
    return null;
  }

  private _updateDebris(dt: number): void {
    const counts = [0, 0, 0, 0];
    // Compact-write: iterate pool, write each active debris into its mesh slot
    const slotCursor = [0, 0, 0, 0];
    const q = _sq;
    const debrisList = this.debrisActiveIdx;
    for (let k = debrisList.length - 1; k >= 0; k--) {
      const i = debrisList[k];
      const d = this.debrisPool[i];
      d.age += dt;
      if (!d.active || d.age >= d.life) {
        d.active = false;
        this._listRemove(debrisList, this.debrisPos, i);
        continue;
      }
      // Sphere-vs-terrain with rolling friction
      const ground = this.world.getHeightAt(d.x, d.z);
      if (d.y - d.radius < ground) {
        d.y = ground + d.radius;
        this.world.getNormalAt(d.x, d.z, _dn);
        if (_dn.y < 0.35) _dn.set(0, 1, 0);
        const vn = d.vx * _dn.x + d.vy * _dn.y + d.vz * _dn.z;
        if (vn < 0) {
          const e = -vn < 1.2 ? 0.1 : 0.35;
          d.vx -= (1 + e) * vn * _dn.x;
          d.vy -= (1 + e) * vn * _dn.y;
          d.vz -= (1 + e) * vn * _dn.z;
          // rolling friction
          const tx = d.vx - _dn.x * (d.vx * _dn.x + d.vy * _dn.y + d.vz * _dn.z);
          const ty = d.vy - _dn.y * (d.vx * _dn.x + d.vy * _dn.y + d.vz * _dn.z);
          const tz = d.vz - _dn.z * (d.vx * _dn.x + d.vy * _dn.y + d.vz * _dn.z);
          d.vx = tx * 0.72 + _dn.x * (d.vx * _dn.x + d.vy * _dn.y + d.vz * _dn.z);
          d.vy = ty * 0.72 + _dn.y * (d.vx * _dn.x + d.vy * _dn.y + d.vz * _dn.z);
          d.vz = tz * 0.72 + _dn.z * (d.vx * _dn.x + d.vy * _dn.y + d.vz * _dn.z);
          d.wx *= 0.7; d.wy *= 0.7; d.wz *= 0.7;
        }
      }
      d.vy -= GRAVITY * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;

      // Spin integration
      const wLen = Math.hypot(d.wx, d.wy, d.wz);
      if (wLen > 1e-5) {
        const ang = wLen * dt;
        _wq.set(d.wx / wLen * Math.sin(ang / 2), d.wy / wLen * Math.sin(ang / 2), d.wz / wLen * Math.sin(ang / 2), Math.cos(ang / 2));
        q.set(d.qx, d.qy, d.qz, d.qw).premultiply(_wq).normalize();
        d.qx = q.x; d.qy = q.y; d.qz = q.z; d.qw = q.w;
        const damp = Math.exp(-0.8 * dt);
        d.wx *= damp; d.wy *= damp; d.wz *= damp;
      }

      // Low-energy plate shards settle flat on their largest face (thin axis
      // is local Y, so identity orientation = plate face down)
      if (
        d.meshIdx < 3 &&
        d.vx * d.vx + d.vy * d.vy + d.vz * d.vz < 1.2 &&
        d.y - d.radius < ground + 0.2
      ) {
        _dq2.set(0, 0, 0, 1);
        q.set(d.qx, d.qy, d.qz, d.qw).slerp(_dq2, Math.min(1, dt * 5)).normalize();
        d.qx = q.x; d.qy = q.y; d.qz = q.z; d.qw = q.w;
        const sdamp = Math.exp(-6 * dt);
        d.wx *= sdamp; d.wy *= sdamp; d.wz *= sdamp;
      }

      // Hot debris trails a little smoke
      if (d.age < 1.5 && (d.vx * d.vx + d.vy * d.vy + d.vz * d.vz) > 1) {
        d.emitAccum += dt;
        if (d.emitAccum > 0.14) {
          d.emitAccum = 0;
          _t3.set(d.x, d.y, d.z);
          this.effects.spawnWreckSmoke(_t3);
        }
      }

      const slot = slotCursor[d.meshIdx]++;
      if (slot >= DEBRIS_PER_MESH) continue;
      _sv.set(d.sx, d.sy, d.sz);
      _sq.set(d.qx, d.qy, d.qz, d.qw);
      _t3.set(d.x, d.y, d.z);
      this.debrisMat4.compose(_t3, _sq, _sv);
      const im = this.debrisMeshes[d.meshIdx];
      im.setMatrixAt(slot, this.debrisMat4);
      im.setColorAt(slot, _dc.setRGB(d.cr, d.cg, d.cb));
      counts[d.meshIdx]++;
    }

    for (let m = 0; m < DEBRIS_MESHES; m++) {
      const im = this.debrisMeshes[m];
      const n = counts[m];
      if (n === 0) {
        if (im.visible) {
          im.visible = false;
          im.count = 0;
        }
        continue;
      }
      im.visible = true;
      im.count = n;
      im.instanceMatrix.clearUpdateRanges();
      im.instanceMatrix.addUpdateRange(0, n * 16);
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) {
        im.instanceColor.clearUpdateRanges();
        im.instanceColor.addUpdateRange(0, n * 3);
        im.instanceColor.needsUpdate = true;
      }
    }
  }

  private _collideTurretHull(wreck: Wreck): void {
    const tb = wreck.turretBody!;
    const hb = wreck.hullBody;
    if (tb.asleep && hb.asleep) return;

    // Turret collision box vs hull OBB (hull treated as infinite mass — it's
    // far heavier). When available this is the barrel-excluded box so the long
    // gun doesn't act like a solid wall; the muzzle tip is tested separately.
    _qi.copy(hb.quat).invert();
    const ex = tb.hasCollideBox ? tb.collideHalf.x : tb.half.x;
    const ey = tb.hasCollideBox ? tb.collideHalf.y : tb.half.y;
    const ez = tb.hasCollideBox ? tb.collideHalf.z : tb.half.z;
    const ox = tb.hasCollideBox ? tb.collideOffset.x : 0;
    const oy = tb.hasCollideBox ? tb.collideOffset.y : 0;
    const oz = tb.hasCollideBox ? tb.collideOffset.z : 0;
    let maxPen = 0;
    _t3.set(0, 0, 0); // accumulated correction in hull space
    for (let cx = -1; cx <= 1; cx += 2) {
      for (let cy = -1; cy <= 1; cy += 2) {
        for (let cz = -1; cz <= 1; cz += 2) {
          _local.set(cx * ex + ox, cy * ey + oy, cz * ez + oz);
          _corner.copy(_local).applyQuaternion(tb.quat).add(tb.pos);
          // into hull local space
          _t1.subVectors(_corner, hb.pos).applyQuaternion(_qi);
          // clamp to hull box
          const px = THREE.MathUtils.clamp(_t1.x, -hb.half.x, hb.half.x);
          const py = THREE.MathUtils.clamp(_t1.y, -hb.half.y, hb.half.y);
          const pz = THREE.MathUtils.clamp(_t1.z, -hb.half.z, hb.half.z);
          const dx = _t1.x - px;
          const dy = _t1.y - py;
          const dz = _t1.z - pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          const margin = 0.03;
          if (d2 < margin * margin && d2 > 1e-9) {
            // penetration depth along the smallest push axis
            const pen = margin - Math.sqrt(d2);
            if (pen > maxPen) {
              // push direction in hull space = from clamped point to corner
              _t2.set(dx, dy, dz).normalize();
              maxPen = pen;
              _t3.copy(_t2);
            }
          } else if (d2 <= 1e-9) {
            // Corner inside hull: push out along axis of least penetration
            const pdx = hb.half.x - Math.abs(_t1.x);
            const pdy = hb.half.y - Math.abs(_t1.y);
            const pdz = hb.half.z - Math.abs(_t1.z);
            let best = pdx;
            let ax = Math.sign(_t1.x) || 1;
            let ay = 0;
            let az = 0;
            if (pdy < best) { best = pdy; ax = 0; ay = Math.sign(_t1.y) || 1; az = 0; }
            if (pdz < best) { best = pdz; ax = 0; ay = 0; az = Math.sign(_t1.z) || 1; }
            _t3.set(ax, ay, az);
            maxPen = Math.max(maxPen, best + margin);
          }
        }
      }
    }
    if (maxPen > 0 && _t3.lengthSq() > 0.5) {
      // Apply correction to turret position (hull is much heavier)
      _t1.copy(_t3).applyQuaternion(hb.quat).multiplyScalar(maxPen * 0.8);
      tb.pos.add(_t1);
      // Kill relative velocity into the hull along that axis
      const relVn = tb.vel.dot(_t1.clone().normalize());
      if (relVn < 0) tb.vel.addScaledVector(_t1.clone().normalize(), -relVn * 1.2);
    }

    // Muzzle tip vs hull box — thin sphere so the barrel can't pass through
    if (tb.hasTip) {
      _corner.copy(tb.tipOffset).applyQuaternion(tb.quat).add(tb.pos);
      _t1.subVectors(_corner, hb.pos).applyQuaternion(_qi);
      const px = THREE.MathUtils.clamp(_t1.x, -hb.half.x, hb.half.x);
      const py = THREE.MathUtils.clamp(_t1.y, -hb.half.y, hb.half.y);
      const pz = THREE.MathUtils.clamp(_t1.z, -hb.half.z, hb.half.z);
      const dx = _t1.x - px;
      const dy = _t1.y - py;
      const dz = _t1.z - pz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const TIP_R = 0.14;
      if (d < TIP_R) {
        if (d > 1e-6) _t2.set(dx, dy, dz).normalize();
        else _t2.set(0, 1, 0);
        _t3.copy(_t2).applyQuaternion(hb.quat).multiplyScalar((TIP_R - d) * 0.8);
        tb.pos.add(_t3);
        const inv = 1 / Math.max(_t3.length(), 1e-6);
        const relVn = tb.vel.dot(_t3) * inv;
        if (relVn < 0) tb.vel.addScaledVector(_t3, -relVn * 1.2 * inv);
      }
    }
  }

  private _registerObstacle(wreck: Wreck): void {
    const hb = wreck.hullBody;
    const obs: ObstacleCollider = {
      id: `wreck_${this.wreckIdCounter++}`,
      kind: 'barrier',
      x: hb.pos.x,
      z: hb.pos.z,
      y: this.world.getHeightAt(hb.pos.x, hb.pos.z) - 0.4,
      radius: Math.max(hb.half.x, hb.half.z) * 0.85,
      height: hb.half.y * 2 + 0.6,
      destructible: false,
      destroyed: false,
    };
    wreck.obstacle = obs;
    this.world.addObstacle(obs);
  }

  private _beginSink(wreck: Wreck): void {
    if (wreck.state === 'sinking' || wreck.state === 'dead') return;
    wreck.state = 'sinking';
    wreck.sinkT = 0;
    wreck.hullBody.asleep = true;
    wreck.hullBody.vel.set(0, 0, 0);
    if (wreck.turretBody) {
      wreck.turretBody.asleep = true;
      wreck.turretBody.vel.set(0, 0, 0);
    }
  }

  private _recycle(wreck: Wreck): void {
    wreck.active = false;
    wreck.state = 'dead';
    wreck.group.visible = false;
    if (wreck.obstacle) {
      this.world.removeObstacle(wreck.obstacle);
      wreck.obstacle = null;
    }
    for (const l of this.lightTargets) {
      if (l === wreck) {
        // cleared on next light scan
      }
    }
  }

  /** Adaptive-quality scalars (main.ts quality levels). */
  public fxRateMul = 1;
  public maxFireWrecks = Infinity;

  private _emitEffects(wreck: Wreck, dt: number, cameraPos: THREE.Vector3): void {
    const burning = wreck.age < 20;
    const dying = wreck.age >= 20 && wreck.age < 35;
    if (!burning && !dying && wreck.age >= 75) return;

    // Transform emitters to world (preallocated slots — no per-frame alloc)
    let emitCount = 0;
    for (const e of wreck.emitters) {
      if (emitCount >= wreck.emitWorld.length) break;
      wreck.emitWorld[emitCount++].copy(e).applyQuaternion(wreck.hullBody.quat).add(wreck.hullBody.pos);
    }
    const emitWorld = wreck.emitWorld;

    const fxDt = dt * this.fxRateMul;

    // Fire licks — many small overlapping quads per emitter
    // L2 cap: only the youngest maxFireWrecks fire-eligible wrecks burn with
    // fire; older ones go straight to smoke.
    wreck.fireAccum += fxDt;
    let fireRate = burning ? 0.055 : dying ? 0.16 : 0;
    if (fireRate > 0 && this.maxFireWrecks < Infinity) {
      let younger = 0;
      for (const w of this.wrecks) {
        if (w !== wreck && w.active && w.age < 35 && w.age < wreck.age) younger++;
      }
      if (younger >= this.maxFireWrecks) fireRate = 0;
    }
    if (fireRate > 0 && wreck.fireAccum >= fireRate) {
      wreck.fireAccum = 0;
      const nEmit = burning ? emitCount : Math.min(2, emitCount);
      const perEmitter = burning ? 2 : 1;
      for (let i = 0; i < nEmit; i++) {
        for (let k = 0; k < perEmitter; k++) {
          const p = emitWorld[i];
          this.effects.spawnWreckFire(p.x, p.y, p.z, burning ? 1.0 : 0.55);
        }
      }
    }

    // Thick black smoke column (continues through the smoke-only phase, thinner)
    wreck.smokeAccum += fxDt;
    const smokeRate = wreck.age < 35 ? 0.15 : 0.3;
    if (wreck.smokeAccum >= smokeRate) {
      wreck.smokeAccum = 0;
      const p = emitWorld[Math.floor(Math.random() * emitCount)];
      _t3.copy(p);
      _t3.y += 0.8;
      this.effects.spawnWreckSmoke(_t3);
    }

    // Embers while burning
    wreck.emberAccum += fxDt;
    if (burning && wreck.emberAccum >= 0.45) {
      wreck.emberAccum = 0;
      const p = emitWorld[Math.floor(Math.random() * emitCount)];
      this.effects.spawnEmbers(p.x, p.y + 0.4, p.z, 4);
    }

    // Delayed cook-off pops
    while (wreck.cookoffIdx < wreck.cookoffPops.length && wreck.age >= wreck.cookoffPops[wreck.cookoffIdx]) {
      wreck.cookoffIdx++;
      const p = emitWorld[0];
      if (!p || !this.effects.wreckFxVisible) continue;
      _t3.set(p.x, p.y + 0.6, p.z);
      this.effects.spawnExplosion(_t3, _dn.set(0, 1, 0), 0.55, 'he_armor');
      this.effects.spawnEmbers(p.x, p.y + 0.8, p.z, 8);
      for (let k = 0; k < 4; k++) {
        this.effects.spawnWreckFire(p.x + (Math.random() - 0.5), p.y + 0.8 + Math.random() * 0.6, p.z + (Math.random() - 0.5), 1.6);
      }
      this.applyBlast(_t3, 4, 7);
    }
    void cameraPos;
  }

  private _updateWreckLights(dt: number, cameraPos: THREE.Vector3): void {
    this.lightScanTimer -= dt;
    if (this.lightScanTimer <= 0) {
      this.lightScanTimer = 0.35;
      // Pick the 2 burning wrecks nearest the camera
      let b0: Wreck | null = null;
      let b1: Wreck | null = null;
      let d0 = Infinity;
      let d1 = Infinity;
      for (const w of this.wrecks) {
        if (!w.active || w.age >= 35) continue;
        const d = w.hullBody.pos.distanceToSquared(cameraPos);
        if (d < d0) { d1 = d0; b1 = b0; d0 = d; b0 = w; }
        else if (d < d1) { d1 = d; b1 = w; }
      }
      this.lightTargets[0] = b0;
      this.lightTargets[1] = b1;
    }
    const t = SHARED_BURN_TIME.value;
    for (let i = 0; i < 2; i++) {
      const light = this.wreckLights[i];
      const w = this.lightTargets[i];
      if (!w || !w.active || w.age >= 40) {
        light.intensity = 0;
        continue;
      }
      const flick = 0.72 + 0.28 * Math.sin(t * 11 + w.seed * 7) * Math.sin(t * 23 + w.seed * 3);
      const heatFade = Math.max(0, 1 - w.age / 40);
      light.intensity = 34 * flick * heatFade;
      light.position.set(
        w.hullBody.pos.x,
        w.hullBody.pos.y + w.hullBody.half.y + 0.8,
        w.hullBody.pos.z
      );
    }
  }
}

// Helper used above for turret-local hit transform
const _turretInvScratch = new THREE.Matrix4();
function turretWorldMatrixInv(tank: Tank): THREE.Matrix4 {
  return _turretInvScratch.copy(tank.rig.turretPivot.matrixWorld).invert();
}

const _sv2 = new THREE.Vector3();
const _pv = new THREE.Vector3();
