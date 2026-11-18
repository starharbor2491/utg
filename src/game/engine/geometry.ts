import earcut from 'earcut';
import {
  Mesh,
  PRIMITIVE_TRIANGLES,
  SEMANTIC_TANGENT,
  TYPE_INT8,
  TYPE_UINT8,
  TYPE_INT16,
  TYPE_UINT16,
  RoundedBoxGeometry as PcRoundedBoxGeometry,
} from 'playcanvas';
import { getDevice } from './app';
import {
  applyMat4,
  applyMat4Dir,
  applyQuat,
  Box3,
  Mat4,
  Quat,
  Vec2,
  Vec3,
  quatFromAxisAngle,
} from './math';

export interface GeoAttribute {
  data: Float32Array;
  components: number;
  semantic?: string;
}

export interface GeoGroup {
  start: number;
  count: number;
  materialIndex: number;
}

const _v = new Vec3();
const _q = new Quat();
const _m = new Mat4();
const _normalMatrix = new Mat4();

/** CPU geometry shared by procedural models, wreck extraction and precise bounds. */
export class Geo {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[] | null = null;
  indices: number[];
  readonly attributes = new Map<string, GeoAttribute>();
  readonly groups: GeoGroup[] = [];
  private gpuMesh: Mesh | null = null;

  constructor(positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = []) {
    this.positions = positions;
    this.normals = normals;
    this.uvs = uvs;
    this.indices = indices;
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return (this.indices.length || this.positions.length / 3) / 3;
  }

  clone(): Geo {
    const g = new Geo([...this.positions], [...this.normals], [...this.uvs], [...this.indices]);
    if (this.colors) g.colors = [...this.colors];
    for (const [name, a] of this.attributes) {
      g.attributes.set(name, { data: new Float32Array(a.data), components: a.components, semantic: a.semantic });
    }
    g.groups.push(...this.groups.map((g) => ({ ...g })));
    return g;
  }

  setAttribute(name: string, data: ArrayLike<number>, components: number, semantic?: string): this {
    this.attributes.set(name, { data: new Float32Array(data), components, semantic });
    return this;
  }

  setColor(hex: string | number): this {
    const n = typeof hex === 'number' ? hex : parseInt(hex.replace('#', ''), 16);
    const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const r = srgbToLinear(((n >> 16) & 255) / 255);
    const g = srgbToLinear(((n >> 8) & 255) / 255);
    const b = srgbToLinear((n & 255) / 255);
    this.colors = [];
    for (let i = 0; i < this.vertexCount; i++) this.colors.push(r, g, b, 1);
    return this;
  }

  applyMatrix(m: Mat4): this {
    _normalMatrix.copy(m).invert().transpose();
    for (let i = 0; i < this.positions.length; i += 3) {
      _v.set(this.positions[i], this.positions[i + 1], this.positions[i + 2]);
      applyMat4(_v, m);
      this.positions[i] = _v.x; this.positions[i + 1] = _v.y; this.positions[i + 2] = _v.z;
    }
    for (let i = 0; i < this.normals.length; i += 3) {
      _v.set(this.normals[i], this.normals[i + 1], this.normals[i + 2]);
      applyMat4Dir(_v, _normalMatrix).normalize();
      this.normals[i] = _v.x; this.normals[i + 1] = _v.y; this.normals[i + 2] = _v.z;
    }
    return this;
  }

  applyQuat(q: Quat): this {
    return this.applyMatrix(_m.setTRS(Vec3.ZERO, q, Vec3.ONE));
  }

  rotateX(a: number): this { return this.applyQuat(quatFromAxisAngle(_q, Vec3.RIGHT, a)); }
  rotateY(a: number): this { return this.applyQuat(quatFromAxisAngle(_q, Vec3.UP, a)); }
  rotateZ(a: number): this { return this.applyQuat(quatFromAxisAngle(_q, Vec3.BACK, a)); }

  translate(x: number, y: number, z: number): this {
    for (let i = 0; i < this.positions.length; i += 3) {
      this.positions[i] += x; this.positions[i + 1] += y; this.positions[i + 2] += z;
    }
    return this;
  }

  scale(x: number, y: number, z: number): this {
    for (let i = 0; i < this.positions.length; i += 3) {
      this.positions[i] *= x; this.positions[i + 1] *= y; this.positions[i + 2] *= z;
    }
    for (let i = 0; i < this.normals.length; i += 3) {
      _v.set(this.normals[i] / x, this.normals[i + 1] / y, this.normals[i + 2] / z).normalize();
      this.normals[i] = _v.x; this.normals[i + 1] = _v.y; this.normals[i + 2] = _v.z;
    }
    return this;
  }

  transform(x: number, y: number, z: number, rx: number, ry: number, rz: number, sx = 1, sy = 1, sz = 1): this {
    const q = new Quat().setFromEulerAngles(rx * 180 / Math.PI, ry * 180 / Math.PI, rz * 180 / Math.PI);
    _m.setTRS(new Vec3(x, y, z), q, new Vec3(sx, sy, sz));
    return this.applyMatrix(_m);
  }

