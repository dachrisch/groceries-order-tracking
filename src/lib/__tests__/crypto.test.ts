import { describe, it, expect } from 'vitest';
import { deriveKey, encrypt, decrypt } from '../../lib/crypto';

describe('crypto', () => {
  describe('deriveKey', () => {
    it('should derive a key from email and password', () => {
      const key = deriveKey('user@example.com', 'password123');
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32); // AES-256 needs 32 bytes
    });

    it('should derive the same key for the same email and password', () => {
      const key1 = deriveKey('user@example.com', 'password123');
      const key2 = deriveKey('user@example.com', 'password123');
      expect(key1.equals(key2)).toBe(true);
    });

    it('should derive different keys for different emails', () => {
      const key1 = deriveKey('user1@example.com', 'password123');
      const key2 = deriveKey('user2@example.com', 'password123');
      expect(key1.equals(key2)).toBe(false);
    });

    it('should derive different keys for different passwords', () => {
      const key1 = deriveKey('user@example.com', 'password1');
      const key2 = deriveKey('user@example.com', 'password2');
      expect(key1.equals(key2)).toBe(false);
    });

    it('should be case-insensitive for email', () => {
      const key1 = deriveKey('User@Example.com', 'password123');
      const key2 = deriveKey('user@example.com', 'password123');
      expect(key1.equals(key2)).toBe(true);
    });
  });

  describe('encrypt', () => {
    it('should encrypt a plaintext string', () => {
      const key = deriveKey('user@example.com', 'password123');
      const ciphertext = encrypt('Hello, World!', key);
      expect(typeof ciphertext).toBe('string');
      expect(ciphertext).toContain(':'); // iv:authTag:ciphertext
    });

    it('should produce different ciphertexts for the same plaintext (due to random IV)', () => {
      const key = deriveKey('user@example.com', 'password123');
      const ciphertext1 = encrypt('Hello, World!', key);
      const ciphertext2 = encrypt('Hello, World!', key);
      expect(ciphertext1).not.toBe(ciphertext2);
    });

    it('should encrypt special characters correctly', () => {
      const key = deriveKey('user@example.com', 'password123');
      const plaintext = 'Special chars: üöä € & "quotes" <tag>';
      const ciphertext = encrypt(plaintext, key);
      const decrypted = decrypt(ciphertext, key);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('decrypt', () => {
    it('should decrypt an encrypted string', () => {
      const key = deriveKey('user@example.com', 'password123');
      const plaintext = 'Secret message';
      const ciphertext = encrypt(plaintext, key);
      const decrypted = decrypt(ciphertext, key);
      expect(decrypted).toBe(plaintext);
    });

    it('should decrypt empty string', () => {
      const key = deriveKey('user@example.com', 'password123');
      const plaintext = '';
      const ciphertext = encrypt(plaintext, key);
      const decrypted = decrypt(ciphertext, key);
      expect(decrypted).toBe(plaintext);
    });

    it('should decrypt long strings', () => {
      const key = deriveKey('user@example.com', 'password123');
      const plaintext = 'A'.repeat(1000);
      const ciphertext = encrypt(plaintext, key);
      const decrypted = decrypt(ciphertext, key);
      expect(decrypted).toBe(plaintext);
    });

    it('should throw error for invalid ciphertext format (missing parts)', () => {
      const key = deriveKey('user@example.com', 'password123');
      expect(() => decrypt('invalid', key)).toThrow('Invalid ciphertext format');
    });

    it('should throw error for invalid ciphertext format (only one colon)', () => {
      const key = deriveKey('user@example.com', 'password123');
      expect(() => decrypt('a:b', key)).toThrow('Invalid ciphertext format');
    });

    it('should throw error for wrong key', () => {
      const key1 = deriveKey('user@example.com', 'password1');
      const key2 = deriveKey('user@example.com', 'password2');
      const ciphertext = encrypt('Secret', key1);
      expect(() => decrypt(ciphertext, key2)).toThrow();
    });

    it('should detect tampering with modified ciphertext', () => {
      const key = deriveKey('user@example.com', 'password123');
      const ciphertext = encrypt('Secret message', key);
      const parts = ciphertext.split(':');
      // Tamper with the ciphertext part
      const tampered = parts[0] + ':' + parts[1] + ':' + '00000000000000000000000000000000';
      expect(() => decrypt(tampered, key)).toThrow();
    });
  });

  describe('round-trip', () => {
    it('should handle multiple encrypt/decrypt cycles', () => {
      const key = deriveKey('user@example.com', 'password123');
      const plaintext = 'Test message';
      
      // First round
      const ciphertext1 = encrypt(plaintext, key);
      const decrypted1 = decrypt(ciphertext1, key);
      expect(decrypted1).toBe(plaintext);
      
      // Second round
      const ciphertext2 = encrypt(plaintext, key);
      const decrypted2 = decrypt(ciphertext2, key);
      expect(decrypted2).toBe(plaintext);
      
      // Third round
      const ciphertext3 = encrypt(plaintext, key);
      const decrypted3 = decrypt(ciphertext3, key);
      expect(decrypted3).toBe(plaintext);
    });
  });
});