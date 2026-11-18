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

const BED = {
  ringR: 1.02, ringH: 0.16, drumR: 0.92, drumH: 0.3, gunY: 0.42, gunZ: 0.15,
  canW: 0.62, canH: 0.52, canD: 1.72, canX: 0.65, canZ: 0.68,
  headW: 0.5, headH: 0.42, headD: 0.6, headZ: 0.15, mastZ: -0.55, bayZ: -1.5,
} as const;

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
export function buildFpvDrone(): Entity {
  const g = group('fpv_drone');
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
  setLocalEulerRad(mesh(cylinder(0.039, 0.039, 0.27, 12), accentMat, 0, -0.056, 0.005), Math.PI / 2, 0, 0);
  mesh(roundedBox(0.092, 0.075, 0.07, 2, 0.008), frameMat, 0, 0.068, 0.134);
  setLocalEulerRad(mesh(cylinder(0.030, 0.032, 0.027, 20), hardware, 0, 0.068, 0.174), Math.PI / 2, 0, 0);
  mesh(sphere(0.024, 16, 10), lensMat, 0, 0.068, 0.183).setLocalScale(1, 1, 0.43);
  const camera = group('fpv_camera', g);
  camera.setLocalPosition(0, 0.068, 0.198);
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
  g.setLocalScale(0.76, 0.76, 0.76);
  return g;
}

