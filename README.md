# ⚙️ MaiinSight — Backend

> **Can a sports venue's booking history alone predict who's about to stop coming back — and prove, statistically, that a campaign actually worked?**

Node.js · Express · MySQL · Prisma · K-Means++ · Logistic Regression · Two-Proportion Z-Test · Holt's Forecasting · Gemini API

![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.22-000000?logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?logo=mysql&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-5.22-2D3748?logo=prisma&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini_API-AI_Strategy-8E75B2?logo=googlegemini&logoColor=white)
![Tests](https://img.shields.io/badge/tests-57_passing-success)
![License](https://img.shields.io/badge/license-MIT-green)

[Overview](#-overview) · [ML/DS Engine](#-data-science--ml-engine) · [API Overview](#-api-overview) · [Tech Stack](#-tech-stack) · [Getting Started](#-getting-started) · [Architecture](#-project-structure) · [Security](#-security) · [Limitations](#-honest-limitations) · [Frontend repo](https://github.com/greythinkerdue/maiinsight-frontend)

---

## ✨ Overview

This is the **API and data-science engine** behind MaiinSight, a marketing decision-support platform for **Maiin Gandaria**, a multi-court sports venue business. It owns the database, every statistical/ML model, and the integrations (Gemini, Meta Graph API, WhatsApp Business Cloud API) that turn raw booking data into campaign decisions.

> Dashboard (Next.js) consuming this API lives in a companion repo: **[maiinsight-frontend](https://github.com/greythinkerdue/maiinsight-frontend)**.

## 🧠 Data Science & ML Engine

Every model below is implemented **from scratch** — no `scikit-learn`, no stats library — living in `src/services/`:

- **`rfmSegmentation.service.js`** — K-Means++ with a seeded PRNG (deterministic/reproducible), RFM features (log-transformed + winsorized), K chosen via Silhouette Score and Elbow Method, with per-customer outlier detection (MAD/IQR) for cluster-fit labeling.
- **`churnRisk.service.js`** — L2-regularized logistic regression via batch gradient descent. Training snapshots are built leakage-safe (features computed only from data strictly before the snapshot date), split **time-based** (train strictly before test, not random), evaluated with a from-scratch AUC (rank-based) and confusion-matrix metrics, and scored customers get per-feature contribution explainability (`coefficient × standardized_value`).
- **`outreachCampaign.service.js`** — a from-scratch two-proportion z-test (Abramowitz-Stegun erf approximation) and Wald confidence interval for campaign-lift significance, gated behind a minimum-sample-size guard.
- **`occupancyForecast.service.js`** — Holt's linear-trend (double exponential smoothing) for weekly occupancy forecasting, with smoothing parameters selected via walk-forward one-step-ahead validation.
- **`aiProvider.service.js`** — wraps Gemini with a factual-number verifier (every AI-stated figure must trace back to the supplied context or the response is rejected and retried), bidirectional PII redaction, and scope/language validation.

## 📡 API Overview

| Route group | Purpose | Access |
|---|---|---|
| `/auth` | Login (email/password + Google OAuth), session management | Public / authenticated |
| `/dashboard` | Overview KPIs, occupancy trend, revenue, play-time mix | All roles |
| `/segmentation` | Run/read RFM + K-Means++ customer segmentation | Operational, Management, IT Support |
| `/targeting` | Low-occupancy slot targeting, recommended customers, outreach campaigns | Operational, IT Support |
| `/churn-risk` | Train/read churn model, at-risk customer list, reactivation campaigns | Operational, Management, IT Support |
| `/ai-strategy` | Gemini-generated campaign strategy + free-form "Ask the AI" | Operational, IT Support |
| `/meta` | Instagram/Meta Graph API sync (InstaSight) | Operational, IT Support |
| `/imports` | Transaction file ingestion (CSV/XLSX) | Operational, IT Support |
| `/operations` | Management reports, activity log, notifications | Varies by endpoint |
| `/system` | Integration config, service-token status | IT Support only |
| `/webhooks/whatsapp` | Meta's own verify-token handshake for delivery/reply events | Meta (unauthenticated by design) |

Full route list in [`src/routes/`](./src/routes).

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Runtime / framework | Node.js 20, Express 4.22 |
| Database / ORM | MySQL 8.0, Prisma 5.22 (35 models) |
| AI | Gemini API (`@google/genai`) |
| Integrations | Meta Graph API v25.0, WhatsApp Business Cloud API |
| Auth | JWT (`jsonwebtoken`), Google OAuth (`google-auth-library`), bcrypt |
| Middleware | `helmet`, `cors`, `morgan`, custom rate limiting |
| Testing | Node's native `node --test` (zero external test framework) |

## ⚙️ Getting Started

```bash
npm install
docker compose up -d        # local MySQL
npx prisma migrate dev
npm run seed                 # creates Operational / Management / IT Support accounts
npm run dev
```

API runs on `http://localhost:5000`. Copy `.env.example` to `.env` and configure — `JWT_SECRET` is required (the API refuses to start without it), and `GOOGLE_CLIENT_ID` must match the frontend's OAuth client ID.

```bash
npm run dev              # Dev server with nodemon
npm start                # Production server
npm run lint             # ESLint
npm test                 # Run the test suite
npm run seed              # Seed role accounts (never overwrites existing passwords)
npx prisma studio         # Open the DB viewer
```

## 🗂 Project Structure

```text
src/
  app.js, server.js
  config/        env, database, Prisma client
  middleware/    auth (JWT + RBAC), error handling, rate limiting
  routes/        one file per route group (see API Overview above)
  services/      business logic + every ML/stats model, one file per domain
prisma/
  schema.prisma  35 models, migrations/
```

57 test files under `src/**/__tests__/`, covering the ML models (sanity-checked against trivially-separable synthetic data and hand-computed AUC/confusion-matrix examples), scoring formulas, and validation gates — not just route smoke tests.

## 🔒 Security

- JWT auth with 3 roles (Operational / Management / IT Support) and a separate, narrowly-scoped service-token type for system-to-system calls
- Per-endpoint rate limiting on sensitive routes (login, password reset)
- Access tokens are redacted from every logged/stored Meta API response before they touch disk
- Integration credentials (Gemini, Meta, WhatsApp) live in a DB-backed settings table with `.env` fallback — rotating a key never requires a redeploy

## 🔭 Honest Limitations

- **No causal attribution.** Campaign-to-booking matching is based on promo-code tokens, not inferred causation — insight generation is explicitly restricted to correlation language.
- **Revenue targets aren't persisted.** Revenue-gap analysis returns "unavailable" until a target-revenue source exists in the database.
- **Churn model AUC is 0.707 ("Fair").** Base churn rate in production is high (~70–83%), so the API also returns a naive-baseline accuracy alongside AUC to keep the number honest.

## 📄 License

MIT — see [LICENSE](./LICENSE).

---

Built as a capstone/portfolio project for Maiin Gandaria. Frontend: [maiinsight-frontend](https://github.com/greythinkerdue/maiinsight-frontend).
