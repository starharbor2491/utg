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
  canD: 1.5,
  canX: 0.58,
  canZ: 0.75,
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

/** Reusable FPV quadcopter airframe: X-frame arms, 4 rotor discs, payload
 *  tube underneath. F5b flies this; F5a displays it on the drone bay. */
export function buildFpvDrone(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'fpv_drone';
  const frameMat = new THREE.MeshStandardMaterial({ color: '#22262a', roughness: 0.6, metalness: 0.5 });
  const accentMat = new THREE.MeshStandardMaterial({ color: '#8a4a2a', roughness: 0.55, metalness: 0.3 });
  const rotorMat = new THREE.MeshStandardMaterial({ color: '#0c0d0e', roughness: 0.9, metalness: 0.1, transparent: true, opacity: 0.55 });
  const armGeo = new THREE.BoxGeometry(0.62, 0.03, 0.05);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(armGeo, frameMat);
    arm.rotation.y = s * Math.PI / 4;
    arm.position.y = 0.02;
    g.add(arm);
  }
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.07, 0.22, 2, 0.02), accentMat);
  body.position.y = 0.06;
  g.add(body);
  const payload = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 10), frameMat);
  payload.rotation.x = Math.PI / 2;
  payload.position.set(0, -0.06, 0.05);
  g.add(payload);
  const motorGeo = new THREE.CylinderGeometry(0.028, 0.034, 0.05, 8);
  const discGeo = new THREE.CircleGeometry(0.11, 20);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const px = sx * 0.21;
    const pz = sz * 0.21;
    const motor = new THREE.Mesh(motorGeo, frameMat);
    motor.position.set(px, 0.05, pz);
    g.add(motor);
    const disc = new THREE.Mesh(discGeo, rotorMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(px, 0.085, pz);
    g.add(disc);
  }
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

  const paint = bedMat(isBlue ? '#4a5238' : '#6b5d43', 0.6, 0.28);
  const dark = bedMat(isBlue ? '#333a26' : '#4c3f2a', 0.66, 0.24);
  const steel = bedMat('#2c2f2c', 0.45, 0.72);
  const black = bedMat('#141517', 0.7, 0.4);
  const radarMat = bedMat(isBlue ? '#c8c4ae' : '#b8b4a0', 0.5, 0.35);

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

  // drone bay crate at the very rear of the bed + quadcopter on top
  tb.rbox(paint, 1.15, 0.34, 0.95, 0.04, 0, 0.19, BED.bayZ);
  tb.box(dark, 1.0, 0.03, 0.8, 0, 0.37, BED.bayZ); // lid
  for (const sx of [-1, 1]) tb.box(black, 0.06, 0.1, 0.7, sx * 0.5, 0.42, BED.bayZ);
  tb.flush(turretPivot);
  const drone = buildFpvDrone();
  drone.position.set(0, 0.55, BED.bayZ);
  drone.rotation.y = 0.5;
  turretPivot.add(drone);

  // radar panel (spins via articulate)
  const radarPanel = new THREE.Mesh(new RoundedBoxGeometry(0.72, 0.4, 0.05, 2, 0.02), radarMat);
  radarPanel.position.set(0, BED.ringH + BED.drumH + 0.62, BED.mastZ);
  radarPanel.castShadow = true;
  turretPivot.add(radarPanel);
  const radarFace = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.02), black);
  radarFace.position.set(0, 0, 0.035);
  radarPanel.add(radarFace);
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
  bb.box(black, BED.headW * 0.7, 0.1, 0.1, 0, BED.headH * 0.32, BED.headZ + BED.headD * 0.42);
  bb.cyl(steel, 0.05, 0.05, 0.16, 8, 0, BED.headH * 0.5 + 0.05, BED.headZ);
  const tubeLocal: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    const cx = sx * BED.canX;
    bb.rbox(paint, BED.canW, BED.canH, BED.canD, 0.04, cx, 0.02, BED.canZ);
    bb.box(dark, BED.canW * 0.96, 0.02, BED.canD * 0.9, cx, BED.canH / 2 + 0.005, BED.canZ);
    for (const lz of [-0.4, 0.4]) bb.box(black, 0.05, 0.08, 0.1, cx + sx * (BED.canW / 2 - 0.02), 0.02, BED.canZ + lz * BED.canD);
    for (const [ty, tz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const mx = cx + (ty * BED.canW) / 5;
      const my = 0.02 + (tz * BED.canH) / 5;
      const mz = BED.canZ + BED.canD / 2 + 0.005;
      bb.cyl(black, 0.075, 0.075, 0.03, 12, mx, my, mz, Math.PI / 2, 0, 0);
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
