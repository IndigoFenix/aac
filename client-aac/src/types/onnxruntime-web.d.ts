// onnxruntime-web's exports map has no "types" condition for its subpath
// builds, so TS can't resolve "onnxruntime-web/wasm" (the WASM-only bundle we
// load for Silero VAD — no webgpu/jsep graph needed for a 2MB LSTM). The
// consumer (sileroVad.ts) treats the module as untyped anyway; this just makes
// the specifier resolvable.
declare module "onnxruntime-web/wasm";
