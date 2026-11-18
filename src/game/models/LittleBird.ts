import type { Entity, Material } from 'playcanvas';
import type { InstantiatedTankRig } from '../AssetLoader';
import { circle, cylinder, type Geo, roundedBox, torus } from '../engine/geometry';
import { standard } from '../engine/materials';
import { setLocalEulerRad, Vec3 } from '../engine/math';
import { findByName, group, meshNode, userData } from '../engine/scene';
import type { Team } from '../types';

export function buildLittleBirdRig(team: Team, airframe: Entity): InstantiatedTankRig {
  const root = group(`little_bird_${team}`);
  const hullTiltGroup = group('hull_tilt_group', root);
  const visualRoot = group('littlebird_visual', hullTiltGroup);
  const model = airframe.clone();
  visualRoot.addChild(model);
  const hullMeshes: Entity[] = [];
  model.forEach((node) => { if ((node as Entity).render) hullMeshes.push(node as Entity); });
  const main = findByName(model, 'Rotor_Main')!, tail = findByName(model, 'Rotor_Tail')!;
  userData(main).noDamageBounds = userData(tail).noDamageBounds = true;

  const paint = standard({ color: team === 'blue' ? '#4e5b4c' : '#74664d', roughness: 0.56, metalness: 0.25 });
  const steel = standard({ color: '#475256', roughness: 0.42, metalness: 0.68 });
  const dark = standard({ color: '#121715', roughness: 0.8 });
  const turretPivot = group('littlebird_turret', visualRoot), turretRestPos = new Vec3(0, 0.95, 0.3);
  turretPivot.setLocalPosition(turretRestPos);
  const gunPivot = group('littlebird_gun', turretPivot), gunRecoilGroup = group('littlebird_recoil', gunPivot);
  const muzzleNode = group('muzzle_datum', gunRecoilGroup), coaxNode = group('coax_datum', gunRecoilGroup);
  const part = (geo: Geo, mat: Material, x: number, y: number, z: number) => {
    const node = meshNode(geo, mat, gunRecoilGroup, { castShadows: true, receiveShadows: true });
    node.setLocalPosition(x, y, z);
    return node;
  };
  coaxNode.setLocalPosition(-1.27, 0, 0.66);
  muzzleNode.setLocalPosition(1.27, 0, 0.65);
  part(roundedBox(0.21, 0.21, 0.52, 2, 0.037), steel, -1.27, 0, 0);
  const barrel = cylinder(0.015, 0.018, 0.44, 8).rotateX(Math.PI / 2);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    part(barrel, steel, -1.27 + Math.cos(a) * 0.053, Math.sin(a) * 0.053, 0.42);
  }
  part(cylinder(0.23, 0.23, 0.9, 20).rotateX(Math.PI / 2), paint, 1.27, 0, 0.19);
  part(circle(0.218, 24), dark, 1.27, 0, 0.646);
  const tube = torus(0.045, 0.009, 7, 12);
  part(tube, steel, 1.27, 0, 0.653);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    part(tube, steel, 1.27 + Math.cos(a) * 0.129, Math.sin(a) * 0.129, 0.653);
  }
  let mainAngle = 0, tailAngle = 0;
  return {
    root, hullTiltGroup, visualRoot, turretPivot, turretRestPos, gunPivot, gunRecoilGroup, muzzleNode, coaxNode,
    rwsNode: null, wheels: [], steerNodes: [], rocketMeshes: [], hullMeshes,
    spinRotors(dt) {
      mainAngle += 35 * dt;
      tailAngle += 79 * dt;
      setLocalEulerRad(main, 0, mainAngle, 0);
      setLocalEulerRad(tail, tailAngle, 0, 0);
    },
  };
}
