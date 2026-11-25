import { NextRequest, NextResponse } from "next/server";

const RETRYABLE = [429, 500, 502, 503, 504];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Seg = { start: number; end: number; text: string };

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Falta GEMINI_API_KEY en el servidor." }, { status: 500 });
  }

  try {
    const { query, segments, duration } = (await req.json()) as {
      query?: string;
      segments?: Seg[];
      duration?: number;
    };

    if (!segments || segments.length === 0) {
      return NextResponse.json({ error: "No hay marcas de tiempo en la transcripción." }, { status: 400 });
    }

    const total = duration && duration > 0 ? duration : segments[segments.length - 1].end;
    const transcript = segments
      .map((s) => `[${Math.floor(s.start)}s] ${s.text.trim()}`)
      .join("\n");

    const q = (query || "").trim();
    const task = q
      ? `Encuentra TODOS los momentos de la clase que sirvan para resolver esto: "${q}". Devuelve entre 1 y 20 momentos, ordenados por tiempo. Si nada en la clase lo responde, devuelve una lista vacía.`
      : `Divide la clase en sus temas o ideas principales, en orden cronológico. Devuelve entre 4 y 15 momentos.`;

    const prompt = `Eres un asistente de educación musical. Recibes la transcripción de una clase con el segundo de inicio de cada frase.

${task}

Reglas:
- "start" y "end" son segundos (números), dentro de 0 y ${Math.floor(total)}.
- Cada momento debe cubrir la explicación completa (normalmente entre 20 y 300 segundos).
- "title": máximo 8 palabras. "summary": una frase.
- Usa solo lo que aparece en la transcripción. No inventes.
- Responde ÚNICAMENTE con JSON: {"markers":[{"start":0,"end":0,"title":"","summary":""}]}

TRANSCRIPCIÓN:
${transcript}`;

    const models = [
      process.env.GEMINI_MODEL || "gemini-2.5-flash",
      process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite",
    ];

    const buildBody = (model: string) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
        ...(model.includes("2.5-flash") && !model.includes("lite")
          ? { thinkingConfig: { thinkingBudget: 0 } }
          : {}),
      },
    });

    let lastError = "El servicio de IA no respondió.";

    for (const model of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify(buildBody(model)),
          }
        );

        if (res.ok) {
          const data = await res.json();
          const raw = (data.candidates?.[0]?.content?.parts ?? [])
            .map((p: any) => p.text || "")
            .join("")
            .replace(/```json|```/g, "")
            .trim();

          try {
            const parsed = JSON.parse(raw);
            const markers = (parsed.markers ?? [])
              .map((m: any) => ({
                start: Math.max(0, Math.min(Number(m.start), total)),
                end: Math.max(0, Math.min(Number(m.end), total)),
                title: String(m.title || "Momento"),
                summary: String(m.summary || ""),
              }))
              .filter((m: any) => Number.isFinite(m.start) && Number.isFinite(m.end) && m.end > m.start)
              .sort((a: any, b: any) => a.start - b.start)
              .map((m: any, i: number) => ({ id: i + 1, ...m }));

            return NextResponse.json({ markers, model });
          } catch {
            lastError = "La IA devolvió un formato no válido.";
            break; // pasa al modelo de respaldo
          }
        }

        const err = await res.json().catch(() => ({}));
        lastError = err?.error?.message || `Error de Gemini (${res.status})`;
        if (!RETRYABLE.includes(res.status)) break;
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }

    return NextResponse.json(
      { error: `No se pudieron generar las marcas. Intenta de nuevo. (${lastError})` },
      { status: 503 }
    );
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Fallo interno al generar marcas." }, { status: 500 });
  }
}