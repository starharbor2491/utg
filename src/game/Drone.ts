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
export type DroneKind = 'gun' | 'fpv';
export type PilotInput = { dmx: number; dmy: number; up: boolean; down: boolean; fire: boolean; keys: ReadonlySet<string> };

const GUN_HEALTH = 45;
export const DRONE_BELT: ShellSpec = {
  ...FPV_WARHEAD_SPEC, id: 'drone_mg', shortCode: 'MG', displayName: 'DRONE MACHINE GUN',
  muzzleSpeed: 540, directDamage: 12, splashDamage: 0, splashRadius: 0, explosionScale: 0,
  penetrationDepth: 0.5, penMm: 13, moduleDamage: { slug: 0.22, spall: 0.06, spallCount: 2 },
  spallCount: 2, dispersionRad: 0.012, tracerColorRGB: [6.4, 5, 2.4],
};

let droneSeq = 0;
const _fwd = new Vec3(), _tmp = new Vec3(), _tmp2 = new Vec3(), _tmp3 = new Vec3();
const _up = new Vec3(0, 1, 0), _motion = new Vec3(), _tankCenter = new Vec3();

export class DroneEntity {
  public readonly id = `drone_${++droneSeq}`;
  public readonly team: Team;
  public readonly operator: TankEntity | null;
  public readonly isBot: boolean;
  public phase: DronePhase = 'launch';
  public readonly group: Entity;
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
  private readonly muzzle: Entity | null;
  private gunDelay = 0;
  public health = GUN_HEALTH;

  constructor(team: Team, operator: TankEntity | null, isBot: boolean, autopilot: boolean, spawnPos: Vec3, yaw: number, public readonly kind: DroneKind = 'fpv') {
    this.team = team;
    this.operator = operator;
    this.isBot = isBot;
    this.autopilot = autopilot;
    this.pos = spawnPos.clone();
    this.group = buildFpvDrone(kind === 'gun');
    this._prevPos.copy(spawnPos);
    this.yaw = this.aimYaw = yaw;
    this.cameraMount = findByName(this.group, 'fpv_camera')!;
    this.muzzle = findByName(this.group, 'drone_muzzle');
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
    const docked = this.operator ? findByName(this.operator.root, `${this.kind}_drone`) : null;
    if (docked) setVisible(docked, true);
  }

