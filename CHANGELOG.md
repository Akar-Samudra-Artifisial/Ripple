# Changelog

Semua perubahan penting dicatat di sini. Format mengikuti Keep a Changelog, versi mengikuti SemVer.

## [Unreleased]

### Added
- M2 (FR-4..6): tab "Copies" di panel sumber dengan tombol "Find copies"/"Rescan", progres pemindaian yang di-poll, ringkasan jumlah drifted/unsure/in sync, filter status, dan kartu salinan (halaman, nilai yang tertulis vs nilai sumber, kutipan verbatim, alasan).
- Pemindaian salinan di antrean `search` dan `judge`: CQL per fakta terkonfirmasi (maks. 200 kandidat per fakta, halaman sumber dan label `ripple-ignore` dikecualikan, sinonim subjek dari LLM), hanya potongan teks yang menyebut fakta yang dinilai LLM, kutipan wajib ditemukan persis di halaman salinan, dan nilai dinormalisasi sebelum dibandingkan ("$60", "60 USD", "sixty dollars").
- Status salinan Sesuai/Menyimpang/Tidak pasti/Historis: penyebutan historis ("previously", "until 2025", changelog) dan fakta dengan kondisi lain (mis. per diem training $40) tidak pernah dinilai menyimpang; salinan yang diabaikan/diperbarui tetap dipertahankan saat rescan.
- Pemindaian bisa dilanjutkan dari batch terakhir (kursor fakta dan kandidat tertunda di Forge SQL), retry otomatis saat rate limit LLM/SQL atau Confluence 429/5xx, dan pemindaian macet >15 menit dilanjutkan lewat tombol "Resume scan".
- Daftar salinan hanya menampilkan halaman yang boleh dibuka pengguna (dicek sebagai pengguna); sisanya hanya dihitung.
- Tabel Forge SQL `scan_jobs`, `scan_hits`, dan `copies` (migrasi v007–v009); melepas status sumber juga menghapus salinan dan pemindaiannya.
- Catatan kecil di panel sumber bila halaman terlalu panjang dan hanya bagian awalnya yang dibaca.
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
- Tab Copies dipoles untuk demo M2: tab Facts | Copies dengan pola ARIA tabs (panah kiri/kanan), ringkasan "N copies · M out of date", filter per status dengan jumlah, progres scan dua tahap (bar + langkah, polling, macet → "Resume search"), error dengan "Try again", tombol Rescan, dan empty state "Confirm facts to scan for copies" dengan tombol ke tab Facts. Kartu salinan menampilkan judul halaman (link tab baru), space, fakta terkait, nilai di salinan berdampingan dengan nilai sumber, kutipan verbatim, dan status; salinan out of date paling atas. Daftar per filter menampilkan loading sampai respons pertama (tanpa flash "No copies"), plus catatan "N copies are in pages you can't view".
- Panel sumber resmi di byline dipoles untuk demo M1: ajakan "Mark as source of truth" dengan penjelasan, progres ekstraksi (bar + waktu berjalan, menghormati reduced motion), error dengan tombol "Try again", ringkasan jumlah fakta per status, kartu fakta (jenis, status, subjek/atribut, nilai, kondisi, nilai lama, kutipan verbatim dengan versi halaman) dengan Confirm/Edit/Reject per fakta, label "Confirming…/Saving…", umpan balik yang diumumkan pembaca layar, fokus terjaga, dan konfirmasi sebelum Unmark.
- Byline tidak lagi menampilkan detail database saat sudah siap dan tidak mengulang daftar tim space (tim tetap tampil di baris Owner).
- Byline hanya menampilkan "Ripple is ready" bila database siap; saat setup atau cek gagal tampil status yang jelas.
- Permintaan ke `claude-sonnet-5` tidak lagi mengirim `temperature` (parameter ini ditolak model tersebut).
- Jumlah salinan per status di tab Copies hanya menghitung halaman yang boleh dibuka pengguna (NFR-3); salinan di halaman lain tetap hanya satu total ("N copies are in pages you can't view").
- Penilaian salinan dibatasi 2 panggilan LLM paralel per halaman dan maks. 300 panggilan per scan; bila batas tercapai scan selesai sebagai `partial` dan salinan dari scan sebelumnya tidak dihapus. Status scan memuat `pagesSkipped` dan `partial` (migrasi v010–v016).
- Halaman arsip/draft tidak lagi menjadi kandidat salinan. Pengecualian space lewat pengaturan belum ada.

