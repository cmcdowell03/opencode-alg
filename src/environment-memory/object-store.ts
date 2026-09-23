/** Bounded byte storage used by environment-memory replication. */

export type ObjectStoreErrorCode =
  | "invalid-key"
  | "object-too-large"
  | "conflict"
  | "unavailable"
  | "unsupported-runtime"
  | "aborted";

export class ObjectStoreError extends Error {
  readonly code: ObjectStoreErrorCode;

  constructor(code: ObjectStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObjectStoreError";
    this.code = code;
  }
}

export type PutIfAbsentResult = "created" | "already-present";

export interface ObjectStore {
  /** Returns null only when the key is absent. */
  get(key: string, options?: { signal?: AbortSignal }): Promise<Uint8Array | null>;
  /** Manifest reads also return the opaque token required for compare-and-swap. */
  getManifest(key: string, options?: { signal?: AbortSignal }): Promise<{ bytes: Uint8Array; version: string } | null>;
  /** Existing byte-identical objects are an idempotent success. */
  putIfAbsent(key: string, bytes: Uint8Array, options?: { signal?: AbortSignal }): Promise<PutIfAbsentResult>;
  /** expectedVersion=null means the manifest must not exist yet. */
  replaceManifest(key: string, bytes: Uint8Array, expectedVersion: string | null, options?: { signal?: AbortSignal }): Promise<{ version: string }>;
  readonly maxObjectBytes: number;
}

export const DEFAULT_MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

function validateLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_MAX_OBJECT_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OBJECT_BYTES) {
    throw new RangeError(`maxObjectBytes must be between 1 and ${MAX_OBJECT_BYTES}`);
  }
  return value;
}

function validateKey(key: string): string {
  if (key.length === 0 || key.length > 1024 || key.startsWith("/") || key.includes("\\") ||
      key.split("/").some((part) => part === "" || part === "." || part === "..") ||
      /[\u0000-\u001f\u007f]/.test(key)) {
    throw new ObjectStoreError("invalid-key", "Object key is not a safe relative key");
  }
  return key;
}