  computeNormals(): this {
    this.normals = new Array(this.positions.length).fill(0);
    const count = this.indices.length || this.positions.length / 3;
    for (let i = 0; i < count; i += 3) {
      const a = this.indices.length ? this.indices[i] : i;
      const b = this.indices.length ? this.indices[i + 1] : i + 1;
      const c = this.indices.length ? this.indices[i + 2] : i + 2;
      const ai = a * 3, bi = b * 3, ci = c * 3;
      const abx = this.positions[bi] - this.positions[ai];
      const aby = this.positions[bi + 1] - this.positions[ai + 1];
      const abz = this.positions[bi + 2] - this.positions[ai + 2];
      const acx = this.positions[ci] - this.positions[ai];
      const acy = this.positions[ci + 1] - this.positions[ai + 1];
      const acz = this.positions[ci + 2] - this.positions[ai + 2];
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      for (const j of [ai, bi, ci]) {
        this.normals[j] += nx; this.normals[j + 1] += ny; this.normals[j + 2] += nz;
      }
    }
    for (let i = 0; i < this.normals.length; i += 3) {
      _v.set(this.normals[i], this.normals[i + 1], this.normals[i + 2]);
      if (_v.lengthSq() < 1e-20) _v.set(0, 1, 0); else _v.normalize();
      this.normals[i] = _v.x; this.normals[i + 1] = _v.y; this.normals[i + 2] = _v.z;
    }
    return this;
  }

  toFlat(): Geo {
    if (!this.indices.length) return this.clone();
    const g = new Geo();
    const remap = (src: number[] | null, size: number, fill: number[]) => {
      if (!src && !fill.length) return null;
      const out: number[] = [];
      for (const i of this.indices) {
        for (let k = 0; k < size; k++) out.push(src?.[i * size + k] ?? fill[k]);
      }
      return out;
    };
    g.positions = remap(this.positions, 3, [0, 0, 0])!;
    g.normals = remap(this.normals, 3, [])!;
    g.uvs = remap(this.uvs, 2, [])!;
    g.colors = this.colors ? remap(this.colors, 4, [1, 1, 1, 1]) : null;
    for (const [name, a] of this.attributes) {
      const data = new Float32Array(this.indices.length * a.components);
      for (let i = 0; i < this.indices.length; i++) {
        for (let k = 0; k < a.components; k++) data[i * a.components + k] = a.data[this.indices[i] * a.components + k] ?? 0;
      }
      g.attributes.set(name, { data, components: a.components, semantic: a.semantic });
    }
    return g;
  }

  weld(tolerance = 1e-4): Geo {
    const map = new Map<string, number>();
    const remap: number[] = [];
    const g = new Geo();
    const vertexKey = (i: number) => {
      const values = [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]];
      if (this.normals.length) values.push(this.normals[i * 3], this.normals[i * 3 + 1], this.normals[i * 3 + 2]);
      if (this.uvs.length) values.push(this.uvs[i * 2], this.uvs[i * 2 + 1]);
      return values.map((v) => Math.round(v / tolerance)).join(',');
    };
    const append = (i: number) => {
      const key = vertexKey(i);
      const existing = map.get(key);
      if (existing !== undefined) return existing;
      const n = g.vertexCount;
      map.set(key, n);
      g.positions.push(...this.positions.slice(i * 3, i * 3 + 3));
      if (this.normals.length) g.normals.push(...this.normals.slice(i * 3, i * 3 + 3));
      if (this.uvs.length) g.uvs.push(...this.uvs.slice(i * 2, i * 2 + 2));
      if (this.colors) g.colors!.push(...this.colors.slice(i * 4, i * 4 + 4));
      return n;
    };
    const count = this.indices.length || this.vertexCount;
    for (let i = 0; i < count; i++) remap.push(append(this.indices.length ? this.indices[i] : i));
    g.indices = remap;
    return g;
  }

  bounds(out = new Box3()): Box3 {
    return out.makeEmpty().expandByPositions(this.positions);
  }

  addGroup(start: number, count: number, materialIndex: number): this {
    this.groups.push({ start, count, materialIndex });
    return this;
  }

  toMesh(): Mesh {
    if (this.gpuMesh?.vertexBuffer) return this.gpuMesh;
    const mesh = new Mesh(getDevice());
    mesh.setPositions(this.positions);
    if (this.normals.length) mesh.setNormals(this.normals);
    if (this.uvs.length) mesh.setUvs(0, this.uvs);
    if (this.colors) mesh.setColors(this.colors, 4);
    let autoSlot = 0;
    for (const [name, a] of this.attributes) {
      const semantic = a.semantic ?? `ATTR${autoSlot++}`;
      a.semantic = semantic;
      mesh.setVertexStream(semantic, a.data, a.components);
    }
    if (this.indices.length) mesh.setIndices(this.indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    this.gpuMesh = mesh;
    return mesh;
  }

  static merge(geometries: Geo[], useGroups = false): Geo | null {
    if (!geometries.length) return null;
    const out = new Geo();
    let hasNormals = geometries.some((g) => g.normals.length > 0);
    let hasUvs = geometries.some((g) => g.uvs.length > 0);
    let hasColors = geometries.some((g) => !!g.colors);
    if (hasColors) out.colors = [];
    for (const source of geometries) {
      const g = source.indices.length ? source : source.clone();
      if (!g.indices.length) for (let i = 0; i < g.vertexCount; i++) g.indices.push(i);
      const offset = out.vertexCount;
      out.positions.push(...g.positions);
      if (hasNormals) {
        for (let i = 0; i < g.vertexCount; i++) out.normals.push(...(g.normals.length ? g.normals.slice(i * 3, i * 3 + 3) : [0, 1, 0]));
      }
      if (hasUvs) {
        for (let i = 0; i < g.vertexCount; i++) out.uvs.push(...(g.uvs.length ? g.uvs.slice(i * 2, i * 2 + 2) : [0, 0]));
      }
      if (hasColors) {
        for (let i = 0; i < g.vertexCount; i++) out.colors!.push(...(g.colors ? g.colors.slice(i * 4, i * 4 + 4) : [1, 1, 1, 1]));
      }
      const start = out.indices.length;
      for (const i of g.indices) out.indices.push(i + offset);
      if (useGroups) out.groups.push({ start, count: g.indices.length, materialIndex: out.groups.length });
    }
    return out;
  }
}

