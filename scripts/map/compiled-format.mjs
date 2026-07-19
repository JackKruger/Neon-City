import { createHash } from 'node:crypto';

export const MANIFEST_VERSION = 1;
export const CONTAINER_VERSION = 2;
export const RUNTIME_VERSION = 2;
export const GLTF_VERSION = '2.0';
export const SECTION_TYPES = ['HGT1', 'COL1', 'NAV2', 'GME1'];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function aligned(value, alignment = 4) {
  return Math.ceil(value / alignment) * alignment;
}

export function encodeChunkContainer(kx, kz, sections) {
  const ordered = SECTION_TYPES.map((type) => {
    const data = sections[type];
    if (!data) throw new Error(`missing ${type} section`);
    return { type, data: Buffer.from(data) };
  });
  const headerSize = 16 + ordered.length * 16;
  let offset = aligned(headerSize);
  const entries = ordered.map((section) => {
    const entry = { ...section, offset, length: section.data.length };
    offset = aligned(offset + section.data.length);
    return entry;
  });
  const output = Buffer.alloc(offset);
  output.write('NBCH', 0, 4, 'ascii');
  output.writeUInt16LE(CONTAINER_VERSION, 4);
  output.writeUInt16LE(headerSize, 6);
  output.writeInt16LE(kx, 8);
  output.writeInt16LE(kz, 10);
  output.writeUInt16LE(entries.length, 12);
  output.writeUInt16LE(0, 14);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const tableOffset = 16 + i * 16;
    output.write(entry.type, tableOffset, 4, 'ascii');
    output.writeUInt32LE(entry.offset, tableOffset + 4);
    output.writeUInt32LE(entry.length, tableOffset + 8);
    output.writeUInt32LE(0, tableOffset + 12);
    entry.data.copy(output, entry.offset);
  }
  return output;
}

export function parseChunkContainer(bytes, expected = null) {
  const data = Buffer.from(bytes);
  if (data.length < 16 || data.toString('ascii', 0, 4) !== 'NBCH') throw new Error('invalid NBCH magic');
  const version = data.readUInt16LE(4);
  if (version !== CONTAINER_VERSION) throw new Error(`unsupported NBCH version ${version}`);
  const headerSize = data.readUInt16LE(6);
  const kx = data.readInt16LE(8);
  const kz = data.readInt16LE(10);
  if (expected && (kx !== expected.kx || kz !== expected.kz)) throw new Error('NBCH chunk coordinate mismatch');
  const count = data.readUInt16LE(12);
  if (headerSize !== 16 + count * 16 || headerSize > data.length) throw new Error('malformed NBCH header');
  const sections = new Map();
  let previousEnd = headerSize;
  for (let i = 0; i < count; i++) {
    const tableOffset = 16 + i * 16;
    const type = data.toString('ascii', tableOffset, tableOffset + 4);
    const offset = data.readUInt32LE(tableOffset + 4);
    const length = data.readUInt32LE(tableOffset + 8);
    if (!SECTION_TYPES.includes(type) || sections.has(type)) throw new Error(`invalid NBCH section ${type}`);
    if (offset < headerSize || offset % 4 !== 0 || offset < previousEnd || offset + length > data.length) {
      throw new Error(`malformed NBCH section ${type}`);
    }
    sections.set(type, data.subarray(offset, offset + length));
    previousEnd = offset + length;
  }
  for (const type of SECTION_TYPES) if (!sections.has(type)) throw new Error(`missing NBCH section ${type}`);
  return { version, kx, kz, sections };
}

