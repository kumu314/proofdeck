/**
 * Minimal session signing (v0). Each session gets an Ed25519 keypair; the
 * private key stays local (never leaves the machine), the public key is
 * recorded on the session. Signing the timeline head hash lets `verify` show
 * whether board state is vouched for by a key — i.e. trusted vs. merely
 * asserted. This is deliberately NOT a full identity/PKI system: no key
 * distribution, revocation, or web-of-trust yet.
 */
export interface SessionKeypair {
    publicKeyPem: string;
    privateKeyPem: string;
}
export declare function generateSessionKeypair(): SessionKeypair;
/** Sign a hex hash string with a PEM private key; returns base64. */
export declare function signHash(privateKeyPem: string, hash: string): string;
/** Verify a base64 signature over a hash against a PEM public key. */
export declare function verifyHash(publicKeyPem: string, hash: string, signatureB64: string): boolean;
//# sourceMappingURL=signing.d.ts.map