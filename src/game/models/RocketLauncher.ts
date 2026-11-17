import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyRealisticArmorShader } from '../AssetLoader';
import type { InstantiatedTankRig, WheelNodeBinding } from '../AssetLoader';
import type { Team } from '../types';

/**
 * Procedural M142 HIMARS-style 6x6 rocket artillery vehicle.
 * One DIMS block drives every part; +Z is forward, min.y = 0 at rest.
 * Layout: ladder frame + full steel deck behind the cab, closed fenders,
 * cab-over-engine armoured cab, low turntable on the deck with trunnion
 * side frames, and a 6-tube pod pivoting at its rear-bottom corner.
 * Exposes turretPivot (turntable), gunPivot (elevation), steerNodes
 * (front axle), rocketMeshes (6 pod tubes) and articulate() for lift rams.
 */

const DIMS = {
  length: 7.0,
  width: 2.4,
  wheelRadius: 0.57,
  wheelWidth: 0.36,
  trackX: 1.02,
  axleZ: [2.3, -0.9, -2.3],
  // Ladder frame + deck
  frameY: 0.86,
  deckTopY: 1.38,
  deckHalfW: 0.72, // centre deck between the fender lines
  deckZFront: 1.9,
  deckZRear: -3.45,
  // Cab-over-engine armoured cab
  cabZFront: 3.45,
  cabZRear: 1.75,
  cabFloorY: 1.15,
  cabRoofY: 2.36,
  // Launcher: turntable ring on the deck, trunnions, pod pivot at rear-bottom
  turretY: 1.38, // turntable flange sits on the deck (top ~1.63)
  turretZ: -1.6, // centred over the rear tandem
  gunPivotY: 1.06, // turret-local: pod bottom ~2.48 world, clears cab roof
  gunPivotZ: 0.7,
  podLength: 3.3,
  podFrontZ: 3.25, // pod-local front face (gun space)
  podW: 0.95,
  podH: 0.72,
  tubeR: 0.135,
} as const;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _m4 = new THREE.Matrix4();

function mat(color: string | number, rough: number, metal: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: rough,
    metalness: metal,
    envMapIntensity: 1.0,
    ...extra,
  });
}

