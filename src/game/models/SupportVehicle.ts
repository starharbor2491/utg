import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyRealisticArmorShader } from '../AssetLoader';
import type { InstantiatedTankRig } from '../AssetLoader';
import { buildRocketChassis } from './RocketLauncher';
import type { Team } from '../types';

/**
 * F5a "SAM support" — shared 6x6 tanker chassis (RocketLauncher.buildRocketChassis)
 * plus an Avenger/Pantsir-style mission module on the rear bed: traversing
 * turntable, twin 4-cell SAM canisters flanking a sensor head (elevating on
 * gunPivot), a slowly scanning radar panel, and a rear drone bay with a
 * visible quadcopter (buildFpvDrone — F5b flies it).
 */

const BED = {
  ringR: 1.02,
  ringH: 0.16,
  drumR: 0.92,
  drumH: 0.3,
  gunY: 0.42,
  gunZ: 0.15,
  canW: 0.62,
  canH: 0.52,
  canD: 1.72,
  canX: 0.65,
  canZ: 0.68,
  headW: 0.5,
  headH: 0.42,
  headD: 0.6,
  headZ: 0.15,
  mastZ: -0.55,
  bayZ: -1.5,
} as const;

function bedMat(color: string, rough: number, metal: number, hRef = 1.9) {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: rough,
    metalness: metal,
    envMapIntensity: 1.0,
  });
  applyRealisticArmorShader(m, 'support-bed', { grain: 0.5, heightRef: hRef });
  return m;
}

/** FPV quadcopter, nose and camera facing +Z. */
export function buildFpvDrone(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'fpv_drone';
  g.userData.keepMeshChildren = true;
  const frameMat = new THREE.MeshStandardMaterial({ color: '#2b2e33', roughness: 0.88, metalness: 0.25 });
  const accentMat = new THREE.MeshStandardMaterial({ color: '#585e40', roughness: 0.7, metalness: 0.2 });
  const lensMat = new THREE.MeshStandardMaterial({ color: '#152630', roughness: 0.23, metalness: 0.6 });
  const navMat = (c: string) => new THREE.MeshStandardMaterial({ color: '#111', emissive: new THREE.Color(c), emissiveIntensity: 2.2 });
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const part = new THREE.Mesh(geo, mat);
    part.position.set(x, y, z);
    g.add(part);
    return part;
  };
  const armGeo = new RoundedBoxGeometry(0.245, 0.018, 0.05, 2, 0.007);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      mesh(armGeo, frameMat, sx * 0.126, 0.026, sz * 0.125).rotation.y = -sx * sz * Math.PI / 4;
      mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.018, 10), frameMat, sx * 0.21, 0.026, sz * 0.21);
    }
  }
  mesh(new RoundedBoxGeometry(0.144, 0.016, 0.268, 2, 0.006), frameMat, 0, 0.025, 0);
  mesh(new RoundedBoxGeometry(0.127, 0.014, 0.235, 2, 0.006), frameMat, 0, 0.075, -0.004);
  mesh(new RoundedBoxGeometry(0.101, 0.04, 0.137, 2, 0.007), accentMat, 0, 0.102, -0.034);
  for (const sz of [-1, 1]) mesh(new THREE.BoxGeometry(0.114, 0.047, 0.013), frameMat, 0, 0.104, -0.035 + 0.041 * sz);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.058, 6), accentMat, sx * 0.053, 0.052, sz * 0.089);
    mesh(new RoundedBoxGeometry(0.017, 0.068, 0.085, 2, 0.007), frameMat, sx * 0.056, 0.066, 0.13);
  }
  mesh(new THREE.CylinderGeometry(0.039, 0.039, 0.27, 12), accentMat, 0, -0.056, 0.005).rotation.x = Math.PI / 2;
  mesh(new RoundedBoxGeometry(0.092, 0.075, 0.07, 2, 0.008), frameMat, 0, 0.068, 0.134);
  mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.023, 16), lensMat, 0, 0.068, 0.18).rotation.x = Math.PI / 2;
  const camera = new THREE.Object3D();
  camera.name = 'fpv_camera';
  camera.position.set(0, 0.068, 0.198);
  camera.rotation.y = Math.PI;
  g.add(camera);
  for (const sx of [-1, 1]) {
    mesh(new THREE.CylinderGeometry(0.005, 0.006, 0.132, 6), frameMat, sx * 0.054, 0.12, -0.137).rotation.z = -sx * 0.33;
  }
  // red/green nav light pair on the front corners
  for (const [sx, c] of [[-1, '#ff2a1a'], [1, '#2aff5a']] as const) {
    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 6), navMat(c));
    nav.position.set(sx * 0.07, 0.09, 0.12);
    g.add(nav);
  }
  const motorGeo = new THREE.CylinderGeometry(0.028, 0.034, 0.05, 8);
  const bladeGeo = new THREE.BoxGeometry(0.092, 0.006, 0.027);
  const hubGeo = new THREE.CylinderGeometry(0.017, 0.017, 0.012, 8);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const px = sx * 0.21;
    const pz = sz * 0.21;
    const motor = new THREE.Mesh(motorGeo, frameMat);
    motor.position.set(px, 0.05, pz);
    g.add(motor);
    // Alternating rotor directions, with solid three-blade props on the ground.
    const rotor = new THREE.Group();
    rotor.position.set(px, 0.085, pz);
    for (let i = 0; i < 3; i++) {
      const a = i * 2 * Math.PI / 3;
      const blade = new THREE.Mesh(bladeGeo, frameMat);
      blade.position.set(Math.cos(a) * 0.062, 0, -Math.sin(a) * 0.062);
      blade.rotation.set(0, a + sx * sz * 0.13, 0);
      rotor.add(blade);
    }
    rotor.add(new THREE.Mesh(hubGeo, frameMat));
    rotor.userData.spin = sx * sz;
    g.add(rotor);
  }
  g.scale.setScalar(0.76);
  return g;
}

