// A fake Chrome, for tests: just enough of the DevTools protocol to drive
// src/browser.mjs without launching a browser.
//
// Node ships a WebSocket *client* but no server, and the project has no
// dependency to spare for one — so this is a minimal RFC6455 server on raw
// node:http: the handshake is one SHA-1, and the frame codec below is the
// whole of the wire format the built-in client ever produces (masked text
// frames in, unmasked out, ping/pong and close).
//
// The server is scriptable rather than literal. It keeps a tiny virtual page —
// a list of elements with text and geometry — and answers the exact
// Runtime.evaluate expressions browser.mjs issues against it: the element
// collection, the click-target lookup, the focus/clear/confirm sequence of a
// type. Input.insertText genuinely lands in the focused element, so a test
// that forgets the focus step sees the type fail the way a real page would
// make it fail. Every command received is recorded in order, which is what
// the tests assert against.

import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ── wire format ───────────────────────────────────────────────────────────────

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

// Parse client frames out of a growing buffer. Client frames are always
// masked; fragments are reassembled until FIN. Calls onText for each complete
// text message and onClose when the peer says goodbye.
function frameReader(onText, onClose, onPing) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload); // a copy — unmasking must not corrupt the buffer
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x8) {
        onClose(payload);
        return;
      }
      if (opcode === 0x9) {
        onPing(payload);
        continue;
      }
      if (opcode === 0xa) continue; // pong; nothing asked
      fragments.push(payload);
      if (fin) {
        const whole = Buffer.concat(fragments);
        fragments = [];
        if (opcode === 0x1 || fragments.length) onText(whole.toString('utf8'));
        else onText(whole.toString('utf8'));
      }
    }
  };
}

// ── the virtual page ──────────────────────────────────────────────────────────
//
// An element: { tag, type, text, href, inView, value, x, y, w, h, readonly }.
// The index the model sees is the element's position in the collection,
// offset by the START argument of the collection expression — exactly how a
// real page's data-woboo tags are numbered across frames.

function blankPage() {
  return { url: 'http://fake.test/', title: 'Fake page', text: '', elements: [] };
}

// Route one Runtime.evaluate to the answer the matching expression in
// browser.mjs would produce on the virtual page. Returns the CDP `result`
// field — either { result: { value } } for returnByValue calls, or
// { result: { objectId } } for the bare querySelector that precedes DOM.focus.
function makeEvaluator(fake) {
  return (params) => {
    const expr = String(params.expression || '');
    const page = fake.pages.get(params.contextId ?? null) || fake.pages.get(null);

    // The element collection, `((START) => { ... })(N)`. Numbered from N so a
    // second frame's elements continue the sequence, as they do on a real page.
    if (expr.startsWith('((START)')) {
      const start = Number(expr.match(/\}\)\((\d+)\)\s*$/)?.[1] ?? 0);
      const elements = page.elements.map((el, n) => {
        const index = start + n;
        fake.known.set(index, el);
        el.fakeIndex = index;
        return {
          i: index,
          tag: el.tag,
          type: el.type || '',
          text: el.text || '',
          href: el.href || '',
          inView: el.inView !== false,
          value: el.value || '',
          focused: false,
        };
      });
      return value({
        url: page.url,
        title: page.title,
        elements,
        dialog: null,
        truncated: false,
        text: page.text,
      });
    }

    // settle()'s liveness probe.
    if (expr.includes('document.readyState')) {
      return value(`complete:${page.url}:${page.elements.length + 7}`);
    }

    // The bare querySelector type() sends first, asking for a handle to focus.
    if (!expr.startsWith('(') && expr.includes('data-woboo')) {
      const el = lookup(fake, expr);
      return el ? { result: { type: 'object', objectId: `obj-${el.fakeIndex}` } } : value(null);
    }

    // click()'s target lookup: scroll into view, measure, report the centre.
    if (expr.includes('offScreen')) {
      const el = lookup(fake, expr);
      if (!el) return value({ ok: false, error: `element ${indexIn(expr)} is no longer on the page` });
      return value({
        ok: true,
        x: Math.round(el.x + el.w / 2),
        y: Math.round(el.y + el.h / 2),
        text: (el.text || el.value || '').slice(0, 60),
        offScreen: el.offScreen === true,
      });
    }

    // click()'s fallback for an off-screen element: el.click() in the page.
    if (expr.includes('el.click()')) {
      const el = lookup(fake, expr);
      if (!el) return value({ ok: false, error: `element ${indexIn(expr)} is no longer on the page` });
      return value({ ok: true, text: (el.text || el.value || '').slice(0, 60) });
    }

    // type()'s focus-and-clear. The el.focus() in it counts, so whatever
    // insertText follows lands here — as it would on the page.
    if (expr.includes('isContentEditable') && expr.includes('dispatchEvent')) {
      const el = lookup(fake, expr);
      if (!el) return value({ ok: false, error: `field ${indexIn(expr)} is no longer on the page` });
      if (!el.readonly) el.value = '';
      fake.focused = el;
      return value({ ok: true });
    }

    // type()'s confirmation read: what is actually in the field now.
    if (expr.includes('landed')) {
      const el = lookup(fake, expr);
      const now = el ? el.value || '' : '';
      if (now.length) return value({ ok: true, landed: now.slice(0, 60) });
      return value({ ok: false, landed: '' });
    }

    // pressEnter()'s focus, scroll(), watchErrors(): no answer to check.
    if (expr.includes('el.focus()') || expr.includes('window.scrollBy') || expr.includes('__wobooErrors')) {
      return value(undefined);
    }

    // readText() and the page text a snapshot carries.
    if (expr.includes('document.body.innerText')) return value(page.text);

    // clickHumanCheck()'s widget hunt: no captcha on a fake page.
    if (expr.includes('cloudflare')) return value(null);

    // problems().
    if (expr.includes('brokenImages')) return value({ errors: [], brokenImages: [] });

    return value(null);
  };
}

