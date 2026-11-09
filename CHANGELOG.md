# Changelog

Semua perubahan penting dicatat di sini. Format mengikuti Keep a Changelog, versi mengikuti SemVer.

## [Unreleased]

### Added
- M4 (FR-8): konfirmasi perubahan mengantrekan usulan suntingan per salinan (`kind: 'propose'` di antrean `extract`), idempoten per (perubahan, salinan). Nilai ditukar secara deterministik; LLM `rewrite_sentence` hanya dipakai bila penukaran gagal. Setiap kalimat baru divalidasi: nilai baru ada, nilai lama hilang, kata lain dan negasi tidak berubah.
- Penggantian teks di format storage tanpa parser (`core/storageEdit.ts`): hanya node teks berisi nilai yang ditulis ulang, markup dan entitas tetap identik byte demi byte. Kalimat yang melintasi markup, ada di CDATA/parameter makro/atribut/komentar, nilai ganda di kalimat, atau kalimat ganda di halaman → `needs_manual`.
- Resolver `listProposalsForPage`, `approveProposal` (opsional kalimat sendiri), `rejectProposal`, `markNotSameFact` (salinan → ignored), `approveAll` (satu versi), `listRollout` (dengan `hiddenCount`). Penerapan memakai izin user (`asUser`), cek izin edit, pesan versi "Updated by Ripple from <judul sumber>"; versi halaman berubah → `stale` dan diusulkan ulang. Status `proposed/approved/applied/rejected/stale/needs_manual/failed` beserta audit `proposal.*`. Byline menyertakan `pendingProposals` dan panel usulan minimal.
- Migrasi `v023_create_proposals`, `v024_proposals_change_copy_unique`.
- M3 (FR-7): menyimpan halaman sumber memicu deteksi perubahan (trigger `avi:confluence:updated:page` → job diff di antrean `extract`); halaman non-sumber, event ganda per versi, dan versi berpesan "Updated by Ripple" diabaikan. Ekstraksi ulang memakai aturan kutipan verbatim M1; fakta terkonfirmasi yang nilainya berubah menjadi satu perubahan tertunda per sumber (diganti secara deterministik oleh versi berikutnya), fakta baru masuk sebagai proposed, fakta yang hilang hanya dicatat.
- Dampak perubahan dari salinan pemindaian terakhir: salinan in sync (nilai lama) dan drifted ikut dipropagasi, kecuali yang sudah menyebut nilai baru; unsure dan historical hanya dihitung.
- Resolver `getPendingChange`, `confirmChange`, `dismissChange`: ringkasan nilai lama → baru, halaman salinan dengan owner (REST v2 `ownerId`/`authorId` + `users-bulk`), tim per space via Teamwork Graph (sumber `teamwork_graph`/`none`), tenggat default 5 hari kerja; konfirmasi/tolak hanya untuk editor sumber, dengan audit. Byline menyertakan flag `pendingChange` dan panel perubahan minimal.
- Sinonim CQL stabil: dibuat LLM sekali per fakta, disimpan (`facts.search_terms`), dipakai ulang di scan berikutnya, dibuat ulang hanya bila subjek/atribut/kondisi berubah; log ringkasan scan memuat `synonymsCached`.
- Tabel Forge SQL `changes` dan `page_events`, kolom `facts.search_terms` dan `scan_jobs.synonyms_cached` (migrasi v017–v020); melepas status sumber juga menghapus perubahannya.
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
- Panel usulan suntingan (M4) di halaman salinan dipoles: "Ripple suggests an update" dengan sumber (link), nilai lama → baru, diff kalimat (nilai lama dicoret, nilai baru disorot), Approve / Edit (textarea dengan validasi ramah sebelum dikirim, error backend ditampilkan) / Reject / Not the same fact, Approve all bila lebih dari satu, catatan "Ripple will save a new page version as you, labelled Updated by Ripple", hasil per usulan (Updated + versi + Reload page, needs manual + Copy new sentence, stale, failed per kode error, declined), tombol nonaktif selama proses, fokus pindah ke hasil, dan pengumuman aria-live.
- Tab Rollout di halaman sumber (setelah perubahan dikonfirmasi dari browser ini): jumlah salinan yang sudah diperbarui dengan progress bar, jumlah per status, daftar halaman dengan status dan alasan masalah, catatan halaman yang tak bisa dilihat; di-poll selama masih ada usulan terbuka.
- Konfirmasi perubahan sumber (M3) dipoles untuk demo: kartu menonjol di atas byline saat ada perubahan, berisi fakta yang berubah (nilai lama dicoret → nilai baru, kutipan kalimat baru), ringkasan "N copies affected across N pages owned by N people", daftar per space → tim (badge "via Teamwork Graph", atau "No team linked") → halaman + owner, salinan yang tidak ikut (unsure, halaman yang tak bisa dibuka, sudah bernilai baru, historis), pemilih tenggat hari kerja dengan tanggal jatuh tempo, tombol "Send update proposals" dan "Not a real change" (dengan konfirmasi), serta status loading/error/sukses ("Confirmed. Update proposals will be prepared"). Tombol "Open larger view" membuka review yang sama di Forge modal (resource byline yang sama, tanpa perubahan manifest); setelah keputusan, panel sumber dimuat ulang.
- Tab Copies dipoles untuk demo M2: tab Facts | Copies dengan pola ARIA tabs (panah kiri/kanan), ringkasan "N copies · M out of date", filter per status dengan jumlah, progres scan dua tahap (bar + langkah, polling, macet → "Resume search"), error dengan "Try again", tombol Rescan, dan empty state "Confirm facts to scan for copies" dengan tombol ke tab Facts. Kartu salinan menampilkan judul halaman (link tab baru), space, fakta terkait, nilai di salinan berdampingan dengan nilai sumber, kutipan verbatim, dan status; salinan out of date paling atas. Daftar per filter menampilkan loading sampai respons pertama (tanpa flash "No copies"), plus catatan "N copies are in pages you can't view".
- Panel sumber resmi di byline dipoles untuk demo M1: ajakan "Mark as source of truth" dengan penjelasan, progres ekstraksi (bar + waktu berjalan, menghormati reduced motion), error dengan tombol "Try again", ringkasan jumlah fakta per status, kartu fakta (jenis, status, subjek/atribut, nilai, kondisi, nilai lama, kutipan verbatim dengan versi halaman) dengan Confirm/Edit/Reject per fakta, label "Confirming…/Saving…", umpan balik yang diumumkan pembaca layar, fokus terjaga, dan konfirmasi sebelum Unmark.
- Byline tidak lagi menampilkan detail database saat sudah siap dan tidak mengulang daftar tim space (tim tetap tampil di baris Owner).
- Byline hanya menampilkan "Ripple is ready" bila database siap; saat setup atau cek gagal tampil status yang jelas.
- Permintaan ke `claude-sonnet-5` tidak lagi mengirim `temperature` (parameter ini ditolak model tersebut).
- Jumlah salinan per status di tab Copies hanya menghitung halaman yang boleh dibuka pengguna (NFR-3); salinan di halaman lain tetap hanya satu total ("N copies are in pages you can't view").
- Penilaian salinan dibatasi 2 panggilan LLM paralel per halaman dan maks. 300 panggilan per scan; bila batas tercapai scan selesai sebagai `partial` dan salinan dari scan sebelumnya tidak dihapus. Status scan memuat `pagesSkipped` dan `partial` (migrasi v010–v016).
- Halaman arsip/draft tidak lagi menjadi kandidat salinan. Pengecualian space lewat pengaturan belum ada.

