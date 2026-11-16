import * as THREE from 'three';

export interface AuditOptions {
  groundY?: number;
  maxGap?: number;
  maxPenetration?: number;
  camera?: THREE.PerspectiveCamera;
  checkConnectivity?: boolean;
  checkInterpenetration?: boolean;
}

export interface AuditIssue {
  severity: 'error' | 'warn';
  code:
    | 'FLOATING_ROOT'
    | 'DISCONNECTED_PART'
    | 'INTERPENETRATION'
    | 'BAD_NORMALS'
    | 'NON_UNIFORM_PARENT'
    | 'DEPTH_PRECISION';
  message: string;
}

/**
 * Programmatic 3D Scene & Assembly Audit (from threejs-3d skill).
 * Validates grounding (`min.y === groundY`), uniform parent scales, vertex/normal integrity,
 * assembly connectivity, sibling interpenetration, and camera depth-buffer precision (`far / near <= 10_000`).
 */
export function auditThreeObject(root: THREE.Object3D, opts: AuditOptions = {}): AuditIssue[] {
  const {
    groundY = 0,
    maxGap = 0.02,
    maxPenetration = 0.25,
    camera,
    checkConnectivity = true,
    checkInterpenetration = false,
  } = opts;
  const issues: AuditIssue[] = [];

  root.updateMatrixWorld(true);

  const rootBox = new THREE.Box3().setFromObject(root);
  if (Number.isFinite(rootBox.min.y) && Math.abs(rootBox.min.y - groundY) > maxGap) {
    issues.push({
      severity: 'error',
      code: 'FLOATING_ROOT',
      message: `Root "${root.name || root.type}" min.y is ${rootBox.min.y.toFixed(4)} (expected ${groundY.toFixed(4)} +/- ${maxGap}).`,
    });
  }

  const meshes: { mesh: THREE.Mesh; box: THREE.Box3 }[] = [];
  root.traverse((obj) => {
    if (!obj.visible) return;
    if (obj.children.length > 0) {
      const s = obj.scale;
      if (Math.abs(s.x - s.y) > 1e-4 || Math.abs(s.y - s.z) > 1e-4) {
        issues.push({
          severity: 'warn',
          code: 'NON_UNIFORM_PARENT',
          message: `Parent "${obj.name || obj.type}" has non-uniform scale (${s.x.toFixed(3)}, ${s.y.toFixed(3)}, ${s.z.toFixed(3)}).`,
        });
      }
    }

    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      const geo = mesh.geometry;
      const pos = geo.getAttribute('position');
      const norm = geo.getAttribute('normal');

      if (!pos || pos.count === 0 || !norm) {
        issues.push({
          severity: 'error',
          code: 'BAD_NORMALS',
          message: `Mesh "${mesh.name || mesh.uuid}" is missing position or normal attributes.`,
        });
      } else {
        const sampleStep = Math.max(1, Math.floor(pos.count / 500));
        for (let i = 0; i < pos.count; i += sampleStep) {
          if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) {
            issues.push({
              severity: 'error',
              code: 'BAD_NORMALS',
              message: `Mesh "${mesh.name}" contains NaN/Infinite vertices.`,
            });
            break;
          }
        }
      }

      geo.computeBoundingBox();
      if (geo.boundingBox) {
        const box = new THREE.Box3().copy(geo.boundingBox).applyMatrix4(mesh.matrixWorld);
        meshes.push({ mesh, box });
      }
    }
  });

  if (checkConnectivity && meshes.length > 1) {
    const visited = new Set<number>([0]);
    const queue = [0];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const expanded = meshes[curr].box.clone().expandByScalar(Math.max(maxGap, 0.15));
      for (let j = 0; j < meshes.length; j++) {
        if (!visited.has(j) && expanded.intersectsBox(meshes[j].box)) {
          visited.add(j);
          queue.push(j);
        }
      }
    }
    for (let i = 0; i < meshes.length; i++) {
      if (!visited.has(i)) {
        issues.push({
          severity: 'error',
          code: 'DISCONNECTED_PART',
          message: `Mesh "${meshes[i].mesh.name || i}" is disconnected from assembly "${root.name}".`,
        });
      }
    }
  }

  if (checkInterpenetration) {
    const overlap = new THREE.Box3();
    const size = new THREE.Vector3();
    for (let i = 0; i < meshes.length; i++) {
      for (let j = i + 1; j < meshes.length; j++) {
        const a = meshes[i];
        const b = meshes[j];
        if (!a.box.intersectsBox(b.box)) continue;
        overlap.copy(a.box).intersect(b.box);
        overlap.getSize(size);
        const minAxis = Math.min(size.x, size.y, size.z);
        if (minAxis > maxPenetration) {
          issues.push({
            severity: 'warn',
            code: 'INTERPENETRATION',
            message: `Meshes "${a.mesh.name || i}" and "${b.mesh.name || j}" overlap by ${minAxis.toFixed(3)}m.`,
          });
        }
      }
    }
  }

  if (camera && camera.far / camera.near > 10_000) {
    issues.push({
      severity: 'warn',
      code: 'DEPTH_PRECISION',
      message: `Camera far/near ratio is ${(camera.far / camera.near).toFixed(0)} (> 10,000); raise camera.near to prevent z-fighting.`,
    });
  }

  return issues;
}
