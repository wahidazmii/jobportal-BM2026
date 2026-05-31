# PT Buana Megah Job Portal (`ptk-app`)

Single-tenant job portal yang men-render SSR HTML (Nunjucks) untuk Public Site,
Applicant Area, dan Admin Console di atas Fastify + MySQL/MariaDB. Dideploy ke
shared cPanel HyperCloudHost (akun `mycdmkay`); pekerjaan terjadwal dijalankan
oleh cPanel cron melalui CLI dispatcher Node yang berbagi codebase dengan API
server.

Lihat `.kiro/specs/pt-buana-megah-job-portal/` untuk dokumen requirements,
design, dan tasks. Dokumen tersebut adalah sumber kebenaran; README ini
menjelaskan operasional repo.

## Quick Start (development)

```bash
npm install
npm run vendor:js      # download htmx, Alpine.js, Sortable.js + compute SRI
npm run build:assets   # build Tailwind CSS
npm run migrate up     # apply migrations to local MySQL
npm run dev            # tsx watch src/server.ts
```

Konfigurasi via environment variables (tanpa `.env` file): `DATABASE_URL`,
`SESSION_SECRET`, `PORT`, `BASE_URL`, `NODE_ENV`, `LOG_LEVEL`.

## Vendored Frontend Assets

Untuk menjaga Content-Security-Policy yang ketat (Req 15.1) dan agar first
paint tidak bergantung pada CDN eksternal (Req 2.10), library frontend
di-vendor ke `src/public/js/` dan disalin ke `public_html/assets/js/` saat
deploy. Versi pinned saat ini:

| Library     | Versi    | File                  | License      | Expected SRI (SHA-384)                                              |
| ----------- | -------- | --------------------- | ------------ | ------------------------------------------------------------------- |
| htmx        | 1.9.12   | `htmx.min.js`         | BSD-2-Clause | `sha384-ujb1lZYygJmzgSwoxRggbCHcjc0rB2XoQrxeTUQyRjrOnlCoYta87iKBWq3EsdM2` |
| Alpine.js   | 3.13.10  | `alpinejs.min.js`     | MIT          | `sha384-XBJ5+bq4ga1+0s+J4sl6njqQ9C/YIfKeQw18HypSuGEaPm1g/VWaNdsQ5d3sE1qi` |
| Sortable.js | 1.15.6   | `sortable.min.js`     | MIT          | `sha384-HZZ/fukV+9G8gwTNjN7zQDG0Sp7MsZy5DDN6VfY3Be7V9dvQpEpR2jF2HlyFUUjU` |

Hash di atas dihitung dari payload upstream pada versi pinned (verified secara
lokal). Jalankan `npm run vendor:js` untuk re-compute dan menulis ulang
`sri-manifest.json`.

### Mengisi atau memperbarui

```bash
npm run vendor:js        # download + compute SHA-384 SRI hashes
npm run vendor:js:check  # CI guard: gagal kalau file masih placeholder
```

Skrip `tools/vendor-js.mjs` mengunduh dari `unpkg.com` dengan fallback ke
`cdn.jsdelivr.net`, menulis payload ke `src/public/js/<file>.min.js`, lalu
menghasilkan `src/public/js/sri-manifest.json` berisi:

```json
{
  "algorithm": "sha384",
  "files": {
    "htmx":       { "version": "1.9.12",  "integrity": "sha384-..." },
    "alpinejs":   { "version": "3.13.10", "integrity": "sha384-..." },
    "sortablejs": { "version": "1.15.6",  "integrity": "sha384-..." }
  }
}
```

### Pemakaian SRI di template

Template `src/views/partials/header.njk` (ditambahkan di task selanjutnya)
membaca manifest dan merender setiap `<script>` dengan atribut `integrity` dan
`crossorigin="anonymous"`:

```html
<script
  src="/assets/js/htmx.min.js"
  integrity="{{ sri.htmx.integrity }}"
  crossorigin="anonymous"
  defer></script>
```

Browser akan menolak eksekusi jika file di disk berbeda dari hash yang
direncanakan, melindungi dari tampering bahkan ketika source same-origin.

### Catatan deploy

- Placeholder bawaan repo (`src/public/js/*.min.js`) hanya berisi komentar
  header dan akan melempar `Error` jika di-load oleh browser. Ini sengaja:
  build/CI harus gagal kalau seseorang lupa menjalankan `vendor:js`.
- Tambahkan `npm run vendor:js` ke prosedur deploy (postinstall opsional, atau
  langkah eksplisit sebelum `build:assets`).
- Saat upgrade versi: ubah konstanta `VENDORS` di `tools/vendor-js.mjs` dan
  header komentar di file placeholder, lalu commit `sri-manifest.json` baru.

