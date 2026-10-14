import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const MAX_GLB_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const SUPPORTED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

type JsonObject = Record<string, unknown>;

interface ImageSource {
  bytes: Buffer;
  mimeType: string;
}

interface Candidate {
  materialLabel: string;
  materialIndex: number;
  role: 'base-color' | 'normal' | 'roughness' | 'metallic';
  source: ImageSource;
  factor?: number;
}

export interface ExtractOptions {
  glbPath: string;
  outputDir?: string;
  overwrite?: boolean;
}

export interface ExtractResult {
  inputPath: string;
  outputDir: string;
  writtenFiles: string[];
  skippedMaps: string[];
  warnings: string[];
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function indexed<T>(value: unknown, index: number): T | undefined {
  return Array.isArray(value) ? (value[index] as T | undefined) : undefined;
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseGlb(bytes: Buffer) {
  if (bytes.byteLength < 20 || bytes.byteLength > MAX_GLB_BYTES) {
    throw new ExtractionError('Input is not a valid-sized GLB 2.0 file.');
  }
  if (
    bytes.readUInt32LE(0) !== GLB_MAGIC ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.byteLength
  ) {
    throw new ExtractionError('Input is not a valid GLB 2.0 file.');
  }

  let offset = 12;
  let document: JsonObject | undefined;
  let binary: Buffer | undefined;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) {
      throw new ExtractionError('GLB contains a truncated chunk header.');
    }
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (length % 4 !== 0 || end > bytes.byteLength || end < start) {
      throw new ExtractionError('GLB contains an invalid or truncated chunk.');
    }
    if (type === JSON_CHUNK) {
      if (document || offset !== 12) {
        throw new ExtractionError('GLB must start with one JSON chunk.');
      }
      try {
        document = object(JSON.parse(bytes.toString('utf8', start, end)));
      } catch {
        throw new ExtractionError('GLB JSON chunk is invalid.');
      }
      if (!document) throw new ExtractionError('GLB JSON must be an object.');
    } else if (type === BIN_CHUNK) {
      if (binary) throw new ExtractionError('GLB has multiple binary chunks.');
      binary = bytes.subarray(start, end);
    }
    offset = end;
  }
  if (!document) throw new ExtractionError('GLB is missing its JSON chunk.');

  const buffers = list<JsonObject>(document.buffers);
  if (
    buffers.length > 1 ||
    (buffers[0]?.uri !== undefined && buffers[0]?.uri !== null)
  ) {
    throw new ExtractionError('Only the embedded GLB buffer is supported.');
  }
  const declaredLength = buffers[0]?.byteLength;
  if (declaredLength !== undefined && !integer(declaredLength)) {
    throw new ExtractionError('GLB buffer length is invalid.');
  }
  if (
    declaredLength !== undefined &&
    binary &&
    declaredLength > binary.byteLength
  ) {
    throw new ExtractionError('GLB buffer length exceeds its binary chunk.');
  }

  return { document, binary: binary ?? Buffer.alloc(0), declaredLength };
}

