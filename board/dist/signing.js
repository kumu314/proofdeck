import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, } from "node:crypto";
export function generateSessionKeypair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return {
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        privateKeyPem: privateKey
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
    };
}
/** Sign a hex hash string with a PEM private key; returns base64. */
export function signHash(privateKeyPem, hash) {
    const key = createPrivateKey(privateKeyPem);
    return sign(null, Buffer.from(hash), key).toString("base64");
}
/** Verify a base64 signature over a hash against a PEM public key. */
export function verifyHash(publicKeyPem, hash, signatureB64) {
    try {
        const key = createPublicKey(publicKeyPem);
        return verify(null, Buffer.from(hash), key, Buffer.from(signatureB64, "base64"));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=signing.js.map