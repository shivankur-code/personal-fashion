// Minimal Blob Storage client over REST with managed-identity tokens (no SDK, small bundle).
import type { TokenProvider } from '@stylist/model-gateway';

export interface BlobStore {
  put(path: string, body: Buffer, contentType: string): Promise<void>;
  /** null when the blob does not exist. */
  get(path: string): Promise<Buffer | null>;
}

export class AzureBlobStore implements BlobStore {
  constructor(private readonly account: string, private readonly token: TokenProvider, private readonly fetchImpl: typeof fetch = fetch) {}

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.token('https://storage.azure.com')}`, 'x-ms-version': '2023-11-03', ...extra };
  }

  async put(path: string, body: Buffer, contentType: string): Promise<void> {
    const res = await this.fetchImpl(`https://${this.account}.blob.core.windows.net/${path}`, {
      method: 'PUT',
      headers: await this.headers({ 'x-ms-blob-type': 'BlockBlob', 'content-type': contentType }),
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 201) throw new Error(`blob put ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  async get(path: string): Promise<Buffer | null> {
    const res = await this.fetchImpl(`https://${this.account}.blob.core.windows.net/${path}`, {
      headers: await this.headers(), signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`blob get ${path}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly items = new Map<string, Buffer>();
  async put(path: string, body: Buffer): Promise<void> { this.items.set(path, body); }
  async get(path: string): Promise<Buffer | null> { return this.items.get(path) ?? null; }
}
