/**
 * 口令散列：scrypt（Node 内置，无第三方依赖）。
 * 存储格式 `scrypt$<salt-b64url>$<hash-b64url>`，参数写死在派生时，便于日后升级。
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const PREFIX = "scrypt";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH);
  return `${PREFIX}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

/** 恒定时间比对；格式非法直接返回 false，不抛异常。 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;

  const salt = Buffer.from(parts[1], "base64url");
  const expected = Buffer.from(parts[2], "base64url");
  const derived = await scryptAsync(password.normalize("NFKC"), salt, expected.length);

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
