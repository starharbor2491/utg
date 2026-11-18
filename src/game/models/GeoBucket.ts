import type { Entity, Material } from 'playcanvas';
import { box, cylinder, Geo, roundedBox } from '../engine/geometry';
import { composeMat, Mat4, Quat, quatFromEuler, Vec3 } from '../engine/math';
import { meshNode } from '../engine/scene';

/** Material-bucketed procedural geometry; one mesh per material on flush. */
export class GeoBucket {
  private readonly buckets = new Map<Material, Geo[]>();

  put(m: Material, source: Geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): void {
    const geo = source.toFlat();
    if (x || y || z || rx || ry || rz || sx !== 1 || sy !== 1 || sz !== 1) {
      geo.applyMatrix(composeMat(new Mat4(), new Vec3(x, y, z), quatFromEuler(new Quat(), rx, ry, rz), new Vec3(sx, sy, sz)));
    }
    const list = this.buckets.get(m) ?? [];
    if (!list.length) this.buckets.set(m, list);
    list.push(geo);
  }

  box(m: Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.put(m, box(w, h, d), x, y, z, rx, ry, rz);
  }

  rbox(m: Material, w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.put(m, roundedBox(w, h, d, 2, r), x, y, z, rx, ry, rz);
  }

  cyl(m: Material, rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.put(m, cylinder(rt, rb, h, seg), x, y, z, rx, ry, rz);
  }

  flush(parent: Entity, out: Entity[] = [], castShadow = true): Entity[] {
    for (const [material, geometries] of this.buckets) {
      const merged = Geo.merge(geometries);
      if (!merged) continue;
      out.push(meshNode(merged, material, parent, { castShadows: castShadow, receiveShadows: true }));
    }
    this.buckets.clear();
    return out;
  }
}