function validateBytes(bytes: Uint8Array, limit: number): void {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Object bytes must be a Uint8Array");
  if (bytes.byteLength > limit) throw new ObjectStoreError("object-too-large", `Object exceeds the ${limit}-byte limit`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ObjectStoreError("aborted", "Object-store operation was cancelled", { cause: signal.reason });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function classifyLocalError(error: unknown): never {
  if (error instanceof ObjectStoreError) throw error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EEXIST") throw new ObjectStoreError("conflict", "Conditional object update conflicted", { cause: error });
  throw new ObjectStoreError("unavailable", "Local object storage is unavailable", { cause: error });
}

/** Local immutable objects use same-filesystem hard-link publication. */
export class LocalDirectoryObjectStore implements ObjectStore {
  readonly maxObjectBytes: number;
  private readonly root: string;
  private readonly lockWaitMs: number;

  private constructor(root: string, maxObjectBytes: number, lockWaitMs: number) {
    this.root = root;
    this.maxObjectBytes = maxObjectBytes;
    this.lockWaitMs = lockWaitMs;
  }

  static async open(options: { directory: string; maxObjectBytes?: number; lockWaitMs?: number }): Promise<LocalDirectoryObjectStore> {
    const maxObjectBytes = validateLimit(options.maxObjectBytes);
    const lockWaitMs = options.lockWaitMs ?? 5_000;
    if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 60_000) throw new RangeError("lockWaitMs must be between 0 and 60000");
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      await fs.mkdir(options.directory, { recursive: true });
      const root = await fs.realpath(options.directory);
      if (!(await fs.stat(root)).isDirectory()) throw new Error("Storage root is not a directory");
      return new LocalDirectoryObjectStore(path.resolve(root), maxObjectBytes, lockWaitMs);
    } catch (error) {
      classifyLocalError(error);
    }
  }

  async get(key: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | null> {
    throwIfAborted(options.signal);
    const target = await this.resolveKey(validateKey(key), false);
    const bytes = await this.readFileBounded(await import("node:fs/promises"), target);
    throwIfAborted(options.signal);
    return bytes;
  }

  async getManifest(key: string, options: { signal?: AbortSignal } = {}): Promise<{ bytes: Uint8Array; version: string } | null> {
    const bytes = await this.get(key, options);
    return bytes === null ? null : { bytes, version: await sha256(bytes) };
  }

  async putIfAbsent(key: string, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<PutIfAbsentResult> {
    validateBytes(bytes, this.maxObjectBytes);
    throwIfAborted(options.signal);
    const target = await this.resolveKey(validateKey(key), true);
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const temp = path.join(path.dirname(target), `.put-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      throwIfAborted(options.signal);
      try {
        await fs.link(temp, target);
        await this.syncDirectory(fs, path.dirname(target));
        return "created";
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
        const existing = await this.get(key, options);
        if (existing && sameBytes(existing, bytes)) return "already-present";
        throw new ObjectStoreError("conflict", "Immutable object key already has different bytes", { cause: error });
      }
    } catch (error) {
      classifyLocalError(error);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async replaceManifest(key: string, bytes: Uint8Array, expectedVersion: string | null, options: { signal?: AbortSignal } = {}): Promise<{ version: string }> {
    validateBytes(bytes, this.maxObjectBytes);
    throwIfAborted(options.signal);
    const safeKey = validateKey(key);
    const target = await this.resolveKey(safeKey, true);
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const lockPath = `${target}.lock`;
    const lock = await this.acquireLock(fs, lockPath, options.signal);
    const temp = path.join(path.dirname(target), `.manifest-${crypto.randomUUID()}.tmp`);
    try {
      const current = await this.readFileBounded(fs, target);
      const actualVersion = current === null ? null : await sha256(current);
      if (actualVersion !== expectedVersion) throw new ObjectStoreError("conflict", "Manifest version changed before conditional replacement");
      throwIfAborted(options.signal);
      const handle = await fs.open(temp, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      throwIfAborted(options.signal);
      await fs.rename(temp, target);
      await this.syncDirectory(fs, path.dirname(target));
      return { version: await sha256(bytes) };
    } catch (error) {
      classifyLocalError(error);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      await lock.close().catch(() => undefined);
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  private async resolveKey(key: string, createParents: boolean): Promise<string> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const target = path.resolve(this.root, ...key.split("/"));
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) throw new ObjectStoreError("invalid-key", "Object key escapes the storage root");
    const parent = path.dirname(target);
    if (createParents) await fs.mkdir(parent, { recursive: true });
    try {
      const realParent = await fs.realpath(parent);
      if (realParent !== this.root && !realParent.startsWith(`${this.root}${path.sep}`)) throw new ObjectStoreError("invalid-key", "Object key resolves outside the storage root");
      try {
        if ((await fs.lstat(target)).isSymbolicLink()) throw new ObjectStoreError("invalid-key", "Object key is a symbolic link");
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
    return target;
  }

  private async readFileBounded(fs: typeof import("node:fs/promises"), target: string): Promise<Uint8Array | null> {
    try {
      const handle = await fs.open(target, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new ObjectStoreError("unavailable", "Object is not a regular file");
        if (info.size > this.maxObjectBytes) throw new ObjectStoreError("object-too-large", `Object exceeds the ${this.maxObjectBytes}-byte limit`);
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, this.maxObjectBytes + 1 - length));
          const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
          if (bytesRead === 0) break;
          length += bytesRead;
          if (length > this.maxObjectBytes) throw new ObjectStoreError("object-too-large", `Object exceeds the ${this.maxObjectBytes}-byte limit`);
          chunks.push(chunk.subarray(0, bytesRead));
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes;
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
      classifyLocalError(error);
    }
  }

  private async acquireLock(fs: typeof import("node:fs/promises"), lockPath: string, signal?: AbortSignal): Promise<import("node:fs/promises").FileHandle> {
    const deadline = Date.now() + this.lockWaitMs;
    while (true) {
      throwIfAborted(signal);
      try { return await fs.open(lockPath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") classifyLocalError(error);
        if (Date.now() >= deadline) throw new ObjectStoreError("unavailable", "Timed out waiting for the manifest lock", { cause: error });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 10);
          const onAbort = () => { clearTimeout(timer); reject(new ObjectStoreError("aborted", "Object-store operation was cancelled", { cause: signal?.reason })); };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      }
    }
  }

  private async syncDirectory(fs: typeof import("node:fs/promises"), directory: string): Promise<void> {
    try {
      const handle = await fs.open(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    } catch {
      // Directory fsync is unavailable on some supported platforms (notably Windows).
    }
  }
}

export interface S3ObjectResponse {
  body: AsyncIterable<Uint8Array> | null;
  contentLength?: number;
  versionToken?: string;
}

/** Narrow transport boundary makes S3 behavior testable without credentials or a bucket. */
export interface S3ObjectTransport {
  getObject(input: { bucket: string; key: string; signal?: AbortSignal }): Promise<S3ObjectResponse | null>;
  putObject(input: { bucket: string; key: string; bytes: Uint8Array; ifNoneMatch?: "*"; ifMatch?: string; signal?: AbortSignal }): Promise<{ versionToken: string }>;
}

export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  prefix?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  maxObjectBytes?: number;
}

export class S3ObjectStore implements ObjectStore {
  readonly maxObjectBytes: number;
  private readonly prefix: string;

  constructor(private readonly options: S3ObjectStoreOptions, private readonly transport: S3ObjectTransport) {
    if (!options.bucket.trim() || !options.region.trim()) throw new TypeError("S3 bucket and region are required");
    this.maxObjectBytes = validateLimit(options.maxObjectBytes);
    this.prefix = options.prefix ? `${validateKey(options.prefix.replace(/\/$/, ""))}/` : "";
  }

  async get(key: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | null> {
    throwIfAborted(options.signal);
    try {
      const response = await this.transport.getObject({ bucket: this.options.bucket, key: this.key(key), signal: options.signal });
      if (response === null) return null;
      if (response.contentLength !== undefined && response.contentLength > this.maxObjectBytes) throw new ObjectStoreError("object-too-large", `Object exceeds the ${this.maxObjectBytes}-byte limit`);
      if (!response.body) return new Uint8Array();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        throwIfAborted(options.signal);
        length += chunk.byteLength;
        if (length > this.maxObjectBytes) throw new ObjectStoreError("object-too-large", `Object exceeds the ${this.maxObjectBytes}-byte limit`);
        chunks.push(chunk);
      }
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    } catch (error) { this.rethrowTransportError(error); }
  }

  async getManifest(key: string, options: { signal?: AbortSignal } = {}): Promise<{ bytes: Uint8Array; version: string } | null> {
    throwIfAborted(options.signal);
    try {
      const response = await this.transport.getObject({ bucket: this.options.bucket, key: this.key(key), signal: options.signal });
      if (response === null) return null;
      if (!response.versionToken) throw new ObjectStoreError("unavailable", "S3 did not return a manifest version token");
      if (response.contentLength !== undefined && response.contentLength > this.maxObjectBytes) throw new ObjectStoreError("object-too-large", `Object exceeds the ${this.maxObjectBytes}-byte limit`);
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (response.body) for await (const chunk of response.body) {
        throwIfAborted(options.signal);
        length += chunk.byteLength;
        if (length > this.maxObjectBytes) throw new ObjectStoreError("object-too-large", `Object exceeds the ${this.maxObjectBytes}-byte limit`);
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { bytes, version: response.versionToken };
    } catch (error) { this.rethrowTransportError(error); }
  }

  async putIfAbsent(key: string, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<PutIfAbsentResult> {
    validateBytes(bytes, this.maxObjectBytes);
    throwIfAborted(options.signal);
    try {
      await this.transport.putObject({ bucket: this.options.bucket, key: this.key(key), bytes, ifNoneMatch: "*", signal: options.signal });
      return "created";
    } catch (error) {
      if (!isConditionalConflict(error)) this.rethrowTransportError(error);
      const existing = await this.get(key, options);
      if (existing !== null && sameBytes(existing, bytes)) return "already-present";
      throw new ObjectStoreError("conflict", "Immutable object key already has different bytes", { cause: error });
    }
  }

  async replaceManifest(key: string, bytes: Uint8Array, expectedVersion: string | null, options: { signal?: AbortSignal } = {}): Promise<{ version: string }> {
    validateBytes(bytes, this.maxObjectBytes);
    throwIfAborted(options.signal);
    try {
      const result = await this.transport.putObject({
        bucket: this.options.bucket,
        key: this.key(key),
        bytes,
        ...(expectedVersion === null ? { ifNoneMatch: "*" as const } : { ifMatch: expectedVersion }),
        signal: options.signal,
      });
      if (!result.versionToken) throw new ObjectStoreError("unavailable", "S3 did not return a manifest version token");
      return { version: result.versionToken };
    } catch (error) {
      if (isConditionalConflict(error)) throw new ObjectStoreError("conflict", "Manifest version changed before conditional replacement", { cause: error });
      this.rethrowTransportError(error);
    }
  }

  private key(key: string): string { return `${this.prefix}${validateKey(key)}`; }

  private rethrowTransportError(error: unknown): never {
    if (error instanceof ObjectStoreError) throw error;
    if ((error as { name?: string } | undefined)?.name === "AbortError") throw new ObjectStoreError("aborted", "S3 object-store operation was cancelled", { cause: error });
    throw new ObjectStoreError("unavailable", "S3 object storage is unavailable", { cause: error });
  }
}

function isConditionalConflict(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return e?.$metadata?.httpStatusCode === 409 || e?.$metadata?.httpStatusCode === 412 || e?.name === "PreconditionFailed" || e?.name === "ConditionalRequestConflict" || e?.Code === "PreconditionFailed";
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return e?.$metadata?.httpStatusCode === 404 || e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.Code === "NoSuchKey";
}

/** Construct the production transport only when S3 is explicitly selected. */
export async function openS3ObjectStore(options: S3ObjectStoreOptions, transport?: S3ObjectTransport): Promise<S3ObjectStore> {
  if (transport) return new S3ObjectStore(options, transport);
  try {
    const sdk = await import("@aws-sdk/client-s3");
    const client = new sdk.S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      // Omit credentials so the AWS SDK standard provider chain supplies them.
    });
    const productionTransport: S3ObjectTransport = {
      async getObject(input) {
        try {
          const response = await client.send(new sdk.GetObjectCommand({ Bucket: input.bucket, Key: input.key }), { abortSignal: input.signal });
          return {
            body: (response.Body as AsyncIterable<Uint8Array> | undefined) ?? null,
            ...(response.ContentLength === undefined ? {} : { contentLength: response.ContentLength }),
            ...(response.ETag ? { versionToken: response.ETag } : {}),
          };
        } catch (error) { if (isNotFound(error)) return null; throw error; }
      },
      async putObject(input) {
        const response = await client.send(new sdk.PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.bytes,
          ...(input.ifNoneMatch ? { IfNoneMatch: input.ifNoneMatch } : {}),
          ...(input.ifMatch ? { IfMatch: input.ifMatch } : {}),
        }), { abortSignal: input.signal });
        if (!response.ETag) throw new ObjectStoreError("unavailable", "S3 did not return an object version token");
        return { versionToken: response.ETag };
      },
    };
    return new S3ObjectStore(options, productionTransport);
  } catch (error) {
    if (error instanceof ObjectStoreError) throw error;
    if ((error as { code?: string } | undefined)?.code === "ERR_MODULE_NOT_FOUND") throw new ObjectStoreError("unsupported-runtime", "S3 support is unavailable in this package", { cause: error });
    throw new ObjectStoreError("unavailable", "Could not initialize the S3 object-store client", { cause: error });
  }
}