## Repository Layout (ringkas)

```
src/
  server.ts            # Fastify bootstrap
  routes/              # request handlers
  modules/             # domain modules (auth, jobs, applications, ...)
  infra/               # db, logger, csrf, security headers, ...
  views/               # Nunjucks templates
  locales/             # id, en
  crons/               # cron CLI dispatcher (mail-flush, alert-digest, ...)
  public/              # static assets (Tailwind output, vendored JS, img)
migrations/            # *.sql files numbered 0001_*
tools/                 # vendor-js.mjs, migrate.mjs, build.mjs, eslint-rules
tests/{unit,integration,pbt,e2e}
```

## Setup Node.js App (cPanel)

Langkah-langkah di cPanel → **Setup Node.js App**:

| Field | Value |
|---|---|
| Node.js version | 22 |
| Application mode | Production |
| Application root | `/home/mycdmkay/ptk-app` |
| Application URL | `buanamegahcareer.my.id` |
| Application startup file | `artifacts/api-server/dist/index.mjs` |

### Environment Variables

Isi di bagian **Environment Variables** pada halaman Setup Node.js App (bukan file `.env`):

| Variable | Keterangan |
|---|---|
| `DATABASE_URL` | MySQL connection string, mis. `mysql://user:pass@localhost/mycdmkay_mycdmkay_ptk` |
| `SESSION_SECRET` | Random 32-byte hex string (generate: `openssl rand -hex 32`) |
| `SMTP_HOST` | Hostname SMTP relay (mis. `smtp.brevo.com`) |
| `SMTP_PORT` | Port SMTP (mis. `587`) |
| `SMTP_USER` | Username SMTP |
| `SMTP_PASS` | Password SMTP |
| `CAPTCHA_SECRET` | hCaptcha secret key |
| `BASE_URL` | `https://buanamegahcareer.my.id` |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |
| `PORT` | Port yang di-assign Passenger (biasanya diisi otomatis) |

Setelah menyimpan, klik **Restart** atau jalankan:

```bash
mkdir -p ~/ptk-app/tmp && touch ~/ptk-app/tmp/restart.txt
```

---

## Cron Jobs

Tambahkan tujuh entri berikut di cPanel → **Cron Jobs**. Semua output diarahkan ke file log di `~/logs/`.

```cron
# Mail outbox flush every 2 minutes (max 200 rows/run)
*/2 * * * *   /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs mail-flush >> /home/mycdmkay/logs/cron-mail.log 2>&1

# Job alert digest evaluation every 15 minutes
*/15 * * * *  /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs alert-digest >> /home/mycdmkay/logs/cron-alert.log 2>&1

# Session GC hourly (at minute 5)
5 * * * *     /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs session-gc >> /home/mycdmkay/logs/cron-gc.log 2>&1

# Daily backup at 02:00 server time
0 2 * * *     /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs backup-daily >> /home/mycdmkay/logs/cron-backup.log 2>&1

# Search optimize weekly Sunday 03:30
30 3 * * 0    /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs search-reindex >> /home/mycdmkay/logs/cron-search.log 2>&1

# File archive monthly day 1 04:00
0 4 1 * *     /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs file-archive >> /home/mycdmkay/logs/cron-arch.log 2>&1

# Audit archive monthly day 2 04:30
30 4 2 * *    /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs audit-archive >> /home/mycdmkay/logs/cron-audit.log 2>&1
```

> Pastikan direktori `~/logs/` sudah ada: `mkdir -p ~/logs`.

---

## Pre-launch Checklist

Gunakan checklist ini sebelum go-live di `buanamegahcareer.my.id`.

### 1. Required Environment Variables