/** Float readback for both procedural and normalized, quantized GLB vertex streams. */
export function geoFromMesh(mesh: Mesh): Geo {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], colors: number[] = [], indices: number[] = [];
  const read = (semantic: string, out: number[]): void => {
    mesh.getVertexStream(semantic, out);
    const element = mesh.vertexBuffer?.getFormat().elements.find((e) => e.name === semantic);
    if (!element?.normalize) return;
    const divisor = element.dataType === TYPE_INT8 ? 127 : element.dataType === TYPE_UINT8 ? 255
      : element.dataType === TYPE_INT16 ? 32767 : element.dataType === TYPE_UINT16 ? 65535 : 1;
    if (divisor !== 1) for (let i = 0; i < out.length; i++) out[i] /= divisor;
  };
  read('POSITION', positions);
  read('NORMAL', normals);
  read('TEXCOORD0', uvs);
  read('COLOR', colors);
  mesh.getIndices(indices);
  const g = new Geo(positions, normals, uvs, indices);
  if (colors.length) g.colors = colors;
  const tangents: number[] = [];
  read(SEMANTIC_TANGENT, tangents);
  if (tangents.length) g.setAttribute('vertex_tangent', tangents, 4, SEMANTIC_TANGENT);
  return g;
}

export function box(width = 1, height = 1, depth = 1, widthSegments = 1, heightSegments = 1, depthSegments = 1): Geo {
  const g = new Geo();
  const build = (u: number, v: number, w: number, udir: number, vdir: number, hu: number, hv: number, hd: number, nu: number, nv: number) => {
    const start = g.vertexCount;
    for (let y = 0; y <= nv; y++) {
      for (let x = 0; x <= nu; x++) {
        const p = [0, 0, 0];
        p[u] = (x / nu * 2 - 1) * hu * udir;
        p[v] = (y / nv * 2 - 1) * hv * vdir;
        p[w] = hd;
        g.positions.push(...p);
        const n = [0, 0, 0]; n[w] = Math.sign(hd); g.normals.push(...n);
        g.uvs.push(x / nu, 1 - y / nv);
      }
    }
    for (let y = 0; y < nv; y++) {
      for (let x = 0; x < nu; x++) {
        const a = start + x + (nu + 1) * y, b = start + x + (nu + 1) * (y + 1), c = b + 1, d = a + 1;
        g.indices.push(a, b, d, b, c, d);
      }
    }
  };
  build(2, 1, 0, -1, -1, depth / 2, height / 2, width / 2, depthSegments, heightSegments);
  build(2, 1, 0, 1, -1, depth / 2, height / 2, -width / 2, depthSegments, heightSegments);
  build(0, 2, 1, 1, 1, width / 2, depth / 2, height / 2, widthSegments, depthSegments);
  build(0, 2, 1, 1, -1, width / 2, depth / 2, -height / 2, widthSegments, depthSegments);
  build(0, 1, 2, 1, -1, width / 2, height / 2, depth / 2, widthSegments, heightSegments);
  build(0, 1, 2, -1, -1, width / 2, height / 2, -depth / 2, widthSegments, heightSegments);
  return g;
}

export function roundedBox(width: number, height: number, depth: number, segments = 2, radius = 0.1): Geo {
  const src = new PcRoundedBoxGeometry({
    halfExtents: new Vec3(width / 2, height / 2, depth / 2),
    radius: Math.min(radius, width / 2, height / 2, depth / 2),
    radiusSegments: Math.max(2, Math.ceil(segments / 2) * 2),
  });
  return new Geo([...src.positions], [...src.normals], [...src.uvs], [...src.indices]);
}