export function buildSupportVehicleRig(team: Team): InstantiatedTankRig {
  const isBlue = team === 'blue';
  const ch = buildRocketChassis(team);
  const { root, hullTiltGroup, visualRoot, wheels, steerNodes, hullMeshes } = ch;
  const paint = bedMat(isBlue ? '#48554b' : '#6b5e4b', 0.6, 0.28);
  const dark = bedMat(isBlue ? '#333a26' : '#4c3f2a', 0.66, 0.24);
  const steel = bedMat('#2c2f2c', 0.45, 0.72), black = bedMat('#141517', 0.7, 0.4);
  const eb = new GeoBucket(), deckY = 1.38;
  eb.rbox(dark, 0.85, 0.62, 1.0, 0.04, -0.55, deckY + 0.31, 0.9);
  eb.box(black, 0.5, 0.06, 0.7, -0.55, deckY + 0.6, 1.0);
  eb.cyl(steel, 0.34, 0.34, 0.34, 18, 0.45, deckY + 0.36, 1.35, 0, 0, Math.PI / 2);
  eb.cyl(black, 0.36, 0.36, 0.05, 18, 0.45, deckY + 0.36, 1.35, 0, 0, Math.PI / 2);
  eb.cyl(dark, 0.1, 0.1, 0.42, 10, 0.45, deckY + 0.36, 1.35, 0, 0, Math.PI / 2);
  for (const rz of [0.35, 1.15]) eb.box(steel, 0.06, 0.85, 0.06, 0.78, deckY + 0.43, rz);
  eb.box(steel, 0.06, 0.85, 0.06, 1.12, deckY + 0.43, 0.75);
  eb.box(dark, 0.4, 0.05, 0.95, 0.95, deckY + 0.82, 0.75);
  eb.rbox(paint, 0.3, 0.24, 0.4, 0.02, 0.95, deckY + 0.97, 0.55);
  eb.rbox(dark, 0.26, 0.2, 0.34, 0.02, 0.95, deckY + 0.95, 0.95);
  eb.flush(hullTiltGroup, hullMeshes);

  const turretPivot = group('support_turret_pivot', hullTiltGroup);
  turretPivot.setLocalPosition(0, 1.38, -1.6);
  const turretRestPos = turretPivot.getLocalPosition().clone();
  const tb = new GeoBucket();
  tb.cyl(steel, BED.ringR, BED.ringR + 0.04, BED.ringH, 28, 0, BED.ringH / 2, 0);
  tb.cyl(dark, BED.drumR, BED.drumR, BED.drumH, 24, 0, BED.ringH + BED.drumH / 2 - 0.02, 0);
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    tb.cyl(black, 0.025, 0.025, 0.03, 6, Math.cos(a) * (BED.ringR - 0.06), BED.ringH + 0.005, Math.sin(a) * (BED.ringR - 0.06));
  }
  for (const sx of [-1, 1]) {
    tb.box(steel, 0.12, 0.3, 0.5, sx * 0.45, BED.gunY - 0.28, BED.gunZ);
    tb.cyl(steel, 0.07, 0.07, 0.34, 10, sx * 0.45, BED.gunY - 0.1, BED.gunZ, 0, 0, Math.PI / 2);
  }
  tb.cyl(steel, 0.035, 0.045, 0.5, 8, 0, BED.ringH + BED.drumH + 0.22, BED.mastZ);
  tb.box(steel, 0.1, 0.08, 0.1, 0, BED.ringH + BED.drumH + 0.47, BED.mastZ);
  tb.rbox(paint, 1.02, 0.23, 0.93, 0.045, 0, 0.15, BED.bayZ);
  tb.box(dark, 0.91, 0.023, 0.82, 0, 0.278, BED.bayZ);
  for (const sx of [-1, 1]) {
    tb.rbox(steel, 0.12, 0.085, 0.84, 0.025, sx * 0.41, 0.314, BED.bayZ);
    tb.box(black, 0.16, 0.025, 0.58, sx * 0.29, 0.296, BED.bayZ);
    for (const z of [BED.bayZ - 0.30, BED.bayZ + 0.30]) tb.rbox(dark, 0.08, 0.055, 0.12, 0.012, sx * 0.46, 0.29, z);
  }
  tb.box(steel, 0.78, 0.035, 0.045, 0, 0.32, BED.bayZ - 0.44);
  for (const x of [-0.26, 0.26]) tb.rbox(dark, 0.11, 0.055, 0.07, 0.012, x, 0.32, BED.bayZ + 0.43);
  tb.flush(turretPivot, hullMeshes);
  const drone = buildFpvDrone();
  drone.setLocalPosition(0, 0.377, BED.bayZ);
  turretPivot.addChild(drone);

  const radarPanel = group('support_radar_panel', turretPivot);
  radarPanel.setLocalPosition(0, BED.ringH + BED.drumH + 0.62, BED.mastZ);
  const rb = new GeoBucket();
  rb.rbox(steel, 0.91, 0.43, 0.1, 0.045, 0, 0, -0.015);
  rb.rbox(dark, 0.83, 0.345, 0.07, 0.035, 0, 0, 0.045);
  const antenna = bedMat('#829286', 0.54, 0.37);
  for (let ix = -3; ix <= 3; ix++) for (let iy = -1; iy <= 1; iy++) rb.box(antenna, 0.049, 0.031, 0.012, ix * 0.105, iy * 0.096, 0.087);
  // Rear truss, receiver modules and edge fasteners remain readable from the chase view.
  for (const y of [-0.16, 0.16]) rb.box(steel, 0.82, 0.025, 0.035, 0, y, -0.085);
  for (const sx of [-1, 1]) {
    rb.box(steel, 0.035, 0.50, 0.035, sx * 0.36, -0.25, -0.075, 0, 0, sx * 0.62);
    rb.rbox(dark, 0.16, 0.12, 0.09, 0.018, sx * 0.25, -0.07, -0.105);
    rb.cyl(antenna, 0.009, 0.012, 0.48, 6, sx * 0.52, 0.06, -0.02, 0, 0, sx * 0.18);
    for (const y of [-0.17, 0.17]) rb.cyl(steel, 0.014, 0.014, 0.025, 6, sx * 0.40, y, -0.115, Math.PI / 2);
  }
  rb.flush(radarPanel, hullMeshes);
  let radarAngle = 0;

  const gunPivot = group('support_gun_pivot', turretPivot);
  gunPivot.setLocalPosition(0, BED.gunY, BED.gunZ);
  const gunRecoilGroup = group('support_recoil_group', gunPivot);
  const bb = new GeoBucket();
  bb.rbox(dark, BED.headW, BED.headH, BED.headD, 0.05, 0, 0.18, BED.headZ);
  const sensor = bedMat('#273e49', 0.16, 0.63, 2);
  bb.cyl(black, 0.114, 0.13, 0.13, 14, 0, 0.22, 0.475, Math.PI / 2);
  bb.cyl(sensor, 0.081, 0.092, 0.016, 14, 0, 0.22, 0.548, Math.PI / 2);
  bb.cyl(steel, 0.05, 0.05, 0.16, 8, 0, BED.headH * 0.5 + 0.05, BED.headZ);
  const tubeLocal: Vec3[] = [];
  for (const sx of [-1, 1]) {
    const cx = sx * BED.canX;
    bb.rbox(steel, BED.canW, BED.canH, 0.22, 0.035, cx, 0.02, BED.canZ - 0.42);
    bb.rbox(steel, BED.canW, BED.canH, 0.19, 0.035, cx, 0.02, BED.canZ + 0.49);
    for (const [ty, tz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const mx = cx + ty * BED.canW / 5, my = 0.02 + tz * BED.canH / 5, mz = BED.canZ + BED.canD / 2 + 0.005;
      bb.cyl(paint, 0.102, 0.102, BED.canD, 12, mx, my, BED.canZ, Math.PI / 2);
      bb.cyl(black, 0.082, 0.082, 0.036, 12, mx, my, mz, Math.PI / 2);
      bb.put(steel, torus(0.091, 0.01, 6, 12), mx, my, mz + 0.017);
      tubeLocal.push(new Vec3(mx, my, mz));
    }
  }
  bb.flush(gunRecoilGroup, hullMeshes);
  const rocketMeshes = tubeLocal.map((p) => {
    const cap = meshNode(cylinder(0.08, 0.08, 0.035, 12), black, gunRecoilGroup);
    setLocalEulerRad(cap, Math.PI / 2, 0, 0);
    cap.setLocalPosition(p.x, p.y, p.z + 0.012);
    return cap;
  });
  const muzzleNode = group('muzzle_datum', gunRecoilGroup), coaxNode = group('coax_datum', gunRecoilGroup);
  muzzleNode.setLocalPosition(0, 0.1, BED.canZ + BED.canD / 2 + 0.15);
  coaxNode.setLocalPosition(muzzleNode.getLocalPosition());
  const articulate = () => {
    radarAngle += 0.018;
    setLocalEulerRad(radarPanel, 0, radarAngle, 0);
  };
  return { root, hullTiltGroup, visualRoot, turretPivot, turretRestPos, gunPivot, gunRecoilGroup,
    muzzleNode, coaxNode, rwsNode: null, wheels, steerNodes, rocketMeshes, articulate, hullMeshes };
}
