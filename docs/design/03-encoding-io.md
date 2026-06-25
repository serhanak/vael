# Encoding, satir sonu ve dosya I/O spesifikasyonu

# Spesifikasyon: Encoding & I/O — "Notepad++ BOM Öfkesini Çözmek"

> Haziran 2026. Bu doküman, kilitlenen mimariye (§3 IPC, §4 capabilities, §5.1 state) uyumlu olarak `core/encoding.rs`, `commands/file.rs`, `commands/watch.rs` ve frontend `services/fs.ts` + `status-bar.ts` davranışını byte seviyesinde tanımlar.

## 0. Doğrulanmış Crate Sürümleri (Haziran 2026)

| Crate | Sürüm | Rol |
|---|---|---|
| `encoding_rs` | **0.8.35** | Tüm decode/encode (UTF-8/16, Windows-1254 vb.). WHATWG Encoding Standard. |
| `chardetng` | **1.0.0** (2026-03-30) | Legacy (BOM'suz) içerik için charset tahmini. `EncodingDetector`. |
| `charset-normalizer-rs` | 1.0.x | *Opsiyonel* ikinci görüş / düşük-güven durumunda. Varsayılan değil. |
| `notify` | **8.x** | FS izleme. |
| `notify-debouncer-full` | 0.5.x | Debounce + rename eşleştirme (notify üstünde). |
| `memmap2` | 0.9.x | Büyük dosya mmap (chunked okuma). |
| `tempfile` | 3.x | Atomik kaydet (aynı-dizin temp). |

**Karar:** Birincil dedektör `chardetng` (encoding_rs ile aynı yazar/hsivonen, encoding_rs `Encoding` tipini doğrudan döndürür → sıfır eşleme sürtünmesi, küçük binary). `charset-normalizer-rs` yalnızca düşük-güven Türkçe/legacy ayrımında ikinci görüş olarak çağrılabilen opsiyonel feature.

---

## 1. Notepad++ Karşı-Örneği (Ne YAPMAYACAĞIZ)

Üç ayrı NPP davranışını açıkça tersine örnek alıyoruz:

| NPP hatası/davranışı | Kaynak | Bizim kuralımız |
|---|---|---|
| **v8.8.3 ters-çevrilen menü:** "Convert to UTF-8" → ANSI üretiyor; "Convert to UTF-8-BOM" → BOM'suz UTF-8 üretiyor (build 2025-07-09, #16814) | regresyon | Encoding adı **byte çıktısını deterministik** belirler. "UTF-8" = BOM'suz, "UTF-8-BOM" = `EF BB BF` ön ek. Tek bir tablo, tek kod yolu, snapshot testle kilitli. İsim↔byte eşlemesi asla ters çevrilemez. |
| **BOM-enjeksiyon:** yeni/ANSI dosyayı UTF-8'e çevirince istenmeden BOM ekleme; "UTF-8 default save" ile sessizce BOM yazma | NPP geçmiş davranışı | **Varsayılan kaydet = BOM'suz UTF-8.** BOM yalnızca (a) kullanıcı açıkça "UTF-8-BOM" seçtiyse veya (b) dosya zaten BOM'lu açıldıysa korunur. Hiçbir koşulda otomatik BOM eklenmez. |
| **Sessiz yeniden-yazma:** açışta tahmin edilen encoding'i kaydetta değiştirme; "ANSI'yi UTF-8 say ama UTF-8-BOM kaydet" | NPP topluluk şikâyetleri | **Sessiz dönüşüm YOK.** Kaydet, açılıştaki encoding+BOM+EOL'u **birebir korur**. Dönüşüm yalnızca kullanıcının status-bar'dan açık eylemiyle olur ve dirty+uyarı tetikler. |

**Tek cümlelik ilke:** *Encoding/BOM/EOL kullanıcının verisidir; uygulama onu görünür kılar ve yalnızca açık komutla değiştirir — asla tahmin edip sessizce yeniden yazmaz.*

---

## 2. Desteklenen Encoding Seti

| Etiket (UI + `meta.encoding`) | encoding_rs `Encoding` | BOM | Not |
|---|---|---|---|
| `UTF-8` | `UTF_8` | yok | **Varsayılan kaydet** |
| `UTF-8-BOM` | `UTF_8` + `EF BB BF` | 3 byte | İsim ayrı; byte ayrı |
| `UTF-16 LE` | `UTF_16LE` | `FF FE` | |
| `UTF-16 BE` | `UTF_16BE` | `FE FF` | |
| `Windows-1254` | `WINDOWS_1254` | yok | **Türkçe legacy (öncelik)** |
| `Windows-1252` | `WINDOWS_1252` | yok | Batı Avrupa |
| `ISO-8859-9` | `ISO_8859_9` | yok | Türkçe ISO |
| `Windows-1250 / 1251 / 1256` | ilgili | yok | Orta Avrupa/Kiril/Arapça |
| `Shift_JIS`, `GBK`, `EUC-KR`, `Big5` | ilgili | yok | encoding_rs tam set |
| `UTF-32 LE/BE` | — | `FF FE 00 00` / `00 00 FE FF` | **Sadece tespit + uyarı**; encoding_rs UTF-32 encode etmez → bu encoding'le *kaydet* devre dışı, kullanıcı UTF-8'e dönüştürmeye yönlendirilir |

> encoding_rs WHATWG kümesini kapsar (UTF-32 hariç). "Yerel kod sayfası" = sistem ANSI (Windows-TR'de 1254); `chardetng` Türkçe metinde 1254/ISO-8859-9 ayrımını yapar.

---

## 3. BOM Tespiti / Soyma (`core/encoding.rs`)

İlk 4 byte'a bakılır; **BOM içerik değildir, görüntüye/düzenlemeye dahil edilmez** ve `has_bom=true` olarak meta'da işaretlenir.

```rust
pub enum Bom { None, Utf8, Utf16Le, Utf16Be, Utf32Le, Utf32Be }

/// (tespit edilen BOM, BOM'dan sonraki byte ofseti) döner.
pub fn sniff_bom(bytes: &[u8]) -> (Bom, usize) {
    match bytes {
        // UTF-32 BOM'ları UTF-16 LE'den ÖNCE kontrol edilmeli (FF FE 00 00 çakışması)
        [0xFF, 0xFE, 0x00, 0x00, ..] => (Bom::Utf32Le, 4),
        [0x00, 0x00, 0xFE, 0xFF, ..] => (Bom::Utf32Be, 4),
        [0xEF, 0xBB, 0xBF, ..]       => (Bom::Utf8, 3),
        [0xFF, 0xFE, ..]             => (Bom::Utf16Le, 2),
        [0xFE, 0xFF, ..]             => (Bom::Utf16Be, 2),
        _                            => (Bom::None, 0),
    }
}
```

**Kritik sıra:** `FF FE 00 00` (UTF-32 LE) mutlaka `FF FE` (UTF-16 LE) öncesinde eşlenmeli; yoksa UTF-32 LE dosya yanlışlıkla UTF-16 LE + `00 00` (NUL) olarak görünür. NPP dahil birçok editör bu tuzağa düşer.

BOM bulunduğunda decode için kalan slice (`&bytes[offset..]`) kullanılır; **encoding doğrudan BOM'dan belirlenir, tahmin atlanır.**

---

## 4. Tespit Hattı (Açış Akışı)

```rust
// core/encoding.rs
pub struct Detected {
    pub encoding: &'static Encoding, // encoding_rs
    pub label: String,               // UI etiketi (UTF-8-BOM dahil)
    pub bom: Bom,
    pub confidence: Confidence,      // High | Medium(score) | Low
}

pub fn detect(bytes: &[u8], forced: Option<&str>) -> Detected {
    // 0) Kullanıcı zorlamışsa tahmini tamamen atla
    if let Some(label) = forced {
        return Detected::from_forced(label, sniff_bom(bytes).0);
    }
    // 1) BOM → kesin
    let (bom, off) = sniff_bom(bytes);
    match bom {
        Bom::Utf8     => return Detected::utf8_bom(),
        Bom::Utf16Le  => return Detected::utf16(true),
        Bom::Utf16Be  => return Detected::utf16(false),
        Bom::Utf32Le | Bom::Utf32Be => return Detected::utf32(bom), // read-only uyarı
        Bom::None => {}
    }
    let body = &bytes[off..];

    // 2) Geçerli UTF-8 mi? (en yaygın, hızlı tam-tarama)
    if std::str::from_utf8(body).is_ok() {
        return Detected::utf8_no_bom(Confidence::High);
    }
    // 3) chardetng — legacy tahmini (örnek için ~64 KB yeterli, ama doğruluk için tüm body taranabilir)
    let mut det = chardetng::EncodingDetector::new();
    det.feed(body, /*last=*/ true);
    let enc = det.guess(/*tld=*/ None, /*allow_utf8=*/ true);
    let conf = score_confidence(body, enc); // örn. replacement char oranı
    Detected::from_encoding(enc, bom, conf)
}
```

**Davranış kuralları:**
- BOM her zaman tahmini ezer (kesin sinyal).
- BOM yoksa **önce katı UTF-8 doğrulaması** (en sık durum, chardetng'den hızlı ve daha kesin); başarısızsa chardetng.
- chardetng `Encoding` döndürür → encoding_rs ile aynı tip, eşleme yok.
- `allow_utf8=true`: chardetng UTF-8'i de aday görür.
- Düşük güvende (çok kısa dosya / yüksek replacement oranı) UI'da **uyarı rozeti** gösterilir ("tahmin — encoding'i doğrulayın"), ama dosya yine açılır.

---

## 5. KESİN DAVRANIŞ TABLOLARI

### 5.1 AÇ (Open)

| Girdi | BOM | Tahmin | `meta.encoding` | `meta.has_bom` | Görüntü | Not |
|---|---|---|---|---|---|---|
| `EF BB BF ...` | UTF-8 BOM | atlanır | `UTF-8-BOM` | `true` | BOM soyulmuş metin | |
| Geçerli UTF-8, BOM yok | yok | UTF-8 OK | `UTF-8` | `false` | metin | High güven |
| `FF FE ...` | UTF-16 LE | atlanır | `UTF-16 LE` | `true` | metin | |
| `FE FF ...` | UTF-16 BE | atlanır | `UTF-16 BE` | `true` | metin | |
| `FF FE 00 00 ...` | UTF-32 LE | atlanır | `UTF-32 LE` | `true` | metin (read-only encoding) | Kaydet UTF-32 ile kapalı; "UTF-8'e dönüştür" önerilir |
| Türkçe legacy (ş/ğ/ı baytları), BOM yok | yok | chardetng → 1254/ISO-8859-9 | tahmin | `false` | decode'lu metin | Medium → uyarı rozeti olası |
| Geçersiz UTF-8 + düşük güven | yok | chardetng best-effort | tahmin | `false` | metin | **Uyarı rozeti**; kullanıcı "yeniden aç" yapabilir |
| Boş dosya (0 byte) | yok | — | `UTF-8` | `false` | boş | Yeni dosya gibi |

**Hiçbir açış senaryosu BOM eklemez veya encoding'i diske yazmaz.** Açış salt-okumadır.

### 5.2 KAYDET (Save)

Mutlak kural: **kaydet, dosyanın mevcut (açılıştaki veya kullanıcının açıkça değiştirdiği) `encoding` + `has_bom` + `eol` üçlüsünü birebir uygular. Yeni dosya hariç hiçbir şey "varsayılana" zorlanmaz.**

| Durum | Yazılan encoding | BOM byte'ları | EOL | Sessiz dönüşüm? |
|---|---|---|---|---|
| Mevcut dosya, değişiklik yok (sadece edit) | açılıştaki encoding | açılıştaki BOM korunur | açılıştaki EOL korunur | **Hayır** |
| Açılışta `UTF-8` (BOM'suz) | UTF-8 | **yok** | korunur | Hayır — **BOM ENJEKTE EDİLMEZ** |
| Açılışta `UTF-8-BOM` | UTF-8 | `EF BB BF` | korunur | Hayır — **BOM SOYULMAZ** |
| Açılışta `Windows-1254` | Windows-1254 | yok | korunur | Hayır — UTF-8'e *çevrilmez* |
| **Yeni (path=null) dosya** | **UTF-8 (BOM'suz)** | yok | platform varsayılanı (Win→CRLF, Unix→LF) — *ayarla değişebilir* | — |
| Kullanıcı status-bar'dan encoding değiştirdi | yeni encoding | yeni encoding'in BOM politikası | korunur | Açık eylem (sessiz değil) |
| Kayıp karakter (örn. `€` Windows-1254'te yok) | hedef encoding | — | — | **Kaydet öncesi diyalog:** "N karakter bu encoding'de temsil edilemez. Devam (kayıplı) / UTF-8'e geç / İptal" |

Kayıp-karakter tespiti: `encoding_rs` encode `Encoder` `had_unmappable` / replacement (`?` veya HTML ref) sinyalini verir; biz **sessizce `?` basmak yerine kullanıcıyı uyarırız** (NPP'nin sessiz veri kaybının tersi).

```rust
pub fn encode_for_save(text: &str, label: &str, add_bom: bool, eol: Eol)
    -> Result<Vec<u8>, SaveError>
{
    let normalized = apply_eol(text, eol);            // §6
    let enc = encoding_for_label(label)?;             // tek deterministik tablo
    if enc == UTF_8 {
        let mut out = Vec::with_capacity(normalized.len() + 3);
        if add_bom { out.extend_from_slice(&[0xEF, 0xBB, 0xBF]); } // SADECE add_bom ise
        out.extend_from_slice(normalized.as_bytes());
        return Ok(out);
    }
    // encoding_rs encode; unmappable kontrolü
    let (cow, _, had_unmappable) = enc.encode(&normalized);
    if had_unmappable {
        return Err(SaveError::LossyEncoding { encoding: label.into() });
    }
    let mut out = Vec::new();
    if matches!(enc, UTF_16LE|UTF_16BE) && add_bom { out.extend_from_slice(bom_bytes(enc)); }
    out.extend_from_slice(&cow);
    Ok(out)
}
```

`label` → `Encoding` ve `add_bom` ayrı parametreler; **isim ile BOM kararı hiçbir yerde iç içe geçmez** (NPP ters-çevirme hatasının kök nedeni). "UTF-8" vs "UTF-8-BOM" yalnızca frontend'in `add_bom` bayrağını set etmesiyle ayrışır; Rust tarafı tek `UTF_8` encoding'i kullanır.

### 5.3 ENCODING DEĞİŞTİR vs "BU ENCODING İLE YENİDEN AÇ"

İki **farklı** komut; NPP'nin karıştırdığı bu ayrımı netleştiriyoruz:

| Komut | Diskten yeniden okur? | Mevcut byte'ları yeniden yorumlar | dirty? | Kullanım |
|---|---|---|---|---|
| **Reopen with Encoding** (`reinterpret`) | Evet (orijinal byte'lar) | Yeni encoding ile **decode** | Hayır (disk değişmedi) | "Yanlış tahmin edildi, doğru tabloyla göster". 1254 sandı → ISO-8859-9 ile yeniden aç. |
| **Convert to Encoding** (`convert`) | Hayır | Mevcut metni **hedef encoding'e dönüştür** (kaydetta byte değişir) | **Evet** | "Bu dosyayı bundan sonra UTF-8 yapacağım." |
| **Set BOM on/off** | Hayır | Sadece `has_bom` bayrağını değiştirir | **Evet** | UTF-8 ↔ UTF-8-BOM. Metin aynı; sadece kaydet'te 3 byte eklenir/çıkarılır. |

```rust
#[tauri::command]
async fn reopen_with_encoding(path: String, encoding: String)
    -> Result<OpenResult, String>;   // diskten ham byte → yeni decode; meta.dirty=false

#[tauri::command]
async fn set_document_encoding(/* in-memory bayrak değişimi frontend state'inde */);
// Bu RUST'a gitmez: convert/set-bom yalnızca DocState'i (encoding,has_bom,dirty=true)
// günceller; gerçek byte değişimi save_file'da olur. → tek yazma yolu.
```

**Tasarım kararı:** `convert` ve `set-bom` *anında diske yazmaz*; yalnızca `DocState.encoding/has_bom`'u günceller ve `dirty=true` yapar. Gerçek serileştirme tek bir yerde (`save_file`) olur → ters-çevirme/çift-dönüşüm hatalarına yer yok. `reopen` ise diskten okumadır (in-memory düzenlemeleri atar → onay diyaloğu eğer dirty).

---

## 6. Satır Sonu (EOL)

```rust
pub enum Eol { Lf, Crlf, Mixed }

pub fn detect_eol(s: &str) -> Eol {
    let crlf = s.matches("\r\n").count();
    let lf = s.matches('\n').count() - crlf; // \r\n içindeki \n'leri düş
    match (crlf, lf) {
        (0, 0) => Eol::Lf,            // EOL yok → platform/ayar varsayılanı
        (_, 0) => Eol::Crlf,
        (0, _) => Eol::Lf,
        _      => Eol::Mixed,
    }
}

pub fn apply_eol(text: &str, eol: Eol) -> std::borrow::Cow<str> {
    match eol {
        Eol::Lf   => normalize(text, "\n"),
        Eol::Crlf => normalize(text, "\r\n"),
        Eol::Mixed => Cow::Borrowed(text), // KORU: dokunma (karışıksa kullanıcı görür)
    }
}
```

| Açılış EOL | Status-bar | Kaydet varsayılanı | Normalize seçeneği |
|---|---|---|---|
| Saf LF | `LF` | LF korunur | "Convert to CRLF" menüde |
| Saf CRLF | `CRLF` | CRLF korunur | "Convert to LF" |
| Karışık | `Mixed` (uyarı rengi) | **Karışık korunur** (sessiz normalize YOK) | "Normalize to LF/CRLF" tek tık |

**Varsayılan = mevcut EOL'u koru.** Karışık dosyada bile sessizce düzeltmeyiz (kullanıcı git-diff gürültüsü istemeyebilir); `Mixed` rozetiyle uyarır, tek tıkla normalize sunarız. CM6 editöründe satır girişi platform değil **doküman EOL'una** göre yapılır (CM6 `lineSeparator` facet'i `eol`'a bağlanır).

---

## 7. Atomik Kaydet (`commands/file.rs`)

Güç kesintisi/çökme güvenliği: **aynı dizinde temp dosya + fsync + atomik rename.**

```rust
use std::io::Write;
use tempfile::NamedTempFile;

#[tauri::command]
async fn save_file(app: tauri::AppHandle, path: String, text: String,
                   encoding: String, add_bom: bool, eol: String)
    -> Result<FileMeta, String>
{
    let bytes = encode_for_save(&text, &encoding, add_bom, eol.parse()?)
        .map_err(|e| e.to_string())?;

    let target = std::path::Path::new(&path);
    // SYMLINK: hedef symlink ise GERÇEK hedefe yaz (link'i dosyayla değiştirme!)
    let real = std::fs::canonicalize(target).unwrap_or(target.to_path_buf());
    let dir = real.parent().ok_or("no parent dir")?;

    // 1) Aynı dizinde temp (cross-device rename'i önler → rename atomik kalır)
    let mut tmp = NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    tmp.write_all(&bytes).map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;   // fsync: veri diskte

    // 2) Orijinal izinleri/sahipliği koru (Unix mode, Windows ACL devralma)
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(&real) {
        use std::os::unix::fs::PermissionsExt;
        let _ = tmp.as_file().set_permissions(
            std::fs::Permissions::from_mode(meta.permissions().mode()));
    }

    // 3) Atomik yerine koy (POSIX rename atomik; Windows ReplaceFileW semantiği)
    tmp.persist(&real).map_err(|e| e.error.to_string())?;

    // 4) Dizin fsync (POSIX: rename dayanıklılığı için)
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) { let _ = d.sync_all(); }

    Ok(stat_meta(&real, &encoding, add_bom, &eol))
}
```

**Önemli noktalar:**
- **Aynı dizin temp** (`new_in(dir)`): farklı diskte rename başarısız olur (cross-device); aynı dizinde rename gerçekten atomiktir.
- **`sync_all` (fsync)** rename'den önce: çökme anında ya eski ya yeni tam dosya kalır, asla yarım.
- **Symlink:** `canonicalize` ile gerçek hedefe yazılır; aksi halde `persist` symlink'i düz dosyayla değiştirir (link kopar). Hedef yoksa orijinal path.
- **İzin koruma:** Unix mode kopyalanır; Windows'ta `ReplaceFileW` (tempfile `persist` bunu kullanır) ACL'leri korur.
- **Tauri fs scope:** Yazma yalnızca capability scope'undaki (§4) ve dialog ile `allow_file()` eklenmiş yollara izinli; temp dosya da aynı dizinde olduğu için scope içinde kalır.

---

## 8. Dosya İzleme + Çatışma Çözümü (`commands/watch.rs`)

```rust
use notify_debouncer_full::{new_debouncer, DebouncedEvent};
use std::time::Duration;

#[tauri::command]
async fn watch_file(app: tauri::AppHandle, path: String) -> Result<u32, String> {
    let id = next_watcher_id();
    let app2 = app.clone();
    // 300 ms debounce: editör/araçların çoklu write event'ini tek olaya indirir
    let mut deb = new_debouncer(Duration::from_millis(300), None,
        move |res: Result<Vec<DebouncedEvent>, _>| {
            if let Ok(events) = res {
                for ev in events {
                    let kind = classify(&ev);   // modified | removed | renamed
                    let _ = app2.emit("file-changed",
                        FileChanged { path: ev_path(&ev), kind, watcher_id: id });
                }
            }
        })?;
    deb.watch(std::path::Path::new(&path), notify::RecursiveMode::NonRecursive)?;
    REGISTRY.lock().insert(id, deb);
    Ok(id)
}

#[tauri::command]
async fn unwatch(id: u32) -> Result<(), String> { REGISTRY.lock().remove(&id); Ok(()) }
```

**`notify-debouncer-full`** seçildi (sade `notify` yerine): rename'leri eşleştirir, art arda write'ları birleştirir, platform farklarını (inotify/FSEvents/ReadDirectoryChangesW) düzler.

### 8.1 Çatışma Matrisi (disk değişti × bellekte değişiklik)

| Disk değişti? | Bellek dirty? | UX |
|---|---|---|
| Evet | Hayır | **Sessiz/yumuşak reload** (içerik değiştiyse). İmleç/scroll korunur. Bildirim toast: "Disk'ten güncellendi". |
| Evet | Evet | **Çatışma banner'ı** (modal değil, üstte bar): *"Bu dosya başka bir programca değiştirildi, kaydedilmemiş değişiklikleriniz var."* Butonlar: **Disk'i Yükle (değişikliklerim gider)** · **Belleğimi Tut (sonraki kaydet diski ezecek)** · **Karşılaştır (diff)**. Otomatik karar YOK. |
| Hayır (removed) | herhangi | Banner: *"Dosya diskten silindi/taşındı."* → **Yeniden Kaydet** (path hâlâ biliniyor) · **Farklı Kaydet** · **Sekmeyi Kapat**. |
| renamed | herhangi | Path güncelle + toast; watcher yeni path'e taşınır. |

**Kendi yazımızı yok say:** `save_file` sırasında o path için watcher kısa süre (`ignore_until = now+500ms`) susturulur ki kendi atomik rename'imiz "harici değişiklik" sanılmasın. Frontend `services/watch.ts` save öncesi `suppressNextChange(path)` çağırır.

---

## 9. Büyük Dosya Yolu (Multi-GB Log) — Encoding ile Etkileşim

| Konu | Karar |
|---|---|
| Tespit | İlk **256 KB** chardetng'e beslenir (`feed(head, last=false)`); tüm dosya taranmaz (GB'lık dosyada gereksiz). BOM yine ilk 4 byte'tan. |
| Okuma | `read_chunk(path, byte_offset, max_bytes, encoding)` → `memmap2` ile mmap, **chunk sınırı UTF-8/çok-byte sınırında kırpılır** (yarım kod birimi sonraki chunk'a taşınır). encoding_rs streaming `Decoder` partial-input destekler. |
| EOL/encoding değişimi | Büyük dosyada **dönüştürerek-kaydet pahalı**; UI uyarır ("N GB yeniden yazılacak"). reopen-with-encoding büyük dosyada sadece görünür pencereyi yeniden decode eder (tam reload değil). |
| Kaydet | Atomik rename yine geçerli; ancak GB'lık temp yazımı için ilerleme event'i (`read-progress`/`save-progress`). |

Bu, mimari §5.2 "is_large" politikasıyla uyumlu: büyük dosyada yalnızca CM6 source + chunked decode; preview/WYSIWYG kapalı.

---

## 10. Status Bar UX (`app/status-bar.ts`)

```
… satır 142, sütun 7   |   UTF-8 ▾   |   CRLF ▾   |   ⚠ tahmin
```

| Gösterge | Tıklama davranışı |
|---|---|
| **Encoding** (`UTF-8`, `Windows-1254`, `UTF-8-BOM` …) | Açılır menü: **Reopen with Encoding ▸** (alt liste, diskten yeniden decode, dirty değil) ve **Convert to Encoding ▸** (dirty yapar). Ayrı **"Add/Remove BOM"** toggle. İki grup görsel olarak ayrık (reinterpret vs convert karışmasın). |
| **EOL** (`LF`/`CRLF`/`Mixed`) | Menü: Convert to LF · Convert to CRLF. `Mixed` ise uyarı rengi + "Normalize…". |
| **Uyarı rozeti** (düşük güven) | Tıkla → "Tespit düşük güvenli. Doğru encoding'i seçin" + reopen kısayolu. |

Encoding/EOL göstergeleri **her zaman görünür** (NPP'de gizli/menü-derinde olmasının tersi). BOM durumu encoding etiketine gömülü (`UTF-8` vs `UTF-8-BOM`) → kullanıcı tek bakışta BOM var/yok görür.

```ts
// services/fs.ts (IPC wrapper — §3.4 ipc.ts üstünde)
export const openFile  = (path: string, force?: string) =>
  call<OpenResult>('open_file', { path, forceEncoding: force ?? null });
export const reopenAs   = (path: string, encoding: string) =>
  call<OpenResult>('reopen_with_encoding', { path, encoding });
export const saveFile  = (d: DocState, text: string) =>
  call<FileMeta>('save_file', {
    path: d.path, text, encoding: encodingBase(d.encoding),
    addBom: d.hasBom, eol: d.eol,
  });
```

`encodingBase("UTF-8-BOM") = "UTF-8"` + `addBom=true` → Rust'a *encoding adı* ve *BOM bayrağı* ayrı gider (NPP iç-içe-geçme hatasının yapısal önlemi).

---

## 11. Crate Listesi (kesin)

```toml
# src-tauri/Cargo.toml  (workspace dependency olarak)
encoding_rs            = "0.8.35"
chardetng              = "1.0"
charset-normalizer-rs  = { version = "1", optional = true }  # feature = "second-opinion"
notify                 = "8"
notify-debouncer-full  = "0.5"
memmap2                = "0.9"
tempfile               = "3"
serde                  = { version = "1", features = ["derive"] }
```

---

## 12. Test Stratejisi (`core/encoding.rs` — Tauri'siz)

Kritik snapshot/golden testler (NPP regresyonlarının asla tekrar etmemesi için):

1. **İsim↔byte kilidi:** "UTF-8" kaydet → byte[0..3] ≠ `EF BB BF`; "UTF-8-BOM" → byte[0..3] == `EF BB BF`. (NPP #16814 ters-çevirme guard'ı.)
2. **BOM enjeksiyon-yok:** BOM'suz aç → düzenle → kaydet → hâlâ BOM yok.
3. **BOM koru:** BOM'lu aç → kaydet → BOM aynı.
4. **Round-trip:** her encoding için `decode → encode` byte-eşitliği (kayıpsız charset'lerde).
5. **Lossy guard:** `€` Windows-1254'e kaydet → `SaveError::LossyEncoding`, sessiz `?` yok.
6. **UTF-32 vs UTF-16 BOM sırası:** `FF FE 00 00` → UTF-32 LE, `FF FE 41 00` → UTF-16 LE.
7. **EOL koru:** karışık dosya → kaydet → byte-eşit (sessiz normalize yok).
8. **Türkçe legacy:** 1254 örnek byte dizisi → chardetng `windows-1254` tahmini.

---

## Özet Kararlar (encoding/I-O katmanı)

1. **encoding_rs 0.8.35 + chardetng 1.0.0**; charset-normalizer-rs opsiyonel ikinci görüş.
2. **İsim ile BOM ayrı parametre** (`encoding` + `add_bom`) — NPP v8.8.3 ters-çevirme hatasının yapısal önlemi; tek deterministik isim↔byte tablosu, snapshot testli.
3. **Varsayılan kaydet = BOM'suz UTF-8**; BOM yalnızca açık "UTF-8-BOM" seçimi veya mevcut BOM'un korunmasıyla yazılır — **otomatik enjeksiyon yok, sessiz soyma yok.**
4. **Sessiz yeniden-yazma yok:** kaydet açılıştaki encoding+BOM+EOL'u korur; dönüşüm yalnızca açık komutla + dirty + (kayıplıysa) uyarı.
5. **Reopen-with-encoding (reinterpret, dirty değil)** ile **Convert-to-encoding (dirty)** kesin ayrımı; convert/set-bom anında yazmaz, tek yazma yolu `save_file`.
6. **BOM sniff sırası** UTF-32'yi UTF-16'dan önce kontrol eder (`FF FE 00 00` tuzağı).
7. **EOL varsayılan = koru**; karışık sessizce düzeltilmez, `Mixed` rozeti + tek-tık normalize.
8. **Atomik kaydet:** aynı-dizin temp + fsync + atomik rename + dizin fsync; symlink `canonicalize` ile korunur; Unix mode/Windows ACL korunur; Tauri fs scope içinde.
9. **notify 8 + notify-debouncer-full** (300 ms); save sırasında self-write suppression; disk×bellek çatışma matrisi (otomatik karar yok, kullanıcı seçer).
10. **Status-bar'da encoding+EOL+BOM her zaman görünür ve tıklanabilir.**

Sources: [chardetng 1.0.0 docs.rs](https://docs.rs/crate/chardetng/latest), [chardetng GitHub (hsivonen)](https://github.com/hsivonen/chardetng), [encoding_rs 0.8.35 docs.rs](https://docs.rs/crate/encoding_rs/latest), [charset-normalizer-rs crates.io](https://crates.io/crates/charset-normalizer-rs), [Notepad++ #16814 — UTF-8/UTF-8-BOM convert inverted (v8.8.3, build 2025-07-09)](https://github.com/notepad-plus-plus/notepad-plus-plus/issues/16814), [notify crate](https://docs.rs/notify/latest/notify/)
