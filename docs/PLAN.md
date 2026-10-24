# PLAN: port server zh ke upstream ZCode v3.16.2

Leader: sesi `zh - leader #1` (session_01TL2dgBFB7GMyFj4jFHxojz). Cabang integrasi: `port-3.16` (dari `fe3ff5d`).

## Latar
v0.5.21 (PR #60) hanya menaikkan pin web ke 3.16.2. Sidebar 3.16 (`ui/src/project-sidebar/useProjectTree.ts`
→ `readProjectSidebarTree`) membutuhkan service backend `remote-projects`, `project` (readTree) dan `task-groups`,
yang tidak ada di server kita, sehingga sidebar error dan daftar task kosong. Produksi sudah di-rollback ke v0.5.20.
Paket di `packages/` adalah salinan upstream `29628c9` (v3.14.3) plus lapisan patch zh. Web sudah lebih maju lewat shim.

## Keputusan
- K1. Port server penuh, bukan shim: semua paket vendored dinaikkan ke upstream `3c5b227649371507ddc4eb46ac5133afe6db1cab` (v3.16.2).
- K2. Merge tiga arah per versi, dua langkah: 29628c9 → aac4755 (v3.15.1), lalu aac4755 → 3c5b2276 (v3.16.2).
  Riwayat upstream `zai-org/ZCode` linear: 29628c9 → aac4755 → 0a1fc56 → 3c5b2276.
- K3. Pemetaan path (sama dengan `scripts/sync-vendor.sh` lama, lihat `git show 6745ff8^:scripts/sync-vendor.sh` atau riwayatnya):
  `apps/zcode-cli/packages/<p>` → `packages/<p>` untuk p ∈ {adapters bootstrap cli contracts core dynamic-workflow
  dynamic-workflow-runtime i18n shared-types telemetry tui}; `packages/<p>` → `packages/<p>` untuk p ∈ {formal-proof
  model-option-map provider provider-node shared zcode-cua rpc client services server}; plus `config`, `patches`,
  `third-party`, `THIRD-PARTY-NOTICES.md`. **`packages/web` TIDAK di-merge** (web dibangun dari checkout upstream + `ui-patches`).
  Paket upstream yang baru muncul atau hilang: laporkan, putuskan bersama leader.
- K4. Mekanik: di clone `zai-org/ZCode`, `git archive` ketiga rev dengan pemetaan K3 ke tiga pohon. Di repo zh, buat cabang
  yatim sementara `vendor-tmp`: commit B (pohon 29628c9), commit T1 (aac4755) sebagai anak B, dan T2 (3c5b2276) sebagai anak T1.
  Lalu di cabang kerja: `git cherry-pick -X ignore-space-at-eol T1` (S1) dan `T2` (S2). Git memakai B/T1 sebagai basis 3-way,
  jadi patch zh tetap terjaga dan konflik muncul per file. `vendor-tmp` tidak di-push.
- K5. Lapisan patch zh (CONTEXT.md "Upstream sync") dipertahankan. Shim yang kini disediakan upstream DIBUANG dan diganti
  versi upstream (mis. `getWorkspaceProviderConfigFile`, `getBillingDiscount` dari 813fbb1). Setiap patch yang dibuang
  dicatat di PR.
- K6. Data produksi: migrasi skema `tasks-index.sqlite` (project-storage, migrasi v6 task-groups) diuji pada SALINAN data
  produksi di instance terpisah, tidak pernah pada file asli. `zh-web.service` (port 4180) tidak boleh disentuh.
- K7. Commit sesi zh (`fa66ed9`, `6dee92d`) dan tag/rilis `v0.5.21` dihapus setelah port OK: `main` di-reset ke `port-3.16`
  (force-push oleh leader, izin pemilik sudah ada). Rilis baru `v0.5.22`.

## Langkah
- **S1. Merge ke v3.15.1 (aac4755).** Bangun B/T1/T2 (K4), cherry-pick T1 ke cabang `s1-vendor-3.15.1` dari `port-3.16`,
  selesaikan konflik (K5), `bun install`, `sh build-all.sh`, `bun test` paket yang tersentuh (minimal services, cli, server), tsc bersih.
  Pin web tetap 3.15.1 (`ZCODE_VENDORED_REV` = aac4755, tidak berubah). Smoke: `zh -p` dengan model deepseek-flash effort low,
  dan instance web terpisah (port 4193, salinan `~/.zcode` di folder sementara): boot, sidebar, daftar task, buat task baru,
  journal tanpa "Method not found"/"Unknown channel" baru dibanding produksi v0.5.20 (yang lama: window-controller,
  marketing-touch, highspeed-card, gen-ui).
  Selesai bila: PR ke `port-3.16` dengan daftar konflik + cara penyelesaian + patch yang dibuang + bukti di atas.
- **S2. Merge ke v3.16.2 (3c5b2276) + web.** Cabang `s2-vendor-3.16.2` dari `port-3.16` (setelah S1 merge): cherry-pick T2,
  `ZCODE_VENDORED_REV` → 3c5b2276, `ZCODE_MANUAL_CLAIM_CLIENT_VERSION` → "3.16.2", ui-patches di-rework
  (rujukan: `git show fa66ed9 -- packages/web/ui-patches`, yang sudah terverifikasi apply bersih di 3c5b2276).
  Bangun web dist seperti `release.yml`. e2e instance terpisah dengan salinan `~/.zcode` produksi (termasuk tasks-index.sqlite):
  sidebar Projects + Tasks tampil (task lama muncul), buat task baru di project, task groups (buat grup, pindah task),
  tanpa "Unknown channel: project|remote-projects|task-groups"; mobile 390px: drawer sidebar + Enter=newline.
  Laporkan perubahan skema tasks-index (versi sebelum/sesudah, tabel baru) dan apakah v0.5.20 masih bisa membaca DB
  yang sudah dimigrasi (penting untuk rollback).
- **S3. Rilis (leader).** Reset `main` ke `port-3.16`, hapus tag/rilis v0.5.21, bump 0.5.22, tag, CI hijau, backup `~/.zcode`
  + instalasi, upgrade VM hanya dengan approval pemilik.

## Aturan eksekutor
- Uji secukupnya (aturan workspace 2026-10-20): uji paket/fitur yang tersentuh + smoke; e2e web penuh sekali per PR (S1, S2).
- Tidak merge, tidak push `main`, tidak force-push, tidak menyentuh `zh-web.service`/port 4180, tidak memakai `pkill -f` dengan
  pola cmdline (pernah membunuh produksi): hentikan instance uji lewat PID dari `ss -tlnp`.
- Salinan kredensial untuk uji dihapus setelah selesai. Jangan mencetak isi credentials.json/provider_config.json.
- Konflik yang meragukan (patch zh vs perubahan upstream yang bertabrakan secara makna): tanyakan ke leader lewat send_message.
