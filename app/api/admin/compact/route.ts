export const runtime = "edge";

import { NextRequest, NextResponse } from "next/server";
import { list, put, del } from "@vercel/blob";

/**
 * Authorisation:
 *  - Automatic cron: Authorization: Bearer <CRON_SECRET>
 *  - Manual: ?key=<LOG_ADMIN_KEY>
 */

function yyyymmddUTC(date: Date) {
  const p = (n: number, w = 2) => n.toString().padStart(w, "0");
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function okAuth(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") || "";
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  if (bearerOk) return true;
  const url = new URL(req.url);
  const key = url.searchParams.get("key") ?? "";
  return !!process.env.LOG_ADMIN_KEY && key === process.env.LOG_ADMIN_KEY;
}

export async function GET(req: NextRequest) {
  if (!okAuth(req)) return new NextResponse("Forbidden", { status: 403 });

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const day = url.searchParams.get("day") || yyyymmddUTC(new Date());

  const prefix = `logs/${day}/`;
  const outKey = `logs/${day}.ndjson`;

  // Skip if NDJSON already exists and not forcing
  const existing = await list({ prefix: outKey, token: process.env.BLOB_READ_WRITE_TOKEN });
  if (!force && existing.blobs.length > 0) {
    return NextResponse.json({ ok: true, message: "Already compacted", day, outKey, written: false, deleted: 0 });
  }

  // Gather per-event JSON blobs
  const items = await list({ prefix, token: process.env.BLOB_READ_WRITE_TOKEN });
  const files = items.blobs.filter((b) => b.pathname.endsWith(".json"));

  if (files.length === 0) {
    return NextResponse.json({ ok: true, message: "No event files", day, written: false, deleted: 0 });
  }

  // Read each blob via HTTP (files are public)
  const lines: string[] = [];
  const batchSize = 40;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const parts = await Promise.all(
      batch.map(async (b) => {
        const r = await fetch(b.url);
        const t = await r.text();
        try {
          const obj = JSON.parse(t);
          return JSON.stringify(obj) + "\n";
        } catch {
          return t.endsWith("\n") ? t : t + "\n";
        }
      })
    );
    lines.push(...parts);
  }

  // Write NDJSON
  await put(outKey, lines.join(""), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/x-ndjson",
    token: process.env.BLOB_READ_WRITE_TOKEN
  });

  // Delete originals
  let deleted = 0;
  for (const f of files) {
    await del(f.pathname, { token: process.env.BLOB_READ_WRITE_TOKEN });
    deleted += 1;
  }

  return NextResponse.json({ ok: true, day, outKey, written: true, deleted });
}
