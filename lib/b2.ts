import { S3Client } from "@aws-sdk/client-s3";

let client: S3Client | null = null;

export const b2Ready = () =>
  !!(process.env.B2_ENDPOINT && process.env.B2_KEY_ID && process.env.B2_APP_KEY && process.env.B2_BUCKET);

export const bucket = () => process.env.B2_BUCKET as string;

export function getS3() {
  if (!client) {
    const endpoint = (process.env.B2_ENDPOINT as string).trim();
    const region = endpoint.split(".")[1] || "us-west-004";
    client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId: (process.env.B2_KEY_ID as string).trim(),
        secretAccessKey: (process.env.B2_APP_KEY as string).trim(),
      },
      // B2 no acepta los checksums extra que añade el SDK nuevo
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
}

export const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-z0-9-]{6,40}$/.test(id);

// Hoy todas las clases viven en una carpeta compartida.
// Cuando integres el login de tu proyecto, devuelve aquí el id del usuario.
export const ownerPrefix = () => "shared";
export const prefixFor = (id: string) => `${ownerPrefix()}/sessions/${id}/`;