function sniffMime(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

function decodeDataUri(uri: string): ImageSource | undefined {
  const comma = uri.indexOf(',');
  if (!uri.startsWith('data:') || comma < 0) return undefined;
  const metadata = uri.slice(5, comma);
  const declaredMime = metadata.split(';', 1)[0]?.toLowerCase() ?? '';
  const payload = uri.slice(comma + 1);
  let bytes: Buffer;
  try {
    if (metadata.toLowerCase().split(';').includes('base64')) {
      bytes = Buffer.from(payload, 'base64');
    } else {
      const parts: Buffer[] = [];
      for (let index = 0; index < payload.length; ) {
        if (payload[index] === '%') {
          const hex = payload.slice(index + 1, index + 3);
          if (!/^[0-9a-f]{2}$/i.test(hex)) return undefined;
          parts.push(Buffer.from([Number.parseInt(hex, 16)]));
          index += 3;
        } else {
          const codePoint = payload.codePointAt(index);
          if (codePoint === undefined) return undefined;
          parts.push(Buffer.from(String.fromCodePoint(codePoint), 'utf8'));
          index += codePoint > 0xffff ? 2 : 1;
        }
      }
      bytes = Buffer.concat(parts);
    }
  } catch {
    return undefined;
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return undefined;
  const mimeType = sniffMime(bytes);
  if (
    !mimeType ||
    !SUPPORTED_MIME.has(declaredMime) ||
    mimeType !== declaredMime
  ) {
    return undefined;
  }
  return { bytes, mimeType };
}

function imageForTexture(
  document: JsonObject,
  binary: Buffer,
  declaredLength: number | undefined,
  textureIndex: number,
  warnings: string[]
): ImageSource | undefined {
  const texture = object(indexed(document.textures, textureIndex));
  if (!texture) {
    warnings.push(`Texture index ${textureIndex} does not exist.`);
    return undefined;
  }
  const extensions = object(texture.extensions);
  const sourceValues = [
    texture.source,
    object(extensions?.KHR_texture_webp)?.source,
    object(extensions?.KHR_texture_basisu)?.source,
    object(extensions?.EXT_texture_webp)?.source,
  ].filter((value) => value !== undefined);
  const distinct = [...new Set(sourceValues)];
  if (distinct.length !== 1 || !integer(distinct[0])) {
    warnings.push(
      `Texture ${textureIndex} has no unambiguous supported image source.`
    );
    return undefined;
  }

  const image = object(indexed(document.images, distinct[0]));
  if (!image) {
    warnings.push(`Texture ${textureIndex} refers to a missing image.`);
    return undefined;
  }
  if (typeof image.uri === 'string') {
    const dataImage = decodeDataUri(image.uri);
    if (dataImage) return dataImage;
    warnings.push(
      `Image ${distinct[0]} is not a supported PNG, JPEG, or WebP data URI.`
    );
    return undefined;
  }
  if (!integer(image.bufferView)) {
    warnings.push(
      `Image ${distinct[0]} is not embedded in a supported buffer view.`
    );
    return undefined;
  }

  const bufferView = object(indexed(document.bufferViews, image.bufferView));
  const start =
    bufferView?.byteOffset === undefined ? 0 : bufferView.byteOffset;
  const length = bufferView?.byteLength;
  if (
    !bufferView ||
    bufferView.buffer !== 0 ||
    !integer(start) ||
    !integer(length) ||
    length === 0 ||
    length > MAX_IMAGE_BYTES ||
    start + length > (declaredLength ?? binary.byteLength) ||
    start + length > binary.byteLength
  ) {
    warnings.push(`Image ${distinct[0]} has an invalid embedded buffer view.`);
    return undefined;
  }
  const bytes = binary.subarray(start, start + length);
  const mimeType = sniffMime(bytes);
  if (
    !mimeType ||
    !SUPPORTED_MIME.has(mimeType) ||
    (image.mimeType !== undefined && image.mimeType !== mimeType)
  ) {
    warnings.push(
      `Image ${distinct[0]} is not a supported PNG, JPEG, or WebP image.`
    );
    return undefined;
  }
  return { bytes, mimeType };
}

function safeLabel(value: unknown, fallback: string) {
  const label = typeof value === 'string' ? value : fallback;
  const normalized = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'material';
}

function imageExtension(mimeType: string) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function materialFactor(value: unknown, name: string, warnings: string[]) {
  if (value === undefined) return 1;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    warnings.push(`Invalid ${name}; using the glTF default factor of 1.`);
    return 1;
  }
  if (value > 1) {
    warnings.push(`Invalid ${name}; using the glTF default factor of 1.`);
    return 1;
  }
  return value;
}

function collectCandidates(
  document: JsonObject,
  binary: Buffer,
  declaredLength: number | undefined,
  warnings: string[]
) {
  const candidates: Candidate[] = [];
  const materials = list<JsonObject>(document.materials);
  for (const [materialIndex, rawMaterial] of materials.entries()) {
    const material = object(rawMaterial) ?? {};
    const pbr = object(material.pbrMetallicRoughness);
    const materialLabel = safeLabel(
      material.name,
      `material-${materialIndex + 1}`
    );
    const references: Array<
      ['base-color' | 'normal' | 'roughness' | 'metallic', unknown, number?]
    > = [
      ['base-color', object(pbr?.baseColorTexture)?.index],
      ['normal', object(material.normalTexture)?.index],
      [
        'roughness',
        object(pbr?.metallicRoughnessTexture)?.index,
        materialFactor(pbr?.roughnessFactor, 'roughnessFactor', warnings),
      ],
      [
        'metallic',
        object(pbr?.metallicRoughnessTexture)?.index,
        materialFactor(pbr?.metallicFactor, 'metallicFactor', warnings),
      ],
    ];
    const resolved = new Map<number, ImageSource | undefined>();
    for (const [role, rawIndex, factor] of references) {
      if (rawIndex === undefined) continue;
      if (!integer(rawIndex)) {
        warnings.push(
          `Material ${materialIndex + 1} has an invalid ${role} texture index.`
        );
        continue;
      }
      let source = resolved.get(rawIndex);
      if (!resolved.has(rawIndex)) {
        source = imageForTexture(
          document,
          binary,
          declaredLength,
          rawIndex,
          warnings
        );
        resolved.set(rawIndex, source);
      }
      if (!source) continue;
      candidates.push({ materialIndex, materialLabel, role, source, factor });
    }
  }
  return candidates;
}

async function splitChannel(bytes: Buffer, channel: 1 | 2, factor: number) {
  const decoded = await sharp(bytes, { limitInputPixels: 100_000_000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = Buffer.alloc(decoded.info.width * decoded.info.height * 4);
  for (let index = 0; index < output.length; index += 4) {
    const value = Math.max(
      0,
      Math.min(
        255,
        Math.round(decoded.data[(index / 4) * 4 + channel] * factor)
      )
    );
    output[index] = value;
    output[index + 1] = value;
    output[index + 2] = value;
    output[index + 3] = 255;
  }
  return sharp(output, {
    raw: {
      width: decoded.info.width,
      height: decoded.info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function extractPbrMaps(
  options: ExtractOptions
): Promise<ExtractResult> {
  const inputPath = path.resolve(options.glbPath);
  const inputStat = await stat(inputPath).catch(() => undefined);
  if (!inputStat?.isFile()) {
    throw new ExtractionError(`GLB file does not exist: ${inputPath}`);
  }
  if (inputStat.size > MAX_GLB_BYTES) {
    throw new ExtractionError('GLB exceeds the 512 MiB safety limit.');
  }

  const outputDir = path.resolve(
    options.outputDir ??
      path.join(
        path.dirname(inputPath),
        `${path.basename(inputPath, path.extname(inputPath))}-textures`
      )
  );
  const warnings: string[] = [];
  const parsed = parseGlb(await readFile(inputPath));
  const candidates = collectCandidates(
    parsed.document,
    parsed.binary,
    parsed.declaredLength,
    warnings
  );
  if (candidates.length === 0) {
    throw new ExtractionError(
      `No extractable embedded PBR maps were found in ${inputPath}. ${warnings.join(' ')}`.trim()
    );
  }

  await mkdir(outputDir, { recursive: true });
  const writtenFiles: string[] = [];
  const skippedMaps: string[] = [];
  const claimed = new Set<string>();
  for (const candidate of candidates) {
    const extension =
      candidate.role === 'roughness' || candidate.role === 'metallic'
        ? 'png'
        : imageExtension(candidate.source.mimeType);
    const filename = `material-${String(candidate.materialIndex + 1).padStart(3, '0')}-${candidate.materialLabel}-${candidate.role}.${extension}`;
    const destination = path.join(outputDir, filename);
    const label = `${candidate.materialLabel}: ${candidate.role}`;
    if (claimed.has(destination)) {
      skippedMaps.push(`${label} (duplicate material map)`);
      continue;
    }
    claimed.add(destination);
    const bytes =
      candidate.role === 'roughness'
        ? await splitChannel(candidate.source.bytes, 1, candidate.factor ?? 1)
        : candidate.role === 'metallic'
          ? await splitChannel(candidate.source.bytes, 2, candidate.factor ?? 1)
          : candidate.source.bytes;

    if (!options.overwrite && (await exists(destination))) {
      skippedMaps.push(
        `${filename} (already exists; set overwrite=true to replace)`
      );
      continue;
    }
    try {
      if (options.overwrite) await writeFile(destination, bytes);
      else await writeFile(destination, bytes, { flag: 'wx' });
      writtenFiles.push(destination);
    } catch (error) {
      if (
        !options.overwrite &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        skippedMaps.push(
          `${filename} (already exists; set overwrite=true to replace)`
        );
        continue;
      }
      throw error;
    }
  }

  return { inputPath, outputDir, writtenFiles, skippedMaps, warnings };
}
