# UX/UI tasarimi ve MVP ozellik spesifikasyonu

# UX & MVP Tasarımı: vael

> Haziran 2026. Mimari kilitli (Seçenek A + KİLİTLENEN KARARLAR). Bu doküman onun üzerine somut UX ve v1 kapsamını koyar. Frontend = Lit chrome + CM6 (vanilla) + Crepe (lazy). Tüm UI dizeleri i18n-ayıklanabilir; tüm FS/encoding işlemi `services/*` üzerinden Rust'a.

---

## 1. Tasarım İlkeleri (Sade-ama-Yetenekli)

| İlke | Somut karşılık |
|---|---|
| **Kutudan-çıktı-gibi temiz** | İlk açılışta: tek editör alanı + ince status bar + tab bar. Sidebar KAPALI, minimap YOK, hiçbir panel açık değil. Sıfır kurulum sihirbazı. |
| **Progressive disclosure** | Gelişmiş her şey opt-in: dosya ağacı (Ctrl+B), komut paleti (Ctrl+Shift+P), ayarlar (Ctrl+,). Mermaid/KaTeX/WYSIWYG yalnızca markdown dosyasında ve istenince yüklenir (lazy). |
| **Görünür gerçeklik** | Encoding, BOM, EOL, satır/sütun, dil, mod status bar'da **daima görünür ve tıklanabilir** (kama #2: encoding). Hiçbir dosya sessizce yeniden-encode edilmez. |
| **Hız hissi** | <500 ms soğuk açılış; büyük dosyada (kama #1) anında ilk ekran, arka planda indeksleme. Bloklamayan UI. |
| **Offline & sessiz** | Sıfır telemetri, sıfır "hesap oluştur", sıfır otomatik ağ çağrısı (updater hariç, opt-in + ayrı host). |
| **Tek doğru kaynak** | Doküman içeriği = markdown string. Mod geçişleri kayıpsız serileştirme (KARAR #8). |
| **Tahmin edilebilir** | Klavye-öncelikli; her görünür eylemin komut paletinde karşılığı ve kısayolu var. |

**Sadelik bekçileri (anti-bloat kuralları):**
1. Varsayılan UI'da en fazla 3 kalıcı yüzey: tab bar, editör, status bar.
2. Yeni bir özellik kalıcı UI ekliyorsa → ya komut paletine ya da ayarlar arkasına gizlenir, toolbar'a değil.
3. Hiçbir özellik ilk açılışta modal/popup/tur göstermez.
4. Toolbar YOK (WYSIWYG modundaki Crepe kendi inline/slash menüsü hariç).

---

## 2. UI Düzen Şeması (ASCII)

### 2.1 Varsayılan görünüm (sidebar kapalı — kutudan çıktığı gibi)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ● readme.md ✎   notes.txt   app.rs               [Source│Split│WYSIWYG]   ⌕ ☰ │  ← tab bar + mod toggle
├─────────────────────────────────────────────────────────────────────────────┤
│  1   # Başlık                                                                 │
│  2                                                                            │
│  3   Markdown içeriği burada. CM6 editör alanı.                               │
│  4                                                                            │
│  5   - liste                                                                  │
│  6   - öğesi                                                                  │   ← EDİTÖR ALANI
│  7                                                                            │      (tek yüzey)
│  ▏                                                                            │
│                                                                               │
│                                                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│ UTF-8 ▾  │ LF ▾  │ Sat 7, Süt 1  │ Sel 0  │ Markdown ▾  │ Spaces:2 ▾  │ ✓     │  ← STATUS BAR
└─────────────────────────────────────────────────────────────────────────────┘
   encoding   EOL    imleç          seçim    dil           girinti      kayıt durumu
   (tık→liste) (tık)                          (tık→liste)               (✓temiz / ●dirty)
```

### 2.2 Sidebar açık (Ctrl+B) + Split mod

```
┌──────────────┬──────────────────────────────────────────────────────────────┐
│ DOSYALAR    ⟳│ ● readme.md ✎   notes.txt        [Source│�é Split│WYSIWYG]  ⌕ ☰ │
│ ▾ project/   ├───────────────────────────────┬──────────────────────────────┤
│   ▾ src/     │  1  # Başlık                  │   Başlık                       │
│      app.rs  │  2                            │   ─────                        │
│      lib.rs  │  3  Metin **kalın** ve `kod`. │   Metin kalın ve kod.          │
│   ▾ docs/    │  4                            │                                │
│    ●readme.md│  5  $E = mc^2$                │   E = mc²   (KaTeX, lazy)      │
│      api.md  │  6                            │                                │
│   .gitignore │  7  ```mermaid               │   ┌────┐   (Mermaid, lazy)     │
│              │  8  graph TD; A-->B           │   │ A  │→ B                    │
│              │  ▏                            │   └────┘                       │
│              │      CM6 source (sol)         │   markdown-it+Prism (sağ)      │
│              │                               │   ⇅ scroll-sync                │
├──────────────┴───────────────────────────────┴──────────────────────────────┤
│ UTF-8 ▾ │ LF ▾ │ Sat 5, Süt 9 │ Markdown ▾ │ Spaces:2 │ ●  3 değişiklik       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Komut paleti (Ctrl+Shift+P) — overlay (Shadow DOM, izole)

```
        ┌────────────────────────────────────────────────────────┐
        │ ⌕ > encod|                                              │
        ├────────────────────────────────────────────────────────┤
        │  Dosyayı şu encoding ile yeniden aç…        ⌘⇧O          │
        │  Encoding değiştir (kaydederken)                        │
        │  BOM ekle/kaldır                                        │
        │  Satır sonunu dönüştür: LF / CRLF                       │
        │ ───────────────────────────────────────────────────    │
        │  son: "Markdown'ı HTML'e aktar"                         │
        └────────────────────────────────────────────────────────┘
```

### 2.4 Büyük dosya modu (kama #1 — is_large)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ● huge.log [BÜYÜK DOSYA]                              [Source]  (Split/WYSIWYG│
│                                                       devre dışı, gri)        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1048571  2026-06-24T10:00:01Z INFO  ...                                       │
│ 1048572  2026-06-24T10:00:01Z WARN  ...      ← CM6, satır-pencereli besleme   │
│ 1048573  ...                                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ UTF-8 │ LF │ Sat 1048572 / ~24.3M │ 2.1 GB │ Log ▾ │ ⟳ indeksleniyor… 38%     │
└─────────────────────────────────────────────────────────────────────────────┘
   tam dosya bellekte DEĞİL · sadece görünür pencere + komşu chunk'lar
```

### 2.5 Status bar — tıklanabilir segment haritası

```
[ UTF-8 ▾ ] → encoding seçici popover (yeniden aç / kaydederken dönüştür)
[ LF ▾    ] → LF ⇄ CRLF dönüştür
[ BOM     ] → (yalnız BOM varsa görünür) BOM ekle/kaldır
[ Sat,Süt ] → "Satıra git" (Ctrl+G)
[ Sel N   ] → seçili karakter/satır sayısı
[ Markdown▾] → dil/sözdizimi seçici (CM6 lang paketi lazy)
[ Spaces:2▾] → girinti (tab/space, genişlik)
[ ✓ / ●   ] → kayıt durumu (✓ temiz, ● dirty); tık = kaydet
```

---

## 3. Mod Değiştirici UX (Source / Split / WYSIWYG)

**Konum:** Tab bar'ın sağında segment kontrol. **Yalnızca markdown benzeri dosyalarda** (`.md`, `.markdown`, `.mdx`) üç seçenek de aktif. Diğer dosya tiplerinde (`.txt`, `.rs`, `.json`…) yalnızca **Source** görünür (toggle gizlenir).

```
Markdown dosyası:    [ Source │ Split │ WYSIWYG ]   ← Ctrl+Shift+S döndürür
Kod/metin dosyası:   (toggle yok, sadece Source)
Büyük dosya:         [ Source ]  Split/WYSIWYG gri + tooltip "Büyük dosyada devre dışı"
```

**Geçiş davranışı (KARAR #8 — kayıpsız):**

| Geçiş | Mekanizma |
|---|---|
| Source → WYSIWYG | `cmView.state.doc.toString()` → lazy `import('@milkdown/crepe')` → `new Crepe({ defaultValue })` |
| WYSIWYG → Source | `crepe.getMarkdown()` → CM6 `dispatch` ile doc değiştir |
| Source → Split | CM6 kalır; sağ panele markdown-it render (debounced 120 ms) + scroll-sync |
| Herhangi geçiş | İki motor aynı anda **canlı tutulmaz**; eski motor `destroy()` |

**Given/When/Then:**
- **Given** WYSIWYG'de düzenlenmiş bir doküman, **When** kullanıcı Source'a geçer, **Then** CM6'da markdown metni Crepe'in serileştirdiği haliyle **bayt-eşdeğer** görünür ve `dirty` durumu korunur.
- **Given** büyük dosya açık, **When** kullanıcı WYSIWYG'e tıklamayı dener, **Then** toggle pasiftir ve hiçbir tam-metin DOM render tetiklenmez.

---

## 4. Temalar & Görünüm

### 4.1 Tema modeli
- **Üç UI modu:** `light`, `dark`, `system` (OS takibi). Tauri `window.theme()` + `tauri://theme-changed` event ile OS değişimi anında yansır.
- **Tema = CSS değişken katmanı.** Tüm chrome (Lit, Light DOM) tek `:root` token seti kullanır: `--bg`, `--bg-elev`, `--fg`, `--fg-muted`, `--accent`, `--border`, `--sel`. Tema değişimi = `<html data-theme="dark">` attribute switch (FOUC yok, JS re-render yok).
- **Sözdizimi teması ayrı eksen:** Editör highlight teması UI temasından bağımsız seçilebilir. CM6 için `themeConf` Compartment (KARAR: cm-setup), preview Prism için `data-prism-theme`. Varsayılan: UI ile eşleşen ("auto").

```
Ayar: appearance.uiTheme = "system" | "light" | "dark"
      appearance.syntaxTheme = "auto" | "github-light" | "github-dark" | "one-dark" | ...
```

### 4.2 Erişilebilirlik (a11y)

| Alan | Yaklaşım |
|---|---|
| **Ekran okuyucu** | CM6'nın yerleşik a11y'si (cursor/seçim duyurusu) korunur. Lit chrome'da semantik roller: tab bar `role="tablist"`/`role="tab"`/`aria-selected`, status bar segmentleri `role="button"` + `aria-label`, komut paleti `role="combobox"`+`aria-activedescendant`+`role="listbox"`. Live region (`aria-live="polite"`) ile "Kaydedildi", "Encoding değişti", "indeksleme tamamlandı" duyuruları. |
| **Klavye nav** | Tüm eylemler klavyeden. Tab order mantıklı; overlay'lerde focus-trap; Esc kapatır. Hiçbir eylem yalnızca-mouse değil. Görünür focus halkası (`:focus-visible`). |
| **CJK / IME** | CM6 ve ProseMirror (Crepe) IME composition'ı yerel destekler; `compositionstart/update/end` sırasında preview render ve dirty-tracking **composition bitene kadar ertelenir** (yarım karakter render edilmez). |
| **Kontrast / motion** | Temalar WCAG AA hedefler. `prefers-reduced-motion` ile geçiş animasyonları kapatılır. |
| **Yazı tipi** | Editör font ve boyutu ayarlanabilir; OS zoom'a saygı. |

### 4.3 i18n & RTL

- **Dize ayıklama:** Tüm UI dizeleri `src/i18n/<locale>.json` içinde anahtar-tabanlı; kodda sabit dize yok. Minik `t('key', params)` fonksiyonu (kütüphane bağımlılığı minimal; ICU MessageFormat-lite çoğul/cinsiyet için). İlk teslim: `en`, `tr`. Eksik anahtar → `en` fallback.
- **RTL:** Chrome `dir="auto"`/`dir="rtl"` ile yön-duyarlı; layout mantıksal CSS özellikleriyle (`margin-inline-start`, `inset-inline-end`) yazılır, fiziksel `left/right` değil. **Editör içeriği** her zaman per-paragraf `dir="auto"` (Arapça/İbranice metin doğru hizalanır) ama satır numaraları/gutter UI yönüne bağlı.
- **Tarih/sayı:** `Intl` API (offline, yerel).

---

## 5. Klavye Kısayolları (Taban Set)

> Windows/Linux gösterimi; macOS'ta `Ctrl`→`⌘`, `Alt`→`⌥`. Tüm kısayollar ayarlardan rebind edilebilir; çakışma ayarlar UI'da uyarılır.

### Dosya & Sekme
| Kısayol | Eylem |
|---|---|
| `Ctrl+N` | Yeni dosya |
| `Ctrl+O` | Dosya aç (native dialog) |
| `Ctrl+S` | Kaydet |
| `Ctrl+Shift+S` | Farklı kaydet |
| `Ctrl+W` | Sekmeyi kapat |
| `Ctrl+Shift+T` | Kapatılan sekmeyi geri aç |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Sonraki / önceki sekme |
| `Ctrl+1..9` | N. sekmeye git |

### Görünüm & Mod
| Kısayol | Eylem |
|---|---|
| `Ctrl+B` | Dosya ağacı sidebar aç/kapat |
| `Ctrl+Shift+S` | Mod döndür: Source → Split → WYSIWYG *(Not: Farklı Kaydet ile çakışmayı önlemek için mod toggle = `Ctrl+Shift+M`)* |
| `Ctrl+Shift+M` | Mod döndür (Source/Split/WYSIWYG) |
| `Ctrl+Shift+V` | Markdown önizlemeyi aç/kapat (Split) |
| `Ctrl+=` / `Ctrl+-` | Yakınlaştır / uzaklaştır |
| `Ctrl+0` | Zoom sıfırla |
| `F11` | Tam ekran / zen |

### Düzenleme (CM6 tabanlı + ek)
| Kısayol | Eylem |
|---|---|
| `Ctrl+Z` / `Ctrl+Y` | Geri al / yinele |
| `Ctrl+F` / `Ctrl+H` | Bul / Değiştir |
| `Ctrl+G` | Satıra git |
| `Ctrl+D` | Sonraki eşleşmeyi seç |
| `Alt+↑/↓` | Satırı taşı |
| `Ctrl+/` | Yorum aç/kapat (kod) |
| `Ctrl+Shift+K` | Satır sil |
| Markdown kısayolları | `Ctrl+B` kalın\*, `Ctrl+I` italik (\*sidebar açıkken bağlam-duyarlı: editör odaklıysa kalın) |

### Genel
| Kısayol | Eylem |
|---|---|
| `Ctrl+Shift+P` | Komut paleti |
| `Ctrl+P` | Hızlı dosya aç (sidebar workspace içinde) |
| `Ctrl+,` | Ayarlar |
| `Ctrl+K Ctrl+S` | Kısayol referansı (chord) |

> **Çakışma notu çözümü:** Markdown kalın geleneksel olarak `Ctrl+B`, sidebar da `Ctrl+B`. Çözüm: **editör odakta ve markdown dosyasındaysa** `Ctrl+B` = kalın; aksi halde sidebar toggle. Bu bağlam-duyarlılık komut paletinde iki ayrı komut olarak da listelenir. Sidebar için alternatif `Ctrl+Shift+E` (explorer) de tanımlı.

---

## 6. Önceliklendirilmiş MVP (v1) Özellik Listesi — Kabul Kriterleriyle

Öncelik: **Must** (v1 olmazsa olmaz) / **Should** (v1 hedef, kayabilir) / **Could** (fırsat olursa). Table-stakes + iki kama (büyük dosya, encoding) Must'tır.

### M — Çekirdek Editör & Dosya

**M1 — Dosya aç/kaydet/yeni (Must)**
- [ ] G/W/T: **Given** çalışan uygulama, **When** `Ctrl+O` ile bir `.md`/`.txt`/kod dosyası seçilir, **Then** içerik <300 ms (orta dosya) CM6'da görünür, status bar encoding/EOL/dil doğru.
- [ ] **Given** değiştirilmiş (dirty) doküman, **When** `Ctrl+S`, **Then** disk'e mevcut encoding+EOL+BOM ile yazılır, `dirty` temizlenir, status bar `✓`.
- [ ] **Given** kaydedilmemiş değişiklik, **When** sekme/uygulama kapatılır, **Then** "kaydet/at/iptal" sorulur.

**M2 — Çoklu sekme (Must)**
- [ ] Aynı anda N dosya; `Ctrl+Tab` gezinme; dirty göstergesi (●); orta-tık kapat.
- [ ] **Given** 3 açık sekme, **When** uygulama kapatılıp açılır, **Then** oturum (açık dosyalar + aktif + imleç) `store` ile geri yüklenir.

**M3 — CM6 Source modu + sözdizimi (Must)**
- [ ] Satır no, aktif satır, parantez eşleme, arama, geri-al. 
- [ ] **Given** `.rs`/`.json`/`.py` dosyası, **When** açılır, **Then** ilgili `@codemirror/lang-*` lazy yüklenip highlight uygulanır; bilinmeyen uzantı → düz metin, çökme yok.

### M — Markdown (Table-stakes)

**M4 — Markdown önizleme (Split) + GFM (Must)**
- [ ] markdown-it + GFM: **tablo**, görev listesi, ~~üstü çizili~~, autolink.
- [ ] **Given** GFM tablo içeren md, **When** Split açılır, **Then** tablo HTML olarak doğru render, scroll-sync ±1 satır.
- [ ] Render debounced (≤150 ms); yazarken takılma yok.

**M5 — KaTeX matematik (Must)**
- [ ] Inline `$...$` ve blok `$$...$$` render.
- [ ] **Given** `$E=mc^2$`, **When** preview, **Then** KaTeX (lazy yüklenmiş) ile doğru render; hatalı LaTeX → kırmızı hata metni, çökme yok.

**M6 — Mermaid diyagram (Must)**
- [ ] ` ```mermaid ` blokları lazy Mermaid ile render, `securityLevel:'strict'`.
- [ ] **Given** geçerli `graph TD`, **When** preview, **Then** SVG diyagram; geçersiz sözdizimi → hata kutusu, diğer içerik render olmaya devam eder.
- [ ] Mermaid yalnızca dökümanda mermaid bloğu **varsa** import edilir (bundle vergisi yok).

**M7 — WYSIWYG (Crepe) modu (Must)**
- [ ] **Given** markdown dosyası, **When** WYSIWYG'e geçilir, **Then** Crepe lazy yüklenir, içerik düzenlenebilir; slash/inline menü çalışır.
- [ ] **Given** WYSIWYG'de düzenleme, **When** Source'a dönülür, **Then** markdown kayıpsız (KARAR #8).

### M — İki Kama

**M8 — Büyük dosya / multi-GB log (Must, KAMA #1)**
- [ ] **Given** 2 GB `.log`, **When** açılır, **Then** ilk ekran <1 s görünür; tam dosya belleğe alınmaz (`read_chunk`); RAM artışı dosya boyutuyla doğru orantılı **değil** (pencere bazlı).
- [ ] **Given** büyük dosya, **When** açık, **Then** Split/WYSIWYG pasif; status bar `[BÜYÜK DOSYA]` + indeksleme yüzdesi.
- [ ] **Given** indeksleme sürerken, **When** kullanıcı kaydırır/`Ctrl+G`, **Then** UI bloklanmaz, hedef chunk getirilir.
- [ ] (Should) Büyük dosyada salt-okunur kilidi opsiyonu (kazara dev dosya düzenlemesini önler).

**M9 — Encoding / BOM / EOL yönetimi (Must, KAMA #2)**
- [ ] **Given** windows-1254/Shift-JIS/UTF-16 dosya, **When** açılır, **Then** `chardetng` ile tespit, doğru çözümlenir, status bar gerçek encoding'i gösterir.
- [ ] **Given** yanlış tespit, **When** kullanıcı status bar'dan "şu encoding ile yeniden aç" seçer, **Then** dosya yeniden çözümlenir (disk'ten, kayıpsız).
- [ ] **Given** BOM'lu UTF-8, **When** açılır, **Then** status bar `BOM` rozeti; kullanıcı BOM ekle/kaldır seçebilir; kaydetme bunu korur.
- [ ] **Given** LF dosya, **When** kullanıcı CRLF'e dönüştürür ve kaydeder, **Then** disk'te tüm satır sonları CRLF.
- [ ] **Given** karışık EOL, **When** açılır, **Then** status bar `Mixed` uyarısı + normalize seçeneği.

### M — Export (Table-stakes)

**M10 — Export: HTML + (Pandoc opsiyonel) (Must)**
- [ ] **Given** md dökümanı, **When** "HTML'e aktar" (Rust comrak/pulldown), **Then** stil gömülü standalone `.html` üretilir (KaTeX/Mermaid dahil).
- [ ] **Given** Pandoc kurulu, **When** kullanıcı PDF/DOCX export seçer, **Then** sidecar Pandoc ile üretilir; **Pandoc yoksa** seçenek gri + "Pandoc kurun" ipucu (çökme yok).
- [ ] Export ağ erişmez; tamamen yerel.

### M — Chrome

**M11 — Komut paleti (Must)**
- [ ] `Ctrl+Shift+P`; fuzzy arama; her komutta kısayol görünür; son kullanılanlar.
- [ ] **Given** palette açık, **When** "encoding" yazılır, **Then** ilgili komutlar listelenir, Enter çalıştırır, Esc kapatır.

**M12 — Status bar (Must)**
- [ ] encoding/EOL/BOM/satır-sütun/seçim/dil/girinti/dirty segmentleri; ilgili olanlar tıklanabilir (§2.5).

**M13 — Ayarlar (dosya tabanlı) (Must)**
- [ ] `Ctrl+,` ayar dosyasını (JSON) açar veya basit UI; değişiklik anında uygulanır.
- [ ] **Given** geçersiz JSON, **When** kaydedilir, **Then** hata gösterilir, son geçerli ayar korunur (çökme yok).

### S — Should

- **S1** Dosya ağacı sidebar (workspace klasör aç, `Ctrl+B`, `Ctrl+P` hızlı aç).
- **S2** Disk değişikliği izleme (`notify` → `file-changed` → "yeniden yükle?" uyarısı) (KARAR #12).
- **S3** Açık/koyu/system tema + sözdizimi teması seçimi (§4.1).
- **S4** Bul/Değiştir gelişmiş (regex, tümünü değiştir).
- **S5** i18n `en`+`tr`, RTL temel desteği.
- **S6** İmzalı updater (opt-in, ayrı host).
- **S7** Oturum/çalışma alanı geri yükleme (taslak M2'de temel; tam workspace state burada).

### C — Could

- **C1** Markdown anahat (outline) paneli / TOC.
- **C2** Minimap (varsayılan kapalı).
- **C3** Eklenti/snippet sistemi.
- **C4** Git durum göstergesi (gutter).
- **C5** Çoklu pencere.
- **C6** Mobil/web hedef (mimari `services/*` mock'lanabilir olduğu için açık — KARAR #14).
- **C7** Diff görünümü.

---

## 7. Ayarlar Şeması Taslağı (gizlilik-dostu, dosya-tabanlı)

> Konum: OS config dizini (`tauri-plugin-store` + insan-okunur JSON export). **Telemetri anahtarı YOK** — çünkü telemetri yok. Yorum/şema doğrulama için `$schema` ile JSON Schema sağlanır; bilinmeyen anahtarlar yok sayılır (ileri uyumluluk).

```jsonc
{
  "$schema": "https://vael.dev/schema/settings-1.json",
  "schemaVersion": 1,

  "appearance": {
    "uiTheme": "system",            // "system" | "light" | "dark"
    "syntaxTheme": "auto",          // "auto" | "github-light" | "one-dark" | ...
    "fontFamily": "",               // "" = OS monospace varsayılan
    "fontSize": 14,
    "lineHeight": 1.5,
    "uiZoom": 1.0
  },

  "editor": {
    "defaultMode": "source",        // "source" | "split" | "wysiwyg" (md için)
    "wordWrap": "off",              // "off" | "on" | "bounded"
    "wrapColumn": 0,                // bounded ise sütun
    "lineNumbers": true,
    "indent": { "style": "space", "size": 2, "detectFromFile": true },
    "renderWhitespace": "selection",// "none" | "selection" | "all"
    "scrollBeyondLastLine": false,
    "minimap": false
  },

  "markdown": {
    "previewDebounceMs": 120,
    "scrollSync": true,
    "katex": { "enabled": true },
    "mermaid": { "enabled": true, "securityLevel": "strict" },
    "gfm": { "tables": true, "tasklists": true, "strikethrough": true }
  },

  "files": {
    "defaultEncoding": "utf-8",
    "defaultEol": "lf",             // "lf" | "crlf" | "platform"
    "writeBom": false,
    "detectEncoding": true,         // chardetng
    "trimTrailingWhitespaceOnSave": false,
    "insertFinalNewline": true,
    "largeFileThresholdMB": 50,     // üstü = chunked/read-only öneri
    "watchForChanges": true         // notify (S2)
  },

  "session": {
    "restoreOnStartup": true,       // açık sekmeler + imleç
    "reopenLastWorkspace": true
  },

  "keybindings": {
    "preset": "default",            // "default" | "custom"
    "overrides": {
      // "toggleSidebar": "Ctrl+Shift+E",
      // "cyclePreviewMode": "Ctrl+Shift+M"
    }
  },

  "language": {
    "locale": "system",             // "system" | "en" | "tr"
    "rtl": "auto"                   // "auto" | "on" | "off"
  },

  "export": {
    "html": { "standalone": true, "embedAssets": true },
    "pandoc": { "enabled": false, "path": "" }  // boş = PATH'te ara
  },

  "privacy": {
    "telemetry": "disabled",        // SABİT; UI'da değiştirilemez, şeffaflık için var
    "checkForUpdates": false        // opt-in; ağ erişimi yalnızca true ise
  }
}
```

**Gizlilik ilkeleri (şemaya gömülü):**
- `privacy.telemetry` daima `"disabled"` ve **salt-okunur** (kod düzeyinde hiçbir telemetri yolu yok; anahtar yalnızca şeffaflık beyanı).
- `privacy.checkForUpdates` varsayılan `false` → kutudan çıkışta sıfır ağ trafiği. Updater yalnızca kullanıcı açarsa, imzalı, ayrı host.
- Ayar dosyası düz JSON → kullanıcı denetleyebilir, sürüm kontrolüne koyabilir, taşıyabilir. Bulut senkron yok.
- `schemaVersion` ile ileri/geri göç; bilinmeyen anahtar yok sayılır (veri kaybı yok).

---

## Özet (KİLİTLENEN UX/MVP KARARLARI)

1. **Varsayılan UI = 3 yüzey** (tab bar + editör + status bar); sidebar/palette/ayarlar opt-in. Toolbar yok. Anti-bloat bekçileri §1.
2. **Mod toggle** tab bar sağında; markdown'da Source/Split/WYSIWYG, diğer dosyalarda yalnız Source, büyük dosyada yalnız Source. Mod döndür = `Ctrl+Shift+M`. Kayıpsız serileştirme.
3. **Status bar tıklanabilir** ve encoding/BOM/EOL'ü **daima görünür** kılar (kama #2'nin UX yüzü).
4. **Büyük dosya modu** ayrı görsel durum (`[BÜYÜK DOSYA]` + indeksleme %), Split/WYSIWYG pasif (kama #1).
5. **Tema = CSS token + `data-theme`** attribute switch (system takipli); sözdizimi teması ayrı eksen. a11y: ARIA roller + live region + focus-trap + IME composition ertelemeli render. i18n: anahtar-tabanlı dize ayıklama (`en`/`tr`), mantıksal-CSS ile RTL.
6. **Kısayol taban seti** tablolandı; `Ctrl+B` bağlam-duyarlı (editör+md → kalın, aksi → sidebar), alternatif `Ctrl+Shift+E`. Tümü rebind-edilebilir.
7. **MVP Must** = M1–M13: dosya/sekme/CM6, GFM+KaTeX+Mermaid+WYSIWYG, **büyük dosya** + **encoding/BOM/EOL** kamaları, HTML export (+opsiyonel Pandoc), komut paleti/status bar/ayarlar. Hepsi G/W/T kabul kriterli. Should: sidebar, watch, tema, gelişmiş bul, i18n, updater. Could: outline, minimap, eklenti, git, çoklu pencere, mobil/web, diff.
8. **Ayarlar = düz JSON** (`$schema` + `schemaVersion`), gizlilik-dostu: `telemetry:"disabled"` salt-okunur, `checkForUpdates:false` varsayılan → kutudan sıfır ağ. Bulut senkron yok, kullanıcı-denetlenebilir dosya.


