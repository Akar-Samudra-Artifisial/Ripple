# Changelog

Semua perubahan penting dicatat di sini. Format mengikuti Keep a Changelog, versi mengikuti SemVer.

## [Unreleased]

### Added
- Status sumber memuat `truncated` bila teks halaman melebihi batas baca LLM (kolom `sources.text_truncated`, migrasi v006).
- M1 (FR-1..3): tombol "Mark as source of truth" di byline (hanya untuk pengguna dengan izin edit halaman, dicek di server), lepas status sumber, status ekstraksi yang di-poll, dan daftar fakta dengan kutipan serta aksi Confirm/Edit/Reject.
- Ekstraksi fakta di antrean `extract` lewat Forge LLM: maksimal 30 fakta per halaman, hanya jenis yang didukung, kutipan wajib ditemukan persis di teks halaman (fakta dengan kutipan palsu dibuang), dedup kunci identitas subjek + atribut + kondisi; ekstraksi ulang mempertahankan fakta yang sudah dikonfirmasi/diedit dan tidak menghidupkan lagi fakta yang ditolak.
- Tabel Forge SQL `sources` dan `facts` (migrasi v003, v004) serta baris audit untuk mark/unmark, ekstraksi, dan tiap review fakta.
- M0: app Ripple ditulis ulang dalam TypeScript dengan Custom UI (esbuild), test vitest, dan `forge lint` sebagai lint.
- Byline "Ripple" di halaman Confluence menampilkan "Ripple is ready", progres setup database, dan tim pemilik space dari Teamwork Graph (`atlassianTeamsBySpace`).
- Database Forge SQL dengan migrasi append-only lewat antrean `schema-migrate` (tabel `settings` dan `audit`), dijalankan otomatis saat install/upgrade.
- Wrapper Forge LLM (tool call, model `claude-sonnet-5`) untuk ekstraksi dan penilaian di milestone berikutnya.
- Manifest final MVP: trigger perubahan halaman, consumer extract/search/judge/demo, settings global Confluence, panel issue Jira, agen Rovo Fact Keeper dengan lima action, dan scheduled trigger mingguan; yang belum dibangun membalas "not implemented" dan mencatat log.

- Fallback otomatis ke model `claude-sonnet-4-6` (dengan log) bila platform menolak `claude-sonnet-5`.
- `docs/PRIVACY.md`: kegunaan tiap scope; `write:confluence-space` hanya untuk tombol Load demo data.

- Byline menampilkan "Owner: <nama> · Team: <tim> (via Teamwork Graph)": owner dari Confluence REST v2 `ownerId`, nama lewat `users-bulk` (scope baru `read:user:confluence`).

### Changed
- Panel sumber resmi di byline dipoles untuk demo M1: ajakan "Mark as source of truth" dengan penjelasan, progres ekstraksi (bar + waktu berjalan, menghormati reduced motion), error dengan tombol "Try again", ringkasan jumlah fakta per status, kartu fakta (jenis, status, subjek/atribut, nilai, kondisi, nilai lama, kutipan verbatim dengan versi halaman) dengan Confirm/Edit/Reject per fakta, label "Confirming…/Saving…", umpan balik yang diumumkan pembaca layar, fokus terjaga, dan konfirmasi sebelum Unmark.
- Byline tidak lagi menampilkan detail database saat sudah siap dan tidak mengulang daftar tim space (tim tetap tampil di baris Owner).
- Byline hanya menampilkan "Ripple is ready" bila database siap; saat setup atau cek gagal tampil status yang jelas.
- Permintaan ke `claude-sonnet-5` tidak lagi mengirim `temperature` (parameter ini ditolak model tersebut).

### Fixed
- Ekstraksi ulang tidak lagi menimpa review yang masuk di tengah ekstraksi dan tidak pernah menghidupkan lagi fakta yang ditolak (UPDATE dengan guard status).
- Halaman yang di-unmark saat LLM berjalan tidak meninggalkan fakta yatim; fakta yang terlanjur ditulis dibersihkan.
- Gagal mengantrekan ekstraksi kini menandai sumber sebagai error (bisa "Try again") alih-alih tertahan di `extracting`.
- Confluence 429/5xx saat membaca halaman di-retry lewat antrean dengan backoff, lalu ditandai gagal.
- Nilai fakta wajib berasal dari kutipannya: fakta number wajib berisi angka yang tertulis di kutipan; jenis lain wajib memuat semua kata nilai (≥3 huruf) di kutipan.
- Kunci identitas lebih dari 400 karakter ditolak (ekstraksi dan edit), bukan gagal di database.
- Mengedit subjek/atribut/kondisi tidak lagi memunculkan duplikat saat ekstraksi ulang (kolom `origin_key`, migrasi v005).

### Security
- Log menyamarkan account id berprefiks 5–7 digit (sebelumnya hanya 6 digit).
- Prompt ekstraksi: judul halaman dijadikan satu baris dan penanda `<<<PAGE`/`PAGE>>>` di judul/isi dinetralkan.

### Removed
- Scope `write:confluence-content` dan `read:confluence-user` (tidak dibutuhkan; suntingan lewat REST v2, nama owner dari Teamwork Graph).
- Prototipe UI Kit "Ripple owners" beserta diagnostik varian query owners di layar (logika Teamwork Graph dipindah ke adapter baru).
