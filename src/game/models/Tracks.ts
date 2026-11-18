import * as THREE from 'three';
import type { InstantiatedTankRig } from '../AssetLoader';

const material = new THREE.MeshStandardMaterial({ color: '#46483f', roughness: 0.86, metalness: 0.37 });
const beltMaterial = new THREE.MeshStandardMaterial({ color: '#252822', roughness: 0.92, metalness: 0.24 });
const trimmedHulls = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/** On these two GLBs the original tread links are baked into `body`, not wheel nodes. */
export function removeBakedTracks(rig: InstantiatedTankRig, ifv: boolean): boolean {
  const body = rig.visualRoot.getObjectByName('body') as THREE.Mesh | undefined;
  const source = body?.geometry;
  if (!body?.isMesh || !source?.index || source.groups.length > 1) return false;
  let trimmed = trimmedHulls.get(source);
  if (!trimmed) {
    body.updateWorldMatrix(true, false);
    const toHull = rig.hullTiltGroup.matrixWorld.clone().invert().multiply(body.matrixWorld);
    const positions = source.getAttribute('position');
    const band = new Int8Array(positions.count);
    const p = new THREE.Vector3();
    // Measured from the original tread islands; the baked fenders sit outboard
    // and the suspension arms and road wheels are separate from the tread run.
    const edgeIn = ifv ? 1.037 : 1.14;
    const edgeOut = ifv ? 1.56 : 1.77;
    const top = ifv ? 1.114 : 1.294;
    for (let i = 0; i < positions.count; i++) {
      p.fromBufferAttribute(positions, i).applyMatrix4(toHull);
      const x = Math.abs(p.x);
      if (x >= edgeIn && x <= edgeOut && p.y <= top) band[i] = Math.sign(p.x);
    }
    const keep: number[] = [];
    for (let i = 0; i < source.index.count; i += 3) {
      const a = source.index.getX(i), b = source.index.getX(i + 1), c = source.index.getX(i + 2);
      if (band[a] !== 0 && band[a] === band[b] && band[b] === band[c]) continue;
      keep.push(a, b, c);
    }
    if (keep.length === source.index.count) return false;
    const scratch = source.clone();
    scratch.setIndex(keep);
    scratch.clearGroups();
    trimmed = scratch.toNonIndexed();
    // Audits and damage bounds should see only rendered vertices.
    trimmed.computeBoundingBox();
    trimmed.computeBoundingSphere();
    trimmedHulls.set(source, trimmed);
  }
  body.geometry = trimmed;
  body.userData.bakedTracksRemoved = true;
  return true;
}

export function addMovingTracks(rig: InstantiatedTankRig): void {
  for (const side of ['L', 'R'] as const) {
    const wheels = rig.wheels.filter((w) => w.side === side);
    if (wheels.length < 2) continue;
    const point = new THREE.Vector3();
    let front = -Infinity, rear = Infinity, x = 0;
    for (const { node } of wheels) {
      rig.hullTiltGroup.worldToLocal(node.getWorldPosition(point));
      front = Math.max(front, point.z);
      rear = Math.min(rear, point.z);
      x += point.x / wheels.length;
    }
    const halfW = Math.abs(x);
    const radius = halfW > 1.4 ? 0.602 : 0.519;
    const straight = front - rear;
    const bend = Math.PI * radius;
    const length = (straight + bend) * 2;
    const count = Math.round(length / 0.24);
    const spacing = length / count;
    const width = halfW > 1.4 ? 0.57 : 0.47;
    const geo = new THREE.BoxGeometry(width, 0.043, spacing * 0.76);
    const mesh = new THREE.InstancedMesh(geo, material, count);
    mesh.name = `moving_track_${side}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.receiveShadow = true;
    rig.hullTiltGroup.add(mesh);
    const beltShape = new THREE.Shape();
    const midY = 0.0225 + radius;
    const inset = radius - 0.022;
    beltShape.moveTo(rear, midY - inset);
    beltShape.lineTo(front, midY - inset);
    beltShape.absarc(front, midY, inset, -Math.PI / 2, Math.PI / 2, false);
    beltShape.lineTo(rear, midY + inset);
    beltShape.absarc(rear, midY, inset, Math.PI / 2, Math.PI * 1.5, false);
    const inside = inset - 0.105;
    const hole = new THREE.Path();
    hole.moveTo(front, midY - inside);
    hole.lineTo(rear, midY - inside);
    hole.absarc(rear, midY, inside, -Math.PI / 2, Math.PI / 2, true);
    hole.lineTo(front, midY + inside);
    hole.absarc(front, midY, inside, Math.PI / 2, -Math.PI / 2, true);
    beltShape.holes.push(hole);
    const beltGeo = new THREE.ExtrudeGeometry(beltShape, { depth: width * 0.86, bevelEnabled: false, curveSegments: 10 });
    beltGeo.rotateY(-Math.PI / 2);
    const belt = new THREE.Mesh(beltGeo, beltMaterial);
    belt.name = `track_belt_${side}`;
    belt.position.x = x + width * 0.43;
    belt.receiveShadow = true;
    rig.hullTiltGroup.add(belt);
    const link = new THREE.Object3D();
    link.position.x = x;
    let phase = 0;
    const advance = (meters: number) => {
      phase = THREE.MathUtils.euclideanModulo(phase + meters, spacing);
      for (let i = 0; i < count; i++) {
        let s = i * spacing + phase;
        let angle = 0;
        let z: number;
        if (s < straight) z = rear + s;
        else if ((s -= straight) < bend) { angle = s / radius; z = front + radius * Math.sin(angle); }
        else if ((s -= bend) < straight) { angle = Math.PI; z = front - s; }
        else { angle = Math.PI + (s - straight) / radius; z = rear + radius * Math.sin(angle); }
        link.position.y = midY + radius * Math.cos(angle);
        link.position.z = z;
        link.rotation.x = angle;
        link.updateMatrix();
        mesh.setMatrixAt(i, link.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    advance(0);
    mesh.computeBoundingSphere();
    (rig.tracks ??= []).push({ side, advance });
  }
}
