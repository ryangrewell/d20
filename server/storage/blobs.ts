/**
 * Private media storage. Objects are never public; access goes through
 * short-lived presigned URLs issued after a campaign permission check.
 */
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ServerConfig } from '../config';

export class Blobs {
  private readonly s3: S3Client;
  /** Separate signer so URLs handed to browsers use a reachable host (e.g. localhost vs container name). */
  private readonly signer: S3Client;
  readonly bucket: string;

  constructor(cfg: Pick<ServerConfig, 'bucketName' | 'region' | 's3Endpoint' | 's3PublicEndpoint' | 's3ForcePathStyle'>) {
    const local = cfg.s3Endpoint ? { credentials: { accessKeyId: 'd20local', secretAccessKey: 'd20localsecret' } } : {};
    this.s3 = new S3Client({ region: cfg.region, forcePathStyle: cfg.s3ForcePathStyle, ...(cfg.s3Endpoint ? { endpoint: cfg.s3Endpoint } : {}), ...local });
    const pub = cfg.s3PublicEndpoint ?? cfg.s3Endpoint;
    this.signer = new S3Client({ region: cfg.region, forcePathStyle: cfg.s3ForcePathStyle, ...(pub ? { endpoint: pub } : {}), ...local });
    this.bucket = cfg.bucketName;
  }

  presignPut(key: string, contentType: string, bytes: number, expiresIn = 300) {
    return getSignedUrl(this.signer, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: bytes }), { expiresIn });
  }

  presignGet(key: string, expiresIn = 900) {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }

  async head(key: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: r.ContentLength ?? 0, contentType: r.ContentType };
    } catch {
      return null;
    }
  }

  /** Reads the first `n` bytes (magic number + image header sniffing). */
  async readHead(key: string, n = 64 * 1024): Promise<Uint8Array> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${n - 1}` }));
    return new Uint8Array(await r.Body!.transformToByteArray());
  }

  async getJson<T>(key: string): Promise<T> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return JSON.parse(await r.Body!.transformToString()) as T;
  }

  async putBytes(key: string, body: Uint8Array, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  /** Local development only: create the bucket with CORS for browser uploads. */
  async ensureLocalBucket(origins: string[]) {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    // MinIO allows all origins by default and rejects the bucket CORS API; real S3 needs it.
    await this.s3
      .send(
        new PutBucketCorsCommand({
          Bucket: this.bucket,
          CORSConfiguration: { CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['GET', 'PUT'], AllowedHeaders: ['*'], MaxAgeSeconds: 3000 }] },
        }),
      )
      .catch(() => undefined);
  }
}