export function cylinder(radiusTop = 1, radiusBottom = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false, thetaStart = 0, thetaLength = Math.PI * 2): Geo {
  const g = new Geo();
  const half = height / 2;
  for (let y = 0; y <= heightSegments; y++) {
    const t = y / heightSegments;
    const r = t * (radiusBottom - radiusTop) + radiusTop;
    const slope = (radiusBottom - radiusTop) / height;
    for (let x = 0; x <= radialSegments; x++) {
      const u = x / radialSegments, a = u * thetaLength + thetaStart;
      const s = Math.sin(a), c = Math.cos(a);
      g.positions.push(r * s, half - t * height, r * c);
      _v.set(s, slope, c).normalize(); g.normals.push(_v.x, _v.y, _v.z);
      g.uvs.push(u, 1 - t);
    }
  }
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < radialSegments; x++) {
      const a = y * (radialSegments + 1) + x, b = a + radialSegments + 1;
      g.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const cap = (top: boolean) => {
    if (openEnded || (top ? radiusTop : radiusBottom) === 0) return;
    const r = top ? radiusTop : radiusBottom, y = top ? half : -half, sign = top ? 1 : -1;
    const center = g.vertexCount;
    g.positions.push(0, y, 0); g.normals.push(0, sign, 0); g.uvs.push(0.5, 0.5);
    for (let x = 0; x <= radialSegments; x++) {
      const a = x / radialSegments * thetaLength + thetaStart, s = Math.sin(a), c = Math.cos(a);
      g.positions.push(r * s, y, r * c); g.normals.push(0, sign, 0);
      g.uvs.push(top ? (s + 1) / 2 : (-s + 1) / 2, (c + 1) / 2);
    }
    for (let x = 0; x < radialSegments; x++) {
      if (top) g.indices.push(center, center + x + 1, center + x + 2);
      else g.indices.push(center, center + x + 2, center + x + 1);
    }
  };
  cap(true); cap(false);
  return g;
}

export function cone(radius = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false): Geo {
  return cylinder(0, radius, height, radialSegments, heightSegments, openEnded);
}

export function sphere(radius = 1, widthSegments = 32, heightSegments = 16, phiStart = 0, phiLength = Math.PI * 2, thetaStart = 0, thetaLength = Math.PI): Geo {
  const g = new Geo();
  for (let y = 0; y <= heightSegments; y++) {
    const v = y / heightSegments, theta = thetaStart + v * thetaLength;
    for (let x = 0; x <= widthSegments; x++) {
      const u = x / widthSegments, phi = phiStart + u * phiLength;
      const px = -radius * Math.cos(phi) * Math.sin(theta);
      const py = radius * Math.cos(theta);
      const pz = radius * Math.sin(phi) * Math.sin(theta);
      g.positions.push(px, py, pz);
      _v.set(px, py, pz).normalize(); g.normals.push(_v.x, _v.y, _v.z);
      g.uvs.push(u, 1 - v);
    }
  }
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * (widthSegments + 1) + x, b = a + widthSegments + 1;
      if (y !== 0 || thetaStart > 0) g.indices.push(a, b, a + 1);
      if (y !== heightSegments - 1 || thetaStart + thetaLength < Math.PI) g.indices.push(a + 1, b, b + 1);
    }
  }
  return g;
}

export function plane(width = 1, height = 1, widthSegments = 1, heightSegments = 1): Geo {
  const g = new Geo();
  for (let y = 0; y <= heightSegments; y++) {
    for (let x = 0; x <= widthSegments; x++) {
      g.positions.push((x / widthSegments - 0.5) * width, (0.5 - y / heightSegments) * height, 0);
      g.normals.push(0, 0, 1); g.uvs.push(x / widthSegments, 1 - y / heightSegments);
    }
  }
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * (widthSegments + 1) + x, b = a + widthSegments + 1;
      g.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return g;
}

export function circle(radius = 1, segments = 32, thetaStart = 0, thetaLength = Math.PI * 2): Geo {
  const g = new Geo([0, 0, 0], [0, 0, 1], [0.5, 0.5]);
  for (let i = 0; i <= segments; i++) {
    const a = thetaStart + i / segments * thetaLength, x = Math.cos(a), y = Math.sin(a);
    g.positions.push(radius * x, radius * y, 0); g.normals.push(0, 0, 1); g.uvs.push((x + 1) / 2, (y + 1) / 2);
  }
  for (let i = 1; i <= segments; i++) g.indices.push(i, i + 1, 0);
  return g;
}

