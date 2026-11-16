import * as THREE from 'three';
import { Tank } from './Tank';
import type { LoadedGameAssets } from './AssetLoader';
import type { DamageEvent, Team, TerrainQuery, VehicleClass } from './types';

export interface MatchFeedEntry {
  id: number;
  text: string;
  age: number;
  accent: 'kill' | 'death' | 'info';
}

const MAX_FEED = 6;
const FEED_TTL = 8.0;
const BASE_BLUE = { x: 0, z: -205 };
const BASE_RED = { x: 0, z: 205 };
const SPAWN_RADIUS_MIN = 0;
const SPAWN_RADIUS_MAX = 35;

const BLUE_BOT_CLASSES: readonly VehicleClass[] = ['normal', 'heavy', 'ifv', 'humvee', 'rocket'];
const RED_BOT_CLASSES: readonly VehicleClass[] = ['normal', 'heavy', 'ifv', 'humvee', 'rocket', 'normal'];

export class Match {
  readonly score = { blue: 0, red: 0 };
  /** tanks[0] is always the human's current vehicle; tanks[1..] are the bots. */
  readonly tanks: Tank[] = [];
  readonly feed: MatchFeedEntry[] = [];

  private readonly scene: THREE.Scene;
  private readonly world: TerrainQuery;
  private readonly humanVehicles: Record<VehicleClass, Tank>;
  private humanClass: VehicleClass = 'normal';
  private pendingClass: VehicleClass | null = null;
  private feedId = 0;
  private readonly _avoid: THREE.Vector3[] = [];

  constructor(scene: THREE.Scene, world: TerrainQuery, assets: LoadedGameAssets) {
    this.scene = scene;
    this.world = world;

    // Pre-build all 5 human vehicles once so class switching swaps tanks[0] with zero runtime allocations
    const blueYaw = this._yawTowardEnemyBase('blue');
    const spawn = this._spawnPoint('blue', null);
    this.humanVehicles = {
      normal: new Tank('you_normal', 'blue', 'normal', assets, spawn, blueYaw, true, 'You'),
      heavy: new Tank('you_heavy', 'blue', 'heavy', assets, spawn, blueYaw, true, 'You'),
      ifv: new Tank('you_ifv', 'blue', 'ifv', assets, spawn, blueYaw, true, 'You'),
      humvee: new Tank('you_humvee', 'blue', 'humvee', assets, spawn, blueYaw, true, 'You'),
      rocket: new Tank('you_rocket', 'blue', 'rocket', assets, spawn, blueYaw, true, 'You'),
    };

    this.tanks.push(this.humanVehicles.normal);
    scene.add(this.humanVehicles.normal.root);

    this._spawnTeamBots('blue', BLUE_BOT_CLASSES, 'Anvil', 2, assets);
    this._spawnTeamBots('red', RED_BOT_CLASSES, 'Viper', 1, assets);
  }

  get human(): Tank {
    return this.tanks[0];
  }

  /** Every Tank instance that can ever be killed: current roster + prebuilt human vehicles. */
  public forEachTankEver(fn: (t: Tank) => void): void {
    const seen = new Set<Tank>();
    for (const t of this.tanks) {
      seen.add(t);
      fn(t);
    }
    for (const cls of Object.keys(this.humanVehicles) as VehicleClass[]) {
      const t = this.humanVehicles[cls];
      if (!seen.has(t)) fn(t);
    }
  }

  baseCenter(team: Team): { x: number; z: number } {
    return team === 'blue' ? BASE_BLUE : BASE_RED;
  }

  /**
   * Queues a human vehicle-class change. Applies on the next respawn, or
   * immediately when the human is alive and within 35m of the blue base.
   */
  selectHumanClass(cls: VehicleClass): void {
    const human = this.human;
    const base = BASE_BLUE;
    const nearBase =
      human.alive &&
      Math.hypot(human.position.x - base.x, human.position.z - base.z) <= 35;
    if (nearBase) {
      if (cls !== this.humanClass) {
        const keepTurret = human.turretRelYaw;
        const pos = human.position.clone();
        const yaw = human.hullYaw;
        this._swapHumanVehicle(cls, pos, yaw);
        this.human.turretRelYaw = keepTurret;
      }
      this.pendingClass = null;
    } else {
      this.pendingClass = cls;
    }
  }

