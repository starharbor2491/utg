import type { Entity, Material } from 'playcanvas';
import { applyRealisticArmorShader } from '../engine/materials';
import type { InstantiatedTankRig } from '../AssetLoader';
import { buildRocketChassis } from './RocketLauncher';
import type { Team } from '../types';
import { box, CatmullRomCurve3, cylinder, extrude, Geo, roundedBox, Shape, sphere, torus, tube } from '../engine/geometry';
import { standard } from '../engine/materials';
import { setLocalEulerRad, Vec2, Vec3 } from '../engine/math';
import { group, meshNode, userData } from '../engine/scene';
import { GeoBucket } from './GeoBucket';
import { applySurfaceFinish } from './SurfaceFinish';

function bedMat(color: string, roughness: number, metalness: number, heightRef = 1.9) {
  const m = standard({ color, roughness, metalness, envIntensity: 1 });
  applyRealisticArmorShader(m, 'support-bed', { grain: 0.5, heightRef });
  return m;
}

const propProfile = new Shape([
  new Vec2(0.012, -0.009), new Vec2(0.046, -0.020), new Vec2(0.097, -0.016), new Vec2(0.114, -0.009),
  new Vec2(0.102, 0.005), new Vec2(0.041, 0.011), new Vec2(0.012, 0.009),
]);
const fpvProp = extrude(propProfile, { depth: 0.003, bevelEnabled: false }).rotateX(Math.PI / 2);

