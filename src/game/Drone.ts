import * as THREE from 'three';
import { buildFpvDrone } from './models/SupportVehicle';
import type { ShellSpec, TankEntity, Team } from './types';
import type { World } from './World';
import type { EffectsManager } from './Effects';

/**
 * F5b FPV kamikaze drone. One airborne per vehicle; 18 s cooldown (player),
 * 25 s (bots). Battery 40 s, control range 450 m from the operator.
 * LMB detonates, RMB aborts (tumbles down, detonates on ground contact).
 * Link loss / range / battery -> same fall-and-detonate. Water = splash,
 * lost, no explosion.
 */

export const FPV_WARHEAD_SPEC: ShellSpec = {
  id: 'fpv_warhead',
  shortCode: 'FPV',
  displayName: 'FPV WARHEAD',
  muzzleSpeed: 0,
  directDamage: 300,
  splashDamage: 160,
  splashRadius: 5,
  penetrationDepth: 0.8,
  penMm: 120, // shaped charge — beats top armour on a dive
  moduleDamage: { slug: 1.0, spall: 0.35, spallCount: 10 },
  spallCount: 10,
  spallWeight: 0.5,
  explosionScale: 1.0,
  tracerColorRGB: [9, 9, 9],
  dispersionRad: 0,
};

const BATTERY_S = 40;
const CONTROL_RANGE = 450;
const PLAYER_COOLDOWN = 18;
const BOT_COOLDOWN = 25;
const BOT_SPEED = 26;
const PLAYER_MIN_SPEED = 14;
const PLAYER_MAX_SPEED = 34;
const PLAYER_DEFAULT_SPEED = 24;
const EXPLOSION_RADIUS = 8;

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
  public battery = BATTERY_S;
  public airTime = 0;
  public launchT = 0;
  public autopilot: boolean;
  public readonly hitRadius = 0.35;
  public onShotDown: (() => void) | null = null;
  public readonly rotors: THREE.Object3D[] = [];
  private readonly _prevPos = new THREE.Vector3();
  private readonly _e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _q = new THREE.Quaternion();

  constructor(team: Team, operator: TankEntity | null, isBot: boolean, autopilot: boolean, spawnPos: THREE.Vector3, yaw: number) {
    this.team = team;
    this.operator = operator;
    this.isBot = isBot;
    this.autopilot = autopilot;
    this.pos = this.group.position;
    this.pos.copy(spawnPos);
    this._prevPos.copy(spawnPos);
    this.yaw = yaw;
    this.group.traverse((o) => {
      if (o.userData.isRotor) this.rotors.push(o);
    });
    this.group.rotation.order = 'YXZ';
  }

  public get alive(): boolean {
    return this.phase !== 'dead';
  }

  // ---- TankEntity shim (seekers/guidance/counter-aim read these) ----
  public readonly isHuman = false;
  public readonly callsign = 'FPV';
  public get position(): THREE.Vector3 {
    return this.pos;
  }
  public get velocity(): THREE.Vector3 {
    return this.vel;
  }
  public readonly stats = { hitRadius: 1.2, collisionRadius: 1.0 } as unknown as import('./types').TankStats;
  public hullYaw = 0;
  public turretRelYaw = 0;
  public get turretWorldYaw(): number {
    return this.yaw;
  }
  public get gunPitch(): number {
    return this.pitch;
  }
  public hitCounter = 0;
  public crewAlive = 1;
  public crewTotal = 1;
  public respawnTimer = 0;
  public cannonCooldown = 0;
  public mgCooldown = 0;
  public mgHeat = 0;
  public mgOverheated = false;
  public dispersionMult = 1;
  public selectedShellIndex = 0 as const;
  public get activeShell(): ShellSpec {
    return FPV_WARHEAD_SPEC;
  }
  public lastXRayReport = null;
  public getMuzzleWorld(outPos: THREE.Vector3, outDir: THREE.Vector3): void {
    outPos.copy(this.pos);
    this.forward(outDir);
  }
  public getCoaxWorld(outPos: THREE.Vector3, outDir: THREE.Vector3): void {
    this.getMuzzleWorld(outPos, outDir);
  }
  public applyRecoil(): void {}
  public takeDamage(): boolean {
    return false;
  }

  public getCenterMassWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos);
  }

  /** TankEntity-shaped shim so seekers/guidance can track drones. */
  public asEntity(): TankEntity {
    return this as unknown as TankEntity;
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
    for (const r of this.rotors) r.rotation.y += rotorSpeed * dt;

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
      this.pos.addScaledVector(this.vel, dt);
      const ground = mgr.world.getHeightAt(this.pos.x, this.pos.z);
      const water = mgr.world.getWaterLevelAt(this.pos.x, this.pos.z);
      if (this.pos.y <= Math.max(ground, water) + 0.15) {
        if (water > 0 && this.pos.y <= water + 0.15 && ground < water) {
          mgr.splash(this.pos);
        } else {
          mgr.detonate(this);
        }
      }
      this.syncMesh();
      return;
    }

    // ---- fly ----
    this.battery -= dt;
    if (input && !this.autopilot) {
      this.stepPlayer(dt, input);
    } else {
      this.stepAutopilot(dt, mgr);
    }

    // integrate (_prevPos stays at pre-step pos -> segment for contact tests)
    this.pos.addScaledVector(this.vel, dt);

    // link / battery / range checks
    const op = this.operator;
    const outOfRange = op ? this.pos.distanceTo(op.position) > CONTROL_RANGE : true;
    const linkLost = !op || !op.alive || this.battery <= 0 || outOfRange;
    if (linkLost) {
      this.phase = 'fall';
      this.vel.multiplyScalar(0.4);
      this.vel.y = Math.min(this.vel.y, 0);
      return;
    }

    // terrain / water contact
    const ground = mgr.world.getHeightAt(this.pos.x, this.pos.z);
    const water = mgr.world.getWaterLevelAt(this.pos.x, this.pos.z);
    if (this.pos.y <= ground + 0.12) {
      mgr.detonate(this);
      return;
    }
    if (water > 0 && this.pos.y <= water + 0.1) {
      mgr.splash(this.pos);
      return;
    }

    // tank contact: swept segment vs enemy hit volumes
    for (const t of mgr.allTanks) {
      if (!t.alive || t.team === this.team) continue;
      if (this.segmentHitsTank(t, 0.4)) {
        mgr.detonate(this);
        return;
      }
    }

    this.syncMesh();
  }

  private stepPlayer(dt: number, input: { dmx: number; dmy: number; up: boolean; down: boolean; keys: ReadonlySet<string> }): void {
    // yaw/pitch rates (rad/s) smoothed toward mouse demand
    const yawRateT = -input.dmx * 0.0028 * 60; // px -> rad/s
    const pitchRateT = -input.dmy * 0.0024 * 60;
    const kl = 1 - Math.exp(-9 * dt);
    this._yawRate += (yawRateT - this._yawRate) * kl;
    this._pitchRate += (pitchRateT - this._pitchRate) * kl;
    // A/D also yaw
    const a = input.keys.has('KeyA') || input.keys.has('ArrowLeft') ? 1 : 0;
    const d = input.keys.has('KeyD') || input.keys.has('ArrowRight') ? 1 : 0;
    this._yawRate += (a - d) * 1.6 * kl * 4;

    this.yaw += this._yawRate * dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch + this._pitchRate * dt, -1.15, 1.15);

    // throttle W/S: 14-34 m/s, default 24
    if (input.up) this.speed = Math.min(this.speed + 26 * dt, PLAYER_MAX_SPEED);
    else if (input.down) this.speed = Math.max(this.speed - 26 * dt, PLAYER_MIN_SPEED);
    else this.speed += (PLAYER_DEFAULT_SPEED - this.speed) * (1 - Math.exp(-1.5 * dt));

    // visual bank into turns + slight turbulence
    const bankT = THREE.MathUtils.clamp(-this._yawRate * 0.35, -0.5, 0.5);
    this.roll += (bankT - this.roll) * (1 - Math.exp(-6 * dt));
    const turb = Math.sin(this.airTime * 13.7) * 0.02 + Math.sin(this.airTime * 7.3) * 0.015;

    this.forward(_fwd);
    this.vel.copy(_fwd).multiplyScalar(this.speed);
    this.vel.y += turb * this.speed * 0.2;
  }

  private _yawRate = 0;
  private _pitchRate = 0;

  private stepAutopilot(dt: number, mgr: DroneManager): void {
    // climb to 20 m AGL, cruise 26 m/s at predicted target pos;
    // inside 50 m horizontal -> dive with PN-style steering, impact.
    const tgt = this._autopilotTarget ?? mgr.pickBotTarget(this);
    if (!tgt) {
      // no target: orbit slowly / hold
      this.yaw += 0.3 * dt;
      this.speed = Math.max(8, this.speed - 10 * dt);
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
        const agl = this.pos.y - mgr.world.getHeightAt(this.pos.x, this.pos.z);
        desiredPitch = THREE.MathUtils.clamp((tAlt - this.pos.y) * 0.07, -0.3, 0.6);
        void agl;
      }
      let dy = desiredYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const turnRate = dive ? 3.0 : 1.4;
      this.yaw += THREE.MathUtils.clamp(dy, -turnRate * dt, turnRate * dt);
      const pitchRate = dive ? 3.2 : 1.0;
      this.pitch += THREE.MathUtils.clamp(desiredPitch - this.pitch, -pitchRate * dt, pitchRate * dt);
      const targetSpeed = dive ? 48 : BOT_SPEED;
      this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-1.8 * dt));
      // impact: close to target -> detonate
      const dist3 = Math.hypot(dx, dy * 0 + (tgt.position.y + 1.2 - this.pos.y), dz);
      if (dive && dist3 < 4.5) {
        mgr.detonate(this);
        return;
      }
    }
    // slight bank into turns
    this.roll += (THREE.MathUtils.clamp(-this._yawRate * 0.2, -0.4, 0.4) - this.roll) * 0.1;
    this.forward(_fwd);
    this.vel.copy(_fwd).multiplyScalar(this.speed);
  }

  private _autopilotTarget: TankEntity | null = null;
  public setAutopilotTarget(t: TankEntity | null): void {
    this._autopilotTarget = t;
  }

  /** Segment (prev->pos) vs tank hit volume (sphere at hull centre + pad). */
  public segmentHitsTank(t: TankEntity, pad: number): boolean {
    const cx = t.position.x;
    const cy = t.position.y + 1.4;
    const cz = t.position.z;
    const r = (t.stats?.collisionRadius ?? 2.6) + pad + 1.0;
    _tmp2.subVectors(this.pos, this._prevPos);
    const l2 = _tmp2.lengthSq();
    if (l2 < 1e-8) {
      const dx = this.pos.x - cx, dy = this.pos.y - cy, dz = this.pos.z - cz;
      return dx * dx + dy * dy + dz * dz < r * r;
    }
    // closest point on segment to tank centre
    const t0 = THREE.MathUtils.clamp(
      ((cx - this._prevPos.x) * _tmp2.x + (cy - this._prevPos.y) * _tmp2.y + (cz - this._prevPos.z) * _tmp2.z) / l2,
      0, 1
    );
    const px = this._prevPos.x + _tmp2.x * t0 - cx;
    const py = this._prevPos.y + _tmp2.y * t0 - cy;
    const pz = this._prevPos.z + _tmp2.z * t0 - cz;
    return px * px + py * py + pz * pz < r * r;
  }

  private syncMesh(): void {
    this.group.rotation.set(this.pitch, this.yaw, this.roll);
  }
}

