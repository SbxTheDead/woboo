// Streaming output.
//
// Instead of waiting for the full brain response, stream tokens to the
// dashboard in real-time. The owner watches the plan form word by word.

import { publish } from './bus.mjs';
import { record } from './journal.mjs';

let streamBuffer = '';
let streaming = false;

export function startStream(missionId) {
  streaming = true;
  streamBuffer = '';
  publish({ type: 'stream:start', missionId });
}

export function pushToken(token) {
  if (!streaming) return;
  streamBuffer += token;
  publish({ type: 'stream:token', token });
}

export function endStream() {
  streaming = false;
  publish({ type: 'stream:end', full: streamBuffer });
  const result = streamBuffer;
  streamBuffer = '';
  return result;
}

export function isStreaming() {
  return streaming;
}

// A transform stream that intercepts fetch responses and pushes tokens.
export function createStreamTransform() {
  const decoder = new TextDecoder();
  return {
    transform(chunk, controller) {
      const text = decoder.decode(chunk);
      // Parse SSE lines from the stream.
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content || '';
            if (delta) pushToken(delta);
          } catch {
            // Not JSON — skip.
          }
        }
      }
      controller.enqueue(chunk);
    },
  };
}
