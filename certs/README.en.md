# OTA code signing certificate directory (security audit #24)

[中文版](README.md) · English (this page)

This directory holds the public key certificate needed for **Expo Updates code signing**.

## What the certificate is for

By default, `expo-updates` OTA bundles rely only on HTTPS for transport security. If the CDN, DNS or update server is compromised, an attacker can push an arbitrary JS bundle and run arbitrary code on user devices (equivalent to remote code execution). **Code signing** makes the client verify the manifest signature with a built-in public key before applying an update, and reject the update if the signature doesn't match — cutting that attack chain off at the root.

## Files

| File | Committed to Git | Description |
| --- | --- | --- |
| `certificate.pem` | Yes | **Public** key certificate. Bundled into the app and used to verify signatures. Harmless to publish. |
| `private-key.pem` | **Never** | Private key, used to sign update bundles. If it leaks, anyone can forge updates. Already ignored by `*.pem` in `.gitignore`. |

> Note: the `*.pem` rule in `.gitignore` also ignores `certificate.pem`.
> After generating it for the first time, force-add it to version control:
> ```bash
> git add -f certs/certificate.pem
> ```

## How to generate it

```bash
# 1. Generate an RSA 2048 private key (valid for 10 years)
openssl genrsa -out certs/private-key.pem 2048

# 2. Export the matching public key certificate (self-signed, 3650 days)
openssl req -new -x509 -key certs/private-key.pem \
  -out certs/certificate.pem -days 3650 \
  -subj "/CN=Sync test OTA Code Signing"

# 3. Check that the two match (the MD5 output should be identical)
openssl rsa -in certs/private-key.pem -pubout -outform DER | openssl md5
openssl x509 -in certs/certificate.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl md5
```

## Where to keep the private key

**Don't** put the private key in the repo, and don't put it in a regular EAS environment variable. Two recommended options:

1. **EAS-managed (recommended)**: `eas credentials` → pick iOS/Android → `Update credentials`
   → upload the private key, and EAS signs automatically during builds and `eas update`.

2. **CI secret**: inject it as a file-type secret in CI, write it to `certs/private-key.pem` before the build,
   and delete it immediately after.

## How it maps to `app.json`

```json
"updates": {
  "codeSigningCertificate": "./certs/certificate.pem",
  "codeSigningMetadata": {
    "keyid": "main",
    "alg": "rsa-v1_5-sha256"
  }
}
```

- `codeSigningCertificate`: path to the public key certificate. **Must** be bundled with the app.
- `codeSigningMetadata.keyid`: key identifier. Must match the keyid used when signing with `eas update`.
- `codeSigningMetadata.alg`: signing algorithm. `rsa-v1_5-sha256` is Expo's recommended default.

## Rollout order (important)

> **OTA code signing is not enabled in this repository.** `certs/` only contains documentation — there is no
> `certificate.pem`, and the `updates` block in `app.json` has no `codeSigningCertificate` field.
> To enable it, generate your own key pair and configure it by following the steps below.

1. Generate the key pair first, and commit `certificate.pem` to the repo.
2. Configure the fields above in `app.json` (**you must do this yourself — it is not enabled in this repo**).
3. **Rebuild the native binary with EAS Build** once — the certificate is embedded into the native binary at build time,
   and OTA can't push a certificate to an older app version.

4. After that, every `eas update` is signed automatically. Older app versions (without the built-in certificate) can still
   receive unsigned updates normally and won't crash because of it.