  onDamage(ev: DamageEvent): void {
    const victim = ev.victim;
    const attacker = ev.attacker;
    if (!ev.killed || !attacker || attacker.team === victim.team) return;
    this.score[attacker.team]++;
    const accent = attacker.isHuman ? 'kill' : victim.isHuman ? 'death' : 'info';
    this._pushFeed(`${attacker.callsign} destroyed ${victim.callsign}`, accent);
  }

  update(dt: number): void {
    const safeDt = Math.min(Math.max(dt, 0.0001), 0.1);

    for (let i = 0; i < this.tanks.length; i++) {
      const tank = this.tanks[i];
      if (!tank.alive && tank.respawnTimer <= 0.01) {
        this._respawnTank(tank);
      }
    }

    for (let i = this.feed.length - 1; i >= 0; i--) {
      const m = this.feed[i];
      m.age += safeDt;
      if (m.age > FEED_TTL) {
        this.feed.splice(i, 1);
      }
    }
  }

  private _yawTowardEnemyBase(team: Team): number {
    const base = this.baseCenter(team);
    const target = this.baseCenter(team === 'blue' ? 'red' : 'blue');
    return Math.atan2(target.x - base.x, target.z - base.z);
  }

  private _spawnPoint(team: Team, avoidExtra: readonly THREE.Vector3[] | null): THREE.Vector3 {
    this._avoid.length = 0;
    for (const t of this.tanks) {
      if (t.alive) this._avoid.push(t.position);
    }
    if (avoidExtra) {
      for (const p of avoidExtra) this._avoid.push(p);
    }
    return this.world.getSafeSpawnPoint(SPAWN_RADIUS_MIN, SPAWN_RADIUS_MAX, this._avoid, this.baseCenter(team));
  }

  private _spawnTeamBots(
    team: Team,
    classes: readonly VehicleClass[],
    callsignPrefix: string,
    callsignStart: number,
    assets: LoadedGameAssets
  ): void {
    for (let i = 0; i < classes.length; i++) {
      const cls = classes[i];
      const pos = this._spawnPoint(team, null);
      const yaw = this._yawTowardEnemyBase(team);
      const bot = new Tank(
        `${team}_bot_${i + 1}`,
        team,
        cls,
        assets,
        pos,
        yaw,
        false,
        `${callsignPrefix} ${callsignStart + i}`
      );
      this.scene.add(bot.root);
      this.tanks.push(bot);
    }
  }

  private _respawnTank(tank: Tank): void {
    const sp = this._spawnPoint(tank.team, null);
    const yaw = this._yawTowardEnemyBase(tank.team);

    if (tank.isHuman) {
      if (this.pendingClass !== null && this.pendingClass !== this.humanClass) {
        this._swapHumanVehicle(this.pendingClass, sp, yaw);
      } else {
        tank.respawnAt(sp, yaw);
      }
      this.pendingClass = null;
      return;
    }
    tank.respawnAt(sp, yaw);
  }

  private _swapHumanVehicle(cls: VehicleClass, pos: THREE.Vector3, yaw: number): void {
    const prev = this.tanks[0];
    this.scene.remove(prev.root);
    this.humanClass = cls;
    const next = this.humanVehicles[cls];
    next.respawnAt(pos, yaw);
    this.scene.add(next.root);
    this.tanks[0] = next;
  }

  private _pushFeed(text: string, accent: MatchFeedEntry['accent']): void {
    this.feed.unshift({ id: ++this.feedId, text, age: 0, accent });
    if (this.feed.length > MAX_FEED) {
      this.feed.length = MAX_FEED;
    }
  }
}
