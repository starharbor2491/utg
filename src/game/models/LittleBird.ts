import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { applyRealisticArmorShader } from '../AssetLoader';
import type { InstantiatedTankRig } from '../AssetLoader';
import type { Team } from '../types';

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
  top: new THREE.Vector3(w, cy + u, z),
  mid: new THREE.Vector3(w, cy, z),
  bottom: new THREE.Vector3(w, cy - l, z),
}));
const top = new THREE.CatmullRomCurve3(POINTS.map((p) => p.top), false, 'catmullrom', 0.43);
const mid = new THREE.CatmullRomCurve3(POINTS.map((p) => p.mid), false, 'catmullrom', 0.43);
const bottom = new THREE.CatmullRomCurve3(POINTS.map((p) => p.bottom), false, 'catmullrom', 0.43);
const tSample = new THREE.Vector3(), mSample = new THREE.Vector3(), bSample = new THREE.Vector3();
const petal = (t: number, turn: number, offset = 0) => {
  top.getPoint(t, tSample);
  mid.getPoint(t, mSample);
  bottom.getPoint(t, bSample);
  const angle = turn * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
  const y = mSample.y + c * ((c > 0 ? tSample.y - mSample.y : mSample.y - bSample.y) + offset);
  return new THREE.Vector3(s * (mSample.x + offset), y, mSample.z);
};

function skinGeometry(): THREE.BufferGeometry {
  const steps = 40, radial = 64, positions: number[] = [], normals: number[] = [], solid: number[] = [], panes: number[] = [];
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= radial; j++) {
      const t = i / steps, a = j / radial;
      positions.push(...petal(t, a).toArray());
      const along = petal(Math.min(1, t + 0.0004), a).sub(petal(Math.max(0, t - 0.0004), a));
      const around = petal(t, a + 0.0004).sub(petal(t, a - 0.0004));
      normals.push(...along.cross(around).normalize().toArray());
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
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(solid.concat(panes));
  geo.addGroup(0, solid.length, 0);
  geo.addGroup(solid.length, panes.length, 1);
  return geo;
}

