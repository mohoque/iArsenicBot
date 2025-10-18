export const runtime = 'edge';

import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';

function cap(v: unknown, n: number) {
  return String(v ?? '').slice(0, n);
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

    const key = `logs/${new Date().toISOString().slice(0, 10)}.ndjson`;
    await put(key, JSON.stringify(record) + '\n', {
      access: 'public',               // keep public
      addRandomSuffix: false,
      contentType: 'application/x-ndjson',
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    // Optional echo
    console.log('[log-event]', record.role, record.text.slice(0, 80));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[log-event] error', err);
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
