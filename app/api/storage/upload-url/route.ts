import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { b2Ready, bucket, getS3, prefixFor, validId } from "../../../../lib/b2";

const EXTS = ["webm", "m4a", "mp3", "wav", "ogg", "bin"];

export async function POST(req: NextRequest) {
  if (!b2Ready()) {
    return NextResponse.json({ error: "El almacenamiento en la nube no está configurado." }, { status: 503 });
  }
  try {
    const { id, contentType, ext } = await req.json();
    if (!validId(id)) return NextResponse.json({ error: "Id no válido." }, { status: 400 });

    const safeExt = EXTS.includes(ext) ? ext : "bin";
    const key = `${prefixFor(id)}audio.${safeExt}`;
    const type = String(contentType || "application/octet-stream").slice(0, 100);

    const url = await getSignedUrl(
      getS3(),
      new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: type }),
      { expiresIn: 3600 }
    );
    return NextResponse.json({ url, key });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "No se pudo preparar el guardado." }, { status: 500 });
  }
}