  public forward(out: Vec3): Vec3 {
    return out.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  public step(
    dt: number,
    input: PilotInput | null,
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
    this.gunDelay -= dt;
    if (this.phase === 'fly' && this.muzzle && this.operator && input?.fire && this.gunDelay <= 0) {
      this.gunDelay = 0.086;
      mgr.onFireMG?.(this.operator, this.muzzle.getPosition(), this.forward(_fwd), DRONE_BELT);
    }
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
    if (this.kind === 'gun') mgr.crash(this, depth > 0.03 && surfaceDist <= contactDist ? surface : undefined);
    else if (hitTank) mgr.detonate(this, undefined, hitTank);
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

  public syncMesh(): void {
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
  public onFireMG?: (shooter: TankEntity, pos: Vec3, dir: Vec3, spec: ShellSpec) => void;
  public onGunLost?: (shotDown: boolean) => void;
  public playerInput: PilotInput | null = null;
  public opponentInput: PilotInput | null = null;
  public localTeam: Team = 'blue';
  public readonly stats = { launched: 0, hits: 0, shotDown: 0, lost: 0 };
  public botLaunchesEnabled = true;
  public lastDetonation = { pos: new Vec3(), vel: new Vec3(), shooter: null as TankEntity | null, t: -99 };

  public cooldownLeft(t: TankEntity): number { return Math.max(0, this.cooldowns.get(t) ?? 0); }
  public activeFor(t: TankEntity): DroneEntity | null {
    for (const d of this.drones) if (d.operator === t && d.alive) return d;
    return null;
  }
  public get playerDrone(): DroneEntity | null {
    return this.drones.find((d) => !d.isBot && d.team === this.localTeam && d.alive && d.health > 0) ?? null;
  }

  public launch(t: TankEntity, opts: { autopilot?: boolean; target?: TankEntity | null; kind?: DroneKind } = {}): DroneEntity | null {
    if (this.cooldownLeft(t) > 0 || this.activeFor(t)) return null;
    const kind = opts.kind ?? 'fpv';
    const bay = applyAxisAngle(_tmp.set(0, 0.7, -3.1), Vec3.UP, t.hullYaw).add(t.position);
    bay.y = this.world.getHeightAt(bay.x, bay.z) + 1.6;
    const docked = findByName(t.root, `${kind}_drone`);
    if (docked) bay.copy(docked.getPosition());
    const d = new DroneEntity(t.team, t, !t.isHuman, opts.autopilot ?? !t.isHuman, bay, t.turretWorldYaw, kind);
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
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const d = this.drones[i];
      if (d.phase === 'dead') { d.dispose(); this.drones.splice(i, 1); continue; }
      if (!d.group.parent) scene.addChild(d.group);
      const inp = d.isBot ? null : d.team === this.localTeam ? this.playerInput : this.opponentInput;
      if (d.autopilot || inp || d.phase === 'fall') d.step(dt, d.isBot ? null : inp, this);
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

  /** Tests the swept shot only up to the nearest terrain, water or vehicle hit. */
  public hitByProjectile(team: Team | undefined, origin: Vec3, direction: Vec3, limit: number, damage: number): boolean {
    let best: DroneEntity | null = null;
    for (const d of this.drones) {
      if (d.kind !== 'gun' || !d.alive || d.health <= 0 || d.team === team) continue;
      const offset = _tmp.sub2(d.pos, origin);
      const along = offset.dot(direction);
      const lateralSq = offset.lengthSq() - along * along;
      if (lateralSq > 0.39 * 0.39) continue;
      const halfChord = Math.sqrt(0.39 * 0.39 - lateralSq);
      const t = Math.max(0, along - halfChord);
      if (along + halfChord < 0 || t > limit) continue;
      best = d;
      limit = t;
    }
    if (!best) return false;
    this.effects.spawnSparkImpact(_tmp.copy(origin).addScaled(direction, limit), _up, true);
    best.health = Math.max(0, best.health - damage);
    if (best.health === 0) {
      best.phase = 'fall';
      this.stats.shotDown++;
      if (!best.isBot && best.team === this.localTeam) this.onGunLost?.(true);
    }
    return true;
  }

  public crash(d: DroneEntity, waterLevel?: number): void {
    d.phase = 'dead';
    this.stats.lost++;
    if (waterLevel !== undefined) {
      d.pos.y = waterLevel;
      this.effects.spawnWaterSplash(d.pos);
    } else {
      this.effects.spawnSparkImpact(d.pos, _up, false);
      this.effects.spawnWreckSmoke(d.pos);
    }
    if (!d.isBot && d.team === this.localTeam && d.health > 0) this.onGunLost?.(false);
  }

  public reset(): void {
    for (const d of this.drones) d.dispose();
    this.drones.length = 0;
    this.cooldowns.clear();
  }

  public duelSnapshot(t: TankEntity): number[] {
    const d = this.drones.find((entry) => entry.team === t.team && entry.alive);
    if (!d) return [this.cooldownLeft(t), 0, 0, 0, 0, 0, 0, 0, 0, 0];
    return [this.cooldownLeft(t), d.kind === 'gun' ? 1 : 2, d.pos.x, d.pos.y, d.pos.z, d.yaw, d.pitch, d.roll, d.health, d.speed];
  }

  public applyDuelSnapshot(t: TankEntity, s: readonly number[], scene: Entity): void {
    if (s[0] > 0) this.cooldowns.set(t, s[0]); else this.cooldowns.delete(t);
    const existing = this.drones.find((d) => d.team === t.team);
    if (existing && (s[1] === 0 || existing.operator !== t || existing.kind !== (s[1] === 1 ? 'gun' : 'fpv'))) {
      if (!s[1] && existing.kind === 'fpv') {
        this.effects.spawnExplosion(existing.pos, _up, 1.35, 'he_armor');
        this.lastDetonation.pos.copy(existing.pos);
        this.lastDetonation.shooter = existing.operator;
      } else if (!s[1] && existing.kind === 'gun') {
        this.effects.spawnWreckSmoke(existing.pos);
      }
      existing.dispose();
      this.drones.splice(this.drones.indexOf(existing), 1);
    }
    if (s[1] !== 1 && s[1] !== 2) return;
    const kind = s[1] === 1 ? 'gun' : 'fpv';
    const pos = _tmp.set(s[2], s[3], s[4]);
    let d = this.drones.find((entry) => entry.team === t.team);
    if (!d) {
      d = new DroneEntity(t.team, t, false, false, pos, s[5], kind);
      const dock = findByName(t.root, `${kind}_drone`);
      if (dock) setVisible(dock, false);
      scene.addChild(d.group);
      this.drones.push(d);
    }
    if (d.health > 0 && s[8] <= 0 && t.team === this.localTeam) this.onGunLost?.(true);
    d.pos.copy(pos);
    d.yaw = s[5]; d.pitch = s[6]; d.roll = s[7]; d.health = s[8]; d.speed = s[9];
    d.phase = d.health > 0 ? 'fly' : 'fall';
    d.syncMesh();
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

  public fpvTelemetry() {
    const d = this.playerDrone;
    if (!d || !d.operator) return null;
    const rangeM = d.pos.distance(d.operator.position);
    const agl = d.pos.y - (this.world?.getHeightAt(d.pos.x, d.pos.z) ?? 0);
    return { kind: d.kind, healthPercent: Math.round(d.health * 100 / GUN_HEALTH), speedKmh: Math.round(d.speed * 3.6),
      altM: Math.round(agl), rangeM: Math.round(rangeM), cooldown: this.cooldownLeft(d.operator) };
  }

  public slotStatus(t: TankEntity): { text: string; airborne: boolean } {
    const d = this.activeFor(t);
    const name = d?.kind === 'gun' || (!d && t.activeShell.id === 'gun_drone') ? 'GUN DRONE' : 'FPV';
    if (d) return { text: `${name} AIRBORNE`, airborne: true };
    const cd = this.cooldownLeft(t);
    if (cd > 0) return { text: `${name} ${Math.ceil(cd)} S`, airborne: false };
    return { text: `${name} READY`, airborne: false };
  }
}