/** FPV quadcopter, nose and camera facing +Z. */
export function buildFpvDrone(armed = false): Entity {
  const g = group(armed ? 'gun_drone' : 'fpv_drone');
  userData(g).keepMeshChildren = true;
  const frameMat = standard({ color: '#2b2e33', roughness: 0.88, metalness: 0.25 });
  applySurfaceFinish(frameMat, 'carbon');
  const hardware = standard({ color: '#4d5455', roughness: 0.43, metalness: 0.7 });
  const propMat = standard({ color: '#313630', roughness: 0.6, metalness: 0.06 });
  const accentMat = standard({ color: '#585e40', roughness: 0.7, metalness: 0.2 });
  const lensMat = standard({ color: '#152630', roughness: 0.23, metalness: 0.6 });
  const navMat = (c: string) => standard({ color: '#111111', emissive: c, emissiveIntensity: 2.2 });
  const mesh = (geo: Geo, mat: Material, x: number, y: number, z: number, parent = g) => {
    const part = meshNode(geo, mat, parent, { castShadows: false, receiveShadows: true });
    part.setLocalPosition(x, y, z);
    return part;
  };
  const armGeo = roundedBox(0.245, 0.018, 0.05, 2, 0.007);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    setLocalEulerRad(mesh(armGeo, frameMat, sx * 0.126, 0.026, sz * 0.125), 0, -sx * sz * Math.PI / 4, 0);
    mesh(cylinder(0.037, 0.037, 0.018, 10), frameMat, sx * 0.21, 0.026, sz * 0.21);
  }
  mesh(roundedBox(0.144, 0.016, 0.268, 2, 0.006), frameMat, 0, 0.025, 0);
  mesh(roundedBox(0.127, 0.014, 0.235, 2, 0.006), frameMat, 0, 0.075, -0.004);
  mesh(roundedBox(0.101, 0.04, 0.137, 2, 0.007), accentMat, 0, 0.102, -0.034);
  for (const sz of [-1, 1]) mesh(box(0.114, 0.047, 0.013), frameMat, 0, 0.104, -0.035 + 0.041 * sz);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) mesh(cylinder(0.007, 0.007, 0.058, 6), accentMat, sx * 0.053, 0.052, sz * 0.089);
    mesh(roundedBox(0.017, 0.068, 0.085, 2, 0.007), frameMat, sx * 0.056, 0.066, 0.13);
  }
  if (armed) {
    const pale = standard({ color: '#a6aa96', roughness: 0.68, metalness: 0.27 });
    mesh(roundedBox(0.24, 0.11, 0.30, 2, 0.03), pale, 0, 0.09, -0.030);
    mesh(roundedBox(0.15, 0.09, 0.22, 2, 0.02), hardware, 0, -0.037, 0.05);
    setLocalEulerRad(mesh(cylinder(0.019, 0.025, 0.34, 10), frameMat, 0, -0.06, 0.22), Math.PI / 2, 0, 0);
    const muzzle = group('drone_muzzle', g);
    muzzle.setLocalPosition(0, -0.06, 0.40);
  } else {
    setLocalEulerRad(mesh(cylinder(0.039, 0.039, 0.27, 12), accentMat, 0, -0.056, 0.005), Math.PI / 2, 0, 0);
  }
  mesh(roundedBox(0.092, 0.075, 0.07, 2, 0.008), frameMat, 0, 0.068, 0.134);
  setLocalEulerRad(mesh(cylinder(0.030, 0.032, 0.027, 20), hardware, 0, 0.068, 0.174), Math.PI / 2, 0, 0);
  mesh(sphere(0.024, 16, 10), lensMat, 0, 0.068, 0.183).setLocalScale(1, 1, 0.43);
  const camera = group('fpv_camera', g);
  camera.setLocalPosition(0, armed ? 0.16 : 0.068, armed ? 0.43 : 0.198);
  setLocalEulerRad(camera, 0, Math.PI, 0);
  for (const sx of [-1, 1]) setLocalEulerRad(mesh(cylinder(0.005, 0.006, 0.132, 6), frameMat, sx * 0.054, 0.12, -0.137), 0, 0, -sx * 0.33);
  const powerLead = new CatmullRomCurve3([
    new Vec3(0.034, 0.104, -0.099), new Vec3(0.030, 0.116, -0.134),
    new Vec3(0.063, 0.085, -0.140), new Vec3(0.058, 0.055, -0.111),
  ]);
  mesh(tube(powerLead, 12, 0.006, 5), accentMat, 0, 0, 0);
  const shoulder = cylinder(0.032, 0.032, 0.012, 12);
  for (const [sx, c] of [[-1, '#ff2a1a'], [1, '#2aff5a']] as const) mesh(sphere(0.012, 6, 6), navMat(c), sx * 0.07, 0.09, 0.12);
  // Battery retention, protected propellers and sacrificial landing feet.
  for (const z of [-0.07, 0.015]) mesh(roundedBox(0.112, 0.008, 0.018, 1, 0.003), frameMat, 0, 0.126, z);
  for (const sx of [-1, 1]) {
    setLocalEulerRad(mesh(cylinder(0.005, 0.005, 0.09, 6), hardware, sx * 0.052, 0.008, -0.06), 0, 0, sx * 0.22);
    mesh(roundedBox(0.018, 0.012, 0.12, 1, 0.004), frameMat, sx * 0.062, -0.037, -0.03);
  }
  const motorGeo = cylinder(0.028, 0.034, 0.05, 16), hubGeo = cylinder(0.017, 0.017, 0.012, 8);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const px = sx * 0.21, pz = sz * 0.21;
    mesh(motorGeo, frameMat, px, 0.05, pz);
    mesh(shoulder, hardware, px, 0.073, pz);
    setLocalEulerRad(mesh(torus(0.126, 0.005, 5, 28), hardware, px, 0.071, pz), Math.PI / 2, 0, 0);
    const rotor = group('fpv_rotor', g);
    rotor.setLocalPosition(px, 0.085, pz);
    for (let i = 0; i < 3; i++) {
      const blade = mesh(fpvProp, propMat, 0, 0, 0, rotor);
      setLocalEulerRad(blade, sx * sz * 0.16, i * 2 * Math.PI / 3, 0, 'YXZ');
      blade.setLocalScale(1, 1, sx * sz);
    }
    mesh(hubGeo, frameMat, 0, 0, 0, rotor);
    userData(rotor).spin = sx * sz;
  }
  g.setLocalScale(armed ? 1.35 : 0.76, armed ? 1.35 : 0.76, armed ? 1.35 : 0.76);
  return g;
}