export class DroneManager {
  public readonly drones: DroneEntity[] = [];
  private readonly cooldowns = new Map<TankEntity, number>();
  public allTanks: readonly TankEntity[] = [];
  public world!: World;
  public effects!: EffectsManager;
  public human: TankEntity | null = null;
  /** Set by main each frame: live player drone input or null. */
  public playerInput: {
    dmx: number;
    dmy: number;
    up: boolean;
    down: boolean;
    keys: ReadonlySet<string>;
    lmb: boolean;
    rmb: boolean;
  } | null = null;
  public fpvActive = false;
  public readonly stats = { launched: 0, hits: 0, shotDown: 0, lost: 0 };
  public botLaunchesEnabled = true;
  public counterFireEnabled = true;
  public lastDetonation = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), shooter: null as TankEntity | null, t: -99 };

  public cooldownLeft(t: TankEntity): number {
    return Math.max(0, this.cooldowns.get(t) ?? 0);
  }

  public activeFor(t: TankEntity): DroneEntity | null {
    for (const d of this.drones) if (d.operator === t && d.alive) return d;
    return null;
  }

  public launch(t: TankEntity, opts: { autopilot?: boolean; target?: TankEntity | null } = {}): DroneEntity | null {
    if (this.cooldownLeft(t) > 0 || this.activeFor(t)) return null;
    // spawn at the drone bay (rear of bed) lifted slightly
    const bay = _tmp.set(0, 0.7, -3.1).applyAxisAngle(THREE.Object3D.DEFAULT_UP, t.hullYaw).add(t.position);
    bay.y = this.world.getHeightAt(bay.x, bay.z) + 1.6;
    const d = new DroneEntity(t.team, t, !t.isHuman, opts.autopilot ?? !t.isHuman, bay, t.turretWorldYaw);
    d.onShotDown = () => this.shootDown(d);
    if (opts.target) d.setAutopilotTarget(opts.target);
    this.drones.push(d);
    this.stats.launched++;
    return d;
  }

  public update(dt: number, scene: THREE.Scene): void {
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
        d.group.removeFromParent();
        this.drones.splice(i, 1);
        continue;
      }
      if (!d.group.parent) scene.add(d.group);
      const useInput = d.operator === this.human && inp ? inp : null;
      d.step(dt, useInput, this);
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
  public detonate(d: DroneEntity): void {
    if (d.phase === 'dead') return;
    d.phase = 'dead';
    const pos = d.pos;
    const dir = d.vel.lengthSq() > 0.1 ? _tmp3.copy(d.vel).normalize() : _tmp3.set(0, -1, 0);
    this.effects.spawnExplosion(_tmp2.copy(pos), _tmp2.set(0, 1, 0).addScaledVector(dir, -0.3).normalize(), FPV_WARHEAD_SPEC.explosionScale, 'he_armor');
    // splash visual
    this.effects.spawnExplosion(pos, new THREE.Vector3(0, 1, 0), 0.8, 'he_ground');

    const shooter = d.operator;
    let nearTank = false;
    for (const t of this.allTanks) {
      if (!t.alive) continue;
      if (shooter && t.team === shooter.team) continue; // no friendly drones hitting friendlies
      const dist = t.position.distanceTo(pos);
      if (dist > EXPLOSION_RADIUS + (t.stats?.collisionRadius ?? 2.5)) continue;
      nearTank = true;
      const fall = Math.max(0.15, 1 - dist / (EXPLOSION_RADIUS + 3));
      // hit point = the warhead itself; velocity dir decides the entry face
      // (steep dive -> top armour, level pass -> side armour)
      const hitPos = _tmp.copy(pos);
      const behind = _tmp2.copy(pos).addScaledVector(dir, -3);
      t.takeDamage(
        FPV_WARHEAD_SPEC.directDamage * fall,
        hitPos,
        behind,
        dir,
        'cannon',
        FPV_WARHEAD_SPEC,
        { attacker: shooter, blastCenter: pos, blastRadius: FPV_WARHEAD_SPEC.splashRadius }
      );
    }
    if (nearTank) this.stats.hits++;
    // remember for droneTest stats
    this.lastDetonation.pos.copy(pos);
    this.lastDetonation.vel.copy(d.vel);
    this.lastDetonation.shooter = shooter;
    this.lastDetonation.t = performance.now() / 1000;
    // cooldown starts when the drone is gone
    if (d.operator) this.cooldowns.set(d.operator, d.isBot ? BOT_COOLDOWN : PLAYER_COOLDOWN);
  }

  /** Shot down by small-arms: small explosion, no tank damage. */
  public shootDown(d: DroneEntity): void {
    if (d.phase === 'dead') return;
    this.stats.shotDown++;
    d.phase = 'dead';
    this.effects.spawnExplosion(d.pos, new THREE.Vector3(0, 1, 0), 0.5, 'he_armor');
    if (d.operator) this.cooldowns.set(d.operator, d.isBot ? BOT_COOLDOWN : PLAYER_COOLDOWN);
  }

  public splash(pos: THREE.Vector3): void {
    this.stats.lost++;
    this.effects.spawnWaterSplash(pos);
  }

  /** Enemy drones a tank's seeker may lock (air defence). */
  public seekerTargets(): TankEntity[] {
    const out: TankEntity[] = [];
    for (const d of this.drones) {
      if (d.alive && d.phase === 'fly') out.push(d.asEntity());
    }
    return out;
  }

  /** Nearest enemy drone within `range` of `t` for bot gun priority.
   *  Requires clear LOS (terrain/obstacles block the engagement). */
  public counterAim(t: TankEntity, range: number): { point: THREE.Vector3; dist: number; drone: DroneEntity } | null {
    let best: DroneEntity | null = null;
    let bd = range;
    for (const d of this.drones) {
      if (!d.alive || d.phase !== 'fly' || d.team === t.team) continue;
      const dist = d.pos.distanceTo(t.position);
      if (dist < bd) { bd = dist; best = d; }
    }
    if (!best) return null;
    // LOS from the bot's hull centre to the drone
    _tmp.subVectors(best.pos, t.position);
    _tmp.y += 1.0;
    const dLen = _tmp.length();
    if (dLen > 1) {
      _tmp.multiplyScalar(1 / dLen);
      const hit = this.world.raycastWorld(_tmp2.set(t.position.x, t.position.y + 1.6, t.position.z), _tmp, Math.max(0.5, dLen - 2));
      if (hit) return null;
    }
    // simple lead: drone speed ~26-46 m/s, assume 35
    const tof = bd / 900; // MG ~900 m/s
    const point = new THREE.Vector3(
      best.pos.x + best.vel.x * tof,
      best.pos.y + best.vel.y * tof,
      best.pos.z + best.vel.z * tof
    );
    return { point, dist: bd, drone: best };
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
    battery: number;
    speedKmh: number;
    altM: number;
    rangeM: number;
    signalBars: number;
    weak: boolean;
  } | null {
    if (!this.human) return null;
    const d = this.activeFor(this.human);
    if (!d || d.phase === 'dead') return null;
    const op = this.human.position;
    const rangeM = d.pos.distanceTo(op);
    const agl = d.pos.y - (this.world?.getHeightAt(d.pos.x, d.pos.z) ?? 0);
    const bars = rangeM <= 300 ? 5 : Math.max(1, 5 - Math.floor((rangeM - 300) / 30));
    return {
      battery: Math.max(0, d.battery / BATTERY_S),
      speedKmh: Math.round(d.speed * 3.6),
      altM: Math.round(agl),
      rangeM: Math.round(rangeM),
      signalBars: bars,
      weak: bars < 2,
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