/** Add a flat vertex colour to every vertex (for merged multi-part geometry). */
function tintGeo(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

export interface RocketChassisParts {
  root: THREE.Group;
  hullTiltGroup: THREE.Group;
  visualRoot: THREE.Object3D;
  wheels: WheelNodeBinding[];
  steerNodes: THREE.Object3D[];
  hullMeshes: THREE.Mesh[];
  mats: Record<string, THREE.Material>;
}

/** Shared 6x6 tanker chassis: hull, cab, wheels, steer knuckles. Both the
 *  rocket pod launcher and the SAM support vehicle build their mission
 *  module on top of this. */
export function buildRocketChassis(team: Team): RocketChassisParts {
  const isBlue = team === 'blue';
  const root = new THREE.Group();
  root.name = `rocket_${team}`;
  const hullTiltGroup = new THREE.Group();
  hullTiltGroup.name = 'hull_tilt_group';
  hullTiltGroup.rotation.order = 'YXZ';
  root.add(hullTiltGroup);

  // --- Materials ---
  // Body-space parts: geometry baked in vehicle coords -> heightRef 0, grain halved.
  const paintMat = mat(isBlue ? '#4a5238' : '#6b5d43', 0.6, 0.28, { envMapIntensity: 1.05 });
  applyRealisticArmorShader(paintMat, 'rocket-paint', { grain: 0.5 });
  const paintDarkMat = mat(isBlue ? '#3a412c' : '#57492f', 0.66, 0.24);
  applyRealisticArmorShader(paintDarkMat, 'rocket-paint-dark', { grain: 0.5 });
  const steelMat = mat('#2c2f2c', 0.45, 0.72, { envMapIntensity: 1.15 });
  applyRealisticArmorShader(steelMat, 'rocket-steel', { grain: 0.5 });
  const darkSteelMat = mat('#1c1e1c', 0.55, 0.6);
  applyRealisticArmorShader(darkSteelMat, 'rocket-dark-steel', { grain: 0.5 });
  const rubberMat = mat('#17181a', 0.94, 0.02);
  applyRealisticArmorShader(rubberMat, 'rocket-rubber', { grain: 0.5 });
  const glassMat = mat('#1a2836', 0.08, 0.9, { envMapIntensity: 1.5 });
  const lensMat = mat('#d8cf9a', 0.3, 0.4, { emissive: new THREE.Color('#8a7a3a'), emissiveIntensity: 0.55 });

  // Articulated-node materials: local y is node space, so heightRef shifts the
  // mud/AO datum up into vehicle space (turntable ~1.6, pod ~2.6).
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

  // Single-material wheel: tyre + rim + bolts merged with vertex colours so each
  // wheel costs ONE draw call while still spinning as a unit.
  const wheelMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.38,
    envMapIntensity: 0.9,
  });
  applyRealisticArmorShader(wheelMat, 'rocket-wheel', { grain: 0.5 });

  const hullMeshes: THREE.Mesh[] = [];

  // Geometry buckets merged per material under each node
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const bucket = (m: THREE.Material) => {
    let b = buckets.get(m);
    if (!b) buckets.set(m, (b = []));
    return b;
  };
  /** Bake a geometry (already in node-local space) into a material bucket. */
  const put = (m: THREE.Material, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    // mergeGeometries requires uniform index-ness; ExtrudeGeometry is
    // non-indexed while primitives are indexed -> normalize to non-indexed.
    if (geo.index) geo = geo.toNonIndexed();
    if (rx || ry || rz || sx !== 1 || sy !== 1 || sz !== 1 || x || y || z) {
      const mtx = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
        new THREE.Vector3(sx, sy, sz)
      );
      geo.applyMatrix4(mtx);
    }
    bucket(m).push(geo);
  };
  const box = (m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    put(m, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
  const rbox = (m: THREE.Material, w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    put(m, new RoundedBoxGeometry(w, h, d, 2, r), x, y, z, rx, ry, rz);
  const cyl = (m: THREE.Material, rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    put(m, new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, rx, ry, rz);

  const visualRoot = new THREE.Group();
  visualRoot.name = 'rocket_visual';

  // ------------------------------------------------------------------
  // LADDER FRAME + STEEL DECK
  // ------------------------------------------------------------------
  const railZ0 = DIMS.deckZRear - 0.15; // -3.6
  const railZ1 = 3.3;
  const railLen = railZ1 - railZ0;
  const railZc = (railZ0 + railZ1) / 2;
  box(steelMat, 0.14, 0.3, railLen, -0.6, DIMS.frameY, railZc);
  box(steelMat, 0.14, 0.3, railLen, 0.6, DIMS.frameY, railZc);
  // Crossmembers
  for (const cz of [-3.2, -2.2, -1.2, -0.2, 0.9, 1.8, 2.7]) {
    box(darkSteelMat, 1.34, 0.1, 0.14, 0, DIMS.frameY + 0.02, cz);
  }

  // Solid launcher deck: bevelled plate from behind the cab to the rear,
  // with panel seams and a perimeter rim (inset trims >= 2 mm proud).
  const deckZc = (DIMS.deckZFront + DIMS.deckZRear) / 2;
  const deckLen = DIMS.deckZFront - DIMS.deckZRear;
  rbox(steelMat, DIMS.deckHalfW * 2, 0.08, deckLen, 0.02, 0, DIMS.deckTopY - 0.04, deckZc);
  // Deck perimeter rim
  box(darkSteelMat, DIMS.deckHalfW * 2 + 0.04, 0.1, 0.06, 0, DIMS.deckTopY - 0.02, DIMS.deckZFront - 0.02);
  box(darkSteelMat, DIMS.deckHalfW * 2 + 0.04, 0.1, 0.06, 0, DIMS.deckTopY - 0.02, DIMS.deckZRear + 0.02);
  box(darkSteelMat, 0.06, 0.1, deckLen, -DIMS.deckHalfW - 0.01, DIMS.deckTopY - 0.02, deckZc);
  box(darkSteelMat, 0.06, 0.1, deckLen, DIMS.deckHalfW + 0.01, DIMS.deckTopY - 0.02, deckZc);
  // Panel seams (2 mm proud strips)
  for (const sz of [-2.9, -1.9, -0.9, 0.4]) {
    box(darkSteelMat, DIMS.deckHalfW * 2 - 0.1, 0.012, 0.035, 0, DIMS.deckTopY + 0.002, sz);
  }
  box(darkSteelMat, 0.035, 0.012, deckLen - 0.2, 0, DIMS.deckTopY + 0.002, deckZc);

  // ------------------------------------------------------------------
  // UNDER-DECK EQUIPMENT: fuel tank on brackets, air tank, battery
  // ------------------------------------------------------------------
  cyl(darkSteelMat, 0.26, 0.26, 1.5, 14, 0, 0.78, -0.6, 0, 0, Math.PI / 2);
  for (const bx of [-0.5, 0.5]) {
    box(steelMat, 0.08, 0.3, 0.5, bx, 0.72, -0.6);
  }
  cyl(darkSteelMat, 0.09, 0.09, 1.2, 8, 0.55, 0.85, 1.4); // air tank along frame
  rbox(steelMat, 0.5, 0.4, 0.6, 0.04, 0.45, 0.92, -1.9); // battery box

  // ------------------------------------------------------------------
  // DECK STOWAGE: tool boxes + storage lockers between/behind wheels
  // ------------------------------------------------------------------
  rbox(paintDarkMat, 0.4, 0.36, 1.15, 0.04, -0.42, DIMS.deckTopY + 0.18, -0.5);
  rbox(paintDarkMat, 0.4, 0.36, 1.15, 0.04, 0.42, DIMS.deckTopY + 0.18, -0.5);
  // Locker doors: panel-line trims + handles
  for (const sx of [-1, 1]) {
    box(darkSteelMat, 0.02, 0.3, 1.0, sx * 0.625, DIMS.deckTopY + 0.18, -0.5);
    box(steelMat, 0.03, 0.05, 0.16, sx * 0.64, DIMS.deckTopY + 0.22, -0.15);
  }
  // Vertical air bottle on the deck + rear storage box
  cyl(steelMat, 0.14, 0.14, 0.62, 12, -0.55, DIMS.deckTopY + 0.33, -2.7);
  cyl(darkSteelMat, 0.17, 0.17, 0.06, 12, -0.55, DIMS.deckTopY + 0.66, -2.7);
  rbox(paintDarkMat, 1.3, 0.4, 0.55, 0.04, 0, DIMS.deckTopY + 0.2, -3.15);
  // Exhaust stack behind cab + heat shield
  cyl(steelMat, 0.07, 0.07, 1.6, 10, 0.82, 1.9, 1.5);
  cyl(darkSteelMat, 0.11, 0.11, 0.3, 10, 0.82, 2.6, 1.5);
  box(darkSteelMat, 0.34, 0.9, 0.04, 0.82, 1.7, 1.42, 0.1, 0, 0);

  // ------------------------------------------------------------------
  // CAB-OVER-ENGINE ARMOURED CAB
  // ------------------------------------------------------------------
  // Engine block under the cab floor
  rbox(darkSteelMat, 1.7, 0.42, 1.5, 0.05, 0, 0.82, 2.55);
  // Cab main shell: faceted side profile extruded across the width
  const cabShape = new THREE.Shape();
  cabShape.moveTo(DIMS.cabZRear, DIMS.cabFloorY);
  cabShape.lineTo(DIMS.cabZFront - 0.04, DIMS.cabFloorY);
  cabShape.lineTo(DIMS.cabZFront, DIMS.cabFloorY + 0.42); // chamfered nose
  cabShape.lineTo(DIMS.cabZFront - 0.12, DIMS.cabRoofY - 0.34); // windshield rake
  cabShape.lineTo(DIMS.cabZRear + 0.1, DIMS.cabRoofY - 0.06);
  cabShape.lineTo(DIMS.cabZRear, DIMS.cabFloorY + 0.5); // rear face slope
  cabShape.closePath();

  const cabGeo = new THREE.ExtrudeGeometry(cabShape, {
    depth: 1.98,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 2,
    steps: 1,
  });
  cabGeo.rotateY(-Math.PI / 2);
  cabGeo.translate(0.99, 0, 0);
  put(paintMat, cabGeo);
  // Cab side skirts closing the gap between engine block and floor line
  for (const sx of [-1, 1]) {
    box(paintDarkMat, 0.08, 0.5, 1.6, sx * 0.92, 0.92, 2.55);
  }

  // Roof rim (thin frame around the roof edge) + sun visor + hatch
  const roofY = DIMS.cabRoofY;
  box(paintDarkMat, 2.0, 0.05, 0.07, 0, roofY + 0.03, DIMS.cabZRear + 0.12);
  box(paintDarkMat, 2.0, 0.05, 0.07, 0, roofY + 0.03, DIMS.cabZFront - 0.62);
  box(paintDarkMat, 0.07, 0.05, 1.6, -0.97, roofY + 0.03, (DIMS.cabZRear + 0.12 + DIMS.cabZFront - 0.62) / 2);
  box(paintDarkMat, 0.07, 0.05, 1.6, 0.97, roofY + 0.03, (DIMS.cabZRear + 0.12 + DIMS.cabZFront - 0.62) / 2);
  // Sun visor over the windshield
  box(paintDarkMat, 1.9, 0.05, 0.34, 0, roofY - 0.3, DIMS.cabZFront - 0.42, -0.42, 0, 0);
  // Roof hatch + periscopes (body-colour hatches, not black slabs)
  rbox(paintDarkMat, 0.72, 0.09, 0.62, 0.03, -0.25, roofY + 0.07, 2.15);
  box(darkSteelMat, 0.26, 0.12, 0.14, -0.42, roofY + 0.12, 2.75);
  box(darkSteelMat, 0.26, 0.12, 0.14, 0.42, roofY + 0.12, 2.75);
  box(darkSteelMat, 0.05, 0.16, 0.05, -0.42, roofY + 0.2, 2.75);
  box(darkSteelMat, 0.05, 0.16, 0.05, 0.42, roofY + 0.2, 2.75);
  // Antenna + whip on the cab roof
  cyl(steelMat, 0.008, 0.012, 1.5, 6, -0.7, roofY + 0.8, 1.95);
  cyl(darkSteelMat, 0.05, 0.07, 0.1, 8, -0.7, roofY + 0.05, 1.95);

  // Windshield: two-piece raked glass with centre mullion + frames
  const wsGlass = new THREE.PlaneGeometry(0.82, 0.62);
  put(glassMat, wsGlass, -0.43, 1.98, 3.3, -0.62, 0, 0);
  put(glassMat, wsGlass.clone(), 0.43, 1.98, 3.3, -0.62, 0, 0);
  box(paintDarkMat, 0.07, 0.7, 0.08, 0, 1.98, 3.32, -0.62, 0, 0); // centre mullion
  box(paintDarkMat, 1.9, 0.07, 0.08, 0, 2.3, 3.12, -0.62, 0, 0); // header
  box(paintDarkMat, 1.9, 0.07, 0.08, 0, 1.68, 3.4, -0.62, 0, 0); // sill
  box(paintDarkMat, 0.07, 0.66, 0.08, -0.9, 1.99, 3.24, -0.62, 0, 0); // A-pillars
  box(paintDarkMat, 0.07, 0.66, 0.08, 0.9, 1.99, 3.24, -0.62, 0, 0);
  // Wipers
  box(darkSteelMat, 0.02, 0.02, 0.42, -0.35, 1.9, 3.32, -0.62, 0, 0.35);
  box(darkSteelMat, 0.02, 0.02, 0.42, 0.35, 1.9, 3.32, -0.62, 0, -0.35);
  // Side windows with frames (front door glass)
  for (const sx of [-1, 1]) {
    const sideGlass = new THREE.PlaneGeometry(0.8, 0.48);
    put(glassMat, sideGlass, sx * 1.005, 1.98, 2.62, 0, sx * Math.PI / 2, 0);
    box(paintDarkMat, 0.06, 0.56, 0.9, sx * 1.0, 1.98, 2.62);
    box(paintDarkMat, 0.86, 0.06, 0.9, sx * 1.0, 2.26, 2.62);
    box(paintDarkMat, 0.86, 0.06, 0.9, sx * 1.0, 1.7, 2.62);
    // Door panel lines + handle + hinges
    box(darkSteelMat, 0.015, 0.7, 0.02, sx * 1.03, 1.55, 2.05);
    box(darkSteelMat, 0.015, 0.7, 0.02, sx * 1.03, 1.55, 3.05);
    box(steelMat, 0.04, 0.07, 0.18, sx * 1.04, 1.62, 2.62);
    cyl(darkSteelMat, 0.025, 0.025, 0.16, 8, sx * 1.02, 1.85, 2.0, 0, 0, Math.PI / 2);
    cyl(darkSteelMat, 0.025, 0.025, 0.16, 8, sx * 1.02, 1.85, 3.2, 0, 0, Math.PI / 2);
    // Grab handle on the door
    const grab = new THREE.TorusGeometry(0.05, 0.012, 6, 10, Math.PI);
    put(steelMat, grab, sx * 1.06, 1.5, 2.3, 0, sx * Math.PI / 2, 0);
  }
  // Rear cab window
  const rearGlass = new THREE.PlaneGeometry(1.1, 0.4);
  put(glassMat, rearGlass, 0, 1.95, DIMS.cabZRear - 0.02, 0, Math.PI, 0);
  box(paintDarkMat, 1.3, 0.55, 0.06, 0, 1.95, DIMS.cabZRear - 0.03);

  // Grille + recessed headlights + marker lights
  box(darkSteelMat, 1.3, 0.42, 0.1, 0, 1.5, DIMS.cabZFront + 0.01);
  for (let i = 0; i < 5; i++) box(steelMat, 1.2, 0.05, 0.03, 0, 1.36 + i * 0.075, DIMS.cabZFront + 0.07);
  for (const hx of [-0.72, 0.72]) {
    cyl(darkSteelMat, 0.1, 0.1, 0.12, 12, hx, 1.72, DIMS.cabZFront + 0.05, Math.PI / 2, 0, 0);
    cyl(lensMat, 0.065, 0.065, 0.02, 12, hx, 1.72, DIMS.cabZFront + 0.12, Math.PI / 2, 0, 0);
    // Marker lights
    box(lensMat, 0.1, 0.05, 0.04, hx * 0.55, 1.95, DIMS.cabZFront + 0.1);
  }
  // Bumper on frame horns flush under the cab nose + tow shackles
  for (const hx of [-0.55, 0.55]) {
    box(steelMat, 0.12, 0.24, 1.5, hx, 0.88, 2.85, 0, 0, 0);
  }
  rbox(steelMat, 2.0, 0.26, 0.34, 0.05, 0, 0.72, DIMS.cabZFront + 0.14);
  for (const hx of [-0.6, 0.6]) {
    const hook = new THREE.TorusGeometry(0.07, 0.025, 8, 12, Math.PI);
    put(steelMat, hook, hx, 0.56, DIMS.cabZFront + 0.32);
  }

  // Steps + grab rails + mirrors on arms
  for (const sx of [-1, 1]) {
    rbox(steelMat, 0.5, 0.06, 0.42, 0.02, sx * 1.15, 0.78, 2.7);
    rbox(steelMat, 0.5, 0.06, 0.42, 0.02, sx * 1.15, 0.5, 2.7);
    box(steelMat, 0.05, 0.5, 0.05, sx * 1.32, 1.0, 2.55);
    // Mirror arm + head
    cyl(steelMat, 0.018, 0.018, 0.55, 6, sx * 1.28, 2.3, 3.15, 0, 0, sx * 0.9);
    rbox(paintDarkMat, 0.06, 0.34, 0.2, 0.02, sx * 1.42, 2.32, 3.28);
    box(glassMat, 0.02, 0.28, 0.16, sx * 1.45, 2.32, 3.28);
  }

  // ------------------------------------------------------------------
  // FENDERS — closed extruded arc bands with real thickness over each wheel
  // ------------------------------------------------------------------
  // Shape: annular sector in (vehicle-z, vehicle-y) space, extruded then
  // rotated so the extrusion runs along vehicle-x (fender width).
  const fenderShape = new THREE.Shape();
  const fRout = 0.8, fRin = 0.64;
  const fA0 = THREE.MathUtils.degToRad(-30); // front-lower
  const fA1 = THREE.MathUtils.degToRad(205); // rear-lower over the top
  fenderShape.absarc(0, 0, fRout, fA0, fA1, false);
  fenderShape.absarc(0, 0, fRin, fA1, fA0, true);
  fenderShape.closePath();
  const fenderGeoProto = new THREE.ExtrudeGeometry(fenderShape, {
    depth: 0.56,
    bevelEnabled: false,
    steps: 1,
  });
  fenderGeoProto.rotateY(-Math.PI / 2); // shape-x -> world-z, extrude -> -x
  fenderGeoProto.translate(0.28, 0, 0); // centre the width on the wheel
  for (const z of DIMS.axleZ) {
    for (const sx of [-1, 1]) {
      put(paintDarkMat, fenderGeoProto.clone(), sx * DIMS.trackX, DIMS.wheelRadius, z);
    }
  }

  // Mud flaps behind the rear wheels (rear tyre edge is z ~ -2.87)
  for (const sx of [-1, 1]) {
    box(rubberMat, 0.46, 0.5, 0.05, sx * DIMS.trackX, 0.42, -2.96);
    box(darkSteelMat, 0.5, 0.06, 0.08, sx * DIMS.trackX, 0.68, -2.9);
  }

  // ------------------------------------------------------------------
  // WHEELS — lathe tyre + rim merged into ONE vertex-coloured geometry
  // ------------------------------------------------------------------
  const wheels: WheelNodeBinding[] = [];
  const steerNodes: THREE.Object3D[] = [];

  const tyreProfile = [
    new THREE.Vector2(0.3, -0.16),
    new THREE.Vector2(0.5, -0.175),
    new THREE.Vector2(0.545, -0.12),
    new THREE.Vector2(0.565, 0),
    new THREE.Vector2(0.545, 0.12),
    new THREE.Vector2(0.5, 0.175),
    new THREE.Vector2(0.3, 0.16),
  ];
  const tyreGeo = new THREE.LatheGeometry(tyreProfile, 18);
  tyreGeo.rotateZ(Math.PI / 2); // axle -> X
  const lugGeo = new THREE.BoxGeometry(DIMS.wheelWidth * 0.92, 0.04, 0.14);
  const wheelParts: THREE.BufferGeometry[] = [tintGeo(tyreGeo, new THREE.Color('#1b1c1e'))];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const lug = lugGeo.clone();
    lug.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(0, Math.cos(a) * 0.55, Math.sin(a) * 0.55),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(a, 0, 0)),
        new THREE.Vector3(1, 1, 1)
      )
    );
    wheelParts.push(tintGeo(lug, new THREE.Color('#151619')));
  }
  const rimProfile = [
    new THREE.Vector2(0.1, -0.14),
    new THREE.Vector2(0.28, -0.16),
    new THREE.Vector2(0.3, -0.1),
    new THREE.Vector2(0.3, 0.1),
    new THREE.Vector2(0.28, 0.16),
    new THREE.Vector2(0.1, 0.14),
  ];
  const rimGeo = new THREE.LatheGeometry(rimProfile, 14);
  rimGeo.rotateZ(Math.PI / 2);
  wheelParts.push(tintGeo(rimGeo, new THREE.Color('#3a3d3a')));
  const hubGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.4, 10);
  hubGeo.rotateZ(Math.PI / 2);
  wheelParts.push(tintGeo(hubGeo, new THREE.Color('#2a2d2a')));
  const boltGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.05, 6);
  boltGeo.rotateZ(Math.PI / 2);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const b = boltGeo.clone();
    b.applyMatrix4(new THREE.Matrix4().makeTranslation(Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0));
    wheelParts.push(tintGeo(b, new THREE.Color('#555a55')));
  }
  const wheelGeo = mergeGeometries(wheelParts, false)!;
  wheelGeo.computeVertexNormals();

  const axleNames = ['FL', 'FR', 'RL1', 'RR1', 'RL2', 'RR2'] as const;
  for (let i = 0; i < 6; i++) {
    const name = axleNames[i];
    const z = DIMS.axleZ[Math.min(i >> 1, 2)];
    const sx = name.includes('L') ? -1 : 1;
    const isFront = i < 2;
    const steerPivot = new THREE.Group();
    steerPivot.name = `steer_${name}`;
    steerPivot.position.set(sx * DIMS.trackX, DIMS.wheelRadius, z);
    const spinNode = new THREE.Group();
    spinNode.name = `wheel_${name}`;
    const wheelMesh = new THREE.Mesh(wheelGeo, wheelMat);
    wheelMesh.castShadow = true;
    spinNode.add(wheelMesh);
    steerPivot.add(spinNode);
    visualRoot.add(steerPivot);
    wheels.push({ node: spinNode, side: name.includes('L') ? 'L' : 'R', radius: DIMS.wheelRadius });
    hullMeshes.push(wheelMesh);
    if (isFront) steerNodes.push(steerPivot);
  }

  // Merge all static body geometry per material
  for (const [m, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    visualRoot.add(mesh);
    hullMeshes.push(mesh);
  }
  buckets.clear();
  hullTiltGroup.add(visualRoot);


  return {
    root,
    hullTiltGroup,
    visualRoot,
    wheels,
    steerNodes,
    hullMeshes,
    mats: {
      paintMat, paintDarkMat, steelMat, darkSteelMat, rubberMat, glassMat, lensMat,
      modPaintT, modDarkT, modSteelT, modPaintP, modDarkP, modSteelP, rocketMat, wheelMat,
    },
  };
}

