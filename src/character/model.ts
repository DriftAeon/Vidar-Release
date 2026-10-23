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
