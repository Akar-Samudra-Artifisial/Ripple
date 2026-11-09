# Changelog

Semua perubahan penting dicatat di sini. Format mengikuti Keep a Changelog, versi mengikuti SemVer.

## [Unreleased]

### Added
- M0: app Ripple ditulis ulang dalam TypeScript dengan Custom UI (esbuild), test vitest, dan `forge lint` sebagai lint.
- Byline "Ripple" di halaman Confluence menampilkan "Ripple is ready", progres setup database, dan tim pemilik space dari Teamwork Graph (`atlassianTeamsBySpace`).
- Database Forge SQL dengan migrasi append-only lewat antrean `schema-migrate` (tabel `settings` dan `audit`), dijalankan otomatis saat install/upgrade.
- Wrapper Forge LLM (tool call, model `claude-sonnet-5`) untuk ekstraksi dan penilaian di milestone berikutnya.
- Manifest final MVP: trigger perubahan halaman, consumer extract/search/judge/demo, settings global Confluence, panel issue Jira, agen Rovo Fact Keeper dengan lima action, dan scheduled trigger mingguan; yang belum dibangun membalas "not implemented" dan mencatat log.

- Fallback otomatis ke model `claude-sonnet-4-6` (dengan log) bila platform menolak `claude-sonnet-5`.
- `docs/PRIVACY.md`: kegunaan tiap scope; `write:confluence-space` hanya untuk tombol Load demo data.

### Changed
- Byline hanya menampilkan "Ripple is ready" bila database siap; saat setup atau cek gagal tampil status yang jelas.
- Permintaan ke `claude-sonnet-5` tidak lagi mengirim `temperature` (parameter ini ditolak model tersebut).

### Security
- Log menyamarkan account id berprefiks 5–7 digit (sebelumnya hanya 6 digit).

### Removed
- Scope `write:confluence-content` dan `read:confluence-user` (tidak dibutuhkan; suntingan lewat REST v2, nama owner dari Teamwork Graph).
- Prototipe UI Kit "Ripple owners" beserta diagnostik varian query owners di layar (logika Teamwork Graph dipindah ke adapter baru).
