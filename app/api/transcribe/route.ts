import { NextRequest, NextResponse } from "next/server";

const MUSIC_PROMPT =
  "Clase de música. Términos: cadencia, arpegio, síncopa, tresillo, compás, tonalidad, acorde, séptima, escala mayor, escala menor, modo dórico, solfeo, armonía, melodía, ritmo, tempo, negra, corchea, semicorchea, Do, Re, Mi, Fa, Sol, La, Si.";

export async function POST(req: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Falta GROQ_API_KEY en el servidor." }, { status: 500 });
  }

  try {
    const incoming = await req.formData();
    const file = incoming.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No se recibió ningún audio." }, { status: 400 });
    }

    const form = new FormData();
    form.append("file", file, file.name || "audio.webm");
    form.append("model", "whisper-large-v3");
    form.append("response_format", "verbose_json");
    form.append("language", "es");
    form.append("temperature", "0");
    form.append("prompt", MUSIC_PROMPT);

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      return NextResponse.json(
        { error: data?.error?.message || "Error en la transcripción.", retryAfter },
        { status: res.status }
      );
    }

    // Quita frases inventadas por Whisper en silencios o con música
    const kept = (data.segments ?? []).filter(
      (s: any) =>
        !(s.no_speech_prob > 0.6 && s.avg_logprob < -0.8) && !(s.compression_ratio > 2.4)
    );

    const segments = kept.map((s: any) => ({ start: s.start, end: s.end, text: s.text }));
    const text = data.segments
      ? kept.map((s: any) => String(s.text).trim()).join(" ")
      : data.text ?? "";

    return NextResponse.json({ text, segments });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Fallo interno al transcribir." }, { status: 500 });
  }
}