export function ring(innerRadius = 0.5, outerRadius = 1, thetaSegments = 32, phiSegments = 1, thetaStart = 0, thetaLength = Math.PI * 2): Geo {
  const g = new Geo();
  for (let j = 0; j <= phiSegments; j++) {
    const r = innerRadius + (outerRadius - innerRadius) * j / phiSegments;
    for (let i = 0; i <= thetaSegments; i++) {
      const a = thetaStart + i / thetaSegments * thetaLength;
      g.positions.push(r * Math.cos(a), r * Math.sin(a), 0); g.normals.push(0, 0, 1);
      g.uvs.push((Math.cos(a) * r / outerRadius + 1) / 2, (Math.sin(a) * r / outerRadius + 1) / 2);
    }
  }
  for (let j = 0; j < phiSegments; j++) {
    for (let i = 0; i < thetaSegments; i++) {
      const a = j * (thetaSegments + 1) + i, b = a + thetaSegments + 1;
      g.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return g;
}

export function torus(radius = 1, tube = 0.4, radialSegments = 12, tubularSegments = 48, arc = Math.PI * 2): Geo {
  const g = new Geo();
  for (let j = 0; j <= radialSegments; j++) {
    const v = j / radialSegments * Math.PI * 2;
    for (let i = 0; i <= tubularSegments; i++) {
      const u = i / tubularSegments * arc;
      const x = (radius + tube * Math.cos(v)) * Math.cos(u);
      const y = (radius + tube * Math.cos(v)) * Math.sin(u);
      const z = tube * Math.sin(v);
      g.positions.push(x, y, z);
      _v.set(x - radius * Math.cos(u), y - radius * Math.sin(u), z).normalize();
      g.normals.push(_v.x, _v.y, _v.z); g.uvs.push(i / tubularSegments, j / radialSegments);
    }
  }
  for (let j = 1; j <= radialSegments; j++) {
    for (let i = 1; i <= tubularSegments; i++) {
      const a = (tubularSegments + 1) * j + i - 1, b = (tubularSegments + 1) * (j - 1) + i - 1;
      const c = (tubularSegments + 1) * (j - 1) + i, d = (tubularSegments + 1) * j + i;
      g.indices.push(a, b, d, b, c, d);
    }
  }
  return g;
}

export function lathe(points: Vec2[], segments = 12, phiStart = 0, phiLength = Math.PI * 2): Geo {
  const g = new Geo();
  for (let i = 0; i <= segments; i++) {
    const phi = phiStart + i / segments * phiLength, s = Math.sin(phi), c = Math.cos(phi);
    for (let j = 0; j < points.length; j++) {
      g.positions.push(points[j].x * s, points[j].y, points[j].x * c);
      g.normals.push(0, 0, 0); g.uvs.push(i / segments, j / (points.length - 1));
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < points.length - 1; j++) {
      const a = i * points.length + j, b = a + points.length;
      g.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return g.computeNormals();
}

export abstract class Curve3 {
  abstract getPoint(t: number, out?: Vec3): Vec3;
  getTangent(t: number, out = new Vec3()): Vec3 {
    const d = 1e-4, a = this.getPoint(Math.max(0, t - d)), b = this.getPoint(Math.min(1, t + d));
    return out.sub2(b, a).normalize();
  }
}

export class LineCurve3 extends Curve3 {
  constructor(private a: Vec3, private b: Vec3) { super(); }
  getPoint(t: number, out = new Vec3()): Vec3 { return out.lerp(this.a, this.b, t); }
}

export class QuadraticBezierCurve3 extends Curve3 {
  constructor(private a: Vec3, private b: Vec3, private c: Vec3) { super(); }
  getPoint(t: number, out = new Vec3()): Vec3 {
    const u = 1 - t;
    return out.set(u * u * this.a.x + 2 * u * t * this.b.x + t * t * this.c.x,
      u * u * this.a.y + 2 * u * t * this.b.y + t * t * this.c.y,
      u * u * this.a.z + 2 * u * t * this.b.z + t * t * this.c.z);
  }
}

export class CubicBezierCurve3 extends Curve3 {
  constructor(private a: Vec3, private b: Vec3, private c: Vec3, private d: Vec3) { super(); }
  getPoint(t: number, out = new Vec3()): Vec3 {
    const u = 1 - t;
    const coeff = (a: number, b: number, c: number, d: number) => u ** 3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t ** 3 * d;
    return out.set(coeff(this.a.x, this.b.x, this.c.x, this.d.x), coeff(this.a.y, this.b.y, this.c.y, this.d.y), coeff(this.a.z, this.b.z, this.c.z, this.d.z));
  }
}

/** Three's uniform Catmull-Rom formulation, including its configurable tension. */
export class CatmullRomCurve3 extends Curve3 {
  constructor(private points: Vec3[], public closed = false, private curveType = 'centripetal', private tension = 0.5) { super(); }
  getPoint(t: number, out = new Vec3()): Vec3 {
    const l = this.points.length;
    let p = (l - (this.closed ? 0 : 1)) * t;
    let int = Math.floor(p), weight = p - int;
    if (this.closed) int = (int + l) % l;
    else if (weight === 0 && int === l - 1) { int = l - 2; weight = 1; }
    const at = (i: number) => this.points[this.closed ? (i + l) % l : Math.max(0, Math.min(l - 1, i))];
    const p0 = at(int - 1), p1 = at(int), p2 = at(int + 1), p3 = at(int + 2);
    const calc = (a: number, b: number, c: number, d: number) => {
      if (this.curveType !== 'catmullrom') {
        const dist = (x: Vec3, y: Vec3) => Math.max(1e-4, x.distanceSq(y) ** (this.curveType === 'centripetal' ? 0.25 : 0.5));
        let t0 = 0, t1 = dist(p0, p1), t2 = t1 + dist(p1, p2), t3 = t2 + dist(p2, p3);
        t1 = (t1 - t0) / (t3 - t0); t2 = (t2 - t0) / (t3 - t0); t3 = 1;
        const tt = t1 + (t2 - t1) * weight;
        const a1 = (a0: number, a1: number) => a0 + (a1 - a0) * (tt / t1 || 0);
        const a2v = (a0: number, a1: number) => a0 + (a1 - a0) * ((tt - t1) / (t2 - t1) || 0);
        const a3v = (a0: number, a1: number) => a0 + (a1 - a0) * ((tt - t2) / (1 - t2) || 0);
        const b0 = a1(a, b), b1 = a2v(b, c), b2 = a3v(c, d);
        const c0 = b0 + (b1 - b0) * ((tt - 0) / t2 || 0);
        const c1 = b1 + (b2 - b1) * ((tt - t1) / (1 - t1) || 0);
        return c0 + (c1 - c0) * ((tt - t1) / (t2 - t1) || 0);
      }
      const m1 = (1 - this.tension) * 0.5 * (c - a);
      const m2 = (1 - this.tension) * 0.5 * (d - b);
      return (2 * weight ** 3 - 3 * weight ** 2 + 1) * b + (weight ** 3 - 2 * weight ** 2 + weight) * m1 +
        (-2 * weight ** 3 + 3 * weight ** 2) * c + (weight ** 3 - weight ** 2) * m2;
    };
    void p3;
    return out.set(calc(p0.x, p1.x, p2.x, p3.x), calc(p0.y, p1.y, p2.y, p3.y), calc(p0.z, p1.z, p2.z, p3.z));
  }
}

export function tube(curve: Curve3, tubularSegments = 64, radius = 1, radialSegments = 8, closed = false): Geo {
  const g = new Geo();
  const frames: { n: Vec3; b: Vec3; p: Vec3 }[] = [];
  let normal = new Vec3();
  const tangent = curve.getTangent(0);
  const min = Math.min(Math.abs(tangent.x), Math.abs(tangent.y), Math.abs(tangent.z));
  normal.set(Math.abs(tangent.x) === min ? 1 : 0, Math.abs(tangent.y) === min ? 1 : 0, Math.abs(tangent.z) === min ? 1 : 0);
  normal.cross(normal, tangent).normalize();
  let previousTangent = tangent.clone();
  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments, tan = curve.getTangent(t);
    if (i > 0) {
      quatFromAxisAngle(_q, _v.copy(previousTangent).cross(previousTangent, tan).normalize(), Math.acos(Math.max(-1, Math.min(1, previousTangent.dot(tan)))));
      if (_v.lengthSq() > 1e-10) applyQuat(normal, _q).normalize();
    }
    frames.push({ n: normal.clone(), b: new Vec3().cross(tan, normal).normalize(), p: curve.getPoint(t) });
    previousTangent = tan.clone();
  }
  for (let i = 0; i <= tubularSegments; i++) {
    for (let j = 0; j <= radialSegments; j++) {
      const a = j / radialSegments * Math.PI * 2, s = Math.sin(a), c = -Math.cos(a), f = frames[i];
      _v.set(c * f.n.x + s * f.b.x, c * f.n.y + s * f.b.y, c * f.n.z + s * f.b.z).normalize();
      g.normals.push(_v.x, _v.y, _v.z);
      g.positions.push(f.p.x + radius * _v.x, f.p.y + radius * _v.y, f.p.z + radius * _v.z);
      g.uvs.push(i / tubularSegments, j / radialSegments);
    }
  }
  for (let i = 1; i <= tubularSegments; i++) {
    for (let j = 1; j <= radialSegments; j++) {
      const a = (radialSegments + 1) * (i - 1) + j - 1, b = (radialSegments + 1) * i + j - 1;
      const c = (radialSegments + 1) * i + j, d = (radialSegments + 1) * (i - 1) + j;
      g.indices.push(a, b, d, b, c, d);
    }
  }
  void closed;
  return g;
}

export class Path {
  readonly points: Vec2[] = [];
  constructor(points: Vec2[] = []) { this.points.push(...points.map((p) => p.clone())); }
  moveTo(x: number, y: number): this { this.points.push(new Vec2(x, y)); return this; }
  lineTo(x: number, y: number): this { this.points.push(new Vec2(x, y)); return this; }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): this {
    const p = this.points[this.points.length - 1] ?? new Vec2(cx, cy);
    for (let i = 1; i <= 12; i++) {
      const t = i / 12, u = 1 - t;
      this.points.push(new Vec2(u * u * p.x + 2 * u * t * cx + t * t * x, u * u * p.y + 2 * u * t * cy + t * t * y));
    }
    return this;
  }
  closePath(): this {
    const a = this.points[0], b = this.points[this.points.length - 1];
    if (a && b && !a.equals(b)) this.points.push(a.clone());
    return this;
  }
  absarc(x: number, y: number, radius: number, start: number, end: number, clockwise = false): this {
    let delta = end - start;
    if (!clockwise && delta < 0) delta += Math.PI * 2;
    if (clockwise && delta > 0) delta -= Math.PI * 2;
    const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI * 2) * 48));
    for (let i = 0; i <= steps; i++) {
      const a = start + delta * i / steps;
      this.points.push(new Vec2(x + Math.cos(a) * radius, y + Math.sin(a) * radius));
    }
    return this;
  }
}