interface GeoBucket {
  put(m: THREE.Material, geo: THREE.BufferGeometry, x?: number, y?: number, z?: number, rx?: number, ry?: number, rz?: number): void;
  box(m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number): void;
  rbox(m: THREE.Material, w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number): void;
  cyl(m: THREE.Material, rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number): void;
  flush(parent: THREE.Object3D, castShadow?: boolean): THREE.Mesh[];
}

function makeBucket(): GeoBucket {
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const bucket = (m: THREE.Material) => {
    let b = buckets.get(m);
    if (!b) buckets.set(m, (b = []));
    return b;
  };
  const xform = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rx: number, ry: number, rz: number) => {
    if (geo.index) geo = geo.toNonIndexed();
    if (rx || ry || rz || x || y || z) {
      const mtx = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
        new THREE.Vector3(1, 1, 1)
      );
      geo.applyMatrix4(mtx);
    }
    return geo;
  };
  return {
    put(m, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
      bucket(m).push(xform(geo, x, y, z, rx, ry, rz));
    },
    box(m, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
      this.put(m, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
    },
    rbox(m, w, h, d, r, x, y, z, rx = 0, ry = 0, rz = 0) {
      this.put(m, new RoundedBoxGeometry(w, h, d, 2, r), x, y, z, rx, ry, rz);
    },
    cyl(m, rt, rb, h, seg, x, y, z, rx = 0, ry = 0, rz = 0) {
      this.put(m, new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, rx, ry, rz);
    },
    flush(parent, castShadow = true) {
      const out: THREE.Mesh[] = [];
      for (const [m, geos] of buckets) {
        const merged = mergeGeometries(geos, false);
        if (!merged) continue;
        merged.computeVertexNormals();
        const mesh = new THREE.Mesh(merged, m);
        mesh.castShadow = castShadow;
        mesh.receiveShadow = true;
        parent.add(mesh);
        out.push(mesh);
      }
      buckets.clear();
      return out;
    },
  };
}

