import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { extractPbrMaps, ExtractionError } from '../src/extract.js';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function pad4(bytes: Buffer, paddingByte = 0) {
  const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4, paddingByte);
  bytes.copy(padded);
  return padded;
}

function makeGlb(document: Record<string, unknown>, binary: Buffer) {
  const json = pad4(Buffer.from(JSON.stringify(document)), 0x20);
  const bin = pad4(binary);
  const result = Buffer.alloc(12 + 8 + json.length + 8 + bin.length);
  result.writeUInt32LE(GLB_MAGIC, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12);
  result.writeUInt32LE(JSON_CHUNK, 16);
  json.copy(result, 20);
  const binHeader = 20 + json.length;
  result.writeUInt32LE(bin.length, binHeader);
  result.writeUInt32LE(BIN_CHUNK, binHeader + 4);
  bin.copy(result, binHeader + 8);
  return result;
}

async function fixture() {
  const base = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 21, g: 22, b: 23, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const packed = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 10, g: 120, b: 200, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const binary = Buffer.alloc(pad4(base).length + pad4(packed).length);
  pad4(base).copy(binary, 0);
  pad4(packed).copy(binary, pad4(base).length);
  const document = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: base.length },
      {
        buffer: 0,
        byteOffset: pad4(base).length,
        byteLength: packed.length,
      },
    ],
    images: [
      { bufferView: 0, mimeType: 'image/png' },
      { bufferView: 1, mimeType: 'image/png' },
    ],
    textures: [{ source: 0 }, { source: 1 }],
    materials: [
      {
        name: 'Paint Red',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicRoughnessTexture: { index: 1 },
          roughnessFactor: 0.5,
          metallicFactor: 0.25,
        },
        normalTexture: { index: 0 },
      },
    ],
  };
  return { glb: makeGlb(document, binary), base, document };
}

async function tempDir(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'texture-mcp-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('extracts original base/normal bytes and splits packed channels with factors', async (t) => {
  const directory = await tempDir(t);
  const { glb, base } = await fixture();
  const input = path.join(directory, 'sample.glb');
  const outputDir = path.join(directory, 'out');
  await writeFile(input, glb);

  const result = await extractPbrMaps({ glbPath: input, outputDir });
  assert.equal(result.writtenFiles.length, 4);
  assert.deepEqual(result.skippedMaps, []);
  assert.deepEqual(result.warnings, []);

  const baseColor = await readFile(
    path.join(outputDir, 'material-001-paint-red-base-color.png')
  );
  const normal = await readFile(
    path.join(outputDir, 'material-001-paint-red-normal.png')
  );
  assert.deepEqual(baseColor, base);
  assert.deepEqual(normal, base);

  const roughness = await sharp(
    path.join(outputDir, 'material-001-paint-red-roughness.png')
  )
    .raw()
    .toBuffer();
  const metallic = await sharp(
    path.join(outputDir, 'material-001-paint-red-metallic.png')
  )
    .raw()
    .toBuffer();
  assert.deepEqual([...roughness], [60, 60, 60, 255]);
  assert.deepEqual([...metallic], [50, 50, 50, 255]);
});

test('does not overwrite outputs unless overwrite is true', async (t) => {
  const directory = await tempDir(t);
  const { glb } = await fixture();
  const input = path.join(directory, 'sample.glb');
  const outputDir = path.join(directory, 'out');
  const basePath = path.join(
    outputDir,
    'material-001-paint-red-base-color.png'
  );
  await writeFile(input, glb);

  await extractPbrMaps({ glbPath: input, outputDir });
  await writeFile(basePath, 'keep-existing-file');
  const skipped = await extractPbrMaps({ glbPath: input, outputDir });
  assert.equal(skipped.skippedMaps.length, 4);
  assert.equal(await readFile(basePath, 'utf8'), 'keep-existing-file');

  const overwritten = await extractPbrMaps({
    glbPath: input,
    outputDir,
    overwrite: true,
  });
  assert.equal(overwritten.writtenFiles.length, 4);
  assert.equal(overwritten.skippedMaps.length, 0);
  assert.notEqual(await readFile(basePath, 'utf8'), 'keep-existing-file');
});

test('rejects an invalid GLB with a clear error', async (t) => {
  const directory = await tempDir(t);
  const input = path.join(directory, 'broken.glb');
  await writeFile(input, Buffer.from('not a glb'));
  await assert.rejects(
    extractPbrMaps({ glbPath: input }),
    (error: unknown) =>
      error instanceof ExtractionError && /valid-sized GLB/.test(error.message)
  );
});

test('returns a clear error when the GLB has no PBR maps', async (t) => {
  const directory = await tempDir(t);
  const input = path.join(directory, 'empty.glb');
  const glb = makeGlb(
    {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 0 }],
      materials: [{}],
    },
    Buffer.alloc(0)
  );
  await writeFile(input, glb);
  await assert.rejects(
    extractPbrMaps({ glbPath: input }),
    (error: unknown) =>
      error instanceof ExtractionError &&
      /No extractable embedded PBR maps/.test(error.message)
  );
});

test('supports a PNG data URI as a source image', async (t) => {
  const directory = await tempDir(t);
  const { base } = await fixture();
  const input = path.join(directory, 'data-uri.glb');
  const document = {
    asset: { version: '2.0' },
    images: [{ uri: `data:image/png;base64,${base.toString('base64')}` }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  };
  await writeFile(input, makeGlb(document, Buffer.alloc(0)));
  const result = await extractPbrMaps({ glbPath: input });
  assert.equal(result.writtenFiles.length, 1);
  assert.deepEqual(await readFile(result.writtenFiles[0]), base);
});

test('preserves binary bytes in percent-encoded data URIs', async (t) => {
  const directory = await tempDir(t);
  const { base } = await fixture();
  const payload = [...base]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
  const input = path.join(directory, 'percent-data-uri.glb');
  const document = {
    asset: { version: '2.0' },
    images: [{ uri: `data:image/png,${payload}` }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  };
  await writeFile(input, makeGlb(document, Buffer.alloc(0)));
  const result = await extractPbrMaps({ glbPath: input });
  assert.deepEqual(await readFile(result.writtenFiles[0]), base);
});
