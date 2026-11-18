import type { Entity, Material } from 'playcanvas';
import type { InstantiatedTankRig } from '../AssetLoader';
import { box, cylinder, type Geo, roundedBox } from '../engine/geometry';
import { standard } from '../engine/materials';
import { setLocalEulerRad, Vec3 } from '../engine/math';
import { findByName, group, meshNode, userData } from '../engine/scene';
import type { Team } from '../types';

export function buildApacheRig(team: Team, airframe: Entity): InstantiatedTankRig {
  const root = group(`apache_${team}`), hullTiltGroup = group('hull_tilt_group', root);
  const visualRoot = group('apache_visual', hullTiltGroup);
  const model = airframe.clone();
  visualRoot.addChild(model);
  const rotor = findByName(model, 'Apache_MainRotor')!, tailRotor = findByName(model, 'Apache_TailRotor')!;
  const body = findByName(model, 'Apache_Airframe')!, canopy = findByName(model, 'Apache_Canopy')!;
  userData(rotor).noDamageBounds = userData(tailRotor).noDamageBounds = true;
  const hullMeshes = [body, canopy, rotor, tailRotor], rocketMeshes: Entity[] = [];
  const launcherPaint = standard({ color: '#535744', roughness: 0.60, metalness: 0.26 });
  const frame = standard({ color: '#242b27', roughness: 0.66, metalness: 0.34 });
  const steel = standard({ color: '#505b60', metalness: 0.62, roughness: 0.43 });
  const marking = standard({ color: team === 'blue' ? '#677f8e' : '#ad7457', roughness: 0.55 });
  const part = (parent: Entity, geo: Geo, mat: Material, x: number, y: number, z: number) => {
    const node = meshNode(geo, mat, parent, { castShadows: true, receiveShadows: true });
    node.setLocalPosition(x, y, z);
    return node;
  };
  const alongZ = (a: number, b: number, length: number, sides = 16) =>
    cylinder(a, b, length, sides).rotateX(Math.PI / 2);
  const rack = group('apache_launcher_racks', visualRoot);
  const rail = roundedBox(0.34, 0.16, 1.13, 2, 0.042);
  const rocketBody = alongZ(0.062, 0.062, 0.92);
  const rocketNose = alongZ(0.006, 0.062, 0.22);
  const nozzle = alongZ(0.043, 0.063, 0.08);
  const band = alongZ(0.064, 0.064, 0.034);
  const fin = box(0.214, 0.017, 0.16);
  for (const side of [-1, 1]) {
    for (let pylon = 0; pylon < 2; pylon++) {
      const x = side * (1.10 + pylon * 0.49), z = -0.28 - pylon * 0.11;
      part(rack, rail, frame, x, 0.99, z);
      part(rack, rail, frame, x, 0.90, z).setLocalScale(0.57, 0.48, 0.88);
      for (let row = 0; row < 2; row++) for (const col of [-1, 1]) {
        const round = group('apache_loaded_missile', rack);
        round.setLocalPosition(x + col * 0.086, 0.83 - row * 0.154, z + 0.67);
        part(round, rocketBody, launcherPaint, 0, 0, -0.57);
        part(round, rocketNose, frame, 0, 0, -0.005);
        part(round, band, marking, 0, 0, -0.26);
        part(round, nozzle, steel, 0, 0, -1.04);
        part(round, fin, frame, 0, 0, -0.93);
        part(round, fin, frame, 0, 0, -0.93).setLocalEulerAngles(0, 0, 90);
        rocketMeshes.push(round);
      }
    }
  }

  const turretPivot = group('apache_chin_turret', visualRoot), turretRestPos = new Vec3(0, 0.68, 2.04);
  turretPivot.setLocalPosition(turretRestPos);
  part(turretPivot, cylinder(0.28, 0.21, 0.29, 20), frame, 0, 0.12, 0);
  const gunPivot = group('apache_gun', turretPivot), gunRecoilGroup = group('apache_gun_recoil', gunPivot);
  const muzzleNode = group('muzzle_datum', gunPivot), coaxNode = group('coax_datum', gunRecoilGroup);
  muzzleNode.setLocalPosition(1.59, 0.15, -1.76);
  coaxNode.setLocalPosition(0, -0.17, 1.59);
  part(gunRecoilGroup, roundedBox(0.45, 0.37, 0.57, 2, 0.092), frame, 0, -0.07, 0.08);
  part(gunRecoilGroup, alongZ(0.16, 0.17, 0.38), steel, 0, -0.17, 0.44);
  const gatling = group('apache_gatling_barrels', gunRecoilGroup);
  gatling.setLocalPosition(0, -0.17, 0.36);
  const barrel = alongZ(0.026, 0.031, 1.15, 10);
  const brake = alongZ(0.036, 0.032, 0.08, 12);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3, x = Math.cos(a) * 0.113, y = Math.sin(a) * 0.113;
    part(gatling, barrel, steel, x, y, 0.58);
    part(gatling, brake, frame, x, y, 1.16);
  }
  const collar = alongZ(0.155, 0.155, 0.077, 20);
  part(gatling, collar, frame, 0, 0, 0.40);
  part(gatling, collar, frame, 0, 0, 0.95);
  let mainAngle = 0, tailAngle = 0, gunAngle = 0;
  return {
    root, hullTiltGroup, visualRoot, turretPivot, turretRestPos, gunPivot, gunRecoilGroup, muzzleNode, coaxNode,
    rwsNode: null, wheels: [], steerNodes: [], rocketMeshes, hullMeshes,
    spinRotors(dt) {
      mainAngle += 28 * dt;
      tailAngle += 68 * dt;
      setLocalEulerRad(rotor, 0, mainAngle, 0);
      setLocalEulerRad(tailRotor, tailAngle, 0, 0);
    },
    spinGatling(dt) {
      gunAngle += 36 * dt;
      setLocalEulerRad(gatling, 0, 0, gunAngle);
    },
  };
}
