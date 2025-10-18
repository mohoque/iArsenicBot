export const runtime = "edge";

import { NextRequest, NextResponse } from "next/server";
// @ts-ignore
import { list, get, put, del } from "@vercel/blob";

/**
 * Authorisation:
 * - Automatic cron: Vercel will send Authorization: Bearer <CRON_SECRET>.
 * - Manual use: supply ?key=<LOG_ADMIN_KEY>.
 */

function yyyymmddUTC(date: Date) {
  const p = (n: number, w = 2) => n.toString().padStart(w, "0");
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1); // yesterday
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function okAuth(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") || "";
  const bearerOk =
    !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  if (bearerOk) return true;

  const url = new URL(req.url);
  const key = url.searchParams.get("key") ?? "";
  const queryOk = !!process.env.LOG_ADMIN_KEY && key === process.env.LOG_ADMIN_KEY;
  return queryOk;
}

export async function GET(req: NextRequest) {
  if (!okAuth(req)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const day = url.searchParams.get("day") || yyyymmddUTC(new Date());

  const prefix = `logs/${day}/`;
  const outKey = `logs/${day}.ndjson`;

  // Skip if output exists and not forcing
  const existing = await list({ prefix: outKey });
  if (!force && existing.blobs.length > 0) {
    return NextResponse.json({
      ok: true,
      message: "Already compacted",
      day,
      outKey,
      deleted: 0,
      written: false
    });
    }

  // Gather per-event JSON files
  const items = await list({ prefix });
  const files = items.blobs.filter(b => b.pathname.endsWith(".json"));

  if (files.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No per-event files to compact",
      day,
      deleted: 0,
      written: false
    });
  }

  // Read in small batches
  const batchSize = 50;
  const lines: string[] = [];

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const parts = await Promise.all(
      batch.map(async b => {
        const blob = await get(b.pathname, { token: process.env.BLOB_READ_WRITE_TOKEN });
        const text = await blob.text();
        try {
          const obj = JSON.parse(text);
          return JSON.stringify(obj) + "\n";
        } catch {
          return text.endsWith("\n") ? text : text + "\n";
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

  return NextResponse.json({ ok: true, day, outKey, written: true, events: files.length, deleted });
}
