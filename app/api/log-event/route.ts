export const runtime = 'edge';

import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';

function cap(v: unknown, n: number) {
  return String(v ?? '').slice(0, n);
}
function tsParts(d = new Date()) {
  const p = (x: number, w = 2) => x.toString().padStart(w, '0');
  return {
    day: `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(),3)}`
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const record = {
      ts: new Date().toISOString(),
      role: cap(body.role, 20),
      text: cap(body.text, 4000),
      len: typeof body.text === 'string' ? body.text.length : 0,
      sessionId: cap(body.sessionId, 200),
      threadId: cap(body.threadId, 200),
      meta: body.meta ?? {},
      ua: cap(req.headers.get('user-agent'), 400)
    };

    const { day, time } = tsParts();
    const key = `logs/${day}/${time}.json`;

    await put(key, JSON.stringify(record), {
      access: 'public',                      // must be public on Blob
      addRandomSuffix: false,
      contentType: 'application/json',
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    // Optional echo for quick checks
    console.log('[log-event]', record.role, record.text.slice(0, 80));

    return NextResponse.json({ ok: true, key });
  } catch (err) {
    console.error('[log-event] error', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 400 });
  }
}
