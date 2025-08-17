class AudioService {
  chunkBuffer(buf, size = 12_288) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return [];
    }
    const out = [];
    for (let i = 0; i < buf.length; i += size) out.push(buf.slice(i, i + size));
    return out;
  }

  looksLikePcm16(buf) {
    return Buffer.isBuffer(buf) && buf.length >= 2 && buf.length % 2 === 0;
  }

  toBase64PcmChunks(input, chunkBytes = 12_288) {
    if (!Buffer.isBuffer(input)) {
      throw new Error("Audio input must be Buffer (raw PCM16).");
    }
    if (!this.looksLikePcm16(input)) {
      throw new Error("Invalid PCM16 buffer.");
    }
    return this.chunkBuffer(input, chunkBytes).map((b) => b.toString("base64"));
  }

  fromBase64Pcm(b64) {
    if (typeof b64 !== "string" || b64.length === 0) {
      throw new Error("Audio input must be non-empty base64 string.");
    }
    // URL-safe
    let fixed = b64.replace(/-/g, "+").replace(/_/g, "/");
    const mod = fixed.length % 4;
    if (mod === 2) fixed += "==";
    else if (mod === 3) fixed += "=";

    const buf = Buffer.from(fixed, "base64");
    // if (!this.looksLikePcm16(buf)) {
    //   throw new Error("Decoded data is not valid PCM16 buffer.");
    // }
    return buf;
  }
}

module.exports = new AudioService();