export class Shape extends Path {
  readonly holes: Path[] = [];
}

interface ExtrudeOptions {
  depth?: number;
  steps?: number;
  bevelEnabled?: boolean;
  bevelThickness?: number;
  bevelSize?: number;
  bevelOffset?: number;
  bevelSegments?: number;
  curveSegments?: number;
}

function cleanContour(points: Vec2[]): Vec2[] {
  const out = points.map((p) => p.clone());
  for (let i = out.length - 1; i > 0; i--) if (out[i].distance(out[i - 1]) < 1e-7) out.splice(i, 1);
  if (out.length > 1 && out[0].distance(out[out.length - 1]) < 1e-7) out.pop();
  return out;
}

function signedArea(points: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length]; area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function offsetContour(points: Vec2[], amount: number): Vec2[] {
  return points.map((p, i) => {
    const prev = points[(i + points.length - 1) % points.length], next = points[(i + 1) % points.length];
    const d0 = new Vec2(p.x - prev.x, p.y - prev.y).normalize();
    const d1 = new Vec2(next.x - p.x, next.y - p.y).normalize();
    const n0 = new Vec2(-d0.y, d0.x), n1 = new Vec2(-d1.y, d1.x);
    const n = new Vec2(n0.x + n1.x, n0.y + n1.y).normalize();
    const denom = Math.max(0.2, n.dot(n0));
    return new Vec2(p.x + n.x * amount / denom, p.y + n.y * amount / denom);
  });
}

