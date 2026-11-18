import type { Entity, MeshInstance } from 'playcanvas';
import { Box3, Vec3 } from './engine/math';
import { meshInstancesIn, worldBounds } from './engine/scene';

export interface AuditOptions {
  groundY?: number;
  maxGap?: number;
  maxPenetration?: number;
  camera?: Entity;
  checkConnectivity?: boolean;
  checkInterpenetration?: boolean;
}

export interface AuditIssue {
  severity: 'error' | 'warn';
  code: 'FLOATING_ROOT' | 'DISCONNECTED_PART' | 'INTERPENETRATION' | 'BAD_NORMALS' | 'NON_UNIFORM_PARENT' | 'DEPTH_PRECISION';
  message: string;
}

/** Grounding, vertex integrity, assembly, scale, and camera depth-range audit for every rig. */
export function auditThreeObject(root: Entity, opts: AuditOptions = {}): AuditIssue[] {
  const { groundY = 0, maxGap = 0.02, maxPenetration = 0.25, camera, checkConnectivity = true, checkInterpenetration = false } = opts;
  const issues: AuditIssue[] = [];
  const rootBox = worldBounds(root, undefined, true);
  if (Number.isFinite(rootBox.min.y) && Math.abs(rootBox.min.y - groundY) > maxGap) {
    issues.push({ severity: 'error', code: 'FLOATING_ROOT', message: `Root "${root.name}" min.y is ${rootBox.min.y.toFixed(4)} (expected ${groundY.toFixed(4)} +/- ${maxGap}).` });
  }

  const meshes: { node: Entity; box: Box3 }[] = [];
  root.forEach((node) => {
    const obj = node as Entity;
    if (!obj.enabled) return;
    if (obj.children.length > 0) {
      const s = obj.getLocalScale();
      if (Math.abs(s.x - s.y) > 1e-4 || Math.abs(s.y - s.z) > 1e-4) {
        issues.push({ severity: 'warn', code: 'NON_UNIFORM_PARENT', message: `Parent "${obj.name}" has non-uniform scale (${s.x.toFixed(3)}, ${s.y.toFixed(3)}, ${s.z.toFixed(3)}).` });
      }
    }
    for (const mi of obj.render?.meshInstances ?? []) {
      auditMesh(mi, issues);
      const aabb = mi.aabb;
      meshes.push({ node: obj, box: new Box3(aabb.getMin(), aabb.getMax()) });
    }
  });

  if (checkConnectivity && meshes.length > 1) {
    const visited = new Set<number>([0]);
    const queue = [0];
    while (queue.length) {
      const curr = queue.shift()!;
      const expanded = meshes[curr].box.clone().expandByScalar(Math.max(maxGap, 0.15));
      for (let j = 0; j < meshes.length; j++) {
        if (!visited.has(j) && expanded.intersectsBox(meshes[j].box)) { visited.add(j); queue.push(j); }
      }
    }
    for (let i = 0; i < meshes.length; i++) {
      if (!visited.has(i)) issues.push({ severity: 'error', code: 'DISCONNECTED_PART', message: `Mesh "${meshes[i].node.name || i}" is disconnected from assembly "${root.name}".` });
    }
  }

  if (checkInterpenetration) {
    const overlap = new Box3(), size = new Vec3();
    for (let i = 0; i < meshes.length; i++) {
      for (let j = i + 1; j < meshes.length; j++) {
        const a = meshes[i], b = meshes[j];
        if (!a.box.intersectsBox(b.box)) continue;
        overlap.copy(a.box).intersect(b.box).getSize(size);
        const minAxis = Math.min(size.x, size.y, size.z);
        if (minAxis > maxPenetration) issues.push({ severity: 'warn', code: 'INTERPENETRATION', message: `Meshes "${a.node.name || i}" and "${b.node.name || j}" overlap by ${minAxis.toFixed(3)}m.` });
      }
    }
  }

  const cam = camera?.camera;
  if (cam && cam.farClip / cam.nearClip > 10_000) {
    issues.push({ severity: 'warn', code: 'DEPTH_PRECISION', message: `Camera far/near ratio is ${(cam.farClip / cam.nearClip).toFixed(0)} (> 10,000); raise camera.nearClip to prevent z-fighting.` });
  }
  return issues;
}

function auditMesh(mi: MeshInstance, issues: AuditIssue[]): void {
  const mesh = mi.mesh;
  if (!mesh) {
    issues.push({ severity: 'error', code: 'BAD_NORMALS', message: `Mesh "${mi.node.name}" has no GPU mesh.` });
    return;
  }
  const positions: number[] = [], normals: number[] = [];
  const count = mesh.getPositions(positions);
  mesh.getNormals(normals);
  if (!count || normals.length < count * 3) {
    issues.push({ severity: 'error', code: 'BAD_NORMALS', message: `Mesh "${mi.node.name}" is missing position or normal attributes.` });
    return;
  }
  const step = Math.max(1, Math.floor(count / 500));
  for (let i = 0; i < count; i += step) {
    if (!Number.isFinite(positions[i * 3]) || !Number.isFinite(positions[i * 3 + 1]) || !Number.isFinite(positions[i * 3 + 2])) {
      issues.push({ severity: 'error', code: 'BAD_NORMALS', message: `Mesh "${mi.node.name}" contains NaN/Infinite vertices.` });
      break;
    }
  }
}

/** Used by devtools when checking a whole scene rather than one rig. */
export function auditScene(root: Entity, opts: AuditOptions = {}): AuditIssue[] {
  meshInstancesIn(root);
  return auditThreeObject(root, opts);
}