export function buildRocketLauncherRig(team: Team): InstantiatedTankRig {
  const ch = buildRocketChassis(team);
  const { root, hullTiltGroup, visualRoot, wheels, steerNodes, hullMeshes } = ch;
  const { modPaintT, modDarkT, modSteelT, modPaintP, modDarkP, modSteelP, rocketMat } = ch.mats;
  const turretPivot = new THREE.Group();
  turretPivot.name = 'rocket_turret_pivot';
  turretPivot.position.set(0, DIMS.turretY, DIMS.turretZ);
  hullTiltGroup.add(turretPivot);
  const turretRestPos = turretPivot.position.clone();

  // Turntable module buckets (turretPivot-local; heightRef ~1.9)
  const deckBuckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const dput = (m: THREE.Material, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    if (geo.index) geo = geo.toNonIndexed();
    const mtx = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(1, 1, 1)
    );
    geo.applyMatrix4(mtx);
    let b = deckBuckets.get(m);
    if (!b) deckBuckets.set(m, (b = []));
    b.push(geo);
  };
  const dbox = (m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    dput(m, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
  const drbox = (m: THREE.Material, w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    dput(m, new RoundedBoxGeometry(w, h, d, 2, r), x, y, z, rx, ry, rz);
  const dcyl = (m: THREE.Material, rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    dput(m, new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, rx, ry, rz);

  // Turntable ring: low drum sitting directly on the deck + slew teeth + bolts
  dcyl(modDarkT, 0.9, 0.96, 0.05, 24, 0, 0.02, 0); // flange on the deck
  dcyl(modDarkT, 0.98, 1.06, 0.22, 24, 0, 0.12, 0); // drum
  dcyl(modSteelT, 0.86, 0.86, 0.06, 24, 0, 0.24, 0); // top plate
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    dbox(modDarkT, 0.09, 0.09, 0.14, Math.cos(a) * 1.0, 0.17, Math.sin(a) * 1.0, 0, -a, 0);
  }
  // Trunnion side frames: bevelled plates rising from the turntable to the pivot
  for (const sx of [-1, 1]) {
    drbox(modPaintT, 0.1, 0.95, 0.55, 0.02, sx * 0.58, 0.62, 0.55);
    // Gusset plate tying the frame foot to the turntable
    drbox(modPaintT, 0.1, 0.4, 0.4, 0.02, sx * 0.58, 0.3, 0.8, 0.5, 0, 0);
    // Pivot pin boss at the top-rear of each frame
    dcyl(modSteelT, 0.09, 0.09, 0.16, 10, sx * 0.58, DIMS.gunPivotY - 0.02, DIMS.gunPivotZ - 0.05, 0, 0, Math.PI / 2);
  }
  // Stow cradle arms under the pod rear (pod rests here at pitch ~0)
  for (const sx of [-1, 1]) {
    drbox(modSteelT, 0.09, 0.8, 0.16, 0.02, sx * 0.4, 0.6, 0.85, -0.35, 0, 0);
    drbox(modSteelT, 0.3, 0.07, 0.2, 0.02, sx * 0.4, 1.0, 0.8);
  }
  // Hydraulic ram barrels + foot pins (static part; rods are separate meshes).
  // Barrel lies along the pitch-0 base->top axis; only the rod articulates.
  for (const sx of [-1, 1]) {
    dcyl(modSteelT, 0.065, 0.065, 0.6, 10, sx * 0.57, 0.37, 0.87, 1.03, 0, 0);
    dput(modSteelT, new THREE.SphereGeometry(0.05, 8, 8), sx * 0.62, 0.22, 0.62);
  }

  const gunPivot = new THREE.Group();
  gunPivot.name = 'rocket_gun_pivot';
  gunPivot.position.set(0, DIMS.gunPivotY, DIMS.gunPivotZ);
  turretPivot.add(gunPivot);

  const gunRecoilGroup = new THREE.Group();
  gunRecoilGroup.name = 'rocket_recoil_group';
  gunPivot.add(gunRecoilGroup);

  // --- Launch pod: extruded rounded-rect with 6 open tube bores ---
  const podBuckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const pput = (m: THREE.Material, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    if (geo.index) geo = geo.toNonIndexed();
    const mtx = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(1, 1, 1)
    );
    geo.applyMatrix4(mtx);
    let b = podBuckets.get(m);
    if (!b) podBuckets.set(m, (b = []));
    b.push(geo);
  };
  const prbox = (m: THREE.Material, w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    pput(m, new RoundedBoxGeometry(w, h, d, 2, r), x, y, z, rx, ry, rz);
  const pbox = (m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    pput(m, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
  const pcyl = (m: THREE.Material, rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    pput(m, new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, rx, ry, rz);

  const podW = DIMS.podW, podH = DIMS.podH;
  const podShape = new THREE.Shape();
  const pr = 0.09;
  const hw = podW / 2, hh = podH / 2;
  podShape.moveTo(-hw + pr, -hh);
  podShape.lineTo(hw - pr, -hh);
  podShape.quadraticCurveTo(hw, -hh, hw, -hh + pr);
  podShape.lineTo(hw, hh - pr);
  podShape.quadraticCurveTo(hw, hh, hw - pr, hh);
  podShape.lineTo(-hw + pr, hh);
  podShape.quadraticCurveTo(-hw, hh, -hw, hh - pr);
  podShape.lineTo(-hw, -hh + pr);
  podShape.quadraticCurveTo(-hw, -hh, -hw + pr, -hh);

  const tubeXs = [-0.27, 0, 0.27];
  const tubeYs = [-0.17, 0.17];
  const borePaths: THREE.Path[] = [];
  for (const ty of tubeYs) {
    for (const tx of tubeXs) {
      const p = new THREE.Path();
      p.absarc(tx, ty, DIMS.tubeR, 0, Math.PI * 2, true);
      borePaths.push(p);
    }
  }
  podShape.holes = borePaths;

  const podGeo = new THREE.ExtrudeGeometry(podShape, {
    depth: DIMS.podLength,
    bevelEnabled: true,
    bevelThickness: 0.025,
    bevelSize: 0.025,
    bevelSegments: 1,
    steps: 1,
  });
  // Extrude runs +Z from 0 -> span z in [-0.05, podLength-0.05]; pod bottom ~0.04
  podGeo.translate(0, 0.40, -0.05);
  pput(modPaintP, podGeo);

  // Tube liners (inner sleeves)
  const linerGeo = new THREE.CylinderGeometry(DIMS.tubeR - 0.012, DIMS.tubeR - 0.012, DIMS.podLength * 0.92, 14, 1, true);
  linerGeo.rotateX(Math.PI / 2);
  for (const ty of tubeYs) {
    for (const tx of tubeXs) {
      pput(modDarkP, linerGeo.clone(), tx, ty + 0.40, DIMS.podFrontZ - DIMS.podLength * 0.55);
    }
  }

  // Pod cage: corner rails, cross ribs, lifting lugs, hinged rear cover
  const podY0 = 0.04, podY1 = podY0 + podH; // 0.04 .. 0.76
  const podZ0 = -0.05, podZ1 = DIMS.podFrontZ;
  // Long corner rails (top + bottom, both sides)
  for (const sx of [-1, 1]) {
    pbox(modSteelP, 0.07, 0.07, DIMS.podLength - 0.1, sx * (hw - 0.02), podY1 - 0.035, (podZ0 + podZ1) / 2);
    pbox(modSteelP, 0.07, 0.07, DIMS.podLength - 0.1, sx * (hw - 0.02), podY0 + 0.035, (podZ0 + podZ1) / 2);
    // Vertical corner posts at front + rear
    pbox(modSteelP, 0.07, podH - 0.06, 0.07, sx * (hw - 0.02), (podY0 + podY1) / 2, podZ0 + 0.06);
    pbox(modSteelP, 0.07, podH - 0.06, 0.07, sx * (hw - 0.02), (podY0 + podY1) / 2, podZ1 - 0.08);
  }
  // Cross ribs: rectangular frames around the pod at 4 stations
  for (const rz of [0.55, 1.55, 2.55]) {
    pbox(modSteelP, podW + 0.1, 0.08, 0.1, 0, podY1 + 0.02, rz);
    pbox(modSteelP, podW + 0.1, 0.08, 0.1, 0, podY0 - 0.02, rz);
    pbox(modSteelP, 0.08, podH + 0.1, 0.1, -hw - 0.03, (podY0 + podY1) / 2, rz);
    pbox(modSteelP, 0.08, podH + 0.1, 0.1, hw + 0.03, (podY0 + podY1) / 2, rz);
  }
  // Lifting lugs on top
  for (const lx of [-0.35, 0, 0.35]) {
    const lug = new THREE.TorusGeometry(0.06, 0.018, 8, 12, Math.PI);
    pput(modSteelP, lug, lx, podY1 + 0.12, 1.6, 0, 0, Math.PI);
  }
  // Hinged rear cover plate + hinge barrels along the bottom rear edge
  prbox(modDarkP, podW - 0.12, podH - 0.14, 0.05, 0.02, 0, (podY0 + podY1) / 2, podZ0 - 0.02);
  pcyl(modSteelP, 0.03, 0.03, podW - 0.2, 8, 0, podY0 + 0.05, podZ0 - 0.06, 0, 0, Math.PI / 2);

  // Rocket meshes: nose + body stub visible inside each bore (1 mesh each)
  const rocketMeshes: THREE.Object3D[] = [];
  const rocketBodyGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.85, 12);
  rocketBodyGeo.rotateX(Math.PI / 2);
  const rocketNoseGeo = new THREE.ConeGeometry(0.1, 0.28, 12);
  rocketNoseGeo.rotateX(Math.PI / 2);
  const rocketGeo = mergeGeometries(
    [rocketBodyGeo.translate(0, 0, -0.1), rocketNoseGeo.translate(0, 0, 0.5)],
    false
  )!;
  rocketGeo.computeVertexNormals();
  let ri = 0;
  for (const ty of tubeYs) {
    for (const tx of tubeXs) {
      const rg = new THREE.Group();
      rg.name = `rocket_tube_${ri}`;
      const rm = new THREE.Mesh(rocketGeo, rocketMat);
      rm.castShadow = true;
      rg.add(rm);
      rg.position.set(tx, ty + 0.40, DIMS.podFrontZ - 0.75);
      gunRecoilGroup.add(rg);
      rocketMeshes.push(rg);
      ri++;
    }
  }

  // Merge static pod parts under the recoil group and turntable parts
  // under the turret pivot.
  for (const [m, geos] of podBuckets) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    gunRecoilGroup.add(mesh);
    hullMeshes.push(mesh);
  }
  podBuckets.clear();
  for (const [m, geos] of deckBuckets) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    turretPivot.add(mesh);
    hullMeshes.push(mesh);
  }
  deckBuckets.clear();

  // --- Elevation rams: barrel+pins merged on the turntable, rod on the pod ---
  const rams: THREE.Group[] = [];
  const ramRodGeo = new THREE.CylinderGeometry(0.032, 0.032, 1, 10);
  ramRodGeo.rotateX(Math.PI / 2);
  for (const sx of [-1, 1]) {
    const ram = new THREE.Group();
    ram.name = `lift_ram_${sx < 0 ? 'L' : 'R'}`;
    const rodMesh = new THREE.Mesh(ramRodGeo, modDarkT);
    rodMesh.position.z = 0.62;
    const pinB = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), modDarkT);
    pinB.position.z = 1;
    ram.add(rodMesh, pinB);
    ram.userData.rodMesh = rodMesh;
    ram.userData.pinB = pinB;
    turretPivot.add(ram);
    rams.push(ram);
    hullMeshes.push(rodMesh);
  }

  // Muzzle/coax datums at the pod front (used by tracers/markers only)
  const muzzleNode = new THREE.Object3D();
  muzzleNode.name = 'muzzle_datum';
  muzzleNode.position.set(0, 0.4, DIMS.podFrontZ + 0.1);
  gunRecoilGroup.add(muzzleNode);
  const coaxNode = new THREE.Object3D();
  coaxNode.name = 'coax_datum';
  coaxNode.position.copy(muzzleNode.position);
  gunRecoilGroup.add(coaxNode);

  // Ram attachment points: bases on the turntable (turretPivot local),
  // tops on the pod underside (gunPivot local).
  const ramBaseLocal = [new THREE.Vector3(-0.62, 0.22, 0.62), new THREE.Vector3(0.62, 0.22, 0.62)];
  const ramTopGun = [new THREE.Vector3(-0.35, 0.02, 1.35), new THREE.Vector3(0.35, 0.02, 1.35)];

  const articulate = (gunPitch: number) => {
    turretPivot.updateWorldMatrix(true, false);
    gunPivot.updateWorldMatrix(true, false);
    for (let i = 0; i < rams.length; i++) {
      const ram = rams[i];
      // Top attach point in turret space
      _v1.copy(ramTopGun[i]).applyMatrix4(gunPivot.matrixWorld).applyMatrix4(_m4.copy(turretPivot.matrixWorld).invert());
      _v2.copy(ramBaseLocal[i]);
      const len = _v1.distanceTo(_v2);
      ram.position.copy(_v2);
      _v3.copy(_v1).sub(_v2).normalize();
      _q1.setFromUnitVectors(_zAxis, _v3);
      ram.quaternion.copy(_q1);
      const rodLen = Math.max(0.08, len - 0.6);
      const rodMesh = ram.userData.rodMesh as THREE.Mesh;
      const pinB = ram.userData.pinB as THREE.Mesh;
      rodMesh.scale.z = rodLen;
      rodMesh.position.z = 0.6 + rodLen / 2;
      pinB.position.z = 0.6 + rodLen;
    }
  };

  return {
    root,
    hullTiltGroup,
    visualRoot,
    turretPivot,
    turretRestPos,
    gunPivot,
    gunRecoilGroup,
    muzzleNode,
    coaxNode,
    rwsNode: null,
    wheels,
    steerNodes,
    rocketMeshes,
    articulate,
    hullMeshes,
  };
}
