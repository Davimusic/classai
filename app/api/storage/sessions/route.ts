import { NextResponse, connection } from "next/server";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { b2Ready, bucket, getS3, ownerPrefix } from "../../../../lib/b2";

export async function GET() {
  await connection();
  if (!b2Ready()) {
    return NextResponse.json({ error: "El almacenamiento en la nube no está configurado." }, { status: 503 });
  }

  try {
    const s3 = getS3();
    const keys: string[] = [];
    let token: string | undefined;

    do {
      const out = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket(),
          Prefix: `${ownerPrefix()}/sessions/`,
          ContinuationToken: token,
        })
      );
      for (const o of out.Contents ?? []) {
        if (o.Key && o.Key.endsWith("/info.json")) keys.push(o.Key);
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);

    // El id empieza con la hora, así que ordenar por nombre ordena por fecha
    keys.sort().reverse();

    const sessions = (
      await Promise.all(
        keys.slice(0, 50).map(async (Key) => {
          try {
            const o = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key }));
            return JSON.parse(await (o.Body as any).transformToString());
          } catch {
            return null;
          }
        })
      )
    ).filter(Boolean);

    return NextResponse.json({ sessions });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "No pude cargar tus clases guardadas." }, { status: 500 });
  }
}