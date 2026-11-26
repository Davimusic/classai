import { NextRequest, NextResponse, connection } from "next/server";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { b2Ready, bucket, getS3, prefixFor, validId } from "../../../../lib/b2";

const notReady = () =>
  NextResponse.json({ error: "El almacenamiento en la nube no está configurado." }, { status: 503 });

// Guarda la clase: datos completos + ficha corta para la lista
export async function POST(req: NextRequest) {
  if (!b2Ready()) return notReady();
  try {
    const b = await req.json();
    if (!validId(b.id)) return NextResponse.json({ error: "Id no válido." }, { status: 400 });

    const prefix = prefixFor(b.id);
    if (typeof b.audioKey !== "string" || !b.audioKey.startsWith(prefix)) {
      return NextResponse.json({ error: "Audio no válido." }, { status: 400 });
    }

    const transcription = String(b.transcription || "");
    const title = String(b.title || "Clase").slice(0, 120);
    const createdAt = String(b.createdAt || new Date().toISOString());
    const duration = Number(b.duration) || 0;

    const segments = (Array.isArray(b.segments) ? b.segments : []).map((s: any) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text || ""),
    }));
    const peaks = (Array.isArray(b.peaks) ? b.peaks : []).map((p: any) =>
      Math.max(0, Math.min(100, Math.round(Number(p) || 0)))
    );

    const data = {
      id: b.id,
      title,
      createdAt,
      audioKey: b.audioKey,
      audioType: String(b.audioType || "").slice(0, 100),
      duration,
      peaks,
      transcription,
      segments,
    };
    const info = { id: b.id, title, createdAt, duration, hasTranscript: transcription.length > 0 };

    const s3 = getS3();
    await Promise.all([
      s3.send(new PutObjectCommand({ Bucket: bucket(), Key: `${prefix}data.json`, Body: JSON.stringify(data), ContentType: "application/json" })),
      s3.send(new PutObjectCommand({ Bucket: bucket(), Key: `${prefix}info.json`, Body: JSON.stringify(info), ContentType: "application/json" })),
    ]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "No se pudo guardar la clase." }, { status: 500 });
  }
}

// Abre una clase: devuelve sus datos y una URL temporal para reproducir el audio
export async function GET(req: NextRequest) {
  await connection();
  if (!b2Ready()) return notReady();
  const id = req.nextUrl.searchParams.get("id");
  if (!validId(id)) return NextResponse.json({ error: "Id no válido." }, { status: 400 });

  try {
    const s3 = getS3();
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: `${prefixFor(id)}data.json` }));
    const data = JSON.parse(await (obj.Body as any).transformToString());

    const audioUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket(), Key: data.audioKey }),
      { expiresIn: 3600 }
    );
    return NextResponse.json({ ...data, audioUrl });
  } catch (err: any) {
    if (err?.name === "NoSuchKey") {
      return NextResponse.json({ error: "Esta clase ya no existe." }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: "No pude abrir esta clase." }, { status: 500 });
  }
}

// Borra la clase completa (audio y datos)
export async function DELETE(req: NextRequest) {
  if (!b2Ready()) return notReady();
  const id = req.nextUrl.searchParams.get("id");
  if (!validId(id)) return NextResponse.json({ error: "Id no válido." }, { status: 400 });

  try {
    const s3 = getS3();
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefixFor(id) }));
    await Promise.all(
      (list.Contents ?? [])
        .filter((o) => o.Key)
        .map((o) => s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: o.Key as string })))
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "No se pudo borrar la clase." }, { status: 500 });
  }
}