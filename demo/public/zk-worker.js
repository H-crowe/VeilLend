/**
 * VeilLend ZK proving Web Worker.
 *
 * Runs snarkjs.groth16.fullProve OFF the main thread so the UI stays
 * responsive during (multi-second) proof generation. Loads the same UMD
 * snarkjs bundle and circuit artifacts as the main-thread fallback.
 *
 * Protocol: { id, inputs, wasm, zkey } in → { id, ok, proof?, publicSignals?, error? } out.
 */
let ready = false;

self.onmessage = async (event) => {
  const { id, inputs, wasm, zkey } = event.data || {};
  if (typeof id !== "number") return;
  try {
    if (!ready) {
      importScripts("/snarkjs.min.js");
      ready = true;
    }
    const { proof, publicSignals } = await self.snarkjs.groth16.fullProve(inputs, wasm, zkey);
    // Post plain JSON-able strings (proof coordinates are decimal strings).
    self.postMessage({ id, ok: true, proof, publicSignals });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