### Fixed
- Salinan dengan nilai sama kembali In sync walaupun judge ragu (`reason_code` value_matches, nilai sama, kondisi tidak berbeda), bukan "not sure this is the same fact".
- Satu kalimat tidak lagi menghasilkan kartu Tidak pasti untuk fakta saudara (atribut sama, kondisi lain yang juga ada di sumber, mis. per diem domestik vs internasional): kode baru `sibling_fact` di prompt judge, kondisi yang cocok dengan fakta saudara diabaikan, dan per kutipan di halaman yang sama hanya satu kartu per kelompok saudara (yang cocok/menyimpang menang; bila semuanya Tidak pasti, fakta dengan nilai resmi terdekat). Kondisi yang tidak ada di sumber (mis. pelatihan) tetap Tidak pasti.
- Log `ripple judge page` mengisi `reasonCode` di setiap fakta (`no_mention` bila tidak ada mention yang dinilai).
- Penilaian drift lebih tepat: prompt judge kini memuat contoh few-shot fiktif (nilai beda = fakta sama/drift, kondisi beda = unsure, topik lain = bukan fakta sama, kalimat "raised from" = historis) dan tidak lagi menjawab "no" hanya karena nilai berbeda. Judge mengisi `reason_code` (enum tetap; nilai lain menjadi `other`). Jawaban "no" dengan `value_differs` tetap dinilai menyimpang, dan `different_condition` selalu tersimpan sebagai Tidak pasti. Log `ripple judge page` menambah `reasonCode` saja, tanpa teks bebas dari LLM.
- Salinan yang menyimpang (nilai berbeda) kini ditemukan berdasarkan kata subjek/sinonim tanpa nilai: tiap subjek dan sinonim menjadi kelompok kata (berpasangan bila tiga kata, mis. "Expense claim deadline" → expense+claim, expense+deadline, claim+deadline), batas 200 kandidat per fakta tetap.
- Salinan dengan kondisi lain (mis. per diem pelatihan eksternal $40) kini Tidak pasti walaupun judge menjawab "bukan fakta yang sama", bukan hilang diam-diam.
- Hitungan "N copies" dan filter "All" kini sama dengan kartu di bawah All: hanya In sync, Out of date, Unsure, Updated; Historical dan Ignored punya filter sendiri.
- Setiap halaman yang dinilai menulis log `ripple judge page` (pageId, factId, hasil per fakta: status / no_chunk / no_match / not_same_fact / example / value_not_comparable, alasan drop), tanpa isi halaman.
- Tahap penilaian salinan tidak lagi gagal dengan "Unknown SQL execution error": daftar halaman yang menunggu dinilai memakai `LIMIT` inline, karena Forge SQL (TiDB) menolak `LIMIT ?` (ER_WRONG_ARGUMENTS).
- Pencarian salinan kini juga mencari kata khas subjek (mis. "diem" untuk "Travel per diem", "flight" + "class") dan angka ≥4 digit dalam bentuk "2,000", sehingga salinan yang tidak memuat frasa subjek persis tetap ditemukan tanpa bergantung pada sinonim LLM.
- Log error SQL kini memuat nama operasi (mis. `SELECT scan_hits`) dan kode error MySQL dengan pesan yang disamarkan; setiap scan menulis satu log ringkasan (kandidat per fakta, halaman dinilai/dilewati, panggilan LLM, partial, hitungan status).
- Setup database tidak lagi berhenti di 14/16: migrasi v015 (unique index satu scan aktif per sumber) memakai `CREATE UNIQUE INDEX IF NOT EXISTS ... ON ...`, karena Forge SQL (TiDB) menolak `ADD UNIQUE INDEX IF NOT EXISTS` (ER_PARSE_ERROR 1064).
- Salinan yang menyebut kondisi sendiri (mis. "training $40") untuk fakta tanpa kondisi kini Tidak pasti, bukan Menyimpang.
- Nilai dengan angka tambahan ("$60 per day (max 3 days)"), tanggal beda format, dan satuan beda (2 weeks = 14 days; USD vs EUR → tidak dinilai) tidak lagi ditandai menyimpang secara keliru.
- Kutipan diperiksa ulang: nilai lama di "from X to Y" jadi Historis, nilai setelah "previously"/"was" jadi Tidak pasti, dan kondisi yang tidak ada di teks jadi Tidak pasti. Istilah pencarian tanpa huruf/angka dibuang.
- Halaman yang tidak bisa dibaca app (mis. 403) atau ditolak LLM dilewati dan dihitung, bukan menggagalkan seluruh scan; error LLM 5xx di-retry dan retry melanjutkan dari potongan teks yang belum dinilai.
- Scan memakai daftar fakta saat scan dimulai, berhenti dan membersihkan diri bila sumber di-unmark di tengah jalan, dan dua klik "Find copies" bersamaan hanya membuat satu scan (unique key di database).
- Daftar salinan memfilter visibilitas sebelum batas 500 baris, dan hitungan/daftar hanya memuat salinan dari fakta yang masih terkonfirmasi.
- Panel sumber resmi tidak lagi sesaat menampilkan "No facts were found" setelah reload: status dan daftar fakta tampil bersamaan, dengan "Loading facts…" (skeleton) sampai daftar pertama datang dan error + Retry bila gagal.
- Byline tidak lagi tertahan di "setting up" sampai popup dibuka ulang: selama setup database, status di-poll tiap 3 detik dengan progres langkah, berhenti saat siap/error/popup ditutup, dan setelah 3 menit menampilkan pesan + tombol Retry.
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