function value(v) {
  return { result: { type: typeof v, value: v === undefined ? null : v } };
}

function indexIn(expr) {
  return Number(expr.match(/data-woboo=\\?"(\d+)/)?.[1] ?? -1);
}

function lookup(fake, expr) {
  return fake.known.get(indexIn(expr)) || null;
}

// ── the server ────────────────────────────────────────────────────────────────

export async function createFakeCdp({ target } = {}) {
  const page = { id: 'page-1', type: 'page', title: 'Fake page', url: 'http://fake.test/', ...target };
  const connections = new Set();

  const fake = {
    // Every command the client sent, in order: { id, method, params }.
    received: [],
    // Pages by execution context; null is the top document, as in browser.mjs.
    pages: new Map([[null, blankPage()]]),
    // Elements issued by the last collections, by their global index.
    known: new Map(),
    focused: null,
    port: 0,
    wsUrl: '',
    calls(method) {
      return fake.received.filter((m) => m.method === method);
    },
    setPage(next, contextId = null) {
      fake.pages.set(contextId, { ...blankPage(), ...next });
    },
    handle(method, fn) {
      handlers[method] = fn;
    },
    // Push an event, the way Chrome announces contexts and dialogs.
    emit(method, params = {}) {
      broadcast(JSON.stringify({ method, params }));
    },
    announceContext({ id, frameId, origin = 'http://fake.test' }) {
      fake.emit('Runtime.executionContextCreated', {
        context: { id, origin, auxData: { frameId, isDefault: true } },
      });
    },
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };

  const handlers = {
    'Page.enable': () => ({}),
    'Runtime.enable': () => ({}),
    'Page.bringToFront': () => ({}),
    'Emulation.setFocusEmulationEnabled': () => ({}),
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'frame-main' } } }),
    'Page.navigate': (params) => {
      const current = fake.pages.get(null);
      current.url = params.url;
      return { frameId: 'frame-main' };
    },
    'DOM.focus': (params) => {
      const index = Number(String(params.objectId).match(/obj-(\d+)/)?.[1]);
      const el = fake.known.get(index);
      if (el) fake.focused = el;
      return {};
    },
    'Runtime.releaseObject': () => ({}),
    'Runtime.evaluate': null, // wired below, it needs fake
    'Input.insertText': (params) => {
      // The browser's own input pipeline delivers to whatever is focused; a
      // field that rejects input (readonly) swallows nothing.
      if (fake.focused && !fake.focused.readonly) fake.focused.value = String(params.text);
      return {};
    },
    'Input.dispatchMouseEvent': () => ({}),
    'Input.dispatchKeyEvent': () => ({}),
    'Page.handleJavaScriptDialog': () => ({}),
    'Page.captureScreenshot': () => ({ data: Buffer.from('not-really-a-png').toString('base64') }),
  };
  handlers['Runtime.evaluate'] = makeEvaluator(fake);

  function broadcast(data) {
    for (const socket of connections) socket.write(encodeFrame(0x1, Buffer.from(data)));
  }

  const server = http.createServer((req, res) => {
    // The endpoint open() polls: what targets exist and where to attach.
    if (req.url === '/json/list') {
      const body = JSON.stringify([{ ...page, webSocketDebuggerUrl: fake.wsUrl }]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const accept = crypto
      .createHash('sha1')
      .update(String(req.headers['sec-websocket-key']) + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    connections.add(socket);

    const close = (payload) => {
      socket.write(encodeFrame(0x8, payload));
      socket.destroy();
    };
    const read = frameReader(
      (text) => {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        fake.received.push(message);
        const handler = handlers[message.method];
        const answer = { id: message.id };
        try {
          answer.result = handler ? handler(message.params || {}) : {};
        } catch (err) {
          delete answer.result;
          answer.error = { message: err.message };
        }
        socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(answer))));
      },
      close,
      (payload) => socket.write(encodeFrame(0xa, payload)),
    );
    socket.on('data', read);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.wsUrl = `ws://127.0.0.1:${fake.port}/devtools/page/${page.id}`;
  return fake;
}
