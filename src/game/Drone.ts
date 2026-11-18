import * as THREE from 'three';
import { intersectSegmentTank } from './Ballistics';
import { buildFpvDrone } from './models/SupportVehicle';
import type { DamageEvent, ObstacleCollider, ShellSpec, TankEntity, Team } from './types';
import type { World } from './World';
import type { EffectsManager } from './Effects';

/**
 * FPV drone. One airborne per vehicle; 9 s cooldown (player),
 * 25 s (bots). Piloted flights have no link or battery cutoff.
 * Impact detonates; RMB aborts flight and lets the drone fall.
 */

export const FPV_WARHEAD_SPEC: ShellSpec = {
  id: 'fpv_warhead',
  shortCode: 'FPV',
  displayName: 'FPV WARHEAD',
  muzzleSpeed: 0,
  directDamage: 650,
  splashDamage: 520,
  splashRadius: 9,
  penetrationDepth: 0.8,
  penMm: 260,
  moduleDamage: { slug: 2, spall: 0.8, spallCount: 14 },
  spallCount: 10,
  spallWeight: 0.5,
  explosionScale: 1.35,
  tracerColorRGB: [9, 9, 9],
  dispersionRad: 0,
};

const BOT_FLIGHT_TIME = 65;
const PLAYER_COOLDOWN = 9;
const BOT_COOLDOWN = 25;
const BOT_SPEED = 26 * 0.6;
const PLAYER_MIN_SPEED = 0;
const PLAYER_MAX_SPEED = 34;
const PLAYER_DEFAULT_SPEED = 24;

export type DronePhase = 'launch' | 'fly' | 'fall' | 'dead';

export interface DroneWorldCtx {
  world: World;
  effects: EffectsManager;
}

let droneSeq = 0;

const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _tmp3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _motion = new THREE.Vector3();
const _tankCenter = new THREE.Vector3();

export class DroneEntity {
  public readonly id = `drone_${++droneSeq}`;
  public readonly team: Team;
  public readonly operator: TankEntity | null;
  public readonly isBot: boolean;
  public phase: DronePhase = 'launch';
  public readonly group = buildFpvDrone();
  public readonly pos: THREE.Vector3; // === group.position
  public readonly vel = new THREE.Vector3();
  public yaw = 0;
  public pitch = 0;
  public roll = 0;
  public speed = 0;
  public airTime = 0;
  public launchT = 0;
  public autopilot: boolean;
  public readonly rotors: THREE.Object3D[] = [];
  private readonly _prevPos = new THREE.Vector3();
  private aimYaw: number;
  private aimPitch = 0;
  private readonly cameraMount = this.group.getObjectByName('fpv_camera')!;

  constructor(team: Team, operator: TankEntity | null, isBot: boolean, autopilot: boolean, spawnPos: THREE.Vector3, yaw: number) {
    this.team = team;
    this.operator = operator;
    this.isBot = isBot;
    this.autopilot = autopilot;
    this.pos = this.group.position;
    this.pos.copy(spawnPos);
    this._prevPos.copy(spawnPos);
    this.yaw = this.aimYaw = yaw;
    this.group.traverse((o) => {
      if (o.userData.spin) this.rotors.push(o);
    });
    this.group.rotation.order = 'YXZ';
    this.syncMesh();
  }

  public get alive(): boolean {
    return this.phase !== 'dead';
  }

  public getCameraPose(pos: THREE.Vector3, quat: THREE.Quaternion): void {
    this.cameraMount.getWorldPosition(pos);
    this.cameraMount.getWorldQuaternion(quat);
  }

