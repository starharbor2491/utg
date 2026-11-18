import type { Entity, Material } from 'playcanvas';
import { applyRealisticArmorShader } from '../engine/materials';
import type { InstantiatedTankRig } from '../AssetLoader';
import type { Team } from '../types';
import { box, CatmullRomCurve3, circle, cylinder, extrude, Geo, roundedBox, Shape, sphere, torus, tube } from '../engine/geometry';
import { standard } from '../engine/materials';
import { lerp, Quat, quatFromUnitVectors, setLocalEulerRad, Vec3 } from '../engine/math';
import { group, meshNode, userData } from '../engine/scene';
import { applySurfaceFinish } from './SurfaceFinish';

// Axial sections: z, centre height, half-width, upper radius, lower radius.
const CABIN = [
  [-1.44, 1.51, 0.25, 0.26, 0.24], [-1.21, 1.47, 0.53, 0.45, 0.42],
  [-0.80, 1.43, 0.78, 0.73, 0.69], [-0.26, 1.43, 0.89, 0.88, 0.81],
  [0.32, 1.45, 0.91, 0.91, 0.85], [0.84, 1.46, 0.84, 0.84, 0.80],
  [1.29, 1.43, 0.70, 0.70, 0.73], [1.64, 1.39, 0.53, 0.52, 0.58],
  [1.87, 1.34, 0.31, 0.35, 0.40], [1.99, 1.30, 0.16, 0.19, 0.23],
  [2.035, 1.29, 0.001, 0.001, 0.001],
] as const;
const POINTS = CABIN.map(([z, cy, w, u, l]) => ({
  top: new Vec3(w, cy + u, z), mid: new Vec3(w, cy, z), bottom: new Vec3(w, cy - l, z),
}));
const top = new CatmullRomCurve3(POINTS.map((p) => p.top), false, 'catmullrom', 0.43);
const mid = new CatmullRomCurve3(POINTS.map((p) => p.mid), false, 'catmullrom', 0.43);
const bottom = new CatmullRomCurve3(POINTS.map((p) => p.bottom), false, 'catmullrom', 0.43);
const tSample = new Vec3(), mSample = new Vec3(), bSample = new Vec3();
const petal = (t: number, turn: number, offset = 0) => {
  top.getPoint(t, tSample); mid.getPoint(t, mSample); bottom.getPoint(t, bSample);
  const angle = turn * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
  const y = mSample.y + c * ((c > 0 ? tSample.y - mSample.y : mSample.y - bSample.y) + offset);
  return new Vec3(s * (mSample.x + offset), y, mSample.z);
};

function skinGeometry(): { solid: Geo; glass: Geo } {
  const steps = 40, radial = 64, positions: number[] = [], normals: number[] = [], solid: number[] = [], panes: number[] = [];
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= radial; j++) {
      const t = i / steps, a = j / radial;
      positions.push(...petal(t, a).toArray());
      const along = petal(Math.min(1, t + 0.0004), a).sub(petal(Math.max(0, t - 0.0004), a));
      const around = petal(t, a + 0.0004).sub(petal(t, a - 0.0004));
      const n = along.cross(along, around).normalize();
      normals.push(n.x, n.y, n.z);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < radial; j++) {
      const upper = Math.min(j, radial - 1 - j);
      const windshield = i >= 21 && i < 39 && upper < 17;
      const door = i >= 12 && i < 20 && upper >= 7 && upper < 17;
      const tris = windshield || door ? panes : solid;
      const a = i * (radial + 1) + j, b = a + radial + 1;
      tris.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return {
    solid: new Geo([...positions], [...normals], [], solid),
    glass: new Geo([...positions], [...normals], [], panes),
  };
}

function plate(outline: [number, number][], thickness: number, edge: number): Geo {
  const shape = new Shape();
  for (const [x, y] of outline) shape.lineTo(x, y);
  shape.closePath();
  return extrude(shape, { depth: thickness, bevelEnabled: true, bevelSize: edge, bevelThickness: edge, bevelSegments: 1 })
    .translate(0, 0, -thickness / 2);
}

