export const runtime = "edge";

import { NextRequest, NextResponse } from "next/server";
// @ts-expect-error Type definitions may lag behind runtime API
import { list, get, put, del } from "@vercel/blob";

/**
 * Protect this endpoint with a simple key in the query string:
 *   /api/admin/compact?key=YOUR_KEY
 * Set LOG_ADMIN_KEY in env to match YOUR_KEY.
 *
 * Behaviour:
 * - Compacts all JSON event files under logs/YYYY-MM-DD/ into one NDJSON file logs/YYYY-MM-DD.ndjson
 * - Skips if there is nothing to compact
 * - If the NDJSON already exists, it will not overwrite unless you pass &force=1
 * - After writing the NDJSON, deletes the original per-event files
 */

function yyyymmddUTC(date: Date) {
  const p = (n: number, w = 2) => n.toString().padStart(w, "0");
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1); // yesterday
  const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return day;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const pass = url.searchParams.get("key") ?? "";
  const force = url.searchParams.get("force") === "1";

  if (!process.env.LOG_ADMIN_KEY || pass !== process.env.LOG_ADMIN_KEY) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const day = url.searchParams.get("day") || yyyymmddUTC(new Date());
  const prefix = `logs/${day}/`;
  const outKey = `logs/${day}.ndjson`;

  // If output already exists and not forcing, exit early
  const existing = await list({ prefix: outKey });
  if (!force && existing.blobs.length > 0) {
    return NextResponse.json({ ok: true, message: "Already compacted", day, outKey, deleted: 0, written: false });
  }

  // Gather all small JSON files for the day
  const items = await list({ prefix });
  const files = items.blobs.filter(b => b.pathname.endsWith(".json"));

  if (files.length === 0) {
    return NextResponse.json({ ok: true, message: "No per-event files to compact", day, deleted: 0, written: false });
  }

  // Read all files (in small batches to control memory)
  const batchSize = 50;
  const lines: string[] = [];

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const parts = await Promise.all(
      batch.map(async b => {
        const blob = await get(b.pathname, { token: process.env.BLOB_READ_WRITE_TOKEN });
        const text = await blob.text();
        // Ensure one JSON object per line
        try {
          const obj = JSON.parse(text);
          return JSON.stringify(obj) + "\n";
        } catch {
          // If it is already plain text or NDJSON, still append safely
          return (text.endsWith("\n") ? text : text + "\n");
        }
      })
    );
    lines.push(...parts);
  }

  // Write the NDJSON
  await put(outKey, lines.join(""), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/x-ndjson",
    token: process.env.BLOB_READ_WRITE_TOKEN
  });

  // Delete the per-event files
  let deleted = 0;
  for (const f of files) {
    await del(f.pathname, { token: process.env.BLOB_READ_WRITE_TOKEN });
    deleted += 1;
  }

  return NextResponse.json({ ok: true, day, outKey, written: true, events: files.length, deleted });
}
