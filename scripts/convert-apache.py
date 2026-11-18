"""Run with Blender in background: blender -b --python scripts/convert-apache.py -- SOURCE.zip apache.glb."""
from collections import defaultdict
from pathlib import Path
import shlex
import sys
from zipfile import ZipFile

import bpy
from mathutils import Matrix, Vector

FILES = (
    ('Apache_Airframe', 'apache/Models/apachemodel/apache.ac'),
    ('Apache_MainRotor', 'apache/Models/mainrotor/mainrotor.ac'),
    ('Apache_TailRotor', 'apache/Models/tailrotor/tailrotor.ac'),
)
SCALE = 0.69
# AC3D is Y-up with the nose along -X. The game is Y-up with the nose along +Z.
MAST_X, MAST_Z = 5.59, 0.13
PIVOTS = ((MAST_X, 0, MAST_Z), (MAST_X, 3.61, MAST_Z), (15.47, 3.21, 0.92))
PALETTE = {
    '_Charcoal_': ('Olive drab', (0.31, 0.34, 0.24), 0.64, 0.22, 1),
    '_Black_': ('Dark trim', (0.09, 0.10, 0.10), 0.68, 0.20, 1),
    'Color_002': ('Panel edges', (0.25, 0.27, 0.22), 0.74, 0.15, 1),
    'US_ARMY_TAG': ('Markings', (0.63, 0.62, 0.51), 0.76, 0, 1),
    'Material4': ('Nose optics', (0.29, 0.43, 0.52), 0.18, 0.24, 1),
    'transparent_scrren': ('Tinted canopy', (0.23, 0.32, 0.38), 0.16, 0.17, 0.66),
    'Color_E01': ('Warning paint', (0.68, 0.56, 0.22), 0.66, 0, 1),
}


def parse_ac(source):
    rows = iter(source.decode('latin1').splitlines())
    assert next(rows) == 'AC3Db'
    materials = []
    line = next(rows)
    while line.startswith('MATERIAL '):
        _, name, _, r, g, b, *rest = shlex.split(line)
        materials.append((name, (float(r), float(g), float(b)), 1 - float(rest[-1])))
        line = next(rows)

    def read_object(header, parent_rotation, parent_origin):
        assert header.startswith('OBJECT '), header
        rotation, offset = Matrix.Identity(3), Vector((0, 0, 0))
        name, verts, faces = '', [], []
        for row in rows:
            key, _, value = row.partition(' ')
            if key == 'data':
                next(rows)
            elif key == 'name':
                name = value.strip('"')
            elif key == 'loc':
                offset = Vector(tuple(map(float, value.split())))
            elif key == 'rot':
                a = list(map(float, value.split()))
                rotation = Matrix((a[:3], a[3:6], a[6:]))
            elif key == 'numvert':
                verts = [Vector(tuple(map(float, next(rows).split()))) for _ in range(int(value))]
            elif key == 'numsurf':
                for _ in range(int(value)):
                    flags = int(next(rows).split()[1], 16)
                    mat = int(next(rows).split()[1])
                    indices = tuple(int(next(rows).split()[0]) for _ in range(int(next(rows).split()[1])))
                    if flags & 0x0f == 0 and len(set(indices)) >= 3:
                        faces.append((indices, mat, bool(flags & 0x10)))
            elif key == 'kids':
                origin = parent_origin + parent_rotation @ offset
                rotation = parent_rotation @ rotation
                if faces:
                    yield name, [origin + rotation @ v for v in verts], faces
                for _ in range(int(value)):
                    yield from read_object(next(rows), rotation, origin)
                return
        raise ValueError('Incomplete AC3D object')

    return materials, list(read_object(line, Matrix.Identity(3), Vector((0, 0, 0))))