const cabinSkin = skinGeometry();
const mainBlade = plate([[-0.10, 0.28], [-0.114, 3.55], [-0.11, 3.69], [-0.065, 3.77],
  [0.029, 3.77], [0.103, 3.64], [0.092, 0.52], [0.053, 0.34]], 0.014, 0.004).rotateX(Math.PI / 2);
const tailBlade = plate([[-0.058, 0.06], [-0.058, 0.48], [-0.005, 0.54],
  [0.052, 0.52], [0.070, 0.2], [0.042, 0.06]], 0.014, 0.004).rotateY(Math.PI / 2);

export function buildLittleBirdRig(team: Team): InstantiatedTankRig {
  const root = group(`little_bird_${team}`);
  const hullTiltGroup = group('hull_tilt_group', root);
  const visualRoot = group('littlebird_visual', hullTiltGroup);
  const hullMeshes: Entity[] = [];
  const paint = standard({ color: team === 'blue' ? '#566154' : '#6b5e49', roughness: 0.54, metalness: 0.28, clearcoat: 0.28, clearcoatRoughness: 0.46 });
  applyRealisticArmorShader(paint, 'littlebird-oxidized-skin', { grain: 0.62, heightRef: 1.5, dust: 0.022 });
  const trim = standard({ color: '#26312c', roughness: 0.68, metalness: 0.28 });
  const steel = standard({ color: '#465354', roughness: 0.40, metalness: 0.68 });
  const glass = standard({ color: '#405d67', roughness: 0.14, metalness: 0.12, transparent: true, opacity: 0.38,
    depthWrite: false, clearcoat: 1, clearcoatRoughness: 0.14, envIntensity: 1.28 });
  applySurfaceFinish(glass, 'glass');
  const marking = standard({ color: '#a1a99b', roughness: 0.69 });
  const part = (parent: Entity, geo: Geo, mat: Material, x = 0, y = 0, z = 0) => {
    const mesh = meshNode(geo, mat, parent, { castShadows: parent === visualRoot, receiveShadows: true });
    mesh.setLocalPosition(x, y, z);
    hullMeshes.push(mesh);
    return mesh;
  };
  const ball = (mat: Material, x: number, y: number, z: number, w: number, h: number, d: number) => {
    const mesh = part(visualRoot, sphere(1, 24, 14), mat, x, y, z);
    mesh.setLocalScale(w, h, d);
    return mesh;
  };
  const span = (parent: Entity, mat: Material, a: number[], b: number[], r: number, tip = r) => {
    const start = new Vec3().fromArray(a), end = new Vec3().fromArray(b), direction = end.clone().sub(start);
    const mesh = part(parent, cylinder(tip, r, direction.length(), 10), mat);
    mesh.setLocalPosition(start.clone().add(end).mulScalar(0.5));
    mesh.setLocalRotation(quatFromUnitVectors(new Quat(), Vec3.UP, direction.normalize()));
    return mesh;
  };
  const solidSkin = part(visualRoot, cabinSkin.solid, paint);
  solidSkin.name = 'littlebird_sectioned_airframe';
  part(visualRoot, cabinSkin.glass, glass).name = 'littlebird_glazing';
  const seam = (t1: number, a1: number, t2: number, a2: number, r = 0.016, mat = trim) => {
    const points = Array.from({ length: 21 }, (_, i) => petal(lerp(t1, t2, i / 20), lerp(a1, a2, i / 20), 0.005));
    part(visualRoot, tube(new CatmullRomCurve3(points), 25, r, 5, false), mat);
  };
  const arch = 17 / 64;
  seam(21 / 40, -arch, 21 / 40, arch, 0.021);
  seam(39 / 40, -arch, 39 / 40, arch, 0.014);
  seam(21 / 40, 0, 39 / 40, 0, 0.019);
  seam(10 / 40, 0.30, 10 / 40, 0.70, 0.007);
  seam(26 / 40, 0.28, 26 / 40, 0.72, 0.007);
  part(visualRoot, roundedBox(0.96, 0.09, 1.16, 2, 0.025), trim, 0, 1.07, 0.61);
  setLocalEulerRad(part(visualRoot, roundedBox(0.46, 0.33, 0.25, 2, 0.045), trim, 0, 1.34, 1.40), -0.20, 0, 0);
  const seat = standard({ color: '#605d51', roughness: 0.91 });
  const instrument = standard({ color: '#25362f', roughness: 0.62, emissive: '#283b2c', emissiveIntensity: 0.34 });
  for (const sign of [-1, 1]) {
    const side = (turn: number) => sign * turn;
    seam(21 / 40, side(arch), 39 / 40, side(arch), 0.020);
    seam(21 / 40, side(8 / 64), 29 / 40, side(13 / 64), 0.014);
    for (const t of [12 / 40, 20 / 40]) seam(t, side(7 / 64), t, side(arch), 0.016);
    for (const a of [7 / 64, arch]) seam(12 / 40, side(a), 20 / 40, side(a), 0.016);
    const door = petal(0.39, side(0.299), 0.013);
    part(visualRoot, roundedBox(0.035, 0.035, 0.14, 2, 0.013), steel, door.x, door.y, door.z);
    part(visualRoot, roundedBox(0.36, 0.16, 0.37, 2, 0.045), seat, sign * 0.33, 1.19, 0.68);
    setLocalEulerRad(part(visualRoot, roundedBox(0.37, 0.52, 0.13, 2, 0.047), seat, sign * 0.33, 1.45, 0.40), -0.12, 0, 0);
    part(visualRoot, roundedBox(0.23, 0.17, 0.13, 2, 0.034), seat, sign * 0.33, 1.75, 0.37);
    for (let i = 0; i < 4; i++) part(visualRoot, box(0.036, 0.025, 0.015), instrument, sign * (0.06 + i * 0.051), 1.44, 1.263);
    const rivet = sphere(0.008, 6, 4);
    for (let i = 0; i < 20; i++) {
      const p = petal(0.20 + i * 0.032, side(0.305), 0.006);
      part(visualRoot, rivet, marking, p.x, p.y, p.z);
    }
  }
  part(visualRoot, roundedBox(0.18, 0.12, 0.24, 2, 0.037), trim, 0, 1.08, 1.83);
  ball(standard({ color: '#83908f', metalness: 0.75, roughness: 0.21 }), 0, 1.07, 1.95, 0.057, 0.045, 0.026);
  // Redesigned turbine deck: a restrained fairing, twin intake lips and cooling slats.
  part(visualRoot, roundedBox(0.70, 0.28, 1.18, 3, 0.09), paint, 0, 2.15, -0.57);
  part(visualRoot, roundedBox(0.46, 0.16, 0.60, 2, 0.055), trim, 0, 2.30, -0.62);
  const intake = standard({ color: '#111916', roughness: 0.90, metalness: 0.05 });
  for (const sx of [-1, 1]) {
    setLocalEulerRad(part(visualRoot, cylinder(0.115, 0.14, 0.20, 18, 1, true), steel, sx * 0.225, 2.20, -0.04), Math.PI / 2, 0, 0);
    part(visualRoot, circle(0.108, 18), intake, sx * 0.225, 2.20, 0.066);
    span(visualRoot, steel, [sx * 0.80, 0.64, 0.30], [sx * 0.80, 0.64, 0.91], 0.026);
    span(visualRoot, steel, [sx * 0.62, 0.86, 0.36], [sx * 0.80, 0.65, 0.36], 0.025);
    for (let j = 0; j < 3; j++) span(visualRoot, steel, [sx * 0.80, 0.64, 0.42 + j * 0.20], [sx * 0.89, 0.64, 0.42 + j * 0.20], 0.017);
  }
  for (let i = 0; i < 7; i++) part(visualRoot, box(0.42, 0.016, 0.025), steel, 0, 2.392, -0.86 + i * 0.075);
  part(visualRoot, cylinder(0.07, 0.09, 0.17, 14), steel, 0, 0.96, 1.64);
  ball(trim, 0, 0.86, 1.65, 0.15, 0.13, 0.16);
  ball(glass, 0, 0.85, 1.79, 0.065, 0.058, 0.025);
  span(visualRoot, paint, [0, 1.47, -0.82], [0, 1.91, -3.92], 0.29, 0.105);
  span(visualRoot, trim, [0, 1.554, -1.39], [0, 1.56, -1.43], 0.265, 0.256);
  span(visualRoot, paint, [0, 1.852, -3.52], [0, 1.917, -3.97], 0.133, 0.107);
  for (const [z, y, r] of [[-1.72, 1.59, 0.235], [-2.45, 1.70, 0.181], [-3.17, 1.81, 0.139]] as const) {
    setLocalEulerRad(part(visualRoot, torus(r, 0.012, 6, 18), steel, 0, y, z), Math.PI / 2, 0, 0);
  }
  const fin = plate([[-0.23, -0.30], [-0.28, 0.02], [-0.18, 0.66], [0.035, 0.66],
    [0.28, 0.02], [0.12, -0.25]], 0.045, 0.014).rotateY(-Math.PI / 2);
  part(visualRoot, fin, paint, 0, 1.94, -3.81);
  const stabilizer = plate([[-0.76, 0.04], [-0.73, 0.22], [0.73, 0.22], [0.76, 0.04],
    [0.55, -0.20], [-0.55, -0.20]], 0.036, 0.014).rotateX(Math.PI / 2);
  part(visualRoot, stabilizer, paint, 0, 1.96, -3.19);
  const exhaust = cylinder(0.103, 0.133, 0.29, 18, 1, true);
  setLocalEulerRad(part(visualRoot, exhaust, steel, -0.34, 1.73, -1.27), -1.28, 0, -0.25);
  setLocalEulerRad(part(visualRoot, circle(0.098, 18), trim, -0.36, 1.77, -1.395), 0, Math.PI, 0);
  for (const sign of [-1, 1]) {
    const x = sign * 0.86;
    span(visualRoot, steel, [x, 0.064, -1.02], [x, 0.064, 1.16], 0.064);
    span(visualRoot, steel, [x, 0.064, 1.16], [x, 0.28, 1.45], 0.056);
    for (const z of [-0.7, 0.78]) span(visualRoot, steel, [sign * 0.48, 0.81, z], [x, 0.095, z], 0.045);
    for (const z of [-0.7, 0.78]) span(visualRoot, trim, [x, 0.065, z - 0.12], [x, 0.065, z + 0.12], 0.068);
    for (let i = 0; i < 5; i++) part(visualRoot, box(0.07, 0.033, 0.16), trim, sign * 0.555, 2.09 + 0.036 * i, -0.54 - 0.052 * i);
    part(visualRoot, roundedBox(0.25, 0.34, 0.77, 2, 0.065), paint, sign * 0.75, 1.49, -0.71);
    part(visualRoot, box(0.013, 0.037, 0.23), marking, sign * 0.88, 1.52, -0.71);
    span(visualRoot, steel, [sign * 0.52, 1.07, -0.32], [sign * 1.62, 1.04, -0.37], 0.043);
    const nav = standard({ color: '#181f1c', emissive: sign > 0 ? '#c62820' : '#31b160', emissiveIntensity: 1.5 });
    ball(nav, sign * 1.62, 1.04, -0.37, 0.052, 0.04, 0.06);
  }
  const mainRotor = group('littlebird_main_rotor', visualRoot), tailRotor = group('littlebird_tail_rotor', visualRoot);
  mainRotor.setLocalPosition(0, 2.69, -0.24); tailRotor.setLocalPosition(0.19, 1.99, -3.87);
  span(visualRoot, steel, [0, 2.25, -0.24], [0, 2.69, -0.24], 0.075);
  part(mainRotor, cylinder(0.18, 0.205, 0.08, 20), steel, 0, 0.03);
  part(mainRotor, cylinder(0.094, 0.125, 0.09, 16), trim, 0, 0.102);
  part(visualRoot, cylinder(0.135, 0.28, 0.19, 24), paint, 0, 2.40, -0.24);
  for (let i = 0; i < 5; i++) {
    const arm = group(`main_rotor_arm_${i}`, mainRotor);
    setLocalEulerRad(arm, 0, i * Math.PI * 0.4, 0);
    span(arm, steel, [0.075, -0.13, 0.11], [0.075, 0.024, 0.31], 0.016);
    span(arm, steel, [0, 0.02, 0.12], [0, 0, 0.42], 0.047, 0.033);
    setLocalEulerRad(part(arm, mainBlade, trim), 0, 0, 0.055);
    setLocalEulerRad(part(arm, box(0.14, 0.017, 0.083), marking, -0.012, 0.006, 3.64), 0, 0, 0.055);
  }
  setLocalEulerRad(part(tailRotor, cylinder(0.078, 0.094, 0.11, 14), steel), 0, 0, Math.PI / 2);
  for (let i = 0; i < 4; i++) setLocalEulerRad(part(tailRotor, tailBlade, trim), i * Math.PI / 2, 0, 0);
  userData(mainRotor).noStaticMerge = userData(tailRotor).noStaticMerge = true;
  userData(mainRotor).noDamageBounds = userData(tailRotor).noDamageBounds = true;

  const turretPivot = group('littlebird_turret', visualRoot), turretRestPos = new Vec3(0, 1.05, 0.63);
  turretPivot.setLocalPosition(turretRestPos);
  const gunPivot = group('littlebird_gun', turretPivot), gunRecoilGroup = group('littlebird_recoil', gunPivot);
  const muzzleNode = group('muzzle_datum', gunRecoilGroup), coaxNode = group('coax_datum', gunRecoilGroup);
  coaxNode.setLocalPosition(-1.13, 0, 0.52); muzzleNode.setLocalPosition(1.16, 0, 0.62);
  part(gunRecoilGroup, roundedBox(0.21, 0.19, 0.54, 2, 0.035), steel, -1.13, 0, -0.04);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3, x = -1.13 + 0.049 * Math.cos(a), y = 0.049 * Math.sin(a);
    span(gunRecoilGroup, steel, [x, y, 0.14], [x, y, 0.51], 0.014);
  }
  setLocalEulerRad(part(gunRecoilGroup, cylinder(0.235, 0.225, 0.92, 16), paint, 1.16, 0, 0.21), Math.PI / 2, 0, 0);
  part(gunRecoilGroup, circle(0.213, 24), trim, 1.16, 0, 0.675).name = 'missile_pod_aperture';
  part(gunRecoilGroup, torus(0.221, 0.014, 8, 24), steel, 1.16, 0, 0.681);
  const aperture = standard({ color: '#090d0b', roughness: 0.98 });
  const holes: [number, number][] = [[0, 0]];
  for (let i = 0; i < 6; i++) holes.push([Math.cos(i * Math.PI / 3) * 0.125, Math.sin(i * Math.PI / 3) * 0.125]);
  for (const [hx, hy] of holes) {
    part(gunRecoilGroup, torus(0.047, 0.007, 6, 14), steel, 1.16 + hx, hy, 0.686);
    part(gunRecoilGroup, circle(0.040, 14), aperture, 1.16 + hx, hy, 0.688);
  }
  part(gunRecoilGroup, roundedBox(0.12, 0.30, 0.38, 2, 0.025), trim, 1.16, 0.27, 0.12);
  let mainAngle = 0, tailAngle = 0;
  return {
    root, hullTiltGroup, visualRoot, turretPivot, turretRestPos, gunPivot, gunRecoilGroup, muzzleNode, coaxNode,
    rwsNode: null, wheels: [], steerNodes: [], rocketMeshes: [], hullMeshes,
    spinRotors(dt) {
      mainAngle += 35 * dt; tailAngle += 79 * dt;
      setLocalEulerRad(mainRotor, 0, mainAngle, 0);
      setLocalEulerRad(tailRotor, tailAngle, 0, 0);
    },
  };
}
