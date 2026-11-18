import type { Mesh, StandardMaterial } from 'playcanvas';
import type { InstantiatedTankRig } from '../AssetLoader';
import { box, cylinder, extrude, Geo, geoFromMesh, Path, roundedBox, Shape } from '../engine/geometry';
import { InstancedMesh } from '../engine/instancing';
import { standard } from '../engine/materials';
import { composeMat, euclideanModulo, Mat4, Quat, Vec3, worldToLocal } from '../engine/math';
import { findByName, meshInstanceOf, meshNode, rememberGeo, userData } from '../engine/scene';
import { applySurfaceFinish } from './SurfaceFinish';

let material: StandardMaterial | null = null;
const beltMaterial = standard({ color: '#252822', roughness: 0.92, metalness: 0.24 });
const trimmedHulls = new WeakMap<Mesh, Geo>();
const trackShoes = new Map<string, Geo>();

function trackShoe(width: number, length: number): Geo {
  const key = `${width}:${length.toFixed(4)}`;
  let geo = trackShoes.get(key);
  if (!geo) {
    const w = width / 2 - 0.005, d = length / 2 - 0.005, c = 0.025;
    const sole = new Shape();
    sole.moveTo(-w + c, -d).lineTo(w - c, -d).lineTo(w, -d + c).lineTo(w, d - c)
      .lineTo(w - c, d).lineTo(-w + c, d).lineTo(-w, d - c).lineTo(-w, -d + c).closePath();
    const body = extrude(sole, { depth: 0.03, bevelSize: 0.005, bevelThickness: 0.005, bevelSegments: 1 })
      .rotateX(Math.PI / 2).translate(0, 0.01, 0);
    const bar = roundedBox(width * 0.74, 0.016, length * 0.30, 1, 0.004).toFlat().translate(0, 0.022, 0);
    const padL = box(width * 0.19, 0.009, length * 0.64).toFlat().translate(-width * 0.36, 0.022, 0);
    const padR = box(width * 0.19, 0.009, length * 0.64).toFlat().translate(width * 0.36, 0.022, 0);
    const guide = box(width * 0.13, 0.038, length * 0.34).toFlat().translate(0, 0.042, 0);
    const pinFront = cylinder(0.0045, 0.0045, width * 0.94, 6).rotateZ(Math.PI / 2).translate(0, 0.026, length * 0.39);
    const pinRear = cylinder(0.0045, 0.0045, width * 0.94, 6).rotateZ(Math.PI / 2).translate(0, 0.026, -length * 0.39);
    geo = Geo.merge([body, bar, padL, padR, guide, pinFront, pinRear])!;
    trackShoes.set(key, geo);
  }
  return geo;
}

