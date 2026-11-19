import type { Entity, Material } from 'playcanvas';
import { applyRealisticArmorShader } from '../engine/materials';
import type { InstantiatedTankRig } from '../AssetLoader';
import { addSixWheels, SIX_WHEEL_BASE } from './SixWheelBase';
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

/** Extrude a side elevation (longitudinal Z, height Y), centred on the given X. */
function sidePanel(points: readonly (readonly [number, number])[], width: number, x = 0) {
  const outline = new Shape(points.map(([z, y]) => new Vec2(z, y)));
  return extrude(outline, { depth: width, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(x + width / 2, 0, 0);
}

export function buildSupportVehicleRig(team: Team): InstantiatedTankRig {
  const root = group(`drone_carrier_${team}`);
  const hullTiltGroup = group('hull_tilt_group', root);
  const visualRoot = group('carrier_visual', hullTiltGroup);
  const hullMeshes: Entity[] = [];
  const { wheels, steerNodes } = addSixWheels(visualRoot, hullMeshes);
  const blue = team === 'blue';
  const paint = bedMat(blue ? '#45666b' : '#885744', 0.66, 0.23);
  const light = bedMat(blue ? '#a2b7ae' : '#c1ac86', 0.64, 0.24);
  const steel = bedMat('#384446', 0.53, 0.55);
  const tread = bedMat('#273033', 0.89, 0.12);
  const ivory = bedMat('#e2d7ad', 0.78, 0.12);
  const glass = standard({ color: '#16313d', roughness: 0.18, metalness: 0.40 });
  applySurfaceFinish(glass, 'glass');
  const lamp = standard({ color: '#d4e2d9', emissive: '#8dbdad', emissiveIntensity: 0.65 });
  const tail = standard({ color: '#8e493b', emissive: '#a63826', emissiveIntensity: 0.65 });
  const body = new GeoBucket();

  // A continuous wheel-arch skirt and a raked nose replace the separate cargo cab.
  const skirt: [number, number][] = [[-3.46, 1.54], [-3.33, 0.78]];
  for (const z of [...SIX_WHEEL_BASE.axleZ].reverse()) {
    for (let i = 0; i <= 12; i++) {
      const a = i * Math.PI / 12;
      skirt.push([z - 0.68 * Math.cos(a), 0.62 + 0.68 * Math.sin(a)]);
    }
  }
  skirt.push([3.31, 0.85], [3.53, 1.26], [3.36, 1.55]);
  body.rbox(tread, 1.64, 0.68, 6.58, 0.12, 0, 0.91, -0.04);
  body.rbox(steel, 2.13, 0.25, 6.88, 0.10, 0, 1.38, -0.02);
  for (const z of SIX_WHEEL_BASE.axleZ) body.cyl(steel, 0.12, 0.12, 1.93, 12, 0, 0.58, z, 0, 0, Math.PI / 2);
  for (const s of [-1, 1]) {
    body.put(paint, sidePanel(skirt, 0.14, s * 1.13));
    body.rbox(steel, 0.13, 0.13, 6.72, 0.04, s * 1.19, 1.50, -0.06);
    body.rbox(tread, 0.09, 0.43, 1.02, 0.035, s * 1.22, 0.97, 0.65);
    body.box(light, 0.04, 0.07, 0.28, s * 1.275, 1.07, 0.68);
    for (const z of [-3.12, 0.12, 3.12]) body.box(lamp, 0.024, 0.047, 0.11, s * 1.265, 1.49, z);
  }

  const cabin = [[0.04, 1.48], [0.06, 2.07], [0.32, 2.71], [0.56, 2.81],
    [2.48, 2.81], [2.70, 2.64], [3.49, 1.58], [3.34, 1.40]] as const;
  body.put(paint, sidePanel(cabin, 2.20));
  const roof = [[0.29, 2.69], [0.52, 2.85], [2.49, 2.85], [2.73, 2.66], [2.60, 2.65], [2.43, 2.75], [0.58, 2.75], [0.38, 2.66]] as const;
  body.put(light, sidePanel(roof, 2.26));
  const rake = -Math.atan2(0.79, 1.06);
  body.rbox(tread, 2.14, 0.91, 0.044, 0.045, 0, 2.15, 3.09, rake);
  for (const s of [-1, 1]) {
    body.rbox(glass, 0.986, 0.77, 0.044, 0.038, s * 0.512, 2.17, 3.104, rake);
    body.put(steel, sidePanel([[1.41, 1.55], [1.42, 2.06], [1.81, 2.11], [2.90, 2.01], [3.04, 1.72], [2.87, 1.55]], 0.022, s * 1.106));
    body.put(paint, sidePanel([[1.46, 1.59], [1.47, 2.02], [1.83, 2.07], [2.87, 1.98], [2.98, 1.73], [2.84, 1.59]], 0.021, s * 1.119));
    body.put(tread, sidePanel([[0.30, 2.19], [0.47, 2.63], [2.53, 2.63], [3.02, 1.97], [1.77, 1.97]], 0.027, s * 1.106));
    body.put(glass, sidePanel([[1.53, 2.16], [1.55, 2.56], [2.47, 2.56], [2.87, 2.04], [1.82, 2.04]], 0.024, s * 1.125));
    body.put(glass, sidePanel([[0.43, 2.23], [0.57, 2.56], [1.42, 2.56], [1.40, 2.14]], 0.024, s * 1.125));
    body.put(light, sidePanel([[0.40, 1.79], [0.39, 1.92], [1.87, 1.75], [2.05, 1.60]], 0.018, s * 1.11));
    body.box(steel, 0.048, 0.048, 0.22, s * 1.149, 1.85, 1.66);
    body.rbox(steel, 0.23, 0.075, 0.67, 0.02, s * 1.13, 0.64, 1.17);
    for (const z of [0.97, 1.38]) body.box(steel, 0.16, 0.19, 0.08, s * 1.045, 0.74, z);
    for (let i = 0; i < 6; i++) body.box(tread, 0.028, 0.096, 0.056, s * 1.213, 1.41, -2.76 + i * 0.14, -0.32);
    body.box(tread, 0.49, 0.14, 0.073, s * 0.78, 1.53, 3.465);
    body.box(lamp, 0.38, 0.064, 0.035, s * 0.78, 1.54, 3.517);
    body.rbox(steel, 0.62, 0.18, 0.27, 0.04, s * 0.73, 1.22, 3.40);
  }
  // Low two-tone comms dome; the aft glazing faces the flight deck.
  body.cyl(steel, 0.32, 0.38, 0.12, 20, -0.38, 2.90, 1.02);
  body.rbox(tread, 0.74, 0.09, 0.82, 0.055, 0.42, 2.86, 1.81);
  for (let i = 0; i < 5; i++) body.box(steel, 0.57, 0.035, 0.039, 0.42, 2.91, 1.54 + i * 0.13);
  body.rbox(tread, 1.55, 0.44, 0.045, 0.035, 0, 2.38, 0.173, 0.39);
  body.rbox(glass, 1.40, 0.34, 0.036, 0.03, 0, 2.39, 0.144, 0.39);
  body.rbox(steel, 1.04, 0.25, 0.06, 0.025, 0, 1.93, 0.039);
  for (const y of [1.86, 1.93, 2.00]) body.box(paint, 0.93, 0.036, 0.065, 0, y, 0.007, -0.18);

  // A chamfered flight deck carries two staggered spots, with room to see each drone from behind.
  const deckPlan = new Shape([[-1.23, 3.20], [-0.96, 3.52], [0.96, 3.52], [1.23, 3.20],
    [1.23, -0.22], [1.05, -0.38], [-1.05, -0.38], [-1.23, -0.22]].map(([x, z]) => new Vec2(x, z)));
  const deck = extrude(deckPlan, { depth: 0.22, bevelEnabled: false }).rotateX(-Math.PI / 2);
  body.put(steel, deck, 0, 1.46, 0);
  body.put(tread, deck, 0, 1.68, -0.02, 0, 0, 0, 0.96, 0.26, 0.97);
  for (const s of [-1, 1]) {
    body.rbox(paint, 0.12, 0.18, 3.03, 0.025, s * 1.14, 1.77, -1.54);
    for (const z of [-2.91, -1.58, -0.37]) body.box(lamp, 0.073, 0.017, 0.20, s * 1.14, 1.866, z);
    body.rbox(steel, 0.38, 0.22, 0.12, 0.03, s * 0.78, 1.40, -3.48);
    body.box(tail, 0.26, 0.072, 0.024, s * 0.78, 1.42, -3.548);
  }
  const pad = (x: number, z: number, radius: number, number: 1 | 2) => {
    body.cyl(steel, radius, radius * 0.95, 0.071, 32, x, 1.768, z);
    body.cyl(tread, radius * 0.94, radius * 0.94, 0.024, 32, x, 1.812, z);
    const arc = torus(radius * 0.83, 0.030, 5, 12, Math.PI * 0.37).rotateX(-Math.PI / 2);
    for (let i = 0; i < 4; i++) body.put(ivory, arc, x, 1.827, z, 0, Math.PI * (i / 2 + 0.065), 0, 1, 0.25, 1);
    // One or two ivory bars repeat the keyboard slot on the lip of each dock.
    for (let i = 0; i < number; i++) body.box(ivory, 0.055, 0.012, 0.18, x + (i - (number - 1) / 2) * 0.10, 1.832, z - radius * 0.83);
  };
  const gunSpot = { x: -0.18, z: -2.35 }, fpvSpot = { x: 0.36, z: -0.78 };
  pad(gunSpot.x, gunSpot.z, 0.87, 1);
  pad(fpvSpot.x, fpvSpot.z, 0.55, 2);
  body.rbox(paint, 0.50, 0.34, 0.79, 0.065, -0.71, 1.89, -0.62);
  body.box(steel, 0.41, 0.057, 0.67, -0.71, 2.06, -0.62);
  for (const z of [-0.87, -0.43]) body.box(light, 0.42, 0.012, 0.045, -0.71, 2.095, z);
  body.flush(visualRoot, hullMeshes);

  const dock = (spot: { x: number; z: number }, armed: boolean) => {
    const cradle = group(armed ? 'carrier_dock_1' : 'carrier_dock_2', hullTiltGroup);
    cradle.setLocalPosition(spot.x, 1.824, spot.z);
    const drone = buildFpvDrone(armed);
    // Seat the lowest feature of each existing rig on its pad; keep the airborne scale.
    drone.setLocalPosition(0, armed ? 0.115 : 0.073, 0);
    cradle.addChild(drone);
  };
  dock(gunSpot, true);
  dock(fpvSpot, false);

  // Use the real sensor dome as the aim pivot; empty turret rigs get a tank-sized fallback box.
  const turretPivot = group('carrier_turret_pivot', hullTiltGroup);
  turretPivot.setLocalPosition(-0.38, 2.98, 1.02);
  const dome = meshNode(sphere(0.37, 20, 10), light, turretPivot, { name: 'carrier_sensor_dome', castShadows: true, receiveShadows: true });
  dome.setLocalScale(1, 0.46, 1);
  hullMeshes.push(dome);
  const turretRestPos = turretPivot.getLocalPosition().clone();
  const gunPivot = group('carrier_gun_pivot', turretPivot);
  const gunRecoilGroup = group('carrier_recoil_group', gunPivot);
  const muzzleNode = group('muzzle_datum', gunRecoilGroup), coaxNode = group('coax_datum', gunRecoilGroup);
  muzzleNode.setLocalPosition(0, 0.2, 0.7);
  return { root, hullTiltGroup, visualRoot, turretPivot, turretRestPos, gunPivot, gunRecoilGroup,
    muzzleNode, coaxNode, rwsNode: null, wheels, steerNodes, rocketMeshes: [], hullMeshes };
}
