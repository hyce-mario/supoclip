import { NextResponse } from "next/server";

import { createTextProxyResponse, fetchBackend } from "@/server/backend-api";
import { getServerSession } from "@/server/session";

/** Upload one of the creator's own music tracks (multipart, field "file"). */
export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const form = await request.formData();
  const upstream = await fetchBackend("/music/uploads", {
    method: "POST",
    signal: request.signal,
    userId: session.user.id,
    body: form,
  });
  return createTextProxyResponse(upstream);
}
