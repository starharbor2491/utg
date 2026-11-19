import type { Entity, StandardMaterial } from 'playcanvas';
import { applyRealisticArmorShader } from '../engine/materials';
import type { InstantiatedTankRig, WheelNodeBinding } from '../AssetLoader';
import type { Team } from '../types';
import {
  applyMat4, composeMat, degToRad, Mat4, Quat, quatFromEuler, quatFromUnitVectors,
  setLocalEulerRad, Vec2, Vec3,
} from '../engine/math';
import { cone, cylinder, extrude, Geo, lathe, Path, roundedBox, Shape, sphere, torus } from '../engine/geometry';
import { standard } from '../engine/materials';
import type { StandardOptions } from '../engine/materials';
import { group, meshNode } from '../engine/scene';
import { GeoBucket } from './GeoBucket';
import { applySurfaceFinish } from './SurfaceFinish';

const DIMS = {
  length: 7.0, width: 2.4, wheelRadius: 0.57, wheelWidth: 0.36, trackX: 1.02, axleZ: [2.3, -0.9, -2.3],
  frameY: 0.86, deckTopY: 1.38, deckHalfW: 0.72, deckZFront: 1.9, deckZRear: -3.45,
  cabZFront: 3.45, cabZRear: 1.75, cabFloorY: 1.15, cabRoofY: 2.36,
  turretY: 1.38, turretZ: -1.6, gunPivotY: 1.06, gunPivotZ: 0.7,
  podLength: 3.3, podFrontZ: 3.25, podW: 0.95, podH: 0.72, tubeR: 0.135,
} as const;

function mat(color: string | number, roughness: number, metalness: number, extra: Partial<StandardOptions> = {}): StandardMaterial {
  return standard({ color, roughness, metalness, envIntensity: 1, ...extra });
}

export interface RocketChassisParts {
  root: Entity;
  hullTiltGroup: Entity;
  visualRoot: Entity;
  wheels: WheelNodeBinding[];
  steerNodes: Entity[];
  hullMeshes: Entity[];
  mats: Record<string, StandardMaterial>;
}