  public dispose(): void {
    this.group.removeFromParent();
    const resources = new Set<THREE.BufferGeometry | THREE.Material>();
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      resources.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) resources.add(m);
    });
    for (const resource of resources) resource.dispose();
    const docked = this.operator?.root.getObjectByName('fpv_drone');
    if (docked) docked.visible = true;
  }

  public forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  /** Advance one sim step. `input` is null for autopilot/bot drones. */
  public step(
    dt: number,
    input: { dmx: number; dmy: number; up: boolean; down: boolean; keys: ReadonlySet<string> } | null,
    mgr: DroneManager
  ): void {
    if (this.phase === 'dead') return;
    this._prevPos.copy(this.pos);
    this.airTime += dt;

    // rotor blur always spins while airborne
    const rotorSpeed = this.phase === 'fly' ? 55 : 18;
    for (const r of this.rotors) r.rotation.y += r.userData.spin * rotorSpeed * dt;

    if (this.phase === 'launch') {
      // rise 3 m to hand-over, then control begins
      this.launchT += dt;
      this.pos.y += 3.4 * dt;
      this.speed = 0;
      if (this.launchT >= 0.9) {
        this.phase = 'fly';
        this.pos.y += 0.4;
      }
      this.syncMesh();
      return;
    }

    if (this.phase === 'fall') {
      // tumble down: mild forward drift + sink, then detonate on contact
      this.vel.y -= 9.8 * dt;
      this.roll += 7 * dt;
      this.pitch += 3 * dt;
    } else if (this.autopilot) {
      this.stepAutopilot(dt, mgr);
    } else {
      // Null input is a paused or unfocused pilot, not an autopilot command.
      if (!input) return;
      this.stepPlayer(dt, input);
    }
    // integrate (_prevPos stays at pre-step pos -> segment for contact tests)
    this.pos.addScaledVector(this.vel, dt);

    const bound = mgr.world.worldHalfSize;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -bound, bound);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -bound, bound);
    if (this.checkImpact(mgr)) return;
    if (this.isBot && this.phase === 'fly' && this.airTime >= BOT_FLIGHT_TIME) {
      this.phase = 'fall';
      this.vel.multiplyScalar(0.4);
      this.vel.y = Math.min(this.vel.y, 0);
    }
    this.syncMesh();
  }

  private checkImpact(mgr: DroneManager): boolean {
    const { x, y, z } = this.pos;
    const ground = mgr.world.getHeightAt(x, z);
    const depth = mgr.world.getWaterDepthAt(x, z);
    const surface = ground + depth;
    const dir = _motion.subVectors(this.pos, this._prevPos);
    const length = dir.length();
    const surfaceDist = y <= surface + 0.12
      ? length * THREE.MathUtils.clamp((this._prevPos.y - surface - 0.12) / Math.max(0.001, this._prevPos.y - y), 0, 1)
      : Infinity;
    const worldHit = length > 0.001
      ? mgr.world.raycastWorld(this._prevPos, dir.multiplyScalar(1 / length), length)
      : null;
    let contactDist = Math.min(surfaceDist, worldHit?.distance ?? Infinity);
    let hitTank: TankEntity | null = null;
    if (length > 0.001) {
      for (const tank of mgr.allTanks) {
        if (!tank.alive || (tank === this.operator && this.airTime < 1.3)) continue;
        const dist = intersectSegmentTank(this._prevPos, dir, length, tank, 0.12, _tankCenter);
        if (dist !== null && dist < contactDist) {
          contactDist = dist;
          hitTank = tank;
        }
      }
    }
    if (!Number.isFinite(contactDist)) return false;
    this.pos.copy(this._prevPos).addScaledVector(dir, contactDist);
    if (hitTank) mgr.detonate(this, undefined, hitTank);
    else if (worldHit && worldHit.distance < surfaceDist) mgr.detonate(this, worldHit.obstacle);
    else if (depth > 0.03) mgr.splash(this, surface);
    else mgr.detonate(this);
    return true;
  }

  private stepPlayer(dt: number, input: { dmx: number; dmy: number; up: boolean; down: boolean; keys: ReadonlySet<string> }): void {
    const a = input.keys.has('KeyA') || input.keys.has('ArrowLeft') ? 1 : 0;
    const d = input.keys.has('KeyD') || input.keys.has('ArrowRight') ? 1 : 0;
    this.aimYaw += -input.dmx * 0.0028 + (a - d) * 1.8 * dt;
    this.aimPitch = THREE.MathUtils.clamp(this.aimPitch - input.dmy * 0.0024, -1.15, 1.15);
    const turn = (this.aimYaw - this.yaw) * (1 - Math.exp(-14 * dt));
    this.yaw += turn;
    this.pitch = THREE.MathUtils.damp(this.pitch, this.aimPitch, 14, dt);

    // Hold reverse throttle to hover, or release for cruise speed.
    if (input.up) this.speed = Math.min(this.speed + 26 * dt, PLAYER_MAX_SPEED);
    else if (input.down) this.speed = Math.max(this.speed - 26 * dt, PLAYER_MIN_SPEED);
    else this.speed += (PLAYER_DEFAULT_SPEED - this.speed) * (1 - Math.exp(-1.5 * dt));

    const bankT = THREE.MathUtils.clamp(-turn / dt * 0.35, -0.5, 0.5);
    this.roll += (bankT - this.roll) * (1 - Math.exp(-6 * dt));

    this.forward(_fwd);
    this.vel.copy(_fwd).multiplyScalar(this.speed);
  }

  private stepAutopilot(dt: number, mgr: DroneManager): void {
    // climb to 20 m AGL, cruise 26 m/s at predicted target pos;
    // inside 50 m horizontal -> dive with PN-style steering, impact.
    const tgt = this._autopilotTarget?.alive ? this._autopilotTarget : mgr.pickBotTarget(this);
    let yawStep = 0;
    if (!tgt) {
      // no target: orbit slowly / hold
      this.yaw += 0.3 * dt;
      this.speed = Math.max(this.isBot ? 4.8 : 8, this.speed - 10 * dt);
    } else {
      const dx = tgt.position.x - this.pos.x;
      const dz = tgt.position.z - this.pos.z;
      const horiz = Math.hypot(dx, dz);
      // cruise altitude grows with range so the terminal dive arrives steep
      const cruiseAlt = Math.min(70, 20 + horiz * 0.18);
      const tAlt = mgr.world.getHeightAt(this.pos.x, this.pos.z) + cruiseAlt;
      // lead the target
      const tof = horiz / BOT_SPEED;
      const aimX = tgt.position.x + (tgt.velocity?.x ?? 0) * tof * 0.85;
      const aimZ = tgt.position.z + (tgt.velocity?.z ?? 0) * tof * 0.85;
      const aimY = tgt.position.y + 1.2;
      const adx = aimX - this.pos.x;
      const ady = aimY - this.pos.y;
      const adz = aimZ - this.pos.z;
      const desiredYaw = Math.atan2(adx, adz);
      const dive = horiz < 42;
      let desiredPitch: number;
      if (dive) {
        // terminal: pure-pursuit intercept — altitude was gained during
        // cruise, so the geometric dive arrives steep (top attack)
        desiredPitch = Math.atan2(ady, Math.max(Math.hypot(adx, adz), 4));
      } else {
        // cruise: hold cruiseAlt AGL toward the predicted point
        desiredPitch = THREE.MathUtils.clamp((tAlt - this.pos.y) * 0.07, -0.3, 0.6);
      }
      let dy = desiredYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const turnRate = dive ? 3.0 : 1.4;
      yawStep = THREE.MathUtils.clamp(dy, -turnRate * dt, turnRate * dt);
      this.yaw += yawStep;
      const pitchRate = dive ? 3.2 : 1.0;
      this.pitch += THREE.MathUtils.clamp(desiredPitch - this.pitch, -pitchRate * dt, pitchRate * dt);
      const targetSpeed = dive ? 48 * 0.6 : BOT_SPEED;
      this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-1.8 * dt));
    }
    // slight bank into turns
    this.roll = THREE.MathUtils.damp(this.roll, THREE.MathUtils.clamp(-yawStep / dt * 0.2, -0.4, 0.4), 6, dt);
    this.forward(_fwd);
    this.vel.copy(_fwd).multiplyScalar(this.speed);
  }

  private _autopilotTarget: TankEntity | null = null;
  public setAutopilotTarget(t: TankEntity | null): void {
    this._autopilotTarget = t;
  }

  private syncMesh(): void {
    this.group.rotation.set(-this.pitch, this.yaw, this.roll);
  }
}