export function buildSupportVehicleRig(team: Team): InstantiatedTankRig {
  const ch = buildRocketChassis(team);
  const { root, hullTiltGroup, visualRoot, wheels, steerNodes, hullMeshes } = ch;
  const paint = bedMat(team === 'blue' ? '#55675c' : '#796353', 0.62, 0.28);
  const steel = bedMat('#333d3c', 0.48, 0.68);
  const rubber = bedMat('#1b2323', 0.86, 0.14);
  const stencil = bedMat('#d9ac65', 0.7, 0.2);
  const lens = standard({ color: '#172322', emissive: '#8cbea2', emissiveIntensity: 1.1 });
  const deck = new GeoBucket();
  deck.rbox(paint, 2.22, 0.37, 4.35, 0.09, 0, 1.57, -1.03);
  deck.rbox(steel, 2.13, 0.16, 3.96, 0.05, 0, 1.78, -1.09);
  // Forward battery/operations cabinet and twin recessed launch pads aft.
  deck.rbox(paint, 2.11, 0.92, 1.34, 0.14, 0, 2.23, 0.33);
  deck.rbox(rubber, 1.96, 0.10, 1.15, 0.04, 0, 2.70, 0.36);
  deck.rbox(steel, 1.48, 0.57, 0.08, 0.04, 0, 2.25, -0.36);
  for (const sx of [-1, 1]) {
    const x = sx * 0.53;
    deck.rbox(paint, 0.17, 0.42, 2.85, 0.04, sx * 1.02, 1.99, -1.71);
    deck.rbox(rubber, 0.86, 0.065, 1.30, 0.04, x, 1.89, -2.24);
    deck.rbox(steel, 0.72, 0.07, 0.38, 0.025, x, 1.94, -2.27);
    deck.box(lens, 0.37, 0.032, 0.05, x, 1.96, -2.93);
    for (const sz of [-1, 1]) {
      deck.box(stencil, 0.68, 0.012, 0.052, x, 1.934, -2.24 + sz * 0.60);
      deck.box(stencil, 0.052, 0.012, 0.32, x + sz * 0.35, 1.934, -2.24);
    }
    for (let i = 0; i < 6; i++) {
      deck.box(steel, 0.035, 0.10, 0.25, sx * 1.066, 2.25 + (i % 2) * 0.14, 0.72 - Math.floor(i / 2) * 0.29);
      deck.box(stencil, 0.097, 0.048, 0.01, sx * (0.76 + (i % 3) * 0.106), 1.97 + Math.floor(i / 3) * 0.065, -3.142, 0, 0, -0.51);
    }
    deck.cyl(steel, 0.034, 0.044, 0.69, 8, sx * 0.84, 2.94, 0.65, 0, 0, sx * -0.17);
    deck.cyl(rubber, 0.014, 0.025, 0.31, 6, sx * 0.92, 3.40, 0.65, 0, 0, sx * -0.17);
    deck.rbox(steel, 0.31, 0.32, 0.40, 0.045, x, 2.03, -0.69);
    deck.box(lens, 0.16, 0.04, 0.016, x, 2.12, -0.90);
  }
  deck.rbox(steel, 1.73, 0.21, 0.17, 0.025, 0, 1.66, -3.18, 0.25);
  deck.box(steel, 0.07, 0.21, 2.13, 0, 1.92, -1.91);
  for (let i = 0; i < 4; i++) deck.box(steel, 1.78, 0.024, 0.07, 0, 1.87, -1.06 - i * 0.14);
  deck.flush(hullTiltGroup, hullMeshes);

  const fpv = buildFpvDrone(), gun = buildFpvDrone(true);
  fpv.setLocalPosition(0.53, 2.02, -2.26);
  gun.setLocalPosition(-0.53, 2.18, -2.26);
  hullTiltGroup.addChild(fpv);
  hullTiltGroup.addChild(gun);

  // The damage model still expects an aim pivot; the carrier has no moving launcher.
  const turretPivot = group('carrier_turret_pivot', hullTiltGroup);
  turretPivot.setLocalPosition(0, 2.34, 0.35);
  const turretRestPos = turretPivot.getLocalPosition().clone();
  const gunPivot = group('carrier_gun_pivot', turretPivot);
  const gunRecoilGroup = group('carrier_recoil_group', gunPivot);
  const muzzleNode = group('muzzle_datum', gunRecoilGroup), coaxNode = group('coax_datum', gunRecoilGroup);
  muzzleNode.setLocalPosition(0, 0.2, 0.7);
  return { root, hullTiltGroup, visualRoot, turretPivot, turretRestPos, gunPivot, gunRecoilGroup,
    muzzleNode, coaxNode, rwsNode: null, wheels, steerNodes, rocketMeshes: [], hullMeshes };
}