/** Shared 6x6 chassis for the rocket launcher and Drone Carrier. */
export function buildRocketChassis(team: Team): RocketChassisParts {
  const isBlue = team === 'blue';
  const root = group(`rocket_${team}`);
  const hullTiltGroup = group('hull_tilt_group', root);
  const paintMat = mat(isBlue ? '#4a5238' : '#6b5d43', 0.6, 0.28, { envIntensity: 1.05 });
  applyRealisticArmorShader(paintMat, 'rocket-paint', { grain: 0.5 });
  const paintDarkMat = mat(isBlue ? '#3a412c' : '#57492f', 0.66, 0.24);
  applyRealisticArmorShader(paintDarkMat, 'rocket-paint-dark', { grain: 0.5 });
  const steelMat = mat('#2c2f2c', 0.45, 0.72, { envIntensity: 1.15 });
  applyRealisticArmorShader(steelMat, 'rocket-steel', { grain: 0.5 });
  const darkSteelMat = mat('#1c1e1c', 0.55, 0.6);
  applyRealisticArmorShader(darkSteelMat, 'rocket-dark-steel', { grain: 0.5 });
  const rubberMat = mat('#17181a', 0.94, 0.02);
  applyRealisticArmorShader(rubberMat, 'rocket-rubber', { grain: 0.5 });
  const glassMat = mat('#1a292c', 0.22, 0.64, { envIntensity: 1.2 });
  applySurfaceFinish(glassMat, 'glass');
  const lensMat = mat('#d8cf9a', 0.3, 0.4, { emissive: '#8a7a3a', emissiveIntensity: 0.55 });
  const tailLens = mat('#6b2821', 0.32, 0.12, { emissive: '#5d1813', emissiveIntensity: 0.4 });
  const mkMod = (color: string, rough: number, metal: number, heightRef: number, tag: string) => {
    const m = mat(color, rough, metal);
    applyRealisticArmorShader(m, tag, { grain: 0.5, heightRef });
    return m;
  };
  const modPaintT = mkMod(isBlue ? '#4a5238' : '#6b5d43', 0.6, 0.28, 1.9, 'rocket-mod-paint-t');
  const modDarkT = mkMod(isBlue ? '#333a26' : '#4c3f2a', 0.66, 0.24, 1.9, 'rocket-mod-dark-t');
  const modSteelT = mkMod('#2c2f2c', 0.45, 0.72, 1.9, 'rocket-mod-steel-t');
  const modPaintP = mkMod(isBlue ? '#4a5238' : '#6b5d43', 0.6, 0.28, 2.7, 'rocket-mod-paint-p');
  const modDarkP = mkMod(isBlue ? '#333a26' : '#4c3f2a', 0.66, 0.24, 2.7, 'rocket-mod-dark-p');
  const modSteelP = mkMod('#2c2f2c', 0.45, 0.72, 2.7, 'rocket-mod-steel-p');
  const rocketMat = mat(isBlue ? '#5a6142' : '#77684a', 0.5, 0.4);
  applyRealisticArmorShader(rocketMat, 'rocket-body', { grain: 0.5, heightRef: 2.7 });
  const wheelMat = standard({ vertexColors: true, roughness: 0.62, metalness: 0.38, envIntensity: 0.9 });
  applySurfaceFinish(wheelMat, 'wheel');
  const hullMeshes: Entity[] = [], b = new GeoBucket();
  const visualRoot = group('rocket_visual');

  const railZ0 = DIMS.deckZRear - 0.15, railZ1 = 3.3, railLen = railZ1 - railZ0, railZc = (railZ0 + railZ1) / 2;
  b.box(steelMat, 0.14, 0.3, railLen, -0.6, DIMS.frameY, railZc);
  b.box(steelMat, 0.14, 0.3, railLen, 0.6, DIMS.frameY, railZc);
  for (const cz of [-3.2, -2.2, -1.2, -0.2, 0.9, 1.8, 2.7]) b.box(darkSteelMat, 1.34, 0.1, 0.14, 0, DIMS.frameY + 0.02, cz);
  const deckZc = (DIMS.deckZFront + DIMS.deckZRear) / 2, deckLen = DIMS.deckZFront - DIMS.deckZRear;
  b.rbox(steelMat, DIMS.deckHalfW * 2, 0.08, deckLen, 0.02, 0, DIMS.deckTopY - 0.04, deckZc);
  b.box(darkSteelMat, DIMS.deckHalfW * 2 + 0.04, 0.1, 0.06, 0, DIMS.deckTopY - 0.02, DIMS.deckZFront - 0.02);
  b.box(darkSteelMat, DIMS.deckHalfW * 2 + 0.04, 0.1, 0.06, 0, DIMS.deckTopY - 0.02, DIMS.deckZRear + 0.02);
  b.box(darkSteelMat, 0.06, 0.1, deckLen, -DIMS.deckHalfW - 0.01, DIMS.deckTopY - 0.02, deckZc);
  b.box(darkSteelMat, 0.06, 0.1, deckLen, DIMS.deckHalfW + 0.01, DIMS.deckTopY - 0.02, deckZc);
  for (const sz of [-2.9, -1.9, -0.9, 0.4]) b.box(darkSteelMat, DIMS.deckHalfW * 2 - 0.1, 0.012, 0.035, 0, DIMS.deckTopY + 0.002, sz);
  b.box(darkSteelMat, 0.035, 0.012, deckLen - 0.2, 0, DIMS.deckTopY + 0.002, deckZc);
  for (const sx of [-1, 1]) for (const z of [-3.05, -2.05, -1.05, 0.05, 1.05]) {
    b.put(steelMat, torus(0.043, 0.009, 6, 10), sx * 0.65, DIMS.deckTopY + 0.018, z, Math.PI / 2);
    b.box(darkSteelMat, 0.10, 0.015, 0.06, sx * 0.65, DIMS.deckTopY + 0.006, z);
  }
  b.cyl(darkSteelMat, 0.26, 0.26, 1.5, 14, 0, 0.78, -0.6, 0, 0, Math.PI / 2);
  for (const bx of [-0.5, 0.5]) b.box(steelMat, 0.08, 0.3, 0.5, bx, 0.72, -0.6);
  b.cyl(darkSteelMat, 0.09, 0.09, 1.2, 8, 0, 0.55, 0.85, 1.4);
  b.rbox(steelMat, 0.5, 0.4, 0.6, 0.04, 0.45, 0.92, -1.9);
  b.rbox(paintDarkMat, 0.4, 0.36, 1.15, 0.04, -0.42, DIMS.deckTopY + 0.18, -0.5);
  b.rbox(paintDarkMat, 0.4, 0.36, 1.15, 0.04, 0.42, DIMS.deckTopY + 0.18, -0.5);
  for (const sx of [-1, 1]) {
    b.box(darkSteelMat, 0.02, 0.3, 1.0, sx * 0.625, DIMS.deckTopY + 0.18, -0.5);
    b.box(steelMat, 0.03, 0.05, 0.16, sx * 0.64, DIMS.deckTopY + 0.22, -0.15);
  }
  b.cyl(steelMat, 0.14, 0.14, 0.62, 12, -0.55, DIMS.deckTopY + 0.33, -2.7);
  b.cyl(darkSteelMat, 0.17, 0.17, 0.06, 12, -0.55, DIMS.deckTopY + 0.66, -2.7);
  b.rbox(paintDarkMat, 1.3, 0.4, 0.55, 0.04, 0, DIMS.deckTopY + 0.2, -3.15);
  b.cyl(steelMat, 0.07, 0.07, 1.6, 10, 0.82, 1.9, 1.5);
  b.cyl(darkSteelMat, 0.11, 0.11, 0.3, 10, 0.82, 2.6, 1.5);
  b.box(darkSteelMat, 0.34, 0.9, 0.04, 0.82, 1.7, 1.42, 0.1);
  b.rbox(darkSteelMat, 1.7, 0.42, 1.5, 0.05, 0, 0.82, 2.55);

  const cabShape = new Shape();
  cabShape.moveTo(DIMS.cabZRear, DIMS.cabFloorY).lineTo(DIMS.cabZFront - 0.04, DIMS.cabFloorY)
    .lineTo(DIMS.cabZFront, DIMS.cabFloorY + 0.42).lineTo(DIMS.cabZFront - 0.17, DIMS.cabRoofY - 0.09)
    .lineTo(DIMS.cabZRear + 0.1, DIMS.cabRoofY - 0.06).lineTo(DIMS.cabZRear, DIMS.cabFloorY + 0.5).closePath();
  b.put(paintMat, extrude(cabShape, { depth: 1.98, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, steps: 1 })
    .rotateY(-Math.PI / 2).translate(0.99, 0, 0));
  for (const sx of [-1, 1]) b.box(paintDarkMat, 0.08, 0.5, 1.6, sx * 0.92, 0.92, 2.55);
  const roofY = DIMS.cabRoofY;
  b.box(paintDarkMat, 2.0, 0.05, 0.07, 0, roofY + 0.03, DIMS.cabZRear + 0.12);
  b.box(paintDarkMat, 2.0, 0.05, 0.07, 0, roofY + 0.03, DIMS.cabZFront - 0.62);
  b.box(paintDarkMat, 0.07, 0.05, 1.6, -0.97, roofY + 0.03, (DIMS.cabZRear + 0.12 + DIMS.cabZFront - 0.62) / 2);
  b.box(paintDarkMat, 0.07, 0.05, 1.6, 0.97, roofY + 0.03, (DIMS.cabZRear + 0.12 + DIMS.cabZFront - 0.62) / 2);
  b.rbox(paintDarkMat, 1.96, 0.05, 0.28, 0.015, 0, roofY - 0.03, 3.31, -0.12);
  b.rbox(paintDarkMat, 0.72, 0.09, 0.62, 0.03, -0.25, roofY + 0.07, 2.15);
  b.box(darkSteelMat, 0.26, 0.12, 0.14, -0.42, roofY + 0.12, 2.75);
  b.box(darkSteelMat, 0.26, 0.12, 0.14, 0.42, roofY + 0.12, 2.75);
  b.box(darkSteelMat, 0.05, 0.16, 0.05, -0.42, roofY + 0.2, 2.75);
  b.box(darkSteelMat, 0.05, 0.16, 0.05, 0.42, roofY + 0.2, 2.75);
  b.cyl(steelMat, 0.008, 0.012, 1.5, 6, -0.7, roofY + 0.8, 1.95);
  b.cyl(darkSteelMat, 0.05, 0.07, 0.1, 8, -0.7, roofY + 0.05, 1.95);
  const rake = -Math.atan2(0.17, roofY - 0.09 - (DIMS.cabFloorY + 0.42));
  for (const x of [-0.46, 0.46]) {
    b.rbox(darkSteelMat, 0.91, 0.56, 0.034, 0.014, x, 1.99, 3.414, rake);
    b.rbox(glassMat, 0.85, 0.50, 0.024, 0.01, x, 1.993, 3.433, rake);
    b.box(darkSteelMat, 0.019, 0.26, 0.02, x, 1.88, 3.476, rake, 0, -0.63);
    b.box(darkSteelMat, 0.018, 0.29, 0.021, x + 0.10, 1.96, 3.457, rake, 0, -1.05);
  }
  for (const sx of [-1, 1]) {
    b.rbox(darkSteelMat, 0.025, 0.50, 0.99, 0.011, sx * 1.041, 1.98, 2.62);
    b.rbox(glassMat, 0.020, 0.43, 0.91, 0.008, sx * 1.057, 1.98, 2.62);
    b.box(paintDarkMat, 0.028, 0.47, 0.032, sx * 1.067, 1.98, 2.76);
    b.box(darkSteelMat, 0.015, 0.7, 0.02, sx * 1.03, 1.55, 2.05);
    b.box(darkSteelMat, 0.015, 0.7, 0.02, sx * 1.03, 1.55, 3.05);
    b.box(steelMat, 0.04, 0.07, 0.18, sx * 1.04, 1.62, 2.62);
    b.cyl(darkSteelMat, 0.025, 0.025, 0.16, 8, sx * 1.02, 1.85, 2.0, 0, 0, Math.PI / 2);
    b.cyl(darkSteelMat, 0.025, 0.025, 0.16, 8, sx * 1.02, 1.85, 3.2, 0, 0, Math.PI / 2);
    b.put(steelMat, torus(0.05, 0.012, 6, 10, Math.PI), sx * 1.06, 1.5, 2.3, 0, sx * Math.PI / 2);
  }
  b.rbox(darkSteelMat, 1.21, 0.45, 0.035, 0.014, 0, 1.95, DIMS.cabZRear - 0.035, -0.15);
  b.rbox(glassMat, 1.13, 0.38, 0.022, 0.009, 0, 1.95, DIMS.cabZRear - 0.052, -0.15);
  b.rbox(paintDarkMat, 1.9, 0.48, 0.16, 0.035, 0, 1.49, DIMS.cabZFront);
  b.rbox(darkSteelMat, 1.24, 0.34, 0.06, 0.02, 0, 1.51, DIMS.cabZFront + 0.08);
  for (let i = -7; i <= 7; i++) b.box(steelMat, 0.024, 0.274, 0.03, i * 0.072, 1.51, DIMS.cabZFront + 0.12);
  for (const hx of [-0.72, 0.72]) {
    b.rbox(darkSteelMat, 0.24, 0.19, 0.09, 0.03, hx, 1.47, DIMS.cabZFront + 0.10);
    b.rbox(lensMat, 0.176, 0.12, 0.035, 0.025, hx, 1.47, DIMS.cabZFront + 0.154);
    b.box(lensMat, 0.09, 0.032, 0.025, hx * 1.16, 1.65, DIMS.cabZFront + 0.11);
    b.box(paintDarkMat, 0.042, 0.20, 0.74, Math.sign(hx) * 1.048, 1.38, 2.52);
  }
  for (const hx of [-0.55, 0.55]) b.box(steelMat, 0.12, 0.24, 1.5, hx, 0.88, 2.85);
  b.rbox(steelMat, 2.0, 0.26, 0.34, 0.05, 0, 0.72, DIMS.cabZFront + 0.14);
  // Recovery winch, armored bumper and hood hardware.
  b.cyl(darkSteelMat, 0.14, 0.14, 0.72, 16, 0, 0.88, DIMS.cabZFront + 0.20, 0, 0, Math.PI / 2);
  for (const sx of [-1, 1]) {
    b.rbox(steelMat, 0.16, 0.28, 0.26, 0.025, sx * 0.46, 0.88, DIMS.cabZFront + 0.20);
    b.box(darkSteelMat, 0.08, 0.11, 0.42, sx * 0.88, 0.82, DIMS.cabZFront + 0.33);
    b.rbox(paintDarkMat, 0.055, 0.36, 1.14, 0.018, sx * 1.012, 1.26, 2.55);
    for (const z of [2.02, 3.08]) for (const y of [1.16, 1.52]) b.cyl(steelMat, 0.018, 0.018, 0.025, 8, sx * 1.047, y, z, 0, 0, Math.PI / 2);
    for (const z of [1.98, 2.36, 2.74, 3.12]) b.box(steelMat, 0.024, 0.085, 0.04, sx * 1.045, 1.44, z);
  }
  b.box(darkSteelMat, 0.08, 0.38, 0.08, 0, 0.88, DIMS.cabZFront + 0.36);
  b.put(steelMat, torus(0.055, 0.014, 8, 14, Math.PI * 1.5), 0, 0.79, DIMS.cabZFront + 0.41, Math.PI / 2, 0, 0);
  for (const hx of [-0.6, 0.6]) b.put(steelMat, torus(0.07, 0.025, 8, 12, Math.PI), hx, 0.56, DIMS.cabZFront + 0.32);
  b.rbox(steelMat, 1.91, 0.155, 0.18, 0.023, 0, 0.68, -3.57);
  for (const x of [-0.78, 0.78]) {
    b.rbox(darkSteelMat, 0.27, 0.12, 0.042, 0.015, x, 0.686, -3.665);
    b.rbox(tailLens, 0.18, 0.078, 0.025, 0.011, x, 0.686, -3.69);
  }
  for (const sx of [-1, 1]) {
    b.rbox(steelMat, 0.32, 0.06, 0.31, 0.018, sx * 1.15, 0.88, 1.34);
    b.rbox(steelMat, 0.32, 0.06, 0.31, 0.018, sx * 1.15, 0.59, 1.34);
    for (const z of [1.23, 1.45]) b.box(steelMat, 0.045, 0.77, 0.047, sx * 1.01, 0.94, z);
    b.cyl(steelMat, 0.018, 0.018, 0.55, 6, sx * 1.28, 2.3, 3.15, 0, 0, sx * 0.9);
    b.rbox(paintDarkMat, 0.06, 0.34, 0.2, 0.02, sx * 1.42, 2.32, 3.28);
    b.box(glassMat, 0.02, 0.28, 0.16, sx * 1.45, 2.32, 3.28);
  }

  const fA0 = degToRad(-30), fA1 = degToRad(205);
  const archSection = [[0.64, -0.26], [0.65, -0.28], [0.776, -0.28], [0.793, -0.272], [0.8, -0.255], [0.8, 0.255],
    [0.793, 0.272], [0.776, 0.28], [0.65, 0.28], [0.64, 0.26], [0.64, -0.26]].map(([r, x]) => new Vec2(r, x));
  const fenderGeo = lathe(archSection, 36, fA0, fA1 - fA0).rotateZ(Math.PI / 2);
  for (const z of DIMS.axleZ) for (const sx of [-1, 1]) {
    b.put(paintDarkMat, fenderGeo, sx * DIMS.trackX, DIMS.wheelRadius, z);
    for (const a of [fA0, fA1]) b.box(paintDarkMat, 0.528, 0.02, 0.153, sx * DIMS.trackX,
      DIMS.wheelRadius + 0.72 * Math.sin(a), z + 0.72 * Math.cos(a), -a);
    for (let i = 0; i < 7; i++) {
      const a = degToRad(-12 + i * 32);
      b.cyl(steelMat, 0.011, 0.011, 0.018, 6, sx * (DIMS.trackX + 0.274), DIMS.wheelRadius + 0.716 * Math.sin(a), z + 0.716 * Math.cos(a), 0, 0, Math.PI / 2);
    }
  }
  for (const sx of [-1, 1]) {
    b.box(rubberMat, 0.46, 0.5, 0.05, sx * DIMS.trackX, 0.42, -2.96);
    b.box(darkSteelMat, 0.5, 0.06, 0.08, sx * DIMS.trackX, 0.68, -2.9);
  }

  const tyreProfile = [new Vec2(0.3, -0.16), new Vec2(0.465, -0.179), new Vec2(0.518, -0.166), new Vec2(0.544, -0.131),
    new Vec2(0.554, -0.078), new Vec2(0.557, 0), new Vec2(0.554, 0.078), new Vec2(0.544, 0.131), new Vec2(0.518, 0.166),
    new Vec2(0.465, 0.179), new Vec2(0.3, 0.16)];
  const wheelParts: Geo[] = [lathe(tyreProfile, 40).rotateZ(Math.PI / 2).setColor('#1b1c1e')];
  const lugGeo = roundedBox(DIMS.wheelWidth * 0.47, 0.032, 0.104, 1, 0.007).weld();
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
  const wheelGeo = Geo.merge(wheelParts)!;
  const wheels: WheelNodeBinding[] = [], steerNodes: Entity[] = [], axleNames = ['FL', 'FR', 'RL1', 'RR1', 'RL2', 'RR2'] as const;
  for (let i = 0; i < 6; i++) {
    const name = axleNames[i], z = DIMS.axleZ[Math.min(i >> 1, 2)], sx = name.includes('L') ? -1 : 1;
    const steerPivot = group(`steer_${name}`, visualRoot);
    steerPivot.setLocalPosition(sx * DIMS.trackX, DIMS.wheelRadius, z);
    const spinNode = group(`wheel_${name}`, steerPivot);
    const wheelMesh = meshNode(wheelGeo, wheelMat, spinNode, { castShadows: true, receiveShadows: true });
    wheels.push({ node: spinNode, side: name.includes('L') ? 'L' : 'R', radius: DIMS.wheelRadius });
    hullMeshes.push(wheelMesh);
    if (i < 2) steerNodes.push(steerPivot);
  }
  b.flush(visualRoot, hullMeshes);
  hullTiltGroup.addChild(visualRoot);
  return {
    root, hullTiltGroup, visualRoot, wheels, steerNodes, hullMeshes,
    mats: { paintMat, paintDarkMat, steelMat, darkSteelMat, rubberMat, glassMat, lensMat,
      modPaintT, modDarkT, modSteelT, modPaintP, modDarkP, modSteelP, rocketMat, wheelMat },
  };
}

