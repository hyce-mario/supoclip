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

type Context = { params: Promise<{ path: string[] }> };

async function forward(request: Request, { params }: Context) {
  const { path } = await params;
  return proxy(request, `/music/${path.map(encodeURIComponent).join("/")}`);
}

export const GET = forward;
export const DELETE = forward;
