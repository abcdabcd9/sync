# Security Policy

[English](#english) · [中文](#中文)

---

## English

### Supported Versions

This project is under active development. Security fixes are applied to the latest `main` branch only.

| Version | Supported |
| --- | --- |
| `main` (latest) | Yes |
| Older commits / forks | No |

### Reporting a Vulnerability

**Please do not open a public issue for security problems.**

Report privately via one of these channels:

1. **GitHub Private Vulnerability Reporting** (preferred)
   Go to the repository's **Security** tab → **Report a vulnerability**.
2. **Email** — [tangchengzhi641@gmail.com](mailto:tangchengzhi641@gmail.com) or [tangchengzhi171@gmail.com](mailto:tangchengzhi171@gmail.com)

Please include:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected file paths, versions, or commits
- Any suggested fix

### What to Expect

| Stage | Target |
| --- | --- |
| Acknowledgement of your report | Within 7 days |
| Initial assessment | Within 14 days |
| Fix or mitigation plan | Within 30 days |

We will credit you in the release notes unless you ask to stay anonymous.

### Scope

In scope:

- Authentication and authorization flaws (RLS policy bypass, privilege escalation)
- Credential or secret leakage in the repository
- Injection vulnerabilities in Edge Functions
- Insecure data exposure through Supabase Storage or Realtime
- Dependency vulnerabilities with a reachable exploit path

Out of scope:

- Issues requiring physical access to a user's device
- Social engineering
- Denial of service through resource exhaustion on self-hosted instances
- Vulnerabilities in third-party services (Supabase, Expo, Firebase) — report those upstream
- Missing security headers on documentation-only pages

### Self-Hosted Deployments

This repository ships **source code only** — no prebuilt binaries. If you deploy your own instance, you are responsible for:

- Enabling RLS on every table (`supabase/migrations/06_*` and `08_*`)
- Keeping `SUPABASE_SERVICE_ROLE_KEY` server-side only (Edge Functions)
- Rotating your own Supabase, Groq, and Firebase credentials
- Restricting your Supabase project's allowed origins and redirect URLs

---

## 中文

### 支持的版本

本项目处于活跃开发阶段，安全修复只应用于最新的 `main` 分支。

| 版本 | 是否支持 |
| --- | --- |
| `main`（最新） | 是 |
| 旧提交 / Fork | 否 |

### 报告漏洞

**请不要为安全问题开公开 Issue。**

请通过以下任一渠道私下报告：

1. **GitHub 私密漏洞报告**（推荐）
   进入仓库的 **Security** 标签页 → **Report a vulnerability**。
2. **邮件** —— [tangchengzhi641@gmail.com](mailto:tangchengzhi641@gmail.com) 或 [tangchengzhi171@gmail.com](mailto:tangchengzhi171@gmail.com)

报告请包含：

- 问题描述与影响范围
- 复现步骤（如有可能，附 PoC）
- 受影响的文件路径、版本或提交
- 你建议的修复方式

### 处理时效

| 阶段 | 目标时间 |
| --- | --- |
| 确认收到报告 | 7 天内 |
| 初步评估 | 14 天内 |
| 修复或缓解方案 | 30 天内 |

除非你要求匿名，我们会在发布说明中致谢。

### 范围

**在范围内：**

- 认证与授权缺陷（RLS 策略绕过、越权）
- 仓库中的凭据或密钥泄露
- Edge Functions 中的注入漏洞
- 通过 Supabase Storage 或 Realtime 造成的非预期数据暴露
- 存在可达利用路径的依赖漏洞

**不在范围内：**

- 需要物理接触用户设备的问题
- 社会工程学攻击
- 自建实例上通过资源耗尽造成的拒绝服务
- 第三方服务（Supabase、Expo、Firebase）自身的漏洞 —— 请向对应上游报告
- 纯文档页面的安全响应头缺失

### 自建部署

本仓库**只提供源码**，不提供预编译安装包。如果你部署自己的实例，你需要自行负责：

- 为每张表启用 RLS（`supabase/migrations/06_*` 与 `08_*`）
- 确保 `SUPABASE_SERVICE_ROLE_KEY` 只存在于服务端（Edge Functions）
- 轮换你自己的 Supabase、Groq、Firebase 凭据
- 限制 Supabase 项目的允许来源与重定向 URL