### Fixed
- Aturan perubahan M3 diperketat setelah review:
  - Angka dibandingkan sesuai urutan dan posisinya di kalimat.
  - Kata lain di sekitar angka ("15 January" → "15 February"), negasi yang ditambah atau dihapus ("required" → "not required"), dan satuan yang hanya ada di satu sisi ("60" → "60 days") dihitung sebagai perubahan.
  - Pemulihan otomatis hanya membatalkan konfirmasi yang lolos aturan wording-only yang ketat ini. Kegagalannya dicatat sebagai warning dan tidak menghentikan diff.
- Fakta proposed hanya dihapus sebagai duplikat bila nilainya sama, atau kondisinya sama dengan kata subject/attribute yang mirip. Fakta saudara di kalimat yang sama (domestik/internasional) tidak ikut terhapus.
- Tim space yang gagal dibaca dari Teamwork Graph sekarang berstatus `unknown`:
  - modal menampilkan "Team unavailable, try again", bukan "No team linked";
  - saat confirm, tim dibaca ulang sekali; bila tetap gagal, routing mencatatnya sebagai `unknown` tanpa id tim.
- Byline menampilkan pesan generik, bukan teks error Teamwork Graph. Judul halaman di prompt diff juga menetralkan penanda `KNOWN`.
- Diff M3 tidak lagi melaporkan perubahan palsu karena wording nilai dari LLM ("2000" USD → "Trips over $2,000", "economy class" → "economy class for flights under 6 hours"):
  - Fakta confirmed hanya berubah bila token nilai di kalimat kutipan berubah. Tidak dianggap berubah bila kalimatnya sama (whitespace/tanda baca diabaikan), angka dan satuan di kalimat sama, atau angka nilainya sama.
  - Fakta tanpa angka dibandingkan lewat kalimat. Rentang, angka tambahan, satuan lain, dan tanggal tetap dihitung sebagai perubahan.
  - Konfirmasi lama yang hanya mengubah wording dipulihkan otomatis pada diff berikutnya:
    - nilai lama kembali;
    - salinan yang di-drift oleh konfirmasi itu kembali in sync;
    - baris change dan audit tetap disimpan, ditambah audit `change.fact_reverted`.
