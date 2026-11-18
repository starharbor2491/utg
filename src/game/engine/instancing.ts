import {
  BUFFER_DYNAMIC,
  Entity,
  Mesh,
  MeshInstance,
  SEMANTIC_ATTR10,
  SEMANTIC_ATTR11,
  SEMANTIC_ATTR12,
  SEMANTIC_ATTR14,
  SEMANTIC_ATTR15,
  SEMANTIC_ATTR7,
  SEMANTIC_ATTR8,
  SEMANTIC_ATTR9,
  StandardMaterial,
  TYPE_FLOAT32,
  VertexBuffer,
  VertexFormat,
} from 'playcanvas';
import type { GraphNode, Material } from 'playcanvas';
import { getDevice } from './app';
import { addShaderHooks } from './materials';
import type { Mat4, Quat, Vec3 } from './math';
import { Geo } from './geometry';
import { rememberGeo, userData } from './scene';

/** Extra per-instance float attribute; read it in shader hooks as `attribute <type> <name>` under INSTANCING. */
export interface InstanceAttribute {
  name: string;
  components: 1 | 2 | 3 | 4;
}

export interface InstancedMeshOptions {
  name?: string;
  parent?: GraphNode | null;
  castShadows?: boolean;
  receiveShadows?: boolean;
  /** Adds a per-instance RGBA tint (Three's instanceColor). Material must be prepared with enableInstanceColor. */
  color?: boolean;
  attributes?: InstanceAttribute[];
}

// Instance matrices use the engine's default slots (ATTR11, 12, 14, 15); ATTR13 is the tangent slot.
const EXTRA_SLOTS = [SEMANTIC_ATTR9, SEMANTIC_ATTR8, SEMANTIC_ATTR7];
export const INSTANCE_COLOR_SEMANTIC = SEMANTIC_ATTR10;

/**
 * Three's InstancedMesh. Instance matrices are relative to the owning entity, like Three.
 * Write instances, set count, then call update() once per frame (or after edits).
 */
export class InstancedMesh {
  readonly entity: Entity;
  readonly meshInstance: MeshInstance;
  readonly capacity: number;
  readonly data: Float32Array;
  /** Floats per instance. */
  readonly stride: number;
  /** Number of instances drawn. */
  count: number;
  private readonly vb: VertexBuffer;
  private readonly colorOffset: number;
  private readonly attrOffsets = new Map<string, number>();
  private dirty = true;

  constructor(src: Mesh | Geo, material: Material, capacity: number, opts: InstancedMeshOptions = {}) {
    const device = getDevice();
    const mesh = src instanceof Geo ? src.toMesh() : src;
    if (src instanceof Geo) rememberGeo(mesh, src);
    const desc: { semantic: string; components: number; type: number }[] = [
      { semantic: SEMANTIC_ATTR11, components: 4, type: TYPE_FLOAT32 },
      { semantic: SEMANTIC_ATTR12, components: 4, type: TYPE_FLOAT32 },
      { semantic: SEMANTIC_ATTR14, components: 4, type: TYPE_FLOAT32 },
      { semantic: SEMANTIC_ATTR15, components: 4, type: TYPE_FLOAT32 },
    ];
    let stride = 16;
    this.colorOffset = -1;
    if (opts.color) {
      desc.push({ semantic: INSTANCE_COLOR_SEMANTIC, components: 4, type: TYPE_FLOAT32 });
      this.colorOffset = stride;
      stride += 4;
    }
    const attrs = opts.attributes ?? [];
    if (attrs.length > EXTRA_SLOTS.length) throw new Error('Too many instance attributes');
    attrs.forEach((a, i) => {
      desc.push({ semantic: EXTRA_SLOTS[i], components: a.components, type: TYPE_FLOAT32 });
      this.attrOffsets.set(a.name, stride);
      stride += a.components;
      if (material instanceof StandardMaterial) material.setAttribute(a.name, EXTRA_SLOTS[i]);
    });
    this.stride = stride;
    this.capacity = capacity;
    this.count = capacity;
    const format = new VertexFormat(device, desc);
    this.data = new Float32Array(capacity * stride);
    for (let i = 0; i < capacity; i++) {
      const o = i * stride;
      this.data[o] = this.data[o + 5] = this.data[o + 10] = this.data[o + 15] = 1;
      if (this.colorOffset >= 0) this.data.fill(1, o + this.colorOffset, o + this.colorOffset + 4);
    }
    this.vb = new VertexBuffer(device, format, capacity, { usage: BUFFER_DYNAMIC, data: this.data });

    this.entity = new Entity(opts.name ?? 'instanced');
    userData(this.entity).instancedMesh = this;
    Object.assign(this.entity, { instancedMesh: this });
    const render = this.entity.addComponent('render', {})!;
    this.meshInstance = new MeshInstance(mesh, material, this.entity);
    this.meshInstance.setInstancing(this.vb);
    render.meshInstances = [this.meshInstance];
    render.castShadows = opts.castShadows ?? false;
    render.receiveShadows = opts.receiveShadows ?? true;
    opts.parent?.addChild(this.entity);
    this.update();
  }

