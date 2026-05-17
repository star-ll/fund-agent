import * as crypto from 'crypto';
import { config } from '../utils/config';

const AES_KEY = Buffer.from(config.wework.encodingAESKey + '=', 'base64');

// 消息签名验证
export function verifySignature(
  signature: string,
  timestamp: string,
  nonce: string,
  echostrOrEncryptedMsg: string,
): boolean {
  const str = [config.wework.token, timestamp, nonce, echostrOrEncryptedMsg]
    .sort()
    .join('');
  const hash = crypto.createHash('sha1').update(str).digest('hex');
  return hash === signature;
}

// AES 解密企微消息
export function decrypt(encrypted: string): string {
  const buf = Buffer.from(encrypted, 'base64');
  const iv = AES_KEY.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(buf), decipher.final()]);

  // 去掉 PKCS7 padding
  const pad = decrypted[decrypted.length - 1];
  const content = decrypted.slice(20, decrypted.length - pad); // 16字节随机+4字节长度
  const msgLen = decrypted.readUInt32BE(16);
  return content.slice(0, msgLen).toString('utf8');
}

// AES 加密回复消息
export function encrypt(plaintext: string): string {
  const random = crypto.randomBytes(16);
  const msg = Buffer.from(plaintext, 'utf8');
  const msgLenBuf = Buffer.allocUnsafe(4);
  msgLenBuf.writeUInt32BE(msg.length, 0);

  const content = Buffer.concat([random, msgLenBuf, msg, Buffer.from(config.wework.corpId)]);

  // PKCS7 padding
  const blockSize = 32;
  const padLen = blockSize - (content.length % blockSize);
  const padded = Buffer.concat([content, Buffer.alloc(padLen, padLen)]);

  const iv = AES_KEY.slice(0, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

export function makeSignature(encrypted: string, timestamp: string, nonce: string): string {
  const str = [config.wework.token, timestamp, nonce, encrypted].sort().join('');
  return crypto.createHash('sha1').update(str).digest('hex');
}
