// app/api/fix-cors/route.ts
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const authResponse = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
      headers: {
        Authorization: "Basic " + Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`).toString("base64"),
      },
    });

    if (!authResponse.ok) throw new Error("No se pudo autenticar con Backblaze.");

    const authData = await authResponse.json();
    const apiUrl = authData.apiUrl;
    const authToken = authData.authorizationToken;

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

    if (!listBucketsResponse.ok) throw new Error("No se pudo obtener la información del bucket.");

    const bucketsData = await listBucketsResponse.json();
    const bucketId = bucketsData.buckets[0].bucketId;

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
            corsRuleName: "production-and-dev",
            allowedOrigins: [
              "http://localhost:3000",
              "https://classai-olive.vercel.app" // Tu dominio de Vercel
            ],
            allowedOperations: [
              "s3_get",
              "s3_put",
              "s3_head", // <-- ESTO ES CLAVE PARA REPRODUCTORES DE AUDIO
              "b2_upload_file",
              "b2_download_file_by_name"
            ],
            allowedHeaders: ["*"],
            exposeHeaders: [
              "ETag",
              "x-amz-request-id",
              "x-amz-id-2",
              "Content-Length",
              "Content-Type",
              "Content-Range"
            ],
            maxAgeSeconds: 86400,
          },
        ],
      }),
    });

    if (!updateResponse.ok) {
      const errorData = await updateResponse.json();
      throw new Error(errorData.message || "No se pudo actualizar CORS.");
    }

    return NextResponse.json({
      success: true,
      message: "✅ CORS actualizado para localhost y Vercel",
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}