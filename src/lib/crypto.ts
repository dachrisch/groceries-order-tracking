import crypto from 'crypto';

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // AES-256 needs 32-byte key
const FIXED_SALT_SUFFIX = 'groceries-tracking-v1';

/**
 * Derives a 256-bit AES key from the user's email and plaintext password.
 * Uses PBKDF2-SHA256 with the email as part of the salt for per-user uniqueness.
 * Call this at login time (when plaintext password is available).
 */
export function deriveKey(email: string, password: string): Buffer {
  const salt = email.toLowerCase() + ':' + FIXED_SALT_SUFFIX;
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypts a plaintext string with AES-256-GCM (authenticated encryption).
 * Returns "ivHex:authTagHex:ciphertextHex".
 * AES-256-GCM is preferred over CBC because it detects tampering via the auth tag.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypts an "ivHex:authTagHex:ciphertextHex" string produced by encrypt().
 * Throws if the auth tag doesn't match (data was tampered).
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