export function buildRocketLauncherRig(team: Team): InstantiatedTankRig {
  const ch = buildRocketChassis(team);
  const { root, hullTiltGroup, visualRoot, wheels, steerNodes, hullMeshes } = ch;
  const { modPaintT, modDarkT, modSteelT, modPaintP, modDarkP, modSteelP, rocketMat } = ch.mats;
  const turretPivot = group('rocket_turret_pivot', hullTiltGroup);
  turretPivot.setLocalPosition(0, DIMS.turretY, DIMS.turretZ);
  const turretRestPos = turretPivot.getLocalPosition().clone();
  const deck = new GeoBucket();
  deck.cyl(modDarkT, 0.9, 0.96, 0.05, 24, 0, 0.02, 0);
  deck.cyl(modDarkT, 0.98, 1.06, 0.22, 24, 0, 0.12, 0);
  deck.cyl(modSteelT, 0.86, 0.86, 0.06, 24, 0, 0.24, 0);
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2;
    deck.box(modDarkT, 0.09, 0.09, 0.14, Math.cos(a), 0.17, Math.sin(a), 0, -a);
  }
  for (const sx of [-1, 1]) {
    deck.rbox(modPaintT, 0.1, 0.95, 0.55, 0.02, sx * 0.58, 0.62, 0.55);
    deck.rbox(modPaintT, 0.1, 0.4, 0.4, 0.02, sx * 0.58, 0.3, 0.8, 0.5);
    deck.cyl(modSteelT, 0.09, 0.09, 0.16, 10, sx * 0.58, DIMS.gunPivotY - 0.02, DIMS.gunPivotZ - 0.05, 0, 0, Math.PI / 2);
    deck.rbox(modSteelT, 0.09, 0.8, 0.16, 0.02, sx * 0.4, 0.6, 0.85, -0.35);
    deck.rbox(modSteelT, 0.3, 0.07, 0.2, 0.02, sx * 0.4, 1.0, 0.8);
    deck.cyl(modSteelT, 0.065, 0.065, 0.6, 10, sx * 0.57, 0.37, 0.87, 1.03);
    deck.put(modSteelT, sphere(0.05, 8, 8), sx * 0.62, 0.22, 0.62);
  }
  const gunPivot = group('rocket_gun_pivot', turretPivot);
  gunPivot.setLocalPosition(0, DIMS.gunPivotY, DIMS.gunPivotZ);
  const gunRecoilGroup = group('rocket_recoil_group', gunPivot);
  const pod = new GeoBucket();
  const podW = DIMS.podW, podH = DIMS.podH, pr = 0.09, hw = podW / 2, hh = podH / 2;
  const podShape = new Shape();
  podShape.moveTo(-hw + pr, -hh).lineTo(hw - pr, -hh).quadraticCurveTo(hw, -hh, hw, -hh + pr)
    .lineTo(hw, hh - pr).quadraticCurveTo(hw, hh, hw - pr, hh).lineTo(-hw + pr, hh)
    .quadraticCurveTo(-hw, hh, -hw, hh - pr).lineTo(-hw, -hh + pr).quadraticCurveTo(-hw, -hh, -hw + pr, -hh);
  const tubeXs = [-0.27, 0, 0.27], tubeYs = [-0.17, 0.17];
  for (const ty of tubeYs) for (const tx of tubeXs) podShape.holes.push(new Path().absarc(tx, ty, DIMS.tubeR, 0, Math.PI * 2, true));
  const podGeo = extrude(podShape, { depth: 0.11, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 1, steps: 1 })
    .translate(0, 0.40, -0.05);
  pod.put(modPaintP, podGeo);
  pod.put(modPaintP, podGeo.clone().translate(0, 0, DIMS.podLength - 0.17));
  const linerGeo = cylinder(DIMS.tubeR - 0.012, DIMS.tubeR - 0.012, DIMS.podLength * 0.92, 14, 1, true).rotateX(Math.PI / 2);
  for (const ty of tubeYs) for (const tx of tubeXs) {
    pod.put(modDarkP, linerGeo, tx, ty + 0.40, DIMS.podFrontZ - DIMS.podLength * 0.55);
    pod.put(modPaintP, cylinder(DIMS.tubeR + 0.016, DIMS.tubeR + 0.016, DIMS.podLength - 0.1, 16, 1, true),
      tx, ty + 0.40, DIMS.podLength * 0.5 - 0.04, Math.PI / 2);
    pod.put(modSteelP, torus(DIMS.tubeR - 0.008, 0.014, 6, 14), tx, ty + 0.40, DIMS.podFrontZ + 0.038);
  }
  const podY0 = 0.04, podY1 = podY0 + podH, podZ0 = -0.05, podZ1 = DIMS.podFrontZ;
  for (const sx of [-1, 1]) {
    pod.box(modSteelP, 0.07, 0.07, DIMS.podLength - 0.1, sx * (hw - 0.02), podY1 - 0.035, (podZ0 + podZ1) / 2);
    pod.box(modSteelP, 0.07, 0.07, DIMS.podLength - 0.1, sx * (hw - 0.02), podY0 + 0.035, (podZ0 + podZ1) / 2);
    pod.box(modSteelP, 0.07, podH - 0.06, 0.07, sx * (hw - 0.02), (podY0 + podY1) / 2, podZ0 + 0.06);
    pod.box(modSteelP, 0.07, podH - 0.06, 0.07, sx * (hw - 0.02), (podY0 + podY1) / 2, podZ1 - 0.08);
  }
  for (const rz of [0.55, 1.55, 2.55]) {
    pod.box(modSteelP, podW + 0.1, 0.08, 0.1, 0, podY1 + 0.02, rz);
    pod.box(modSteelP, podW + 0.1, 0.08, 0.1, 0, podY0 - 0.02, rz);
    pod.box(modSteelP, 0.08, podH + 0.1, 0.1, -hw - 0.03, (podY0 + podY1) / 2, rz);
    pod.box(modSteelP, 0.08, podH + 0.1, 0.1, hw + 0.03, (podY0 + podY1) / 2, rz);
  }
  for (const sx of [-1, 1]) {
    for (const z of [0.60, 1.58, 2.56]) {
      pod.rbox(modPaintP, 0.035, 0.47, 0.69, 0.012, sx * (hw + 0.045), 0.40, z);
      pod.box(modDarkP, 0.045, 0.055, 0.74, sx * (hw + 0.068), 0.40, z, 0.58);
      for (const y of [0.19, 0.61]) pod.cyl(modSteelP, 0.018, 0.018, 0.028, 6, sx * (hw + 0.077), y, z, 0, 0, Math.PI / 2);
    }
    pod.rbox(modDarkP, 0.09, 0.17, 0.36, 0.015, sx * (hw + 0.07), 0.41, 3.05);
  }
  pod.rbox(modPaintP, podW * 0.88, 0.47, 0.055, 0.015, 0, 0.41, -0.16, 0.18);
  for (const x of [-0.39, 0.39]) for (const y of [0.13, 0.67]) pod.cyl(modSteelP, 0.018, 0.018, 0.035, 6, x, y, 3.32, Math.PI / 2);
  for (const lx of [-0.35, 0, 0.35]) pod.put(modSteelP, torus(0.06, 0.018, 8, 12, Math.PI), lx, podY1 + 0.12, 1.6, 0, 0, Math.PI);
  pod.rbox(modDarkP, podW - 0.12, podH - 0.14, 0.05, 0.02, 0, (podY0 + podY1) / 2, podZ0 - 0.02);
  pod.cyl(modSteelP, 0.03, 0.03, podW - 0.2, 8, 0, podY0 + 0.05, podZ0 - 0.06, 0, 0, Math.PI / 2);
  const rocketMeshes: Entity[] = [];
  const rocketGeo = Geo.merge([
    cylinder(0.1, 0.1, 0.85, 12).rotateX(Math.PI / 2).translate(0, 0, -0.1),
    cone(0.1, 0.28, 12).rotateX(Math.PI / 2).translate(0, 0, 0.5),
  ])!.computeNormals();
  let ri = 0;
  for (const ty of tubeYs) for (const tx of tubeXs) {
    const rg = group(`rocket_tube_${ri++}`, gunRecoilGroup);
    meshNode(rocketGeo, rocketMat, rg, { castShadows: true, receiveShadows: true });
    rg.setLocalPosition(tx, ty + 0.40, DIMS.podFrontZ - 0.75);
    rocketMeshes.push(rg);
  }
  pod.flush(gunRecoilGroup, hullMeshes);
  deck.flush(turretPivot, hullMeshes);

  const rams: { root: Entity; rod: Entity; pin: Entity }[] = [];
  const ramRodGeo = cylinder(0.032, 0.032, 1, 10).rotateX(Math.PI / 2);
  for (const sx of [-1, 1]) {
    const ram = group(`lift_ram_${sx < 0 ? 'L' : 'R'}`, turretPivot);
    const rod = meshNode(ramRodGeo, modDarkT, ram), pin = meshNode(sphere(0.045, 8, 8), modDarkT, ram);
    rod.setLocalPosition(0, 0, 0.62); pin.setLocalPosition(0, 0, 1);
    rams.push({ root: ram, rod, pin });
    hullMeshes.push(rod);
  }
  const muzzleNode = group('muzzle_datum', gunRecoilGroup), coaxNode = group('coax_datum', gunRecoilGroup);
  muzzleNode.setLocalPosition(0, 0.4, DIMS.podFrontZ + 0.1);
  coaxNode.setLocalPosition(muzzleNode.getLocalPosition());
  const ramBaseLocal = [new Vec3(-0.62, 0.22, 0.62), new Vec3(0.62, 0.22, 0.62)];
  const ramTopGun = [new Vec3(-0.35, 0.02, 1.35), new Vec3(0.35, 0.02, 1.35)];
  const top = new Vec3(), direction = new Vec3(), inv = new Mat4(), q = new Quat(), zAxis = new Vec3(0, 0, 1);
  const articulate = (_gunPitch: number) => {
    for (let i = 0; i < rams.length; i++) {
      const ram = rams[i];
      top.copy(ramTopGun[i]);
      applyMat4(top, gunPivot.getWorldTransform());
      applyMat4(top, inv.copy(turretPivot.getWorldTransform()).invert());
      const base = ramBaseLocal[i], len = top.distance(base);
      ram.root.setLocalPosition(base);
      direction.sub2(top, base).normalize();
      ram.root.setLocalRotation(quatFromUnitVectors(q, zAxis, direction));
      const rodLen = Math.max(0.08, len - 0.6);
      ram.rod.setLocalScale(1, 1, rodLen);
      ram.rod.setLocalPosition(0, 0, 0.6 + rodLen / 2);
      ram.pin.setLocalPosition(0, 0, 0.6 + rodLen);
    }
  };
  return { root, hullTiltGroup, visualRoot, turretPivot, turretRestPos, gunPivot, gunRecoilGroup,
    muzzleNode, coaxNode, rwsNode: null, wheels, steerNodes, rocketMeshes, articulate, hullMeshes };
}
