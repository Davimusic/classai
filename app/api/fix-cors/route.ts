// app/api/fix-cors/route.ts
import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Paso 1: Obtener token de autorización de Backblaze
    const authResponse = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
      headers: {
        Authorization: "Basic " + Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`).toString("base64"),
      },
    });

    if (!authResponse.ok) {
      throw new Error("No se pudo autenticar con Backblaze. Revisa tus credenciales.");
    }

    const authData = await authResponse.json();
    const apiUrl = authData.apiUrl;
    const authToken = authData.authorizationToken;

    // Paso 2: Obtener el bucketId de tu bucket
    const listBucketsResponse = await fetch(`${apiUrl}/b2api/v2/b2_list_buckets`, {
      method: "POST",
      headers: {
        Authorization: authToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId: authData.accountId,
        bucketName: process.env.B2_BUCKET,
      }),
    });

    if (!listBucketsResponse.ok) {
      throw new Error("No se pudo obtener la información del bucket.");
    }

    const bucketsData = await listBucketsResponse.json();
    if (!bucketsData.buckets || bucketsData.buckets.length === 0) {
      throw new Error(`No se encontró el bucket "${process.env.B2_BUCKET}".`);
    }

    const bucketId = bucketsData.buckets[0].bucketId;

    // Paso 3: Actualizar las reglas CORS del bucket
    const updateResponse = await fetch(`${apiUrl}/b2api/v2/b2_update_bucket`, {
      method: "POST",
      headers: {
        Authorization: authToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId: authData.accountId,
        bucketId: bucketId,
        corsRules: [
          {
            corsRuleName: "localhost-dev",
            allowedOrigins: ["http://localhost:3000", "https://classai-olive.vercel.app"],
            allowedOperations: ["s3_put", "s3_get", "b2_upload_file", "b2_download_file_by_name"],
            allowedHeaders: ["*"],
            exposeHeaders: [
              "ETag",
              "x-amz-request-id",
              "x-amz-id-2",
              "Content-Length",
              "Content-Type",
              "Content-Range",
              "x-amz-version-id",
              "x-amz-delete-marker"
            ],
            maxAgeSeconds: 86400,
          },
        ],
      }),
    });

    if (!updateResponse.ok) {
      const errorData = await updateResponse.json();
      throw new Error(errorData.message || "No se pudo actualizar las reglas CORS.");
    }

    return NextResponse.json({
      success: true,
      message: "✅ ¡Reglas CORS actualizadas correctamente en Backblaze!",
    });
  } catch (error: any) {
    console.error("❌ Error al actualizar CORS:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
}