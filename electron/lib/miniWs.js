// Minimal WebSocket client (RFC 6455, ws:// only) for talking to a local ComfyUI.
// Electron 33 ships Node 20, which has no global WebSocket, and pulling in a package for one
// loopback connection is not worth it. Pure module (no electron import).
const http = require('http');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Open ws://host:port/path. Resolves to { close() } once the handshake succeeded.
 * onMessage(data, isBinary) gets whole messages; onClose() fires once when the socket ends.
 */
function connect({ host = '127.0.0.1', port, path = '/', onMessage, onClose }) {
    return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        const req = http.request({
            host, port, path,
            headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
        });
        req.on('response', (res) => { res.resume(); reject(new Error(`WebSocket refused (HTTP ${res.statusCode})`)); });
        req.on('error', reject);
        req.on('upgrade', (res, socket, head) => {
            const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
            if (res.headers['sec-websocket-accept'] !== expected) {
                socket.destroy();
                reject(new Error('WebSocket handshake failed'));
                return;
            }
            let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0); // frames sent right after the 101 arrive here
            let fragments = [];
            let fragmentOpcode = 0;
            let closed = false;
            const finish = () => { if (!closed) { closed = true; onClose?.(); } };

            const sendFrame = (opcode, payload = Buffer.alloc(0)) => {
                if (socket.destroyed) return;
                const mask = crypto.randomBytes(4);
                const length = payload.length;
                const head = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length])
                    : length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255])
                        : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
                const masked = Buffer.from(payload);
                for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
                socket.write(Buffer.concat([head, mask, masked]));
            };

            const parse = () => {
                for (;;) {
                    if (buffer.length < 2) return;
                    const fin = (buffer[0] & 0x80) !== 0;
                    const opcode = buffer[0] & 0x0f;
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
                    if (buffer.length < offset + length) return;
                    const payload = buffer.subarray(offset, offset + length);
                    buffer = buffer.subarray(offset + length);

                    if (opcode === 0x9) { sendFrame(0xA, payload); continue; }   // ping → pong
                    if (opcode === 0xA) continue;                                  // pong
                    if (opcode === 0x8) { socket.end(); finish(); return; }        // close
                    if (opcode !== 0) fragmentOpcode = opcode;
                    fragments.push(payload);
                    if (!fin) continue;
                    const message = Buffer.concat(fragments);
                    fragments = [];
                    try {
                        if (fragmentOpcode === 0x1) onMessage?.(message.toString('utf8'), false);
                        else onMessage?.(message, true);
                    } catch { /* a bad handler must not kill the socket */ }
                }
            };

            socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); parse(); });
            socket.on('end', () => { socket.end(); finish(); }); // the upgraded socket is half-open: answer the peer's FIN
            socket.on('close', finish);
            socket.on('error', finish);
            if (buffer.length) setImmediate(parse);
            resolve({
                close() { try { sendFrame(0x8); socket.end(); } catch { /* already gone */ } finish(); },
            });
        });
        req.end();
    });
}

module.exports = { connect };
