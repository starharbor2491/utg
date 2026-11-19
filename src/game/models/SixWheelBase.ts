import type { Entity } from 'playcanvas';
import type { WheelNodeBinding } from '../AssetLoader';
import { cylinder, Geo, lathe, roundedBox, torus } from '../engine/geometry';
import { composeMat, Mat4, Quat, quatFromEuler, Vec2, Vec3 } from '../engine/math';
import { standard } from '../engine/materials';
import { group, meshNode } from '../engine/scene';
import { applySurfaceFinish } from './SurfaceFinish';

export const SIX_WHEEL_BASE = { wheelRadius: 0.57, wheelWidth: 0.36, trackX: 1.02, axleZ: [2.3, -0.9, -2.3] } as const;

function buildWheel(): Geo {
  const tyreProfile = [new Vec2(0.3, -0.16), new Vec2(0.465, -0.179), new Vec2(0.518, -0.166), new Vec2(0.544, -0.131),
    new Vec2(0.554, -0.078), new Vec2(0.557, 0), new Vec2(0.554, 0.078), new Vec2(0.544, 0.131), new Vec2(0.518, 0.166),
    new Vec2(0.465, 0.179), new Vec2(0.3, 0.16)];
  const wheelParts: Geo[] = [lathe(tyreProfile, 40).rotateZ(Math.PI / 2).setColor('#1b1c1e')];
  const lugGeo = roundedBox(SIX_WHEEL_BASE.wheelWidth * 0.47, 0.032, 0.104, 1, 0.007).weld();
  for (const sx of [-1, 1]) for (let i = 0; i < 23; i++) {
    const a = (i + sx * 0.16) / 23 * Math.PI * 2;
    const lug = lugGeo.clone().applyMatrix(composeMat(new Mat4(), new Vec3(sx * 0.087, Math.cos(a) * 0.554, Math.sin(a) * 0.554),
      quatFromEuler(new Quat(), a, sx * 0.36, 0), Vec3.ONE));
    wheelParts.push(lug.setColor('#151619'));
  }
  const rimProfile = [new Vec2(0.1, -0.14), new Vec2(0.28, -0.16), new Vec2(0.3, -0.1), new Vec2(0.3, 0.1), new Vec2(0.28, 0.16), new Vec2(0.1, 0.14)];
  wheelParts.push(lathe(rimProfile, 30).rotateZ(Math.PI / 2).setColor('#3a3d3a'));
  for (const sx of [-1, 1]) {
    wheelParts.push(torus(0.285, 0.016, 8, 30).rotateY(Math.PI / 2).translate(sx * 0.145, 0, 0).setColor('#555a55'));
    wheelParts.push(torus(0.465, 0.007, 6, 36).rotateY(Math.PI / 2).translate(sx * 0.176, 0, 0).setColor('#242629'));
    wheelParts.push(cylinder(0.065, 0.065, 0.035, 12).rotateZ(Math.PI / 2).translate(sx * 0.218, 0, 0).setColor('#626861'));
  }
  wheelParts.push(cylinder(0.12, 0.12, 0.4, 10).rotateZ(Math.PI / 2).setColor('#2a2d2a'));
  const boltGeo = cylinder(0.02, 0.02, 0.05, 6).rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    wheelParts.push(boltGeo.clone().translate(sx * 0.17, Math.cos(a) * 0.20, Math.sin(a) * 0.20).setColor('#555a55'));
  }
  return Geo.merge(wheelParts)!;
}

let wheelGeo: Geo | undefined;

export function addSixWheels(visualRoot: Entity, hullMeshes: Entity[]) {
  wheelGeo ??= buildWheel();
  const wheelMat = standard({ vertexColors: true, roughness: 0.62, metalness: 0.38, envIntensity: 0.9 });
  applySurfaceFinish(wheelMat, 'wheel');
  const wheels: WheelNodeBinding[] = [], steerNodes: Entity[] = [], axleNames = ['FL', 'FR', 'RL1', 'RR1', 'RL2', 'RR2'] as const;
  for (let i = 0; i < 6; i++) {
    const name = axleNames[i], z = SIX_WHEEL_BASE.axleZ[Math.min(i >> 1, 2)], sx = name.includes('L') ? -1 : 1;
    const steerPivot = group(`steer_${name}`, visualRoot);
    steerPivot.setLocalPosition(sx * SIX_WHEEL_BASE.trackX, SIX_WHEEL_BASE.wheelRadius, z);
    const spinNode = group(`wheel_${name}`, steerPivot);
    const wheelMesh = meshNode(wheelGeo, wheelMat, spinNode, { castShadows: true, receiveShadows: true });
    wheels.push({ node: spinNode, side: name.includes('L') ? 'L' : 'R', radius: SIX_WHEEL_BASE.wheelRadius });
    hullMeshes.push(wheelMesh);
    if (i < 2) steerNodes.push(steerPivot);
  }
  return { wheels, steerNodes };
}
