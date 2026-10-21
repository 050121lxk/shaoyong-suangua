// Shared by the Edge Function and the browser bundle (web/app.mjs, web/auth.mjs).

// Yields the data payload of each Server-Sent Event; cancels the source if the consumer stops early.
export async function* sseData(body, limit = 64 * 1024 * 1024) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data = [], total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (total > limit) throw new Error('too_large');
      }
      const text = decoder.decode(value, { stream: !done });
      // Only re-split when a line actually ended; avoids quadratic work on one long line.
      if (!done && !text.includes('\n')) {
        buffer += text;
        if (buffer.length > 1024 * 1024) throw new Error('too_large');
        continue;
      }
      buffer += text;
      const lines = buffer.split('\n');
      buffer = done ? '' : lines.pop();
      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5));
      }
      if (buffer.length > 1024 * 1024) throw new Error('too_large');
      if (done) break;
    }
    if (data.length) yield data.join('\n');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Parsed completion chunks from a streaming (SSE) or plain JSON Chat Completions response.
export async function* completionChunks(response, limit = 64 * 1024 * 1024) {
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    const text = await response.text();
    if (text.length > limit) throw new Error('too_large');
    yield JSON.parse(text);
    return;
  }
  if (!response.body) return;
  for await (const data of sseData(response.body, limit)) {
    if (data.trim() === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    yield chunk;
  }
}

// One OpenAI-compatible chunk (stream delta) or full completion (message) to visible text.
export function streamDelta(json) {
  const choice = json?.choices?.[0];
  const delta = choice?.delta || choice?.message || {};
  const content = delta.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('') : '';
  return { text, reasoning: !text && !!(delta.reasoning_content || delta.reasoning), finish: choice?.finish_reason || null };
}
