export const runtime = "edge";

import { NextResponse } from "next/server";
import { put } from "@vercel/blob";

export async function POST(req: Request) {
  try {
    const ua = req.headers.get("user-agent") || "";
    const ts = new Date().toISOString();
    const body = await req.json().catch(() => ({}));

    // Normalise to one record
    let record: Record<string, unknown>;

    if (body?.type === "turn") {
      record = {
        ts,                           // server time
        type: "turn",
        id: String(body.id || ""),
        user_text: String(body.user_text || ""),
        user_ts: String(body.user_ts || ""),
        assistant_text: String(body.assistant_text || ""),
        assistant_ts: String(body.assistant_ts || ""),
        meta: body.meta ?? {},
        ua,
      };
    } else {
      // Backwards compatibility: single-sided event
      const text = String(body.text || "");
      const role = String(body.role || "user");
      record = {
        ts,
        role,
        text,
        len: text.length,
        sessionId: String(body.sessionId || ""),
        threadId: String(body.threadId || ""),
        meta: body.meta ?? {},
        ua,
      };
    }

    // One file per turn. Keyed by date and time.
    const day = ts.slice(0, 10);
    const time = ts.slice(11, 23).replace(/[:.]/g, "-");
    const suffix = body?.type === "turn" ? ".turn.json" : ".json";
    const key = `logs/${day}/${time}${suffix}`;

    await put(key, JSON.stringify(record), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    return NextResponse.json({ ok: true, key });
  } catch (err) {
    console.error("[log-event] error", err);
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
}
