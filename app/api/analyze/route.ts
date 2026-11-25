import { NextRequest, NextResponse } from "next/server";

const RETRYABLE = [429, 500, 502, 503, 504];
const MAX_DOC_CHARS = 400_000; // tope de texto total de PDFs
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Falta GEMINI_API_KEY en el servidor." }, { status: 500 });
  }

  try {
    const { prompt, transcription, documents } = (await req.json()) as {
      prompt?: string;
      transcription?: string;
      documents?: { name: string; text: string }[];
    };

    const instruction = (prompt || "").trim();
    if (!instruction) {
      return NextResponse.json({ error: "Falta la instrucción." }, { status: 400 });
    }

    let remaining = MAX_DOC_CHARS;
    const docsText = (documents ?? [])
      .map((d) => {
        const t = (d.text || "").slice(0, Math.max(remaining, 0));
        remaining -= t.length;
        return `--- Documento: ${d.name} ---\n${t}`;
      })
      .join("\n\n");

    const fullPrompt = `Eres un asistente experto en educación musical. Responde de forma clara y en español.

Instrucción del usuario: ${instruction}

TRANSCRIPCIÓN DE LA CLASE:
${(transcription || "").trim() || "Ninguna"}

DOCUMENTOS DE REFERENCIA:
${docsText || "Ninguno"}

Basa tu respuesta en la transcripción y los documentos. Si algo no aparece en ellos, dilo en lugar de inventarlo.`;

    const models = [
      process.env.GEMINI_MODEL || "gemini-2.5-flash",
      process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite",
    ];

    const buildBody = (model: string) => ({
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        ...(model.includes("2.5-flash") && !model.includes("lite")
          ? { thinkingConfig: { thinkingBudget: 0 } }
          : {}),
      },
    });

    let upstream: Response | null = null;
    let lastError = "El servicio de IA no respondió.";

    outer: for (const model of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify(buildBody(model)),
          }
        );

        if (res.ok && res.body) {
          upstream = res;
          break outer;
        }

        const err = await res.json().catch(() => ({}));
        lastError = err?.error?.message || `Error de Gemini (${res.status})`;

        if (!RETRYABLE.includes(res.status)) break; // pasa al modelo de respaldo
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }

    if (!upstream || !upstream.body) {
      return NextResponse.json(
        { error: `No se pudo completar el análisis. Intenta de nuevo en unos minutos. (${lastError})` },
        { status: 503 }
      );
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const json = line.slice(5).trim();
              if (!json) continue;
              try {
                const chunk = JSON.parse(json);
                const text = (chunk.candidates?.[0]?.content?.parts ?? [])
                  .map((p: any) => p.text || "")
                  .join("");
                if (text) controller.enqueue(encoder.encode(text));
              } catch {
                /* línea incompleta, se ignora */
              }
            }
          }
        } catch (e) {
          console.error(e);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Fallo interno al analizar." }, { status: 500 });
  }
}