/** Straight extrusion with Three-style caps, bevels, and holes. */
export function extrude(shapes: Shape | Shape[], options: ExtrudeOptions = {}): Geo {
  const out = new Geo();
  for (const shape of Array.isArray(shapes) ? shapes : [shapes]) {
    let outer = cleanContour(shape.points);
    if (outer.length < 3) continue;
    if (signedArea(outer) < 0) outer.reverse();
    const holes = shape.holes.map((h) => {
      const p = cleanContour(h.points); if (signedArea(p) > 0) p.reverse(); return p;
    }).filter((p) => p.length >= 3);
    const depth = options.depth ?? 1, steps = options.steps ?? 1;
    const bevel = options.bevelEnabled ?? true;
    const thickness = bevel ? options.bevelThickness ?? 0.2 : 0;
    const size = bevel ? options.bevelSize ?? thickness - 0.1 : 0;
    const bevelSegments = bevel ? options.bevelSegments ?? 3 : 0;
    const contours = [outer, ...holes];
    const layers: { z: number; inset: number }[] = [];
    for (let b = 0; b <= bevelSegments; b++) {
      const t = b / Math.max(1, bevelSegments);
      layers.push({ z: -thickness * Math.cos(t * Math.PI / 2), inset: size * Math.sin(t * Math.PI / 2) + (options.bevelOffset ?? 0) });
    }
    for (let s = 1; s <= steps; s++) layers.push({ z: depth * s / steps, inset: 0 });
    for (let b = bevelSegments - 1; b >= 0; b--) {
      const t = b / Math.max(1, bevelSegments);
      layers.push({ z: depth + thickness * Math.cos(t * Math.PI / 2), inset: size * Math.sin(t * Math.PI / 2) + (options.bevelOffset ?? 0) });
    }
    const rings = layers.map((layer) => contours.map((c, i) => offsetContour(c, i === 0 ? layer.inset : -layer.inset)));
    const cap = (ring: Vec2[][], back: boolean) => {
      const flat: number[] = [], holeIndices: number[] = [];
      for (const c of ring) {
        if (c !== ring[0]) holeIndices.push(flat.length / 2);
        for (const p of c) flat.push(p.x, p.y);
      }
      const triangles = earcut(flat, holeIndices, 2), z = back ? layers[0].z : layers[layers.length - 1].z;
      const base = out.vertexCount;
      for (let i = 0; i < flat.length; i += 2) {
        out.positions.push(flat[i], flat[i + 1], z); out.normals.push(0, 0, back ? -1 : 1); out.uvs.push(flat[i], flat[i + 1]);
      }
      for (let i = 0; i < triangles.length; i += 3) {
        if (back) out.indices.push(base + triangles[i], base + triangles[i + 2], base + triangles[i + 1]);
        else out.indices.push(base + triangles[i], base + triangles[i + 1], base + triangles[i + 2]);
      }
    };
    cap(rings[0], true); cap(rings[rings.length - 1], false);
    const sideBase = out.vertexCount;
    for (let l = 0; l < rings.length; l++) {
      for (const contour of rings[l]) {
        for (const p of contour) { out.positions.push(p.x, p.y, layers[l].z); out.uvs.push(p.x, p.y); out.normals.push(0, 0, 0); }
      }
    }
    let contourStart = 0;
    const offsets: number[] = [];
    for (const c of contours) { offsets.push(contourStart); contourStart += c.length; }
    for (let l = 0; l < rings.length - 1; l++) {
      const layerA = sideBase + rings.slice(0, l).reduce((n, r) => n + r.reduce((s, c) => s + c.length, 0), 0);
      const layerB = sideBase + rings.slice(0, l + 1).reduce((n, r) => n + r.reduce((s, c) => s + c.length, 0), 0);
      for (let c = 0; c < rings[l].length; c++) {
        const start = offsets[c], len = rings[l][c].length;
        for (let i = 0; i < len; i++) {
          const a = layerA + start + i, b = layerA + start + (i + 1) % len;
          const d = layerB + start + i, e = layerB + start + (i + 1) % len;
          if (c === 0) out.indices.push(a, d, b, b, d, e);
          else out.indices.push(a, b, d, b, e, d);
        }
      }
    }
  }
  out.computeNormals();
  // Restore cap normals: computeNormals only sees isolated cap vertices, so they remain correct.
  return out;
}

