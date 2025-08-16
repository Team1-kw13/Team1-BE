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
}

module.exports = new AudioService();
