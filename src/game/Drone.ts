import type { Entity } from 'playcanvas';
import { intersectSegmentTank } from './Ballistics';
import { buildFpvDrone } from './models/SupportVehicle';
import type { DamageEvent, ObstacleCollider, ShellSpec, TankEntity, Team } from './types';
import type { World } from './World';
import type { EffectsManager } from './Effects';
import { applyAxisAngle, clamp, damp, Quat, setLocalEulerRad, Vec3 } from './engine/math';
import { findByName, setVisible, userData } from './engine/scene';

export const FPV_WARHEAD_SPEC: ShellSpec = {
  id: 'fpv_warhead', shortCode: 'FPV', displayName: 'FPV WARHEAD', muzzleSpeed: 0,
  directDamage: 650, splashDamage: 520, splashRadius: 9, penetrationDepth: 0.8, penMm: 260,
  moduleDamage: { slug: 2, spall: 0.8, spallCount: 14 }, spallCount: 10, spallWeight: 0.5,
  explosionScale: 1.35, tracerColorRGB: [9, 9, 9], dispersionRad: 0,
};

const BOT_FLIGHT_TIME = 65, PLAYER_COOLDOWN = 9, BOT_COOLDOWN = 25, BOT_SPEED = 26 * 0.6;
const PLAYER_MIN_SPEED = 0, PLAYER_MAX_SPEED = 34, PLAYER_DEFAULT_SPEED = 24;

export type DronePhase = 'launch' | 'fly' | 'fall' | 'dead';

let droneSeq = 0;
const _fwd = new Vec3(), _tmp = new Vec3(), _tmp2 = new Vec3(), _tmp3 = new Vec3();
const _up = new Vec3(0, 1, 0), _motion = new Vec3(), _tankCenter = new Vec3();

export class DroneEntity {
  public readonly id = `drone_${++droneSeq}`;
  public readonly team: Team;
  public readonly operator: TankEntity | null;
  public readonly isBot: boolean;
  public phase: DronePhase = 'launch';
  public readonly group = buildFpvDrone();
  public readonly pos: Vec3;
  public readonly vel = new Vec3();
  public yaw = 0;
  public pitch = 0;
  public roll = 0;
  public speed = 0;
  public airTime = 0;
  public launchT = 0;
  public autopilot: boolean;
  public readonly rotors: Entity[] = [];
  private readonly rotorAngles: number[] = [];
  private readonly _prevPos = new Vec3();
  private aimYaw: number;
  private aimPitch = 0;
  private readonly cameraMount: Entity;

  constructor(team: Team, operator: TankEntity | null, isBot: boolean, autopilot: boolean, spawnPos: Vec3, yaw: number) {
    this.team = team;
    this.operator = operator;
    this.isBot = isBot;
    this.autopilot = autopilot;
    this.pos = spawnPos.clone();
    this._prevPos.copy(spawnPos);
    this.yaw = this.aimYaw = yaw;
    this.cameraMount = findByName(this.group, 'fpv_camera')!;
    this.group.forEach((node) => {
      if (userData(node).spin) {
        this.rotors.push(node as Entity);
        this.rotorAngles.push(0);
      }
    });
    this.syncMesh();
  }

  public get alive(): boolean { return this.phase !== 'dead'; }

  public getCameraPose(pos: Vec3, quat: Quat): void {
    pos.copy(this.cameraMount.getPosition());
    quat.copy(this.cameraMount.getRotation());
  }

  public dispose(): void {
    this.group.destroy();
    const docked = this.operator ? findByName(this.operator.root, 'fpv_drone') : null;
    if (docked) setVisible(docked, true);
  }