Set semua variabel berikut di cPanel → **Setup Node.js App → Environment Variables**. Jangan gunakan file `.env` — Passenger membaca langsung dari konfigurasi ini (Req 1 AC #9).

| Variable | Keterangan | Contoh |
|---|---|---|
| `DATABASE_URL` | MySQL connection string untuk mysql2 pool | `mysql://mycdmkay_user:pass@localhost/mycdmkay_mycdmkay_ptk` |
| `SESSION_SECRET` | Random 32-byte hex untuk cookie signing dan CSRF | `openssl rand -hex 32` |
| `SMTP_HOST` | Hostname SMTP relay | `smtp.brevo.com` |
| `SMTP_PORT` | Port SMTP | `587` |
| `SMTP_USER` | Username SMTP | `user@example.com` |
| `SMTP_PASS` | Password SMTP | _(dari dashboard SMTP provider)_ |
| `CAPTCHA_SITE` | hCaptcha site key (public) | _(dari hCaptcha dashboard)_ |
| `CAPTCHA_SECRET` | hCaptcha secret key (private) | _(dari hCaptcha dashboard)_ |
| `BASE_URL` | Canonical origin — digunakan di link email dan HSTS | `https://buanamegahcareer.my.id` |
| `NODE_ENV` | Harus `production` di server live | `production` |
| `LOG_LEVEL` | Level log pino | `info` |
| `PORT` | Port yang di-assign Passenger (biasanya diisi otomatis) | _(otomatis)_ |

> **Startup check**: Saat `NODE_ENV=production`, `src/infra/startup-check.ts` akan melempar error deskriptif jika `DATABASE_URL`, `SESSION_SECRET`, atau `BASE_URL` kosong, sehingga Passenger gagal start dengan pesan yang jelas.

### 2. AutoSSL

Di cPanel → **SSL/TLS Status**, klik **Run AutoSSL** untuk:
- Apex domain: `buanamegahcareer.my.id`
- Subdomain: `ptkbuanamegah.my.id` (jika digunakan)

Pastikan status semua domain menunjukkan ✅ sebelum melanjutkan.

### 3. Cron Jobs (7 entri)

Tambahkan tepat tujuh entri berikut di cPanel → **Cron Jobs** (Design §11.2). Node binary path: `/home/mycdmkay/nodevenv/ptk-app/22/bin/node`.

```cron
# Mail outbox flush every 2 minutes (max 200 rows/run)
*/2 * * * *   /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs mail-flush >> /home/mycdmkay/logs/cron-mail.log 2>&1

# Job alert digest evaluation every 15 minutes
*/15 * * * *  /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs alert-digest >> /home/mycdmkay/logs/cron-alert.log 2>&1

# Session GC hourly (at minute 5)
5 * * * *     /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs session-gc >> /home/mycdmkay/logs/cron-gc.log 2>&1

# Daily backup at 02:00 server time
0 2 * * *     /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs backup-daily >> /home/mycdmkay/logs/cron-backup.log 2>&1

# Search optimize weekly Sunday 03:30
30 3 * * 0    /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs search-reindex >> /home/mycdmkay/logs/cron-search.log 2>&1

# File archive monthly day 1 04:00
0 4 1 * *     /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs file-archive >> /home/mycdmkay/logs/cron-arch.log 2>&1

# Audit archive monthly day 2 04:30
30 4 2 * *    /home/mycdmkay/nodevenv/ptk-app/22/bin/node /home/mycdmkay/ptk-app/artifacts/api-server/dist/crons/index.mjs audit-archive >> /home/mycdmkay/logs/cron-audit.log 2>&1
```

Pastikan direktori log sudah ada: `mkdir -p ~/logs`.

### 4. Passenger Restart

Setelah mengubah env vars atau men-deploy kode baru, restart Passenger:

```bash
mkdir -p ~/ptk-app/tmp && touch ~/ptk-app/tmp/restart.txt
```

Atau klik **Restart** di cPanel → Setup Node.js App.

### 5. Smoke Test

```bash
# Health check — harus mengembalikan {"status":"ok"}
curl https://buanamegahcareer.my.id/healthz

# Halaman utama
curl -I https://buanamegahcareer.my.id/

# Daftar lowongan
curl -I https://buanamegahcareer.my.id/id/jobs
```

Lakukan juga pengujian manual:
- [ ] Login sebagai Applicant → apply ke lowongan → cek status di `/me/applications`
- [ ] Login sebagai HR → buka kanban → pindahkan aplikasi antar kolom
- [ ] Cek `~/logs/cron-mail.log` setelah 2 menit untuk memastikan `mail-flush` berjalan

---

## Deployment

Prosedur deployment via cPanel Terminal (setelah setup awal selesai):

```bash
# 1. Masuk ke direktori aplikasi
cd ~/ptk-app

# 2. Pull perubahan terbaru dari Git Version Control
git pull

# 3. Install dependencies (production only, tanpa devDependencies)
npm ci --omit=dev

# 4. Build aplikasi (TypeScript → artifacts/api-server/dist/)
npm run build

# 5. Jalankan migrasi database
node tools/migrate.mjs up

# 6. Restart Passenger
touch tmp/restart.txt
```

### Deploy .htaccess

Setelah perubahan pada `.htaccess.template`:

```bash
npm run deploy:htaccess
# Setara dengan: cp .htaccess.template ~/public_html/.htaccess
```

### Smoke test setelah deploy

```bash
curl https://buanamegahcareer.my.id/healthz
# Expected: {"status":"ok"}
```

---

## License

Proprietary — internal project for PT Buana Megah.
