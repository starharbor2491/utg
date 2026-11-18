import { Color, Mat4, Quat, Vec2, Vec3, Vec4 } from 'playcanvas';
import type { GraphNode } from 'playcanvas';

export { Color, Mat4, Quat, Vec2, Vec3, Vec4 };

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const inverseLerp = (a: number, b: number, v: number): number => (a !== b ? (v - a) / (b - a) : 0);
export const mapLinear = (x: number, a1: number, a2: number, b1: number, b2: number): number =>
  b1 + ((x - a1) * (b2 - b1)) / (a2 - a1);
/** Same argument order as THREE.MathUtils.smoothstep(x, min, max). */
export const smoothstep = (x: number, min: number, max: number): number => {
  if (x <= min) return 0;
  if (x >= max) return 1;
  const t = (x - min) / (max - min);
  return t * t * (3 - 2 * t);
};
export const euclideanModulo = (n: number, m: number): number => ((n % m) + m) % m;
export const degToRad = (deg: number): number => deg * DEG2RAD;
export const radToDeg = (rad: number): number => rad * RAD2DEG;
export const randFloat = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
export const randFloatSpread = (range: number): number => range * (0.5 - Math.random());
export const randInt = (lo: number, hi: number): number => lo + Math.floor(Math.random() * (hi - lo + 1));
export const damp = (x: number, y: number, lambda: number, dt: number): number => lerp(x, y, 1 - Math.exp(-lambda * dt));
/** Wraps an angle in radians to [-PI, PI). */
export function wrapAngle(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

// ---------------------------------------------------------------------------
// Vec3 helpers with Three.js semantics. All are safe when out aliases an input.
// ---------------------------------------------------------------------------

export function distSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/** out = q * v (Three's v.applyQuaternion(q)). */
export function applyQuat(v: Vec3, q: Quat, out: Vec3 = v): Vec3 {
  const x = v.x, y = v.y, z = v.z;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return out.set(
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx
  );
}

/** Transforms a point by an affine matrix (Three's v.applyMatrix4(m) for affine m). */
export function applyMat4(v: Vec3, m: Mat4, out: Vec3 = v): Vec3 {
  const e = m.data, x = v.x, y = v.y, z = v.z;
  return out.set(
    e[0] * x + e[4] * y + e[8] * z + e[12],
    e[1] * x + e[5] * y + e[9] * z + e[13],
    e[2] * x + e[6] * y + e[10] * z + e[14]
  );
}

/** Rotates a direction by the matrix's upper 3x3 without normalizing. */
export function applyMat4Dir(v: Vec3, m: Mat4, out: Vec3 = v): Vec3 {
  const e = m.data, x = v.x, y = v.y, z = v.z;
  return out.set(e[0] * x + e[4] * y + e[8] * z, e[1] * x + e[5] * y + e[9] * z, e[2] * x + e[6] * y + e[10] * z);
}

/** Three's v.transformDirection(m): rotate by the 3x3 and normalize. */
export function transformDirection(v: Vec3, m: Mat4, out: Vec3 = v): Vec3 {
  return applyMat4Dir(v, m, out).normalize();
}

/** Full projective transform including the perspective divide (Three's applyMatrix4). */
export function applyMat4Projective(v: Vec3, m: Mat4, out: Vec3 = v): Vec3 {
  const e = m.data, x = v.x, y = v.y, z = v.z;
  const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
  return out.set(
    (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
    (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
    (e[2] * x + e[6] * y + e[10] * z + e[14]) * w
  );
}

export function negate(v: Vec3): Vec3 {
  return v.set(-v.x, -v.y, -v.z);
}

export function angleTo(a: Vec3, b: Vec3): number {
  const denominator = Math.sqrt(a.lengthSq() * b.lengthSq());
  if (denominator === 0) return Math.PI / 2;
  return Math.acos(clamp(a.dot(b) / denominator, -1, 1));
}

const _axisQuat = new Quat();
export function applyAxisAngle(v: Vec3, axis: Vec3, rad: number, out: Vec3 = v): Vec3 {
  return applyQuat(v, quatFromAxisAngle(_axisQuat, axis, rad), out);
}

/** Three's v.projectOnPlane(n) for a unit normal. */
export function projectOnPlane(v: Vec3, n: Vec3, out: Vec3 = v): Vec3 {
  const d = v.dot(n);
  return out.set(v.x - n.x * d, v.y - n.y * d, v.z - n.z * d);
}

export function clampLength(v: Vec3, min: number, max: number): Vec3 {
  const len = v.length() || 1;
  return v.mulScalar(clamp(len, min, max) / len);
}

export function setLength(v: Vec3, length: number): Vec3 {
  const len = v.length();
  return len > 0 ? v.mulScalar(length / len) : v;
}

/** Copies a world position from a node (Three's getWorldPosition). */
export function worldPosition(node: GraphNode, out: Vec3): Vec3 {
  return out.copy(node.getPosition());
}

/** Three's worldToLocal: converts a world point into node-local space in place. */
const _invWorld = new Mat4();
export function worldToLocal(node: GraphNode, point: Vec3): Vec3 {
  _invWorld.copy(node.getWorldTransform()).invert();
  return applyMat4(point, _invWorld);
}

export function localToWorld(node: GraphNode, point: Vec3): Vec3 {
  return applyMat4(point, node.getWorldTransform());
}

// ---------------------------------------------------------------------------
// Quaternions (radians). Formulas match Three.js so ported code keeps its poses.
// ---------------------------------------------------------------------------

export type EulerOrder = 'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY';

/** Three's Quaternion.setFromEuler(new Euler(x, y, z, order)). XYZ is Three's default. */
export function quatFromEuler(out: Quat, x: number, y: number, z: number, order: EulerOrder = 'XYZ'): Quat {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  switch (order) {
    case 'XYZ':
      return out.set(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
    case 'YXZ':
      return out.set(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3);
    case 'ZXY':
      return out.set(s1 * c2 * c3 - c1 * s2 * s3, c1 * s2 * c3 + s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
    case 'ZYX':
      return out.set(s1 * c2 * c3 - c1 * s2 * s3, c1 * s2 * c3 + s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3);
    case 'YZX':
      return out.set(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 + s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
    case 'XZY':
      return out.set(s1 * c2 * c3 - c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3);
  }
}

/** Radians, unlike PlayCanvas Quat.setFromAxisAngle which takes degrees. axis must be unit length. */
export function quatFromAxisAngle(out: Quat, axis: Vec3, rad: number): Quat {
  const s = Math.sin(rad / 2);
  return out.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(rad / 2));
}

/** Three's Quaternion.setFromUnitVectors(from, to). */
export function quatFromUnitVectors(out: Quat, from: Vec3, to: Vec3): Quat {
  let r = from.dot(to) + 1;
  if (r < 1e-8) {
    r = 0;
    if (Math.abs(from.x) > Math.abs(from.z)) out.set(-from.y, from.x, 0, r);
    else out.set(0, -from.z, from.y, r);
  } else {
    out.set(from.y * to.z - from.z * to.y, from.z * to.x - from.x * to.z, from.x * to.y - from.y * to.x, r);
  }
  return out.normalize();
}

/** Rotation whose local axes are the given orthonormal basis vectors. */
const _basis = new Mat4();
export function quatFromBasis(out: Quat, x: Vec3, y: Vec3, z: Vec3): Quat {
  const e = _basis.data;
  e[0] = x.x; e[1] = x.y; e[2] = x.z; e[3] = 0;
  e[4] = y.x; e[5] = y.y; e[6] = y.z; e[7] = 0;
  e[8] = z.x; e[9] = z.y; e[10] = z.z; e[11] = 0;
  e[12] = 0; e[13] = 0; e[14] = 0; e[15] = 1;
  return out.setFromMat4(_basis);
}

const _lx = new Vec3(), _ly = new Vec3(), _lz = new Vec3();
/**
 * Three's Object3D.lookAt for non-camera objects: local +Z points from eye toward target.
 * PlayCanvas Entity.lookAt aims local -Z instead (camera convention).
 */
export function quatLookAtPlusZ(out: Quat, eye: Vec3, target: Vec3, up: Vec3 = Vec3.UP): Quat {
  _lz.sub2(target, eye);
  if (_lz.lengthSq() === 0) _lz.z = 1;
  _lz.normalize();
  _lx.cross(up, _lz);
  if (_lx.lengthSq() === 0) {
    if (Math.abs(up.z) === 1) _lz.x += 0.0001;
    else _lz.z += 0.0001;
    _lz.normalize();
    _lx.cross(up, _lz);
  }
  _lx.normalize();
  _ly.cross(_lz, _lx);
  return quatFromBasis(out, _lx, _ly, _lz);
}

/** Camera convention: local -Z points from eye toward target (Three camera.lookAt / Matrix4.lookAt). */
export function quatLookAtMinusZ(out: Quat, eye: Vec3, target: Vec3, up: Vec3 = Vec3.UP): Quat {
  _lz.sub2(eye, target);
  if (_lz.lengthSq() === 0) _lz.z = 1;
  _lz.normalize();
  _lx.cross(up, _lz);
  if (_lx.lengthSq() === 0) {
    if (Math.abs(up.z) === 1) _lz.x += 0.0001;
    else _lz.z += 0.0001;
    _lz.normalize();
    _lx.cross(up, _lz);
  }
  _lx.normalize();
  _ly.cross(_lz, _lx);
  return quatFromBasis(out, _lx, _ly, _lz);
}

/** Sets a node's local rotation from radians in the given Euler order (Three's object.rotation.set). */
const _eulerQuat = new Quat();
export function setLocalEulerRad(node: GraphNode, x: number, y: number, z: number, order: EulerOrder = 'XYZ'): void {
  node.setLocalRotation(quatFromEuler(_eulerQuat, x, y, z, order));
}

/** Three's Matrix4.compose(position, quaternion, scale). */
export function composeMat(out: Mat4, p: Vec3, q: Quat, s: Vec3): Mat4 {
  return out.setTRS(p, q, s);
}

/** Three's Matrix4.decompose; handles non-uniform scale and mirroring like Three. */
const _decompose = new Mat4();
export function decomposeMat(m: Mat4, p: Vec3, q: Quat, s: Vec3): void {
  const e = m.data;
  let sx = Math.hypot(e[0], e[1], e[2]);
  const sy = Math.hypot(e[4], e[5], e[6]);
  const sz = Math.hypot(e[8], e[9], e[10]);
  const det =
    e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
  if (det < 0) sx = -sx;
  p.set(e[12], e[13], e[14]);
  _decompose.copy(m);
  const d = _decompose.data;
  const ix = 1 / sx, iy = 1 / sy, iz = 1 / sz;
  d[0] *= ix; d[1] *= ix; d[2] *= ix;
  d[4] *= iy; d[5] *= iy; d[6] *= iy;
  d[8] *= iz; d[9] *= iz; d[10] *= iz;
  q.setFromMat4(_decompose);
  s.set(sx, sy, sz);
}

// ---------------------------------------------------------------------------
// Axis-aligned box with Three's Box3 min/max API.
// ---------------------------------------------------------------------------

const _corner = new Vec3();
export class Box3 {
  readonly min = new Vec3(Infinity, Infinity, Infinity);
  readonly max = new Vec3(-Infinity, -Infinity, -Infinity);

  constructor(min?: Vec3, max?: Vec3) {
    if (min) this.min.copy(min);
    if (max) this.max.copy(max);
  }

  set(min: Vec3, max: Vec3): this {
    this.min.copy(min);
    this.max.copy(max);
    return this;
  }

  clone(): Box3 {
    return new Box3(this.min, this.max);
  }

  copy(b: Box3): this {
    return this.set(b.min, b.max);
  }

  makeEmpty(): this {
    this.min.set(Infinity, Infinity, Infinity);
    this.max.set(-Infinity, -Infinity, -Infinity);
    return this;
  }

  isEmpty(): boolean {
    return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z;
  }

  expandByPoint(p: Vec3): this {
    this.min.min(p);
    this.max.max(p);
    return this;
  }

  expandByXYZ(x: number, y: number, z: number): this {
    return this.expandByPoint(_corner.set(x, y, z));
  }

  expandByScalar(s: number): this {
    this.min.x -= s; this.min.y -= s; this.min.z -= s;
    this.max.x += s; this.max.y += s; this.max.z += s;
    return this;
  }

  union(b: Box3): this {
    this.min.min(b.min);
    this.max.max(b.max);
    return this;
  }

  intersect(b: Box3): this {
    this.min.max(b.min);
    this.max.min(b.max);
    if (this.isEmpty()) this.makeEmpty();
    return this;
  }

  getSize(out: Vec3): Vec3 {
    return this.isEmpty() ? out.set(0, 0, 0) : out.sub2(this.max, this.min);
  }

  getCenter(out: Vec3): Vec3 {
    return this.isEmpty() ? out.set(0, 0, 0) : out.add2(this.min, this.max).mulScalar(0.5);
  }

  containsPoint(p: Vec3): boolean {
    return p.x >= this.min.x && p.x <= this.max.x && p.y >= this.min.y && p.y <= this.max.y && p.z >= this.min.z && p.z <= this.max.z;
  }

  intersectsBox(b: Box3): boolean {
    return b.max.x >= this.min.x && b.min.x <= this.max.x && b.max.y >= this.min.y && b.min.y <= this.max.y && b.max.z >= this.min.z && b.min.z <= this.max.z;
  }

  /** Transforms the 8 corners and re-fits, like Three's Box3.applyMatrix4. */
  applyMatrix4(m: Mat4): this {
    if (this.isEmpty()) return this;
    const { x: x0, y: y0, z: z0 } = this.min;
    const { x: x1, y: y1, z: z1 } = this.max;
    this.makeEmpty();
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0);
      this.expandByPoint(applyMat4(_corner, m));
    }
    return this;
  }

  /** Grows the box to include a flat xyz array transformed by m (or untransformed). */
  expandByPositions(positions: ArrayLike<number>, m?: Mat4): this {
    for (let i = 0; i + 2 < positions.length; i += 3) {
      _corner.set(positions[i], positions[i + 1], positions[i + 2]);
      if (m) applyMat4(_corner, m);
      this.expandByPoint(_corner);
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// Colours. PlayCanvas materials, lights, fog and ambient take sRGB colours and
// linearize on upload; vertex colours and raw shader uniforms must be linear.
// ---------------------------------------------------------------------------

/** sRGB colour for material, light and fog properties. Accepts '#rrggbb' or 0xrrggbb. */
export function srgb(hex: string | number): Color {
  const c = new Color();
  if (typeof hex === 'number') return c.set(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, 1);
  return c.fromString(hex);
}

/** Linear colour for vertex colours and setParameter uniforms (Three's new Color(hex) values). */
export function linearColor(hex: string | number): Color {
  return srgb(hex).linear();
}

export function toVec3(c: Color, out: Vec3 = new Vec3()): Vec3 {
  return out.set(c.r, c.g, c.b);
}
