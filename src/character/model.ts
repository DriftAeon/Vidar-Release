// Validate before GLTFLoader can resolve a URI or hand data to a decoder. The size and
// sha256 pin is Rust's (read_character_model re-checks it on every load);
// what stays here is the structure: a self-contained GLB v2.
export function validateCharacterModel(bytes: ArrayBuffer, name: string): void {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 20) {
    throw new Error(`The ${name} model is not a GLB v2 file.`);
  }
  const header = new DataView(bytes);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2
      || header.getUint32(8, true) !== bytes.byteLength || header.getUint32(16, true) !== 0x4e4f534a
      || 20 + header.getUint32(12, true) > bytes.byteLength) {
    throw new Error(`The ${name} model is not a GLB v2 file.`);
  }
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, header.getUint32(12, true))));
  if ((json.buffers ?? []).some((b: { uri?: unknown }) => b.uri !== undefined)
      || (json.images ?? []).some((i: { uri?: unknown; bufferView?: unknown }) => i.uri !== undefined || !Number.isInteger(i.bufferView))
      || (json.extensionsUsed ?? []).length) {
    throw new Error("The character viewer only accepts embedded assets without extensions.");
  }
}

const CLIP_NAMES: Record<string, string> = {
  bn01: "Idle", bn02: "Idle (Low HP)", ba01: "Attack 01", ba02: "Attack 02",
  bd01: "Hit", bd02: "Knock Down", bd03: "Get Up", bg01: "Block", bg02: "Dodge",
  br01: "Run", bf01: "Field Action", bs01: "Special 01", bs02: "Special 02",
  bv01: "Victory 01", bv02: "Victory 02", bv03: "Victory 03",
  fe01: "Eat", fe02: "Field Victory", fe03: "Yawn", fe04: "Field Fight",
  fq01: "Yes", fq02: "No", f000: "Rest 01", f001: "Rest 02",
};

export function clipLabel(name: string): string {
  const code = name.replace(/^chr\d+_/, "");
  return CLIP_NAMES[code] ?? `Clip ${code.toUpperCase()}`;
}
