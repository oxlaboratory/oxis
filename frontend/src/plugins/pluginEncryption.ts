/**
 * pluginEncryption.ts — premium plugin package encryption.
 *
 * See README § Premium Plugin Licensing & Encryption. Real AES-256-GCM
 * via the browser/webview's native Web Crypto API — not a toy XOR
 * cipher, not base64-as-"encryption". Important framing, stated
 * plainly rather than oversold: this protects a *distributed,
 * at-rest* file from casual copying and makes the plugin source not
 * trivially readable by opening the file in a text editor. It does
 * NOT make a plugin impossible to extract from a machine that is
 * actively, successfully running it — software executing locally can
 * always be observed by a sufficiently determined local user with
 * full control of their own machine (a debugger, a memory dump, a
 * modified runtime). No client-side scheme, from any vendor, changes
 * that; nobody should be sold on this being unbreakable DRM, and this
 * codebase doesn't claim it is.
 *
 * Key derivation: PBKDF2 over a per-install device identifier, so the
 * encrypted package only decrypts on the machine (well, the OXIS
 * install) it was licensed for — copying the raw file to another
 * computer yields ciphertext that machine can't open, which is the
 * actual, honest goal here (see README's DRM-scope note above).
 */

const ITERATIONS = 150_000;
const KEY_LENGTH_BITS = 256;

async function deriveKey(deviceId: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(deviceId),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: KEY_LENGTH_BITS },
    false,
    ["encrypt", "decrypt"]
  );
}

export interface EncryptedPluginPackage {
  /** Format version — bump if the on-disk layout ever changes, so an
   *  older OXIS build can at least fail with a clear "unsupported
   *  package version" instead of garbage output. */
  v: 1;
  plugin: string;
  salt: string;   // base64
  iv: string;     // base64
  ciphertext: string; // base64
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encrypt a plugin's Lua source for local storage. Called once, right
 *  after downloading a premium plugin package post-subscription (see
 *  README's install-flow diagram). */
export async function encryptPluginPackage(plugin: string, luaSource: string, deviceId: string): Promise<EncryptedPluginPackage> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(deviceId, salt);
  const encoded = new TextEncoder().encode(luaSource);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, encoded);
  return {
    v: 1,
    plugin,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`couldn't decrypt premium plugin package: ${reason}`);
    this.name = "DecryptionError";
  }
}

/** Decrypt a plugin package into memory only — the caller is
 *  responsible for never writing the result back to disk in
 *  plaintext (see loadPremiumPlugin in pluginManager.ts, which loads
 *  it straight into a Lua VM and never persists the string). */
export async function decryptPluginPackage(pkg: EncryptedPluginPackage, deviceId: string): Promise<string> {
  if (pkg.v !== 1) throw new DecryptionError(`unsupported package version: ${pkg.v}`);
  try {
    const key = await deriveKey(deviceId, fromBase64(pkg.salt));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(pkg.iv) as unknown as BufferSource },
      key,
      fromBase64(pkg.ciphertext) as unknown as BufferSource
    );
    return new TextDecoder().decode(plaintext);
  } catch (e) {
    // AES-GCM decrypt fails closed on any tampering or wrong key —
    // this is also what happens if the package was copied to a
    // different device (different deviceId -> different derived key).
    throw new DecryptionError(e instanceof Error ? e.message : String(e));
  }
}

/** A stable per-install identifier — not tied to hardware serials
 *  (there's no cross-platform, permission-free way to read those from
 *  a webview) but stable across restarts of this OXIS install, which
 *  is what actually matters for "this file only opens on the install
 *  it was licensed to". Generated once, cached in localStorage. */
export function getDeviceId(): string {
  const KEY = "oxis-device-id-v1";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