export class DroneManager {
  public readonly drones: DroneEntity[] = [];
  private readonly cooldowns = new Map<TankEntity, number>();
  public allTanks: readonly TankEntity[] = [];
  public world!: World;
  public effects!: EffectsManager;
  public onDamage?: (event: DamageEvent) => void;
  /** Set by main each frame: live player drone input or null. */
  public playerInput: {
    dmx: number;
    dmy: number;
    up: boolean;
    down: boolean;
    keys: ReadonlySet<string>;
  } | null = null;
  public readonly stats = { launched: 0, hits: 0, shotDown: 0, lost: 0 };
  public botLaunchesEnabled = true;
  public lastDetonation = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), shooter: null as TankEntity | null, t: -99 };

  public cooldownLeft(t: TankEntity): number {
    return Math.max(0, this.cooldowns.get(t) ?? 0);
  }

  public activeFor(t: TankEntity): DroneEntity | null {
    for (const d of this.drones) if (d.operator === t && d.alive) return d;
    return null;
  }

  public get playerDrone(): DroneEntity | null {
    return this.drones.find((d) => !d.isBot && d.alive) ?? null;
  }

  public launch(t: TankEntity, opts: { autopilot?: boolean; target?: TankEntity | null } = {}): DroneEntity | null {
    if (this.cooldownLeft(t) > 0 || this.activeFor(t)) return null;
    // spawn at the drone bay (rear of bed) lifted slightly
    const bay = _tmp.set(0, 0.7, -3.1).applyAxisAngle(THREE.Object3D.DEFAULT_UP, t.hullYaw).add(t.position);
    bay.y = this.world.getHeightAt(bay.x, bay.z) + 1.6;
    const docked = t.root.getObjectByName('fpv_drone');
    if (docked) docked.getWorldPosition(bay);
    const d = new DroneEntity(t.team, t, !t.isHuman, opts.autopilot ?? !t.isHuman, bay, t.turretWorldYaw);
    if (docked) docked.visible = false;
    if (opts.target) d.setAutopilotTarget(opts.target);
    this.drones.push(d);
    if (t.isHuman) this.cooldowns.set(t, PLAYER_COOLDOWN);
    this.stats.launched++;
    return d;
  }

  public update(dt: number, scene: THREE.Scene, running = true): void {
    if (!running) return;
    // cooldowns
    for (const [t, c] of this.cooldowns) {
      const nc = c - dt;
      if (nc <= 0) this.cooldowns.delete(t);
      else this.cooldowns.set(t, nc);
    }
    // step (add to scene once, remove on death)
    const inp = this.playerInput;
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const d = this.drones[i];
      if (d.phase === 'dead') {
        d.dispose();
        this.drones.splice(i, 1);
        continue;
      }
      if (!d.group.parent) scene.add(d.group);
      if (d.autopilot || inp) d.step(dt, d.isBot ? null : inp, this);
    }
    // bot launches: support bots send a drone at 120-450 m
    for (const t of this.botLaunchesEnabled ? this.allTanks : []) {
      if (!t.alive || t.isHuman || t.stats.vehicleClass !== 'support') continue;
      if (this.cooldownLeft(t) > 0 || this.activeFor(t)) continue;
      // nearest enemy within band
      let best: TankEntity | null = null;
      let bd = Infinity;
      for (const e of this.allTanks) {
        if (!e.alive || e.team === t.team) continue;
        const dist = e.position.distanceTo(t.position);
        if (dist >= 120 && dist <= 450 && dist < bd) { bd = dist; best = e; }
      }
      if (best) this.launch(t, { autopilot: true, target: best });
    }
  }

  /** Warhead detonation: contact tank takes the shaped charge, neighbours
   *  take splash through takeDamage's blast path. */
  public detonate(d: DroneEntity, obstacle?: ObstacleCollider, contact?: TankEntity): void {
    if (d.phase === 'dead') return;
    d.phase = 'dead';
    const pos = d.pos;
    const dir = d.vel.lengthSq() > 0.1 ? _tmp3.copy(d.vel).normalize() : _tmp3.set(0, -1, 0);
    this.effects.spawnExplosion(pos, _tmp2.copy(_up).addScaledVector(dir, -0.3).normalize(), FPV_WARHEAD_SPEC.explosionScale, 'he_armor');
    this.effects.spawnExplosion(pos, _up, 0.8, 'he_ground');
    if (obstacle) this.world.damageObstacle(obstacle, FPV_WARHEAD_SPEC.directDamage, dir.x, dir.z);
    const blastRadius = FPV_WARHEAD_SPEC.splashRadius;
    this.world.blastObstacles(pos.x, pos.y, pos.z, blastRadius, FPV_WARHEAD_SPEC.splashDamage);

    const shooter = d.operator;
    let nearTank = false;
    for (const t of this.allTanks) {
      if (!t.alive) continue;
      if (t.team === d.team) continue;
      const dist = t.getCenterMassWorld(_tmp).distanceTo(pos);
      const hullRadius = t.stats.collisionRadius + 1.4;
      if (dist > blastRadius + hullRadius) continue;
      nearTank = true;
      const fall = Math.max(0, 1 - Math.max(0, dist - hullRadius) / blastRadius);
      // hit point = the warhead itself; velocity dir decides the entry face
      // (steep dive -> top armour, level pass -> side armour)
      const hitPos = _tmp.copy(pos);
      const behind = _tmp2.copy(pos).addScaledVector(dir, -3);
      const killed = t.takeDamage(
        FPV_WARHEAD_SPEC.directDamage * fall,
        hitPos,
        behind,
        t === contact ? dir : undefined,
        'cannon',
        FPV_WARHEAD_SPEC,
        { attacker: shooter, blastCenter: pos, blastRadius }
      );
      this.onDamage?.({ victim: t, attacker: shooter, amount: FPV_WARHEAD_SPEC.directDamage * fall, killed, hitPoint: pos, weapon: 'cannon', xrayReport: t.lastXRayReport });
    }
    if (nearTank) this.stats.hits++;
    // remember for droneTest stats
    this.lastDetonation.pos.copy(pos);
    this.lastDetonation.vel.copy(d.vel);
    this.lastDetonation.shooter = shooter;
    this.lastDetonation.t = performance.now() / 1000;
    if (d.isBot && d.operator) this.cooldowns.set(d.operator, BOT_COOLDOWN);
  }

  public splash(d: DroneEntity, level: number): void {
    this.stats.lost++;
    d.pos.y = level;
    this.effects.spawnWaterSplash(d.pos);
    this.detonate(d);
  }

  /** Autopilot target picker for bot drones (nearest enemy 120-450 m). */
  public pickBotTarget(d: DroneEntity): TankEntity | null {
    if (!d.operator) return null;
    let best: TankEntity | null = null;
    let bd = Infinity;
    for (const e of this.allTanks) {
      if (!e.alive || e.team === d.team) continue;
      const dist = e.position.distanceTo(d.pos);
      if (dist < bd) { bd = dist; best = e; }
    }
    return best;
  }

  /** FPV HUD telemetry for the human's active drone. */
  public fpvTelemetry(): {
    speedKmh: number;
    altM: number;
    rangeM: number;
    cooldown: number;
  } | null {
    const d = this.playerDrone;
    if (!d || !d.operator) return null;
    const rangeM = d.pos.distanceTo(d.operator.position);
    const agl = d.pos.y - (this.world?.getHeightAt(d.pos.x, d.pos.z) ?? 0);
    return {
      speedKmh: Math.round(d.speed * 3.6),
      altM: Math.round(agl),
      rangeM: Math.round(rangeM),
      cooldown: this.cooldownLeft(d.operator),
    };
  }

  /** Panel status string for the support's weapon slot 2. */
  public slotStatus(t: TankEntity): { text: string; airborne: boolean } {
    const d = this.activeFor(t);
    if (d) return { text: 'FPV AIRBORNE', airborne: true };
    const cd = this.cooldownLeft(t);
    if (cd > 0) return { text: `FPV ${Math.ceil(cd)} S`, airborne: false };
    return { text: 'FPV READY', airborne: false };
  }
}