export function buildLittleBirdRig(team: Team): InstantiatedTankRig {
  const root = new THREE.Group();
  root.name = `little_bird_${team}`;
  const hullTiltGroup = new THREE.Group();
  root.add(hullTiltGroup);
  const visualRoot = new THREE.Group();
  hullTiltGroup.add(visualRoot);
  const hullMeshes: THREE.Mesh[] = [];
  const paint = new THREE.MeshPhysicalMaterial({ color: '#3b4139', roughness: 0.58, metalness: 0.31, clearcoat: 0.23, clearcoatRoughness: 0.52 });
  applyRealisticArmorShader(paint, 'littlebird-oxidized-skin', { grain: 0.43, heightRef: 1.5 });
  const trim = new THREE.MeshStandardMaterial({ color: '#1e2622', roughness: 0.74, metalness: 0.32 });
  const steel = new THREE.MeshStandardMaterial({ color: '#353f40', roughness: 0.44, metalness: 0.71 });
  const glass = new THREE.MeshPhysicalMaterial({ color: '#314851', roughness: 0.17, metalness: 0.16,
    transparent: true, opacity: 0.48, depthWrite: false, clearcoat: 1, clearcoatRoughness: 0.14, envMapIntensity: 1.28 });
  const marking = new THREE.MeshStandardMaterial({ color: '#a1a99b', roughness: 0.69 });
  const part = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = parent === visualRoot;
    mesh.receiveShadow = true;
    parent.add(mesh);
    hullMeshes.push(mesh);
    return mesh;
  };
  const ball = (mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number) => {
    const m = part(visualRoot, new THREE.SphereGeometry(1, 24, 14), mat, x, y, z);
    m.scale.set(w, h, d);
    return m;
  };
  const span = (parent: THREE.Object3D, mat: THREE.Material, a: number[], b: number[], r: number, tip = r) => {
    const start = new THREE.Vector3().fromArray(a), end = new THREE.Vector3().fromArray(b);
    const direction = end.clone().sub(start);
    const m = part(parent, new THREE.CylinderGeometry(tip, r, direction.length(), 10), mat);
    m.position.copy(start).lerp(end, 0.5);
    m.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, direction.normalize());
    return m;
  };
  const skin = part(visualRoot, skinGeometry(), [paint, glass]);
  skin.name = 'littlebird_sectioned_airframe';
  const seam = (t1: number, a1: number, t2: number, a2: number, r = 0.016, mat = trim) => {
    const points = Array.from({ length: 21 }, (_, i) => petal(THREE.MathUtils.lerp(t1, t2, i / 20), THREE.MathUtils.lerp(a1, a2, i / 20), 0.005));
    part(visualRoot, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 25, r, 5, false), mat);
  };
  const arch = 17 / 64;
  seam(21 / 40, -arch, 21 / 40, arch, 0.021);
  seam(39 / 40, -arch, 39 / 40, arch, 0.014);
  seam(21 / 40, 0, 39 / 40, 0, 0.019);
  seam(10 / 40, 0.30, 10 / 40, 0.70, 0.007);
  seam(26 / 40, 0.28, 26 / 40, 0.72, 0.007);
  part(visualRoot, new RoundedBoxGeometry(0.96, 0.09, 1.16, 2, 0.025), trim, 0, 1.07, 0.61);
  part(visualRoot, new RoundedBoxGeometry(0.46, 0.33, 0.25, 2, 0.045), trim, 0, 1.34, 1.40).rotation.x = -0.20;
  const seat = new THREE.MeshStandardMaterial({ color: '#605d51', roughness: 0.91 });
  const instrument = new THREE.MeshStandardMaterial({ color: '#25362f', roughness: 0.62, emissive: '#283b2c', emissiveIntensity: 0.34 });
  for (const sign of [-1, 1]) {
    const side = (turn: number) => sign * turn;
    seam(21 / 40, side(arch), 39 / 40, side(arch), 0.020);
    seam(21 / 40, side(8 / 64), 29 / 40, side(13 / 64), 0.014);
    for (const t of [12 / 40, 20 / 40]) seam(t, side(7 / 64), t, side(arch), 0.016);
    for (const a of [7 / 64, arch]) seam(12 / 40, side(a), 20 / 40, side(a), 0.016);
    const door = petal(0.39, side(0.299), 0.013);
    part(visualRoot, new RoundedBoxGeometry(0.035, 0.035, 0.14, 2, 0.013), steel, door.x, door.y, door.z);
    part(visualRoot, new RoundedBoxGeometry(0.36, 0.16, 0.37, 2, 0.045), seat, sign * 0.33, 1.19, 0.68);
    part(visualRoot, new RoundedBoxGeometry(0.37, 0.52, 0.13, 2, 0.047), seat, sign * 0.33, 1.45, 0.40).rotation.x = -0.12;
    part(visualRoot, new RoundedBoxGeometry(0.23, 0.17, 0.13, 2, 0.034), seat, sign * 0.33, 1.75, 0.37);
    for (let i = 0; i < 4; i++) part(visualRoot, new THREE.BoxGeometry(0.036, 0.025, 0.015), instrument, sign * (0.06 + i * 0.051), 1.44, 1.263);
    const rivet = new THREE.SphereGeometry(0.008, 6, 4);
    for (let i = 0; i < 20; i++) {
      const p = petal(0.20 + i * 0.032, side(0.305), 0.006);
      part(visualRoot, rivet, marking, p.x, p.y, p.z);
    }
  }
  part(visualRoot, new RoundedBoxGeometry(0.18, 0.12, 0.24, 2, 0.037), trim, 0, 1.08, 1.83);
  ball(new THREE.MeshStandardMaterial({ color: '#83908f', metalness: 0.75, roughness: 0.21 }), 0, 1.07, 1.95, 0.057, 0.045, 0.026);
  span(visualRoot, paint, [0, 1.47, -0.82], [0, 1.91, -3.92], 0.29, 0.105);
  part(visualRoot, new RoundedBoxGeometry(0.095, 0.73, 0.37, 2, 0.04), paint, 0, 2.12, -3.77).rotation.x = -0.27;
  part(visualRoot, new RoundedBoxGeometry(1.32, 0.09, 0.47, 2, 0.035), paint, 0, 1.96, -3.19);
  for (const sign of [-1, 1]) {
    const x = sign * 0.86;
    span(visualRoot, steel, [x, 0.064, -1.02], [x, 0.064, 1.16], 0.064);
    span(visualRoot, steel, [x, 0.064, 1.16], [x, 0.28, 1.45], 0.056);
    for (const z of [-0.7, 0.78]) span(visualRoot, steel, [sign * 0.48, 0.81, z], [x, 0.095, z], 0.045);
    for (let i = 0; i < 5; i++) {
      part(visualRoot, new THREE.BoxGeometry(0.07, 0.033, 0.16), trim, sign * 0.555, 2.09 + 0.036 * i, -0.54 - 0.052 * i);
    }
    part(visualRoot, new RoundedBoxGeometry(0.25, 0.34, 0.77, 2, 0.065), paint, sign * 0.75, 1.49, -0.71);
    part(visualRoot, new THREE.BoxGeometry(0.013, 0.037, 0.23), marking, sign * 0.88, 1.52, -0.71);
    span(visualRoot, steel, [sign * 0.52, 1.07, -0.32], [sign * 1.62, 1.04, -0.37], 0.043);
    const nav = new THREE.MeshStandardMaterial({ color: '#181f1c', emissive: sign > 0 ? '#c62820' : '#31b160', emissiveIntensity: 1.5 });
    ball(nav, sign * 1.62, 1.04, -0.37, 0.052, 0.04, 0.06);
  }
  const mainRotor = new THREE.Group();
  const tailRotor = new THREE.Group();
  mainRotor.name = 'littlebird_main_rotor';
  tailRotor.name = 'littlebird_tail_rotor';
  mainRotor.position.set(0, 2.69, -0.24);
  tailRotor.position.set(0.19, 1.99, -3.87);
  visualRoot.add(mainRotor, tailRotor);
  span(visualRoot, steel, [0, 2.25, -0.24], [0, 2.69, -0.24], 0.075);
  part(mainRotor, new THREE.CylinderGeometry(0.14, 0.16, 0.10, 12), steel);
  part(visualRoot, new THREE.CylinderGeometry(0.21, 0.30, 0.15, 20), paint, 0, 2.38, -0.24);
  for (let i = 0; i < 5; i++) {
    const arm = new THREE.Group();
    arm.rotation.y = i * Math.PI * 0.4;
    mainRotor.add(arm);
    span(arm, steel, [0, -.047, .065], [0, .007, .36], .032, .024);
    const airfoil = new THREE.Shape();
    airfoil.moveTo(-0.11, 0.43); airfoil.lineTo(-0.105, 3.59); airfoil.quadraticCurveTo(-0.06, 3.77, 0.04, 3.76);
    airfoil.lineTo(0.108, 3.62); airfoil.lineTo(0.103, 0.43); airfoil.closePath();
    const bladeGeo = new THREE.ExtrudeGeometry(airfoil, { depth: 0.021, bevelEnabled: false });
    bladeGeo.rotateX(Math.PI / 2);
    const blade = part(arm, bladeGeo, trim);
    blade.rotation.y = -0.024;
    part(arm, new THREE.BoxGeometry(0.17, 0.028, 0.095), marking, -0.035, 0, 3.65);
  }
  part(tailRotor, new THREE.BoxGeometry(0.024, 0.095, 1.11), trim);
  part(tailRotor, new THREE.BoxGeometry(0.024, 1.11, 0.095), trim);
  mainRotor.userData.noStaticMerge = tailRotor.userData.noStaticMerge = true;
  mainRotor.userData.noDamageBounds = tailRotor.userData.noDamageBounds = true;

  const turretPivot = new THREE.Group();
  const turretRestPos = new THREE.Vector3(0, 1.05, 0.63);
  turretPivot.position.copy(turretRestPos);
  visualRoot.add(turretPivot);
  const gunPivot = new THREE.Group(), gunRecoilGroup = new THREE.Group();
  turretPivot.add(gunPivot);
  gunPivot.add(gunRecoilGroup);
  const muzzleNode = new THREE.Object3D(), coaxNode = new THREE.Object3D();
  coaxNode.position.set(-1.13, 0, 0.52);
  muzzleNode.position.set(1.16, 0, 0.62);
  gunRecoilGroup.add(muzzleNode, coaxNode);
  part(gunRecoilGroup, new RoundedBoxGeometry(0.21, 0.19, 0.54, 2, 0.035), steel, -1.13, 0, -0.04);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    const x = -1.13 + 0.049 * Math.cos(a), y = 0.049 * Math.sin(a);
    span(gunRecoilGroup, steel, [x, y, 0.14], [x, y, 0.51], 0.014);
  }
  const tube = part(gunRecoilGroup, new THREE.CylinderGeometry(0.19, 0.18, 0.84, 10), paint, 1.16, 0, 0.17);
  tube.rotation.x = Math.PI / 2;
  const port = part(gunRecoilGroup, new THREE.CircleGeometry(0.162, 10), trim, 1.16, 0, 0.592);
  port.name = 'missile_pod_aperture';
  for (const x of [-0.066, 0.066]) {
    part(gunRecoilGroup, new THREE.TorusGeometry(0.052, 0.009, 6, 12), steel, 1.16 + x, 0, 0.597);
    part(gunRecoilGroup, new THREE.CircleGeometry(0.044, 12), new THREE.MeshStandardMaterial({ color: '#11150f', roughness: 0.96 }), 1.16 + x, 0, 0.599);
  }
  return {
    root, hullTiltGroup, visualRoot, turretPivot, turretRestPos, gunPivot, gunRecoilGroup, muzzleNode, coaxNode,
    rwsNode: null, wheels: [], steerNodes: [], rocketMeshes: [], hullMeshes,
    spinRotors(dt) { mainRotor.rotation.y += 35 * dt; tailRotor.rotation.x += 79 * dt; },
  };
}
