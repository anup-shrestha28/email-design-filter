import { generateKeyPairSync, randomBytes } from "node:crypto";

export function ringJson(entries: Record<string, Buffer>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.toString("base64")])),
  );
}

export function randomKey(): Buffer {
  return randomBytes(32);
}

export function ed25519Pair(): {
  privDer: string;
  pubDer: string;
  privPem: string;
  pubPem: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privDer: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    pubDer: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    pubPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);
