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
    const keyBuf = Buffer.from(publicKey, 'hex');
    console.log('[verify] publicKey len:', keyBuf.length, 'raw:', publicKey.slice(0, 8) + '...');
    console.log('[verify] signature len:', signature.length, 'timestamp:', timestamp);
    const spkiDer = Buffer.concat([SPKI_PREFIX, keyBuf]);
    const key = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    const result = crypto.verify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, 'hex'));
    console.log('[verify] result:', result);
    return result;
  } catch (e) {
    console.log('[verify] error:', e);
    return false;
  }
}