export function shapeGeo(shape: Shape | Shape[]): Geo {
  return extrude(shape, { depth: 0, bevelEnabled: false });
}

function polyhedron(vertices: number[], indices: number[], radius: number, detail: number): Geo {
  let triangles: [Vec3, Vec3, Vec3][] = [];
  for (let i = 0; i < indices.length; i += 3) {
    triangles.push([0, 1, 2].map((k) => new Vec3(vertices[indices[i + k] * 3], vertices[indices[i + k] * 3 + 1], vertices[indices[i + k] * 3 + 2])) as [Vec3, Vec3, Vec3]);
  }
  for (let d = 0; d < detail; d++) {
    const next: typeof triangles = [];
    for (const [a, b, c] of triangles) {
      const ab = a.clone().add(b).mulScalar(0.5), bc = b.clone().add(c).mulScalar(0.5), ca = c.clone().add(a).mulScalar(0.5);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    triangles = next;
  }
  const g = new Geo();
  for (const tri of triangles) {
    for (const p of tri) {
      p.normalize().mulScalar(radius); g.positions.push(p.x, p.y, p.z); g.normals.push(p.x / radius, p.y / radius, p.z / radius);
      g.uvs.push(Math.atan2(p.z, -p.x) / (Math.PI * 2) + 0.5, 1 - (Math.asin(p.y / radius) / Math.PI + 0.5));
    }
  }
  return g;
}

export function icosahedron(radius = 1, detail = 0): Geo {
  const t = (1 + Math.sqrt(5)) / 2;
  return polyhedron([-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1],
    [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1], radius, detail);
}

export function octahedron(radius = 1, detail = 0): Geo {
  return polyhedron([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1], [0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 4, 2, 1, 3, 4, 1, 5, 3, 1, 2, 5], radius, detail);
}

export function dodecahedron(radius = 1, detail = 0): Geo {
  const t = (1 + Math.sqrt(5)) / 2, r = 1 / t;
  return polyhedron([-1, -1, -1, -1, -1, 1, -1, 1, -1, -1, 1, 1, 1, -1, -1, 1, -1, 1, 1, 1, -1, 1, 1, 1, 0, -r, -t, 0, -r, t, 0, r, -t, 0, r, t, -t, 0, -r, t, 0, -r, -t, 0, r, t, 0, r, -r, -t, 0, -r, t, 0, r, -t, 0, r, t, 0],
    [3, 11, 7, 3, 7, 15, 3, 15, 13, 7, 19, 17, 7, 17, 6, 7, 6, 15, 17, 4, 8, 17, 8, 10, 17, 10, 6, 8, 0, 16, 8, 16, 2, 8, 2, 10, 0, 12, 1, 0, 1, 18, 0, 18, 16, 6, 10, 2, 6, 2, 13, 6, 13, 15, 2, 16, 18, 2, 18, 3, 2, 3, 13, 18, 1, 9, 18, 9, 11, 18, 11, 3, 4, 14, 12, 4, 12, 0, 4, 0, 8, 11, 9, 5, 11, 5, 19, 11, 19, 7, 19, 5, 14, 19, 14, 4, 19, 4, 17, 1, 12, 14, 1, 14, 5, 1, 5, 9], radius, detail);
}
