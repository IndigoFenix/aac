import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const bucket = process.env.S3_UPLOADS_BUCKET;

const s3 = new S3Client({
  region: process.env.AWS_REGION || process.env.AWS_SECRETS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  } : {}),
});

function requireBucket(): string {
  if (!bucket) {
    throw new Error("S3_UPLOADS_BUCKET environment variable is not set");
  }
  return bucket;
}

export const s3Service = {
  async upload(key: string, buffer: Buffer, contentType: string): Promise<void> {
    await s3.send(new PutObjectCommand({
      Bucket: requireBucket(),
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
  },

  async download(key: string): Promise<Buffer> {
    const result = await s3.send(new GetObjectCommand({
      Bucket: requireBucket(),
      Key: key,
    }));
    const stream = result.Body;
    if (!stream) throw new Error(`Empty response for S3 key: ${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  },

  async delete(key: string): Promise<void> {
    await s3.send(new DeleteObjectCommand({
      Bucket: requireBucket(),
      Key: key,
    }));
  },

  /**
   * A time-limited URL the CLIENT fetches directly, so the bytes never pass
   * through this process.
   *
   * The alternative — downloading from S3 and re-serving, as
   * `GET /api/custom-symbols/:id/image` does — pays Lambda duration plus S3
   * egress plus CloudFront egress for every image, and caches nothing. That is
   * tolerable for 256px symbols and not for a photo board.
   *
   * Callers MUST authorize access before minting one of these: the URL itself
   * is the capability, and anyone holding it can read the object until it
   * expires. Keep the TTL short for that reason.
   */
  async presignGet(key: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: requireBucket(), Key: key }),
      { expiresIn: expiresInSeconds },
    );
  },

  async exists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: requireBucket(),
        Key: key,
      }));
      return true;
    } catch (err: any) {
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  },
};
