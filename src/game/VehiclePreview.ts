import { Entity, TONEMAP_ACES, Vec4 } from 'playcanvas';
import { instantiateTankRig, type LoadedGameAssets } from './AssetLoader';
import { clamp, Vec3 } from './engine/math';
import { worldBounds } from './engine/scene';
import type { World } from './World';
import type { Team, VehicleClass } from './types';

interface Exhibit { root: Entity; center: Vec3; radius: number }

/** The briefing has its own camera and inert display models, never a second simulation. */
export class VehiclePreview {
  private readonly camera = new Entity('briefing_camera');
  private readonly exhibits = new Map<string, Exhibit>();
  private active?: Exhibit;
  private key = '';
  private yaw = 0;
  private pitch = 0.28;
  private aspect = 1;
  private readonly rect = new Vec4();
  private dirtyRect = true;
  private readonly floor: Vec3;

  constructor(private readonly scene: Entity, private readonly assets: LoadedGameAssets,
    private readonly world: World, private readonly pane: HTMLElement, profile: HTMLElement) {
    this.floor = world.getSafeSpawnPoint(0, 12, [], { x: -85, z: -430 });
    this.camera.addComponent('camera', { fov: 39, nearClip: 0.15, farClip: 1400 });
    this.camera.camera!.toneMapping = TONEMAP_ACES;
    this.camera.enabled = false;
    scene.addChild(this.camera);
    new ResizeObserver(() => { this.dirtyRect = true; }).observe(pane);
    this.bindDrag(pane);
    this.bindDrag(profile);
  }

  private reset(): void {
    this.yaw = this.key.endsWith(':support') ? 2.38 : 0.77;
    this.pitch = 0.28;
  }

  private bindDrag(handle: HTMLElement): void {
    let pointer = -1, x = 0, y = 0;
    const rotate = (dx: number, dy: number) => {
      this.yaw = (this.yaw - dx * 0.009) % (Math.PI * 2);
      this.pitch = clamp(this.pitch + dy * 0.007, 0.04, 1.34);
    };
    handle.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('is-dragging');
      pointer = e.pointerId; x = e.clientX; y = e.clientY;
    });
    handle.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointer) return;
      rotate(e.clientX - x, e.clientY - y);
      x = e.clientX; y = e.clientY;
    });
    handle.addEventListener('lostpointercapture', () => { pointer = -1; handle.classList.remove('is-dragging'); });
    handle.addEventListener('dblclick', () => this.reset());
    handle.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowLeft': rotate(-18, 0); break;
        case 'ArrowRight': rotate(18, 0); break;
        case 'ArrowUp': rotate(0, 15); break;
        case 'ArrowDown': rotate(0, -15); break;
        case 'Home': this.reset(); break;
        default: return;
      }
      e.preventDefault(); e.stopPropagation();
    });
  }

  public update(show: boolean, cls: VehicleClass, team: Team, gameCamera: Entity): void {
    if (!show) {
      if (this.camera.enabled) {
        this.camera.enabled = false;
        if (this.active) this.active.root.enabled = false;
        gameCamera.camera!.enabled = true;
      }
      return;
    }
    const key = `${team}:${cls}`;
    if (this.key !== key) {
      if (this.active) this.active.root.enabled = false;
      this.key = key;
      this.reset();
      let exhibit = this.exhibits.get(key);
      if (!exhibit) {
        const rig = instantiateTankRig(this.assets, cls, team);
        const elevation = cls === 'rocket' ? 0.25 : 0;
        rig.root.setPosition(this.floor);
        this.scene.addChild(rig.root);
        rig.gunPivot.setLocalEulerAngles(-elevation * 180 / Math.PI, 0, 0);
        rig.articulate?.(elevation);
        const box = worldBounds(rig.root, undefined, true);
        const size = box.getSize(new Vec3());
        exhibit = { root: rig.root, center: box.getCenter(new Vec3()), radius: size.length() * 0.5 };
        this.exhibits.set(key, exhibit);
      }
      this.active = exhibit;
    }
    if (!this.camera.enabled) this.dirtyRect = true;
    if (this.dirtyRect) {
      const r = this.pane.getBoundingClientRect(), w = window.innerWidth, h = window.innerHeight;
      this.aspect = r.width / Math.max(1, r.height);
      this.camera.camera!.rect = this.rect.set(r.left / w, 1 - r.bottom / h, r.width / w, r.height / h);
      this.dirtyRect = false;
    }
    const model = this.active!;
    model.root.enabled = true;
    this.camera.enabled = true;
    gameCamera.camera!.enabled = false;
    const d = model.radius * 1.10 / Math.sin(Math.atan(Math.tan(39 * Math.PI / 360) * Math.min(1, this.aspect)));
    const r = d * Math.cos(this.pitch), c = model.center;
    const x = c.x + r * Math.sin(this.yaw), z = c.z + r * Math.cos(this.yaw);
    const ground = this.world.getHeightAt(x, z) + this.world.getWaterDepthAt(x, z);
    this.camera.setPosition(x, Math.max(ground + 0.45, c.y + d * Math.sin(this.pitch)), z);
    this.camera.lookAt(c);
  }
}