def linear(v):
    return v / 12.92 if v < 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def material(name, rgb, alpha):
    name, rgb, rough, metal, alpha = PALETTE.get(name, (name, rgb, 0.67, 0.03, alpha))
    label = f'{name} ({",".join(f"{x:.2f}" for x in rgb)})'
    if m := bpy.data.materials.get(label):
        return m
    m = bpy.data.materials.new(label)
    m.use_nodes = True
    pbr = m.node_tree.nodes.get('Principled BSDF')
    pbr.inputs['Base Color'].default_value = (*map(linear, rgb), 1)
    pbr.inputs['Roughness'].default_value = rough
    pbr.inputs['Metallic'].default_value = metal
    pbr.inputs['Alpha'].default_value = alpha
    m.use_backface_culling = alpha == 1
    return m


def assemble(name, mats, objects, pivot, floor, body):
    batches = defaultdict(lambda: ([], []))
    for source_name, verts, faces in objects:
        if body:
            # The game fits its own stores to these pylons.
            if source_name.startswith(('Mesh69 Group7', 'Mesh70 Group8')):
                continue
            # Remove the source sim's instrument switches and other small cockpit internals.
            size = [max(a) - min(a) for a in zip(*verts)]
            if max(size) < 0.26 and all(0.85 < v.x < 4.45 and 1.05 < v.y < 2.65 and -0.63 < v.z < 0.77 for v in verts):
                continue
        for indices, mi, smooth in faces:
            other = body and mats[mi][0] == 'transparent_scrren'
            vout, fout = batches[other]
            start = len(vout)
            # Game +X, -Z and +Y map to Blender +X, +Y and +Z.
            for idx in indices:
                x, y, z = verts[idx]
                px, py, pz = pivot
                vout.append(((z - pz) * SCALE, (x - px) * SCALE, (y - py) * SCALE))
            fout.append((tuple(range(start, len(vout))), mi, smooth))
    for glass, (verts, faces) in batches.items():
        node_name = 'Apache_Canopy' if glass else name
        mesh = bpy.data.meshes.new(node_name)
        mesh.from_pydata(verts, [], [indices for indices, _, _ in faces])
        if mesh.validate():
            raise ValueError(f'{node_name}: mesh validation unexpectedly removed source faces')
        mesh.update()
        used = {mi: i for i, mi in enumerate(sorted({mi for _, mi, _ in faces}))}
        for mi in used:
            mesh.materials.append(material(*mats[mi]))
        for poly, (_, mi, smooth) in zip(mesh.polygons, faces):
            poly.material_index = used[mi]
            poly.use_smooth = smooth
        # AC meshes share the same corner if their disconnected face records coincide.
        # Only weld within each material/part, not across the animated subassemblies.
        obj = bpy.data.objects.new(node_name, mesh)
        bpy.context.collection.objects.link(obj)
        px, py, pz = pivot
        obj.location = ((pz - MAST_Z) * SCALE, (px - MAST_X) * SCALE, (py - floor) * SCALE)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        weld = obj.modifiers.new('Weld source corners', 'WELD')
        weld.merge_threshold = 0.00002
        bpy.ops.object.modifier_apply(modifier=weld.name)
        obj.select_set(False)
        print(f'{node_name}: {len(obj.data.vertices)} vertices, {len(obj.data.polygons)} faces at {tuple(obj.location)}')


if __name__ == '__main__':
    source, output = sys.argv[sys.argv.index('--') + 1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with ZipFile(source) as archive:
        parts = [parse_ac(archive.read(path)) for _, path in FILES]
    # Guard against the source's loose editor construction lines, not the visible tires.
    floor = min(v.y for _, verts, faces in parts[0][1] for indices, _, _ in faces for v in (verts[i] for i in indices))
    for i, ((name, _), (mats, objs)) in enumerate(zip(FILES, parts)):
        assemble(name, mats, objs, PIVOTS[i], floor, i == 0)
    bpy.ops.export_scene.gltf(filepath=str(Path(output).resolve()), export_format='GLB',
                              export_animations=False, export_texcoords=False, export_yup=True)
