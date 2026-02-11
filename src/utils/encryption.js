import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 64;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

const getKey = () => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error('ENCRYPTION_KEY должен быть минимум 32 символа');
  }
  return key.slice(0, 32);
};

export const encrypt = (text) => {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.pbkdf2Sync(getKey(), salt, ITERATIONS, KEY_LENGTH, 'sha256');
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return [
    salt.toString('hex'),
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted
  ].join(':');
};

export const decrypt = (encryptedData) => {
  const [saltHex, ivHex, authTagHex, encrypted] = encryptedData.split(':');
  
  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const key = crypto.pbkdf2Sync(getKey(), salt, ITERATIONS, KEY_LENGTH, 'sha256');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
};
