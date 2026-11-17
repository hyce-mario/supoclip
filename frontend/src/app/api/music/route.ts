import { NextResponse } from "next/server";

import { createProxyResponse, fetchBackend } from "@/server/backend-api";
import { getServerSession } from "@/server/session";

/** Studio music: the library and upload listing, track files, and deletes. */
async function proxy(request: Request, path: string) {
  const session = await getServerSession();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const range = request.headers.get("range");
  const upstream = await fetchBackend(path, {
    method: request.method,
    signal: request.signal,
    userId: session.user.id,
    extraHeaders: range ? { Range: range } : {},
    cache: "no-store",
  });
  return createProxyResponse(upstream);
}

export function GET(request: Request) {
  return proxy(request, "/music");
}