  public forward(out: Vec3): Vec3 {
    return out.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  public step(
    dt: number,
    input: { dmx: number; dmy: number; up: boolean; down: boolean; keys: ReadonlySet<string> } | null,
    mgr: DroneManager
  ): void {
    if (this.phase === 'dead') return;
    this._prevPos.copy(this.pos);
    this.airTime += dt;
    const rotorSpeed = this.phase === 'fly' ? 55 : 18;
    for (let i = 0; i < this.rotors.length; i++) {
      this.rotorAngles[i] += Number(userData(this.rotors[i]).spin) * rotorSpeed * dt;
      setLocalEulerRad(this.rotors[i], 0, this.rotorAngles[i], 0);
    }

    if (this.phase === 'launch') {
      this.launchT += dt;
      this.pos.y += 3.4 * dt;
      this.speed = 0;
      if (this.launchT >= 0.9) { this.phase = 'fly'; this.pos.y += 0.4; }
      this.syncMesh();
      return;
    }
    if (this.phase === 'fall') {
      this.vel.y -= 9.8 * dt;
      this.roll += 7 * dt;
      this.pitch += 3 * dt;
    } else if (this.autopilot) {
      this.stepAutopilot(dt, mgr);
    } else {
      if (!input) return;
      this.stepPlayer(dt, input);
    }
    this.pos.addScaled(this.vel, dt);
    const bound = mgr.world.worldHalfSize;
    this.pos.x = clamp(this.pos.x, -bound, bound);
    this.pos.z = clamp(this.pos.z, -bound, bound);
    if (this.checkImpact(mgr)) return;
    if (this.isBot && this.phase === 'fly' && this.airTime >= BOT_FLIGHT_TIME) {
      this.phase = 'fall';
      this.vel.mulScalar(0.4);
      this.vel.y = Math.min(this.vel.y, 0);
    }
    this.syncMesh();
  }

  private checkImpact(mgr: DroneManager): boolean {
    const { x, y, z } = this.pos;
    const ground = mgr.world.getHeightAt(x, z), depth = mgr.world.getWaterDepthAt(x, z), surface = ground + depth;
    const dir = _motion.sub2(this.pos, this._prevPos), length = dir.length();
    const surfaceDist = y <= surface + 0.12
      ? length * clamp((this._prevPos.y - surface - 0.12) / Math.max(0.001, this._prevPos.y - y), 0, 1)
      : Infinity;
    const worldHit = length > 0.001 ? mgr.world.raycastWorld(this._prevPos, dir.mulScalar(1 / length), length) : null;
    let contactDist = Math.min(surfaceDist, worldHit?.distance ?? Infinity);
    let hitTank: TankEntity | null = null;
    if (length > 0.001) {
      for (const tank of mgr.allTanks) {
        if (!tank.alive || (tank === this.operator && this.airTime < 1.3)) continue;
        const dist = intersectSegmentTank(this._prevPos, dir, length, tank, 0.12, _tankCenter);
        if (dist !== null && dist < contactDist) { contactDist = dist; hitTank = tank; }
      }
    }
    if (!Number.isFinite(contactDist)) return false;
    this.pos.copy(this._prevPos).addScaled(dir, contactDist);
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
    this.aimPitch = clamp(this.aimPitch - input.dmy * 0.0024, -1.15, 1.15);
    const turn = (this.aimYaw - this.yaw) * (1 - Math.exp(-14 * dt));
    this.yaw += turn;
    this.pitch = damp(this.pitch, this.aimPitch, 14, dt);
    if (input.up) this.speed = Math.min(this.speed + 26 * dt, PLAYER_MAX_SPEED);
    else if (input.down) this.speed = Math.max(this.speed - 26 * dt, PLAYER_MIN_SPEED);
    else this.speed += (PLAYER_DEFAULT_SPEED - this.speed) * (1 - Math.exp(-1.5 * dt));
    const bankT = clamp(-turn / dt * 0.35, -0.5, 0.5);
    this.roll += (bankT - this.roll) * (1 - Math.exp(-6 * dt));
    this.forward(_fwd);
    this.vel.copy(_fwd).mulScalar(this.speed);
  }

  private stepAutopilot(dt: number, mgr: DroneManager): void {
    const tgt = this._autopilotTarget?.alive ? this._autopilotTarget : mgr.pickBotTarget(this);
    let yawStep = 0;
    if (!tgt) {
      this.yaw += 0.3 * dt;
      this.speed = Math.max(this.isBot ? 4.8 : 8, this.speed - 10 * dt);
    } else {
      const dx = tgt.position.x - this.pos.x, dz = tgt.position.z - this.pos.z, horiz = Math.hypot(dx, dz);
      const cruiseAlt = Math.min(70, 20 + horiz * 0.18);
      const tAlt = mgr.world.getHeightAt(this.pos.x, this.pos.z) + cruiseAlt;
      const tof = horiz / BOT_SPEED;
      const aimX = tgt.position.x + (tgt.velocity?.x ?? 0) * tof * 0.85;
      const aimZ = tgt.position.z + (tgt.velocity?.z ?? 0) * tof * 0.85;
      const aimY = tgt.position.y + 1.2;
      const adx = aimX - this.pos.x, ady = aimY - this.pos.y, adz = aimZ - this.pos.z;
      const desiredYaw = Math.atan2(adx, adz), dive = horiz < 42;
      const desiredPitch = dive ? Math.atan2(ady, Math.max(Math.hypot(adx, adz), 4)) : clamp((tAlt - this.pos.y) * 0.07, -0.3, 0.6);
      let dy = desiredYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const turnRate = dive ? 3.0 : 1.4;
      yawStep = clamp(dy, -turnRate * dt, turnRate * dt);
      this.yaw += yawStep;
      const pitchRate = dive ? 3.2 : 1.0;
      this.pitch += clamp(desiredPitch - this.pitch, -pitchRate * dt, pitchRate * dt);
      const targetSpeed = dive ? 48 * 0.6 : BOT_SPEED;
      this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-1.8 * dt));
    }
    this.roll = damp(this.roll, clamp(-yawStep / dt * 0.2, -0.4, 0.4), 6, dt);
    this.forward(_fwd);
    this.vel.copy(_fwd).mulScalar(this.speed);
  }

  private _autopilotTarget: TankEntity | null = null;
  public setAutopilotTarget(t: TankEntity | null): void { this._autopilotTarget = t; }

  private syncMesh(): void {
    this.group.setLocalPosition(this.pos);
    setLocalEulerRad(this.group, -this.pitch, this.yaw, this.roll, 'YXZ');
  }
}