/** Encode a minimal deterministic GLB 2.0 with one primitive per material. */
export function encodeGlb(primitives, materials) {
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  let byteOffset = 0;
  const pushBuffer = (buffer, target) => {
    const padding = Buffer.alloc(aligned(buffer.length) - buffer.length);
    const index = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buffer.length, target });
    chunks.push(buffer, padding);
    byteOffset += buffer.length + padding.length;
    return index;
  };
  const meshPrimitives = [];
  for (const primitive of primitives) {
    if (primitive.positions.length === 0) continue;
    const positionBuffer = Buffer.from(new Float32Array(primitive.positions).buffer);
    const normalBuffer = Buffer.from(new Float32Array(primitive.normals).buffer);
    const maxIndex = primitive.positions.length / 3 - 1;
    const use32 = maxIndex > 65535;
    const indexArray = use32 ? new Uint32Array(primitive.indices) : new Uint16Array(primitive.indices);
    const indexBuffer = Buffer.from(indexArray.buffer);
    const positionView = pushBuffer(positionBuffer, 34962);
    const normalView = pushBuffer(normalBuffer, 34962);
    const indexView = pushBuffer(indexBuffer, 34963);
    const mins = [Infinity, Infinity, Infinity];
    const maxs = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < primitive.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        mins[axis] = Math.min(mins[axis], primitive.positions[i + axis]);
        maxs[axis] = Math.max(maxs[axis], primitive.positions[i + axis]);
      }
    }
    const positionAccessor = accessors.length;
    accessors.push({ bufferView: positionView, componentType: 5126, count: primitive.positions.length / 3, type: 'VEC3', min: mins, max: maxs });
    const normalAccessor = accessors.length;
    accessors.push({ bufferView: normalView, componentType: 5126, count: primitive.normals.length / 3, type: 'VEC3' });
    const indexAccessor = accessors.length;
    accessors.push({ bufferView: indexView, componentType: use32 ? 5125 : 5123, count: primitive.indices.length, type: 'SCALAR', min: [0], max: [maxIndex] });
    meshPrimitives.push({
      attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
      indices: indexAccessor,
      material: materials.findIndex((material) => material.name === primitive.material),
      mode: 4,
    });
  }
  const binary = Buffer.concat(chunks);
  const document = {
    asset: { version: GLTF_VERSION, generator: 'neon-bay-map-compiler/1' },
    scene: 0,
    scenes: [{ nodes: meshPrimitives.length > 0 ? [0] : [] }],
    nodes: meshPrimitives.length > 0 ? [{ mesh: 0, name: 'compiled-chunk' }] : [],
    meshes: meshPrimitives.length > 0 ? [{ primitives: meshPrimitives }] : [],
    materials: materials.map(({ name, color, roughness = 0.8, metalness = 0 }) => ({
      name,
      pbrMetallicRoughness: {
        baseColorFactor: [...color, 1],
        roughnessFactor: roughness,
        metallicFactor: metalness,
      },
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.length }],
  };
  const jsonRaw = Buffer.from(stableStringify(document));
  const json = Buffer.concat([jsonRaw, Buffer.alloc(aligned(jsonRaw.length) - jsonRaw.length, 0x20)]);
  const bin = Buffer.concat([binary, Buffer.alloc(aligned(binary.length) - binary.length)]);
  const total = 12 + 8 + json.length + (bin.length > 0 ? 8 + bin.length : 0);
  const output = Buffer.alloc(total);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(total, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  if (bin.length > 0) {
    const header = 20 + json.length;
    output.writeUInt32LE(bin.length, header);
    output.writeUInt32LE(0x004e4942, header + 4);
    bin.copy(output, header + 8);
  }
  return output;
}

export function parseGlb(bytes) {
  const data = Buffer.from(bytes);
  if (data.length < 20 || data.readUInt32LE(0) !== 0x46546c67) throw new Error('invalid GLB magic');
  if (data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) throw new Error('invalid GLB header');
  const jsonLength = data.readUInt32LE(12);
  if (data.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > data.length) throw new Error('invalid GLB JSON chunk');
  const json = JSON.parse(data.toString('utf8', 20, 20 + jsonLength).trim());
  if (json.asset?.version !== GLTF_VERSION) throw new Error(`unsupported glTF ${json.asset?.version}`);
  return json;
}
