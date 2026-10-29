# OTA 代码签名证书目录（安全审计 #24）

本目录存放 **Expo Updates 代码签名** 所需的公钥证书。

## 为什么需要它

`expo-updates` 的 OTA 热更新包默认只依赖 HTTPS 传输安全。一旦 CDN、DNS 或
更新服务器被攻破，攻击者可以下发任意 JS bundle，在用户设备上执行任意代码
（等同于远程代码执行）。**代码签名** 让客户端在应用更新前用内置公钥验证
manifest 签名，签名不匹配则拒绝更新，从根本上阻断这条攻击链。

## 文件说明

| 文件 | 是否提交 Git | 说明 |
| --- | --- | --- |
| `certificate.pem` | ✅ 提交 | **公钥**证书，会被打包进 App，用于验签。公开无害。 |
| `private-key.pem` | ❌ **绝不提交** | 私钥，用于签名更新包。泄露即可伪造更新。已在 `.gitignore` 中忽略 `*.pem`。 |

> ⚠️ 注意：`.gitignore` 中的 `*.pem` 规则会同时忽略 `certificate.pem`。
> 首次生成后需强制加入版本控制：
> ```bash
> git add -f certs/certificate.pem
> ```

## 生成步骤

```bash
# 1. 生成 RSA 2048 私钥（有效期 10 年）
openssl genrsa -out certs/private-key.pem 2048

# 2. 导出对应的公钥证书（自签名，3650 天）
openssl req -new -x509 -key certs/private-key.pem \
  -out certs/certificate.pem -days 3650 \
  -subj "/CN=Sync test OTA Code Signing"

# 3. 校验两者匹配（输出的 MD5 应完全一致）
openssl rsa -in certs/private-key.pem -pubout -outform DER | openssl md5
openssl x509 -in certs/certificate.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl md5
```

## 私钥托管

私钥**不要**放在仓库里，也不要放进 EAS 的普通环境变量。推荐两种方式：

1. **EAS 托管（推荐）**：`eas credentials` → 选择 iOS/Android → `Update credentials`
   → 上传私钥，由 EAS 在构建与 `eas update` 时自动签名。
2. **CI Secret**：在 CI 中以文件型 Secret 注入，构建前写入 `certs/private-key.pem`，
   构建后立即删除。

## 与 `app.json` 的对应关系

```json
"updates": {
  "codeSigningCertificate": "./certs/certificate.pem",
  "codeSigningMetadata": {
    "keyid": "main",
    "alg": "rsa-v1_5-sha256"
  }
}
```

- `codeSigningCertificate`：公钥证书路径，**必须**随 App 一起打包。
- `codeSigningMetadata.keyid`：密钥标识，需与 `eas update` 签名时使用的 keyid 一致。
- `codeSigningMetadata.alg`：签名算法，`rsa-v1_5-sha256` 为 Expo 默认推荐值。

## 启用顺序（重要）

1. 先生成密钥对，把 `certificate.pem` 提交到仓库。
2. 在 `app.json` 中配置上述字段（已完成）。
3. 用 **EAS Build 重新构建** 一次原生包 —— 证书是在构建期嵌入原生二进制的，
   OTA 无法把证书推给旧版本 App。
4. 之后所有 `eas update` 都会自动签名，旧版本 App（未内置证书）仍可正常接收
   未签名的更新，不会因此崩溃。