- Diff M3 tidak lagi bergantung pada wording LLM:
  - Fakta tersimpan (confirmed dan proposed yang bukan duplikat) dikirim ke prompt ekstraksi, dan model mengisi `existing_fact_id`. Id hanya diterima bila ditawarkan untuk source ini dan dipakai sekali.
  - Fallback deterministik: kalimat sama setelah angka diabaikan (Jaccard kata ≥ 0,75; confirmed didahulukan, lalu nilai sama, lalu kemiripan wording), kemudian identity key.
  - Fakta yang cocok tetap memakai key dan wording lama, sehingga perubahan nilai menjadi change dan tidak muncul sebagai fakta proposed baru.
  - Fakta proposed duplikat dari pembacaan sebelumnya yang salah cocok dihapus pada diff berikutnya.
  - Log diff memuat `matchedById`, `matchedByQuote`, `matchedByKey`, `duplicatesRemoved`.
- Deteksi perubahan M3 diperkeras setelah review:
  - Job diff menyimpan perubahan dulu, baru menandai versi halaman sudah dibaca, sehingga retry setelah gagal tidak kehilangan perubahan.
  - `confirmChange`/`dismissChange` wajib membawa `version` dan status hanya berubah untuk versi itu. Bila versi lebih baru sudah menggantikannya, muncul error "Review it again" dan panel memuat ulang.
  - Konfirmasi ulang untuk versi yang sama aman diulang: menyelesaikan update fakta dan salinan dari fakta yang sudah bernilai baru.
  - Routing konfirmasi mencakup semua salinan terdampak, termasuk halaman yang tidak bisa dibuka pengonfirmasi.
  - Claim event dilepas bila enqueue gagal.
  - Perubahan bentuk nilai (rentang, angka tambahan, satuan lain) dihitung sebagai perubahan.
  - Salinan in sync tanpa nilai yang bisa dibandingkan masuk "needs check" (`needsCheck`, tidak dipropagasi otomatis).
  - Hasil sinonim kosong tidak di-cache.
- Hemat LLM:
  - Versi baru dengan teks sama (hash `sources.text_hash`) tidak memanggil LLM.
  - Nilai yang di-dismiss (`change_dismissals`) tidak dimunculkan lagi; nilai lain tetap memunculkan perubahan.
  - `page_events` dibatasi 30 hari dan dibersihkan saat unmark (migrasi v021–v022).
- Aturan fakta saudara dan kondisi lebih ketat: `sibling_fact` hanya membuang mention bila sumber memang punya fakta saudara (selain itu Tidak pasti, drift tidak hilang); jawaban "no" menjadi Tidak pasti hanya dengan `reason_code` `different_condition`; kartu Tidak pasti untuk kondisi yang tidak ada di sumber (mis. pelatihan) dipasang pada fakta pilihan keluarga saudara (tanpa kondisi dulu, lalu urutan di sumber) menggantikan heuristik nilai terdekat, satu kartu per kalimat per halaman (kutipan yang dipotong berbeda tetap dianggap satu kalimat); enum `reason_code` diurutkan netral.
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
