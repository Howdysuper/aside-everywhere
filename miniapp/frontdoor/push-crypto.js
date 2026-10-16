/*
 * Web Push crypto (RFC 8291 aes128gcm) and VAPID (RFC 8292, ES256) using
 * ONLY the WebCrypto API, so the same file runs inside the Cloudflare
 * Worker and in Node (globalThis.crypto) for offline tests.
 *
 * Byte-for-byte compatible with the `web-push` npm package (http_ece):
 *   secret = HKDF(salt=authSecret, ikm=ECDH(local,remote),
 *                info="WebPush: info\0" || receiverPub || senderPub, 32)
 *   prk    = HMAC-SHA256(salt16, secret)
 *   key    = HKDF-Expand(prk, "Content-Encoding: aes128gcm\0", 16)
 *   nonce  = HKDF-Expand(prk, "Content-Encoding: nonce\0", 12)
 *   body   = salt || rs(4096) || 65 || localPub || AES-128-GCM(pt || 0x02)
 */

const te = new TextEncoder();

function b64urlToBytes(s) {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const b = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const cat = (...parts) => {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

async function hkdfExpand(prk, info, len) {
  const out = [];
  let t = new Uint8Array(0);
  let counter = 1;
  let total = 0;
  while (total < len) {
    t = await hmac(prk, cat(t, info, new Uint8Array([counter])));
    out.push(t);
    total += t.length;
    counter += 1;
  }
  return cat(...out).slice(0, len);
}

/**
 * Encrypt a push payload for one subscription (aes128gcm, single record:
 * our payloads are far below rs-17 = 4079 bytes).
 * Returns the exact HTTP request body octets.
 */
export async function encryptPayload(sub, payloadText) {
  const remotePub = b64urlToBytes(sub.keys.p256dh); // 65-byte uncompressed point
  const auth = b64urlToBytes(sub.keys.auth); // 16 bytes
  if (remotePub.length !== 65 || remotePub[0] !== 4) throw new Error('bad p256dh');
  if (auth.length !== 16) throw new Error('bad auth');

  const remoteKey = await crypto.subtle.importKey(
    'raw', remotePub, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const local = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const ikm = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: remoteKey }, local.privateKey, 256,
  ));
  const localPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));

  // WebPush secret (http_ece webpushSecret, encrypt mode): the info carries
  // BOTH public keys — receiver (remote) first, then the sender's (local).
  const prk0 = await hmac(auth, ikm);
  const secret = await hkdfExpand(
    prk0, cat(te.encode('WebPush: info\0'), remotePub, localPub), 32,
  );

  // aes128gcm key derivation (http_ece deriveKeyAndNonce).
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, secret);
  const cek = await hkdfExpand(prk, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, te.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey(
    'raw', cek, { name: 'AES-GCM', length: 128 }, false, ['encrypt'],
  );
  const pt = te.encode(payloadText);
  const padded = new Uint8Array(pt.length + 1);
  padded.set(pt);
  padded[pt.length] = 2; // last-record delimiter (http_ece encryptRecord)
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded,
  ));

  // aes128gcm header: salt || rs=4096 (BE32) || keyidLen=65 || localPub.
  const header = new Uint8Array(21 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(localPub, 21);
  return cat(header, ct);
}

/* ---- VAPID (ES256 JWT) -------------------------------------------------- */
// JWS compact serialization carries the raw IEEE P1363 r||s (64 bytes) as
// the signature; node/webcrypto ECDSA sign already returns exactly that.
// (DER is only needed for X.509 land, not JWS.)

/**
 * Build the VAPID Authorization header for one push endpoint.
 * vapidJwk: { kty:'EC', crv:'P-256', x, y, d } (base64url parts) plus publicKey.
 */
export async function vapidHeader(endpoint, vapidJwk, subject, expSec) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(te.encode(JSON.stringify({
    aud,
    exp: expSec,
    sub: subject,
  })));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: vapidJwk.x, y: vapidJwk.y, d: vapidJwk.d },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const raw = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(signingInput),
  ));
  return `vapid t=${signingInput}.${bytesToB64url(raw)}, k=${vapidJwk.publicKey}`;
}

/**
 * One complete delivery: encrypt + sign + POST to the push endpoint.
 * Returns { ok, status } or throws.
 */
export async function deliver(sub, payloadObj, vapidJwk, subject) {
  const body = await encryptPayload(sub, JSON.stringify(payloadObj));
  const expSec = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const authorization = await vapidHeader(sub.endpoint, vapidJwk, subject, expSec);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'normal',
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      Authorization: authorization,
    },
    body,
  });
  return { ok: res.ok, status: res.status };
}
