# Sandbox.co.in E-way bill integration

Implemented: vehicle-linked manual register, IST validity, 24-hour warning status, PDF/image storage, CSV export, provider configuration status, and a test-connection button. Server adapter authenticates Sandbox first, then E-way bill session; tokens never go to the browser. The consignor generation endpoint is implemented server-side, but a complete reviewed generation form and live provider validation remain pending.

## Configure locally

Copy `.env.example` to `.env` in this directory. Fill your Sandbox API key/secret, E-way bill API username/password and taxpayer GSTIN in that local file. Do not use VITE-prefixed variables or paste secrets into chat. API credentials must be onboarded for Sandbox on the E-way bill portal.

Run `npm run api` from this directory, then `npm run dev -- --port 5173`. Use E-way bills → Test provider connection.

`EWB_ENABLE_GENERATION=false` is the default. The provider name Sandbox does not mean the configured account is a safe test account. Do not enable generation until account environment, taxpayer and intended submissions have been verified.

## API

- GET `/api/eway/status`: configuration presence only, not an authentication check.
- POST `/api/eway/connect`: authenticate both sessions, returns only success.
- POST `/api/eway/generate`: accepts `{confirmed:true,bill:<provider schema>}`. Requires server generation switch. This creates a government-facing record when enabled and configured. Not yet exposed as a user generation form.

Local calls require same-origin browser requests through Vite. Server binds to loopback. Never expose this development adapter publicly; it does not implement multi-user login/authorisation.

Generation attempts are journalled by invoice identity under `server/private`. Repeated identities are blocked, including after uncertain network results. Verify at provider before manually resolving a journal record. No automatic generation retries.

Tests cover NIC business-error envelopes, missing fields, and missing credentials. Real provider calls have not been made. Manual validity/status updates are unverified and do not update government records. Expiry warnings are visible in the register; push alerts and integration with the document blocker remain pending.

Sources: https://developer.sandbox.co.in/recipes/gst/authentication/generate_e_way_bill_session and https://developer.sandbox.co.in/api-reference/gst/compliance/endpoints/e-way-bill/consignor/generate_e_way_bill