export class DroneManager {
  public readonly drones: DroneEntity[] = [];
  private readonly cooldowns = new Map<TankEntity, number>();
  public allTanks: readonly TankEntity[] = [];
  public world!: World;
  public effects!: EffectsManager;
  public onDamage?: (event: DamageEvent) => void;
  public playerInput: { dmx: number; dmy: number; up: boolean; down: boolean; keys: ReadonlySet<string> } | null = null;
  public readonly stats = { launched: 0, hits: 0, shotDown: 0, lost: 0 };
  public botLaunchesEnabled = true;
  public lastDetonation = { pos: new Vec3(), vel: new Vec3(), shooter: null as TankEntity | null, t: -99 };

  public cooldownLeft(t: TankEntity): number { return Math.max(0, this.cooldowns.get(t) ?? 0); }
  public activeFor(t: TankEntity): DroneEntity | null {
    for (const d of this.drones) if (d.operator === t && d.alive) return d;
    return null;
  }
  public get playerDrone(): DroneEntity | null { return this.drones.find((d) => !d.isBot && d.alive) ?? null; }

  public launch(t: TankEntity, opts: { autopilot?: boolean; target?: TankEntity | null } = {}): DroneEntity | null {
    if (this.cooldownLeft(t) > 0 || this.activeFor(t)) return null;
    const bay = applyAxisAngle(_tmp.set(0, 0.7, -3.1), Vec3.UP, t.hullYaw).add(t.position);
    bay.y = this.world.getHeightAt(bay.x, bay.z) + 1.6;
    const docked = findByName(t.root, 'fpv_drone');
    if (docked) bay.copy(docked.getPosition());
    const d = new DroneEntity(t.team, t, !t.isHuman, opts.autopilot ?? !t.isHuman, bay, t.turretWorldYaw);
    if (docked) setVisible(docked, false);
    if (opts.target) d.setAutopilotTarget(opts.target);
    this.drones.push(d);
    if (t.isHuman) this.cooldowns.set(t, PLAYER_COOLDOWN);
    this.stats.launched++;
    return d;
  }