  setMatrixAt(i: number, m: Mat4): void {
    this.data.set(m.data, i * this.stride);
    this.dirty = true;
  }

  getMatrixAt(i: number, out: Mat4): Mat4 {
    const o = i * this.stride;
    for (let k = 0; k < 16; k++) out.data[k] = this.data[o + k];
    return out;
  }

  /** Writes position, rotation and scale directly. */
  setTRS(i: number, p: Vec3, q: Quat, s: Vec3): void {
    const d = this.data, o = i * this.stride;
    const { x, y, z, w } = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    d[o] = (1 - (yy + zz)) * s.x; d[o + 1] = (xy + wz) * s.x; d[o + 2] = (xz - wy) * s.x; d[o + 3] = 0;
    d[o + 4] = (xy - wz) * s.y; d[o + 5] = (1 - (xx + zz)) * s.y; d[o + 6] = (yz + wx) * s.y; d[o + 7] = 0;
    d[o + 8] = (xz + wy) * s.z; d[o + 9] = (yz - wx) * s.z; d[o + 10] = (1 - (xx + yy)) * s.z; d[o + 11] = 0;
    d[o + 12] = p.x; d[o + 13] = p.y; d[o + 14] = p.z; d[o + 15] = 1;
    this.dirty = true;
  }

  /** Linear RGB (Three's instanceColor values) plus optional alpha. */
  setColorAt(i: number, r: number, g: number, b: number, a = 1): void {
    if (this.colorOffset < 0) throw new Error('InstancedMesh created without color');
    const o = i * this.stride + this.colorOffset;
    this.data[o] = r; this.data[o + 1] = g; this.data[o + 2] = b; this.data[o + 3] = a;
    this.dirty = true;
  }

  setAttributeAt(i: number, name: string, a: number, b = 0, c = 0, d = 0): void {
    const off = this.attrOffsets.get(name);
    if (off === undefined) throw new Error(`Unknown instance attribute ${name}`);
    const o = i * this.stride + off;
    this.data[o] = a; this.data[o + 1] = b; this.data[o + 2] = c; this.data[o + 3] = d;
    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Uploads edited instances and applies count. Cheap when nothing changed. */
  update(): void {
    const n = Math.max(0, Math.min(this.count, this.capacity));
    this.meshInstance.instancingCount = n;
    this.meshInstance.visible = n > 0;
    if (this.dirty) {
      this.vb.setData(this.data);
      this.dirty = false;
    }
  }

  destroy(): void {
    this.entity.destroy();
    this.vb.destroy();
  }
}

/**
 * Prepares a StandardMaterial to multiply albedo (or emission for unlit materials) by the
 * per-instance colour, and opacity by its alpha. Non-instanced use of the material is unaffected.
 */
export function enableInstanceColor(m: StandardMaterial): void {
  m.setAttribute('instance_color', INSTANCE_COLOR_SEMANTIC);
  addShaderHooks(m, {
    vsDecl: '#ifdef INSTANCING\nattribute vec4 instance_color;\nvarying vec4 vInstanceColor;\n#endif',
    vsMainEnd: '#ifdef INSTANCING\nvInstanceColor = instance_color;\n#endif',
    psDecl: '#ifdef INSTANCING\nvarying vec4 vInstanceColor;\n#endif',
    albedo: '#ifdef INSTANCING\ndAlbedo *= vInstanceColor.rgb;\n#endif',
    emission: '#ifdef INSTANCING\ndEmission *= vInstanceColor.rgb;\n#endif',
    opacity: '#ifdef INSTANCING\ndAlpha *= vInstanceColor.a;\n#endif',
  });
}