/** On these two GLBs the original tread links are baked into `body`, not wheel nodes. */
export function removeBakedTracks(rig: InstantiatedTankRig, ifv: boolean): boolean {
  const body = findByName(rig.visualRoot, 'body');
  const instance = body ? meshInstanceOf(body) : null;
  const source = instance?.mesh;
  if (!body || !instance || !source || (body.render?.meshInstances.length ?? 0) > 1) return false;
  let trimmed = trimmedHulls.get(source);
  if (!trimmed) {
    const toHull = new Mat4().copy(rig.hullTiltGroup.getWorldTransform()).invert().mul(body.getWorldTransform());
    const sourceGeo = geoFromMesh(source);
    if (!sourceGeo.indices.length) return false;
    const positions = sourceGeo.positions, band = new Int8Array(sourceGeo.vertexCount), p = new Vec3();
    const edgeIn = ifv ? 1.037 : 1.14, edgeOut = ifv ? 1.56 : 1.77, top = ifv ? 1.114 : 1.294;
    for (let i = 0; i < sourceGeo.vertexCount; i++) {
      p.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      // Transform with the full affine matrix, including the GLB's normalization.
      const e = toHull.data, x = p.x, y = p.y, z = p.z;
      p.set(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      const ax = Math.abs(p.x);
      if (ax >= edgeIn && ax <= edgeOut && p.y <= top) band[i] = Math.sign(p.x);
    }
    const keep: number[] = [];
    for (let i = 0; i < sourceGeo.indices.length; i += 3) {
      const a = sourceGeo.indices[i], b = sourceGeo.indices[i + 1], c = sourceGeo.indices[i + 2];
      if (band[a] !== 0 && band[a] === band[b] && band[b] === band[c]) continue;
      keep.push(a, b, c);
    }
    if (keep.length === sourceGeo.indices.length) return false;
    const scratch = sourceGeo.clone();
    scratch.indices = keep;
    trimmed = scratch.toFlat();
    trimmedHulls.set(source, trimmed);
  }
  const mesh = trimmed.toMesh();
  rememberGeo(mesh, trimmed);
  instance.mesh = mesh;
  userData(body).bakedTracksRemoved = true;
  Object.assign(body, { bakedTracksRemoved: true });
  return true;
}

export function addMovingTracks(rig: InstantiatedTankRig): void {
  if (!material) {
    material = standard({ color: '#46483f', roughness: 0.86, metalness: 0.37 });
    applySurfaceFinish(material, 'track');
  }
  for (const side of ['L', 'R'] as const) {
    const wheels = rig.wheels.filter((w) => w.side === side);
    if (wheels.length < 2) continue;
    const point = new Vec3();
    let front = -Infinity, rear = Infinity, x = 0;
    for (const { node } of wheels) {
      point.copy(node.getPosition());
      worldToLocal(rig.hullTiltGroup, point);
      front = Math.max(front, point.z); rear = Math.min(rear, point.z); x += point.x / wheels.length;
    }
    const halfW = Math.abs(x), radius = halfW > 1.4 ? 0.602 : 0.519;
    const straight = front - rear, bend = Math.PI * radius, length = (straight + bend) * 2;
    const count = Math.round(length / 0.24), spacing = length / count, width = halfW > 1.4 ? 0.57 : 0.47;
    const mesh = new InstancedMesh(trackShoe(width, spacing * 0.83), material, count, {
      name: `moving_track_${side}`, parent: rig.hullTiltGroup, castShadows: false, receiveShadows: true,
    });
    const beltShape = new Shape();
    const midY = 0.0225 + radius, inset = radius - 0.022;
    beltShape.moveTo(rear, midY - inset).lineTo(front, midY - inset)
      .absarc(front, midY, inset, -Math.PI / 2, Math.PI / 2, false)
      .lineTo(rear, midY + inset).absarc(rear, midY, inset, Math.PI / 2, Math.PI * 1.5, false);
    const inside = inset - 0.105, hole = new Path();
    hole.moveTo(front, midY - inside).lineTo(rear, midY - inside)
      .absarc(rear, midY, inside, -Math.PI / 2, Math.PI / 2, true)
      .lineTo(front, midY + inside).absarc(front, midY, inside, Math.PI / 2, -Math.PI / 2, true);
    beltShape.holes.push(hole);
    const beltGeo = extrude(beltShape, { depth: width * 0.86, bevelEnabled: false, curveSegments: 10 }).rotateY(-Math.PI / 2);
    const belt = meshNode(beltGeo, beltMaterial, rig.hullTiltGroup, { name: `track_belt_${side}`, castShadows: false, receiveShadows: true });
    belt.setLocalPosition(x + width * 0.43, 0, 0);
    const p = new Vec3(x, 0, 0), q = new Quat(), scale = Vec3.ONE, matrix = new Mat4();
    let phase = 0;
    const advance = (meters: number) => {
      phase = euclideanModulo(phase + meters, spacing);
      for (let i = 0; i < count; i++) {
        let s = i * spacing + phase, angle = 0, z: number;
        if (s < straight) z = rear + s;
        else if ((s -= straight) < bend) { angle = s / radius; z = front + radius * Math.sin(angle); }
        else if ((s -= bend) < straight) { angle = Math.PI; z = front - s; }
        else { angle = Math.PI + (s - straight) / radius; z = rear + radius * Math.sin(angle); }
        p.y = midY + radius * Math.cos(angle); p.z = z;
        q.setFromAxisAngle(Vec3.RIGHT, angle * 180 / Math.PI);
        mesh.setMatrixAt(i, composeMat(matrix, p, q, scale));
      }
      mesh.update();
    };
    advance(0);
    (rig.tracks ??= []).push({ side, advance });
  }
}