  public update(dt: number, scene: Entity, running = true): void {
    if (!running) return;
    for (const [t, c] of this.cooldowns) {
      const nc = c - dt;
      if (nc <= 0) this.cooldowns.delete(t); else this.cooldowns.set(t, nc);
    }
    const inp = this.playerInput;
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const d = this.drones[i];
      if (d.phase === 'dead') { d.dispose(); this.drones.splice(i, 1); continue; }
      if (!d.group.parent) scene.addChild(d.group);
      if (d.autopilot || inp) d.step(dt, d.isBot ? null : inp, this);
    }
    for (const t of this.botLaunchesEnabled ? this.allTanks : []) {
      if (!t.alive || t.isHuman || t.stats.vehicleClass !== 'support') continue;
      if (this.cooldownLeft(t) > 0 || this.activeFor(t)) continue;
      let best: TankEntity | null = null, bd = Infinity;
      for (const e of this.allTanks) {
        if (!e.alive || e.team === t.team) continue;
        const dist = e.position.distance(t.position);
        if (dist >= 120 && dist <= 450 && dist < bd) { bd = dist; best = e; }
      }
      if (best) this.launch(t, { autopilot: true, target: best });
    }
  }

  public detonate(d: DroneEntity, obstacle?: ObstacleCollider, contact?: TankEntity): void {
    if (d.phase === 'dead') return;
    d.phase = 'dead';
    const pos = d.pos;
    const dir = d.vel.lengthSq() > 0.1 ? _tmp3.copy(d.vel).normalize() : _tmp3.set(0, -1, 0);
    this.effects.spawnExplosion(pos, _tmp2.copy(_up).addScaled(dir, -0.3).normalize(), FPV_WARHEAD_SPEC.explosionScale, 'he_armor');
    this.effects.spawnExplosion(pos, _up, 0.8, 'he_ground');
    if (obstacle) this.world.damageObstacle(obstacle, FPV_WARHEAD_SPEC.directDamage, dir.x, dir.z);
    const blastRadius = FPV_WARHEAD_SPEC.splashRadius;
    this.world.blastObstacles(pos.x, pos.y, pos.z, blastRadius, FPV_WARHEAD_SPEC.splashDamage);
    const shooter = d.operator;
    let nearTank = false;
    for (const t of this.allTanks) {
      if (!t.alive || t.team === d.team) continue;
      const dist = t.getCenterMassWorld(_tmp).distance(pos), hullRadius = t.stats.collisionRadius + 1.4;
      if (dist > blastRadius + hullRadius) continue;
      nearTank = true;
      const fall = Math.max(0, 1 - Math.max(0, dist - hullRadius) / blastRadius);
      const hitPos = _tmp.copy(pos), behind = _tmp2.copy(pos).addScaled(dir, -3);
      const killed = t.takeDamage(FPV_WARHEAD_SPEC.directDamage * fall, hitPos, behind, t === contact ? dir : undefined,
        'cannon', FPV_WARHEAD_SPEC, { attacker: shooter, blastCenter: pos, blastRadius });
      this.onDamage?.({ victim: t, attacker: shooter, amount: FPV_WARHEAD_SPEC.directDamage * fall, killed,
        hitPoint: pos, weapon: 'cannon', xrayReport: t.lastXRayReport });
    }
    if (nearTank) this.stats.hits++;
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

  public pickBotTarget(d: DroneEntity): TankEntity | null {
    if (!d.operator) return null;
    let best: TankEntity | null = null, bd = Infinity;
    for (const e of this.allTanks) {
      if (!e.alive || e.team === d.team) continue;
      const dist = e.position.distance(d.pos);
      if (dist < bd) { bd = dist; best = e; }
    }
    return best;
  }

  public fpvTelemetry(): { speedKmh: number; altM: number; rangeM: number; cooldown: number } | null {
    const d = this.playerDrone;
    if (!d || !d.operator) return null;
    const rangeM = d.pos.distance(d.operator.position);
    const agl = d.pos.y - (this.world?.getHeightAt(d.pos.x, d.pos.z) ?? 0);
    return { speedKmh: Math.round(d.speed * 3.6), altM: Math.round(agl), rangeM: Math.round(rangeM), cooldown: this.cooldownLeft(d.operator) };
  }

  public slotStatus(t: TankEntity): { text: string; airborne: boolean } {
    const d = this.activeFor(t);
    if (d) return { text: 'FPV AIRBORNE', airborne: true };
    const cd = this.cooldownLeft(t);
    if (cd > 0) return { text: `FPV ${Math.ceil(cd)} S`, airborne: false };
    return { text: 'FPV READY', airborne: false };
  }
}
