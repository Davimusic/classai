import { NextResponse, connection } from "next/server";

async function ping(url: string, headers: Record<string, string>) {
  try {
    const r = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  await connection(); // fuerza ejecución en cada visita, no en el build

  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  const [groq, gemini] = await Promise.all([
    groqKey
      ? ping("https://api.groq.com/openai/v1/models", { Authorization: `Bearer ${groqKey}` })
      : Promise.resolve(false),
    geminiKey
      ? ping("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
          "x-goog-api-key": geminiKey,
        })
      : Promise.resolve(false),
  ]);

  return NextResponse.json({ groq, gemini });
}