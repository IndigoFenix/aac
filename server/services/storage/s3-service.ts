import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

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
