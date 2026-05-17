import * as crypto from 'crypto';

// Ed25519 SPKI DER 头部（固定值）
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string,
): boolean {
  try {
    const spkiDer = Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, 'hex')]);
    const key = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}