export function buildSupportVehicleRig(team: Team): InstantiatedTankRig {
  const isBlue = team === 'blue';
  const ch = buildRocketChassis(team);
  const { root, hullTiltGroup, visualRoot, wheels, steerNodes, hullMeshes } = ch;

  const paint = bedMat(isBlue ? '#48554b' : '#6b5e4b', 0.6, 0.28);
  const dark = bedMat(isBlue ? '#333a26' : '#4c3f2a', 0.66, 0.24);
  const steel = bedMat('#2c2f2c', 0.45, 0.72);
  const black = bedMat('#141517', 0.7, 0.4);

  // Bed equipment forward of the turntable (hull-static, on the deck):
  // generator box, cable reel, stowage rack.
  const eb = makeBucket();
  const deckY = 1.38;
  eb.rbox(dark, 0.85, 0.62, 1.0, 0.04, -0.55, deckY + 0.31, 0.9);   // generator box
  eb.box(black, 0.5, 0.06, 0.7, -0.55, deckY + 0.6, 1.0);          // gen lid vent
  eb.cyl(steel, 0.34, 0.34, 0.34, 18, 0.45, deckY + 0.36, 1.35, 0, 0, Math.PI / 2); // cable reel
  eb.cyl(black, 0.36, 0.36, 0.05, 18, 0.45, deckY + 0.36, 1.35, 0, 0, Math.PI / 2);
  eb.cyl(dark, 0.1, 0.1, 0.42, 10, 0.45, deckY + 0.36, 1.35, 0, 0, Math.PI / 2);   // reel core
  // stowage rack: two posts + shelf + crates
  for (const rz of [0.35, 1.15]) eb.box(steel, 0.06, 0.85, 0.06, 0.78, deckY + 0.43, rz);
  eb.box(steel, 0.06, 0.85, 0.06, 1.12, deckY + 0.43, 0.75);
  eb.box(dark, 0.4, 0.05, 0.95, 0.95, deckY + 0.82, 0.75);
  eb.rbox(paint, 0.3, 0.24, 0.4, 0.02, 0.95, deckY + 0.97, 0.55);
  eb.rbox(dark, 0.26, 0.2, 0.34, 0.02, 0.95, deckY + 0.95, 0.95);
  eb.flush(hullTiltGroup);

  // ---- turntable on the deck (same pivot as the rocket pod) ----
  const turretPivot = new THREE.Group();
  turretPivot.name = 'support_turret_pivot';
  turretPivot.position.set(0, 1.38, -1.6);
  hullTiltGroup.add(turretPivot);
  const turretRestPos = turretPivot.position.clone();

  const tb = makeBucket(); // turret-static geometry (ring, drum, bay, mast pole)
  tb.cyl(steel, BED.ringR, BED.ringR + 0.04, BED.ringH, 28, 0, BED.ringH / 2, 0);
  tb.cyl(dark, BED.drumR, BED.drumR, BED.drumH, 24, 0, BED.ringH + BED.drumH / 2 - 0.02, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    tb.cyl(black, 0.025, 0.025, 0.03, 6, Math.cos(a) * (BED.ringR - 0.06), BED.ringH + 0.005, Math.sin(a) * (BED.ringR - 0.06));
  }
  // trunnion pedestals (static; the beam pivots between them)
  for (const sx of [-1, 1]) {
    tb.box(steel, 0.12, 0.3, 0.5, sx * 0.45, BED.gunY - 0.28, BED.gunZ);
    tb.cyl(steel, 0.07, 0.07, 0.34, 10, sx * 0.45, BED.gunY - 0.1, BED.gunZ, 0, 0, Math.PI / 2);
  }
  // radar mast pole (panel spins separately)
  tb.cyl(steel, 0.035, 0.045, 0.5, 8, 0, BED.ringH + BED.drumH + 0.22, BED.mastZ);
  tb.box(steel, 0.1, 0.08, 0.1, 0, BED.ringH + BED.drumH + 0.47, BED.mastZ);

  // A low landing cradle leaves the frame and battery visible.
  tb.rbox(paint, 1.02, 0.23, 0.93, 0.045, 0, 0.15, BED.bayZ);
  tb.box(dark, 0.91, 0.023, 0.82, 0, 0.278, BED.bayZ);
  for (const sx of [-1, 1]) {
    tb.rbox(steel, 0.12, 0.085, 0.84, 0.025, sx * 0.41, 0.314, BED.bayZ);
    tb.box(black, 0.16, 0.025, 0.58, sx * 0.29, 0.296, BED.bayZ);
  }
  tb.flush(turretPivot);
  const drone = buildFpvDrone();
  drone.position.set(0, 0.377, BED.bayZ);
  drone.rotation.y = 0;
  turretPivot.add(drone);

  // radar panel: dark olive flat-array with raised frame + recessed matte
  // face carrying a fine grid of radiating elements (no bright face)
  const radarPanel = new THREE.Group();
  radarPanel.position.set(0, BED.ringH + BED.drumH + 0.62, BED.mastZ);
  turretPivot.add(radarPanel);
  const rb = makeBucket();
  rb.rbox(steel, 0.91, 0.43, 0.1, 0.045, 0, 0, -0.015);
  rb.rbox(dark, 0.83, 0.345, 0.07, 0.035, 0, 0, 0.045);
  const antenna = bedMat('#829286', 0.54, 0.37);
  // radiating element grid on the face
  for (let ix = -3; ix <= 3; ix++) {
    for (let iy = -1; iy <= 1; iy++) {
      rb.box(antenna, 0.049, 0.031, 0.012, ix * 0.105, iy * 0.096, 0.087);
    }
  }
  rb.flush(radarPanel, true);
  let radarAngle = 0;

  // ---- elevating beam: sensor head + twin canisters ----
  const gunPivot = new THREE.Group();
  gunPivot.name = 'support_gun_pivot';
  gunPivot.position.set(0, BED.gunY, BED.gunZ);
  turretPivot.add(gunPivot);
  const gunRecoilGroup = new THREE.Group();
  gunPivot.add(gunRecoilGroup);

  const bb = makeBucket(); // beam geometry (elevates with gunPivot)
  bb.rbox(dark, BED.headW, BED.headH, BED.headD, 0.05, 0, 0.18, BED.headZ);
  const sensor = bedMat('#273e49', 0.16, 0.63, 2);
  bb.cyl(black, .114, .13, .13, 14, 0, .22, .475, Math.PI / 2);
  bb.cyl(sensor, .081, .092, .016, 14, 0, .22, .548, Math.PI / 2);
  bb.cyl(steel, 0.05, 0.05, 0.16, 8, 0, BED.headH * 0.5 + 0.05, BED.headZ);
  const tubeLocal: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    const cx = sx * BED.canX;
    bb.rbox(steel, BED.canW, BED.canH, 0.22, 0.035, cx, 0.02, BED.canZ - 0.42);
    bb.rbox(steel, BED.canW, BED.canH, 0.19, 0.035, cx, 0.02, BED.canZ + 0.49);
    for (const [ty, tz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const mx = cx + (ty * BED.canW) / 5;
      const my = 0.02 + (tz * BED.canH) / 5;
      const mz = BED.canZ + BED.canD / 2 + 0.005;
      bb.cyl(paint, 0.102, 0.102, BED.canD, 12, mx, my, BED.canZ, Math.PI / 2);
      bb.cyl(black, 0.082, 0.082, 0.036, 12, mx, my, mz, Math.PI / 2);
      bb.put(steel, new THREE.TorusGeometry(0.091, 0.01, 6, 12), mx, my, mz + 0.017);
      tubeLocal.push(new THREE.Vector3(mx, my, mz));
    }
  }
  bb.flush(gunRecoilGroup);

  // rocketMeshes: one cap per tube mouth — hidden as each SAM launches
  const rocketMeshes: THREE.Object3D[] = tubeLocal.map((p) => {
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.035, 12),
      black
    );
    cap.rotation.x = Math.PI / 2;
    cap.position.copy(p);
    cap.position.z += 0.012;
    gunRecoilGroup.add(cap);
    return cap;
  });

  const muzzleNode = new THREE.Object3D();
  muzzleNode.name = 'muzzle_datum';
  muzzleNode.position.set(0, 0.1, BED.canZ + BED.canD / 2 + 0.15);
  gunRecoilGroup.add(muzzleNode);
  const coaxNode = new THREE.Object3D();
  coaxNode.name = 'coax_datum';
  coaxNode.position.copy(muzzleNode.position);
  gunRecoilGroup.add(coaxNode);

  const articulate = () => {
    radarAngle += 0.018; // ~1 rev / 5.8 s at 60 fps — slow search scan
    radarPanel.rotation.y = radarAngle;
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
