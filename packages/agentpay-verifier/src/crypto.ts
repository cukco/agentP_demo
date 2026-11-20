import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createBodyCipher(key: Uint8Array) {
  if (key.byteLength !== 32) throw new Error("VERIFIER_BODY_KEY must be 32 bytes");
  const secret = Buffer.from(key);
  return {
    encryptBody(body: Uint8Array): Buffer {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", secret, iv);
      const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptBody(body: Uint8Array): Buffer {
      if (body.byteLength < IV_BYTES + TAG_BYTES) throw new Error("Invalid encrypted body");
      const decipher = createDecipheriv("aes-256-gcm", secret, body.subarray(0, IV_BYTES));
      decipher.setAuthTag(body.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(body.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    },
  };
}
