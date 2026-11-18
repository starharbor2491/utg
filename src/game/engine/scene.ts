import { Entity, Mesh, MeshInstance } from 'playcanvas';
import type { GraphNode, Material } from 'playcanvas';
import { Box3, Mat4 } from './math';
import { geoFromMesh } from './geometry';
import type { Geo } from './geometry';

/**
 * Scene-graph conventions for the port: every Three Object3D/Group/Mesh is a PlayCanvas
 * Entity. A mesh is an Entity with a render component holding exactly one MeshInstance.
 */

export interface MeshNodeOptions {
  name?: string;
  castShadows?: boolean;
  receiveShadows?: boolean;
}

export function group(name = '', parent?: GraphNode | null): Entity {
  const e = new Entity(name);
  parent?.addChild(e);
  return e;
}

const geoOfMesh = new WeakMap<Mesh, Geo>();

/** Remembers the CPU geometry behind a mesh so precise bounds and audits can read vertices. */
export function rememberGeo(mesh: Mesh, geo: Geo): void {
  geoOfMesh.set(mesh, geo);
}

export function geoOf(mesh: Mesh): Geo | undefined {
  return geoOfMesh.get(mesh);
}

/** Creates an Entity that renders one mesh. Geo inputs share one GPU mesh per Geo instance. */
export function meshNode(src: Geo | Mesh, material: Material, parent?: GraphNode | null, opts: MeshNodeOptions = {}): Entity {
  let mesh: Mesh;
  if (src instanceof Mesh) {
    mesh = src;
  } else {
    mesh = src.toMesh();
    rememberGeo(mesh, src);
  }
  const e = new Entity(opts.name ?? '');
  const render = e.addComponent('render', {})!;
  render.meshInstances = [new MeshInstance(mesh, material, e)];
  render.castShadows = opts.castShadows ?? true;
  render.receiveShadows = opts.receiveShadows ?? true;
  parent?.addChild(e);
  return e;
}

/** The single MeshInstance of a meshNode, or null for plain group entities. */
export function meshInstanceOf(node: GraphNode): MeshInstance | null {
  return (node as Entity).render?.meshInstances?.[0] ?? null;
}

export function isMeshNode(node: GraphNode): boolean {
  return !!meshInstanceOf(node);
}

/** All MeshInstances in a subtree (enabled or not). */
export function meshInstancesIn(root: GraphNode, out: MeshInstance[] = []): MeshInstance[] {
  root.forEach((n) => {
    const mis = (n as Entity).render?.meshInstances;
    if (mis) for (const mi of mis) out.push(mi);
  });
  return out;
}

export function setMaterial(node: GraphNode, material: Material): void {
  const mi = meshInstanceOf(node);
  if (mi) mi.material = material;
}

export function setCastShadows(root: GraphNode, cast: boolean, recursive = true): void {
  const apply = (n: GraphNode) => {
    const r = (n as Entity).render;
    if (r) r.castShadows = cast;
  };
  if (recursive) root.forEach(apply);
  else apply(root);
}

const userDataMap = new WeakMap<GraphNode, Record<string, unknown>>();
/** Replacement for Three's object.userData. */
export function userData(node: GraphNode): Record<string, unknown> {
  let d = userDataMap.get(node);
  if (!d) userDataMap.set(node, (d = {}));
  return d;
}

export function findByName(root: GraphNode, name: string): Entity | null {
  return (root.findByName(name) as Entity | null) ?? null;
}

export function detach(node: GraphNode): void {
  node.parent?.removeChild(node);
}

/** Three's object.visible. Disabled entities neither render nor cast shadows. */
export function setVisible(node: GraphNode, visible: boolean): void {
  (node as Entity).enabled = visible;
}

const _bounds = new Box3();
const _toWorld = new Mat4();
/**
 * World-space bounds of a subtree, like Three's Box3.setFromObject. With precise set, vertex
 * positions of Geo-built meshes are transformed individually; other meshes use their AABB.
 */
export function worldBounds(root: GraphNode, out: Box3 = new Box3(), precise = false, includeDisabled = false): Box3 {
  out.makeEmpty();
  root.forEach((n) => {
    const e = n as Entity;
    if (!includeDisabled && e.enabled === false) return;
    const mis = e.render?.meshInstances;
    if (!mis) return;
    for (const mi of mis) {
      if (precise && mi.instancingData) continue;
      const geo = precise && mi.mesh ? (geoOf(mi.mesh) ?? geoFromMesh(mi.mesh)) : undefined;
      if (geo) {
        out.expandByPositions(geo.positions, _toWorld.copy(mi.node.getWorldTransform()));
      } else {
        const aabb = mi.aabb;
        _bounds.set(aabb.getMin(), aabb.getMax());
        out.union(_bounds);
      }
    }
  });
  return out;
}
