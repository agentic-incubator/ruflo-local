// =============================================================================
// collect-body.mjs — bufferStream(): the shared "settle-once" promise guard behind
// gateway-server.mjs's collectBody/collectResponseBody. Both buffer a stream
// (bounded by maxBytes) into a single Buffer, settling exactly once no matter which
// event fires first — a stream can emit 'end' and 'close' in either order, or 'error'
// and 'close' together, and without the guard a caller could see a resolved promise
// change its mind, or reject/resolve twice (the second a silent no-op in a Promise,
// but still a sign something upstream double-fired).
// =============================================================================

/**
 * @param {NodeJS.EventEmitter} stream  anything emitting data/end/error/close (a real
 *   req/res works; so does any plain EventEmitter, which is all the tests use)
 * @param {{maxBytes:number, tooLargeCode:string, tooLargeMsg:string, abortCode:string, abortMsg:string}} opts
 * @returns {Promise<Buffer>}
 */
export function bufferStream(stream, { maxBytes, tooLargeCode, tooLargeMsg, abortCode, abortMsg }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        settle(reject, Object.assign(new Error(tooLargeMsg), { code: tooLargeCode }));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => settle(resolve, Buffer.concat(chunks)));
    stream.on("error", (err) => settle(reject, err));
    stream.on("close", () => settle(reject, Object.assign(new Error(abortMsg), { code: abortCode })));
  });
}
