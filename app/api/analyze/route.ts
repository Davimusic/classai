import { NextRequest, NextResponse } from "next/server";

const RETRYABLE = [429, 500, 502, 503, 504];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callGemini(model: string, apiKey: string, body: unknown) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Falta GEMINI_API_KEY en el servidor." },
      { status: 500 }
    );
  }

  try {
    const form = await req.formData();
    const instruction = String(form.get("prompt") || "").trim();
    const transcription = String(form.get("transcription") || "").trim();
    const pdfs = form
      .getAll("pdfs")
      .filter((f): f is File => f instanceof File);

    if (!instruction) {
      return NextResponse.json(
        { error: "Falta la instrucción." },
        { status: 400 }
      );
    }

    const prompt = `Eres un asistente experto en educación musical. Responde de forma clara y en español. Año actual: ${new Date().getFullYear()}.

Instrucción del usuario: ${instruction}

Transcripción de la clase (si existe): "${transcription || "Ninguna"}"

Usa los PDFs adjuntos (si hay) como contexto principal. Si algo no aparece en la transcripción o los documentos, dilo en lugar de inventarlo.`;

    const parts: any[] = [{ text: prompt }];
    for (const pdf of pdfs) {
      const buffer = Buffer.from(await pdf.arrayBuffer());
      parts.push({
        inline_data: {
          mime_type: "application/pdf",
          data: buffer.toString("base64"),
        },
      });
    }

    const body = {
      contents: [{ parts }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    };

    const models = [
      process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
      process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash",
    ];

    let lastError = "El servicio de IA no respondió.";

    for (const model of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await callGemini(model, apiKey, body);

        if (res.ok) {
          const data = await res.json();
          const text = (data.candidates?.[0]?.content?.parts ?? [])
            .map((p: any) => p.text || "")
            .join("")
            .trim();
          if (text) return NextResponse.json({ analysis: text, model });
          lastError = "La IA devolvió una respuesta vacía.";
          break;
        }

        const err = await res.json().catch(() => ({}));
        lastError = err?.error?.message || `Error de Gemini (${res.status})`;

        if (!RETRYABLE.includes(res.status)) {
          // Error no reintentable (ej. 400/404): prueba con el siguiente modelo
          break;
        }
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }

    return NextResponse.json(
      {
        error: `No se pudo completar el análisis. Intenta de nuevo en unos minutos. (${lastError})`,
      },
      { status: 503 }
    );
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Fallo interno al analizar." },
      { status: 500 }
    );
  }
}