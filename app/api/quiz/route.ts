import { NextRequest, NextResponse } from "next/server";

const RETRYABLE = [429, 500, 502, 503, 504];
const MAX_DOC_CHARS = 400_000;
const MAX_CLASS_CHARS = 300_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Seg = { start: number; end: number; text: string };

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Falta GEMINI_API_KEY en el servidor." }, { status: 500 });
  }

  try {
    const { topic, count, transcription, segments, documents } = (await req.json()) as {
      topic?: string;
      count?: number;
      transcription?: string;
      segments?: Seg[];
      documents?: { name: string; text: string }[];
    };

    const n = Math.min(15, Math.max(3, Number(count) || 5));
    const focus = (topic || "").trim();

    const classText = (
      segments && segments.length > 0
        ? segments.map((s) => `[${Math.floor(s.start)}s] ${String(s.text).trim()}`).join("\n")
        : (transcription || "").trim()
    ).slice(0, MAX_CLASS_CHARS);

    let remaining = MAX_DOC_CHARS;
    const docsText = (documents ?? [])
      .map((d) => {
        const t = (d.text || "").slice(0, Math.max(remaining, 0));
        remaining -= t.length;
        return `--- Documento: ${d.name} ---\n${t}`;
      })
      .join("\n\n");

    if (!classText && !docsText) {
      return NextResponse.json({ error: "No hay material para crear preguntas." }, { status: 400 });
    }

    const prompt = `Eres un profesor de música que prepara un repaso. Crea exactamente ${n} preguntas de opción múltiple en español usando SOLO el material de abajo.

${
  focus
    ? `Enfócate en este tema: "${focus}". Si el material no trata ese tema, devuelve {"questions":[]}.`
    : "Cubre partes distintas del material."
}

Reglas:
- 4 opciones por pregunta, solo una correcta. Las incorrectas deben ser plausibles y del mismo tema.
- No inventes datos ni uses conocimiento externo: cada pregunta debe poder verificarse en el material.
- La longitud o redacción de las opciones no debe delatar la correcta.
- "explanation": 1 o 2 frases que justifican la respuesta con lo que dice el material.
- "ref": origen corto, por ejemplo "Clase, 12:30" o "archivo.pdf, pág. 3".
- "at": si la respuesta sale de la clase, el número de segundos [Ns] donde empieza ese pasaje; si sale de un PDF, null.
- La clase es la transcripción de un audio: pregunta por lo que se dijo, no por lo que se tocó.
- Responde ÚNICAMENTE con JSON: {"questions":[{"question":"","options":["","","",""],"correct":0,"explanation":"","ref":"","at":null}]}

TRANSCRIPCIÓN DE LA CLASE:
${classText || "Ninguna"}

DOCUMENTOS:
${docsText || "Ninguno"}`;

    const models = [
      process.env.GEMINI_MODEL || "gemini-2.5-flash",
      process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite",
    ];

    const buildBody = (model: string) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 8192,
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
            const questions = (parsed.questions ?? [])
              .map((q: any) => {
                const options = Array.isArray(q.options) ? q.options.map((o: any) => String(o)) : [];
                const correct = Number(q.correct);
                if (!q.question || options.length !== 4 || !Number.isInteger(correct) || correct < 0 || correct > 3) {
                  return null;
                }
                // Mezcla las opciones para que la correcta no caiga siempre en la misma posición
                const tagged = options.map((text: string, i: number) => ({ text, ok: i === correct }));
                const mixed = shuffle(tagged);
                const at = Number(q.at);
                return {
                  question: String(q.question),
                  options: mixed.map((o) => o.text),
                  correct: mixed.findIndex((o) => o.ok),
                  explanation: String(q.explanation || ""),
                  ref: String(q.ref || ""),
                  at: q.at !== null && Number.isFinite(at) && at >= 0 ? at : null,
                };
              })
              .filter(Boolean)
              .slice(0, n);

            if (questions.length === 0) {
              return NextResponse.json(
                {
                  error: focus
                    ? "No encontré en el material suficiente sobre ese tema para crear preguntas."
                    : "No pude crear preguntas con este material.",
                },
                { status: 422 }
              );
            }
            return NextResponse.json({ questions, model });
          } catch {
            lastError = "La IA devolvió un formato no válido.";
            break;
          }
        }

        const err = await res.json().catch(() => ({}));
        lastError = err?.error?.message || `Error de Gemini (${res.status})`;
        if (!RETRYABLE.includes(res.status)) break;
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }

    return NextResponse.json(
      { error: `No se pudo generar el quiz. Intenta de nuevo. (${lastError})` },
      { status: 503 }
    );
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Fallo interno al generar el quiz." }, { status: 500 });
  }
}