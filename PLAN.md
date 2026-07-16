# vael — Uygulama Planı

> Hafif, hızlı, gizlilik/offline öncelikli, çapraz platform metin + Markdown + kod editörü. Tauri v2 + TypeScript/Lit + CodeMirror 6 + Milkdown/Crepe. Haziran 2026. Tüm sürümler doğrulanmıştır.

---

## 1. Genel Bakış ve Hedef

**Vizyon:** Hem kod hem düz metin/Markdown yazan karma kullanıcıya hitap eden, açık kaynak (MIT), sade varsayılan arayüzlü, sıfır telemetrili masaüstü editörü. "Gördüğün = aldığın" garantisi ve büyük dosyalarda çökmeyen sağlamlık.

**Dört farklılaştırıcı:**
1. **Multi-GB log/dosya işleme** — rakipler (Notepad++/Scintilla) bellek modeli yüzünden çökerken, üç-katmanlı eşik + Rust-tarafı streaming ile sub-100 MB RAM'de açma.
2. **Görünür ve doğru encoding/BOM/EOL yönetimi** — Notepad++'ın ters-çevrilen menü/sessiz-yeniden-yazma hatalarının yapısal tersine örneği.
3. **Offline-by-default + sıfır telemetri** — hiçbir dış ağ isteği yok (yalnız opsiyonel imzalı updater).
4. **Sürdürülen OSS + temiz/sade UI.**

**Başarı kriterleri / performans hedefleri:**

| Hedef | Tanım | Ölçüm koşulu |
|---|---|---|
| Soğuk açılış | < 500 ms | Boş editör, markdown modu, Windows/macOS |
| Boş RAM | ~sub-100 MB | **Boş editör + markdown modu** (WYSIWYG/Mermaid/büyük-dosya açıkken GARANTİ EDİLMEZ — dürüst sınır) |
| Büyük dosya açma | İlk görünür içerik < 500 ms | 12 GB log, StreamViewer, ilk Channel chunk'ı |
| Preview↔export sadakati | Byte düzeyinde aynı render | Tek-motor mimarisi (drift imkânsız) |
| Telemetri | Sıfır dış istek | CSP `connect-src` dış-yok |

**Lisans:** MIT (en geniş ekosistem uyumu; tüm yığın MIT/Apache-2.0/BSD/ISC uyumlu).

---

## 2. Teknoloji Kararları Tablosu

| Katman | Seçim | Sürüm | Gerekçe | Reddedilen alternatif |
|---|---|---|---|---|
| Kabuk | Tauri v2 (Rust + OS WebView) | CLI 2.11.3, api 2.11.1 | Hafif binary, küçük RAM, Rust güvenlik modeli | Electron (+200-450 MB RAM, "hafif" tezine aykırı) |
| Frontend chrome | Vanilla TS + **Lit** | Lit ~3.x | CM6/Crepe framework-agnostik imperatif; framework yalnız chrome'a değer; Lit en hafif/standart/Web-Component, Crepe'in Vue 3.5'iyle izole yan yana yaşar | React/Svelte/Solid (chrome için ikinci/üçüncü reaktivite runtime'ı) |
| Build | Vite + pnpm | Vite 5.x | Hızlı HMR; pnpm sıkı bağımlılık + overrides ile tek-instance pin | npm/yarn (overrides garantisi zayıf) |
| Kod editörü | CodeMirror 6 (elle kompoze) | state 6.6.0, view 6.43.0, commands 6.10.3 | Rope-tabanlı, milyonlarca satır, viewport virtualization, Compartment ile runtime degrade | `basic-setup` (bundle şişer, compartment kontrolü yok) |
| WYSIWYG | Milkdown **Crepe** | 7.21.2 | Batteries-included; CodeMirror/Latex/Table feature'ları; lazy yüklenir | Saf ProseMirror (çok düşük seviye) |
| Preview render | markdown-it | 14.2.0 | **KANONİK MOTOR** (preview + export tek kaynaktan) | comrak'ı render motoru yapmak (math/mermaid/plugin drift'i) |
| Syntax (preview) | Prism | 1.30.0 | markdown-it highlight callback, statik token | — |
| Syntax (editör) | CM6/Lezer | lang-markdown 6.x + language-data | Fence-içi lazy highlight, `codeLanguages` | — |
| Matematik | KaTeX | 0.17.0 | Crepe ile aynı hat (çakışma yok), senkron HTML+MathML | MathJax (ağır, asenkron) |
| Diyagram | Mermaid | 11.15.0 | Lazy, `securityLevel:'strict'` (CSP uyumlu) | — |
| Sanitizasyon | DOMPurify | 3.4.x | render→sanitize→DOM derinlik savunması | — |
| Encoding decode/encode | encoding_rs | 0.8.35 | WHATWG kümesi, streaming Decoder | — |
| Charset tespiti | chardetng | 1.0.0 | encoding_rs `Encoding` döndürür (sıfır eşleme), Türkçe legacy | charset-normalizer-rs (opsiyonel ikinci görüş) |
| Büyük dosya I/O | memmap2 | 0.9.10 | Zero-copy random access | tam-dosya read (WebView string tavanı) |
| Hızlı arama | grep-searcher + grep-regex | 0.1.16 | ripgrep motoru, backtracking YOK → linear-time | WebView regex (catastrophic backtracking) |
| Newline tarama | memchr | 2.x | SIMD newline | — |
| FS izleme | notify + notify-debouncer-full | 8.x / 0.5.x | Cross-platform, rename eşleştirme, debounce | tauri-plugin-fs watch (mobil/platform tutarsızlığı) |
| Atomik kaydet | tempfile | 3.x | Aynı-dizin temp + fsync + rename | — |
| Export md→HTML | (markdown-it kanonik) | — | Drift yok | comrak (yedek/CI-referans rolüne indirildi) |
| Export PDF | **WebView print_to_pdf** (birincil) | OS | Birebir sadakat, sıfır binary, offline | Headless Chromium (+150 MB) |
| Export PDF | Typst (ikincil) | 0.13.x | Apache-2.0, saf-Rust, deterministik rapor/CI | Pandoc-PDF (GPL + TeX Live ~GB) |
| Export DOCX | Pandoc sidecar (opsiyonel) | sistem | Ayrı süreç → GPL bulaşması yok | Pandoc bundle (+150 MB, GPL) |
| Async runtime | tokio | 1.x | Arka plan indeksleme, Channel streaming | — |

---

## 3. Mimari

### 3.1 Sistem Şeması

```
┌──────────────────────────────────────────────────────────────────┐
│  OS WebView (WebView2 / WKWebView / WebKitGTK)                     │
│  ┌─ FRONTEND (TS) ──────────────────────────────────────────────┐ │
│  │  Lit chrome:  app-shell · tab-bar · status-bar · cmd-palette  │ │
│  │       │ signal store (docs, activeId, mode)                   │ │
│  │       ▼                                                       │ │
│  │  editor/   ┌─ source-view  → CM6 EditorView (eager)           │ │
│  │            ├─ split-view   → CM6 + markdown-it+Prism preview   │ │
│  │            ├─ wysiwyg-view → Crepe (Vue/ProseMirror) [lazy]    │ │
│  │            └─ stream-viewer → özel virtualized (>1 GB)         │ │
│  │            preview: KaTeX · Mermaid (lazy) · DOMPurify         │ │
│  │       │  (editör/chrome ASLA @tauri-apps/* import etmez)       │ │
│  │       ▼                                                       │ │
│  │  services/ fs · watch · export · ipc  ──┐ (TEK IPC SINIRI)    │ │
│  └─────────────────────────────────────────┼───────────────────┘ │
│        invoke(cmd) ▲ │ Channel<T> akış ▲    │ invoke ▼             │
├────────────────────┼──────────────────-────┼─────────────────────┤
│  ┌─ RUST (Tauri v2) ───────────────────────▼───────────────────┐ │
│  │  commands: open_big · read_lines · read_chunk · save_file ·  │ │
│  │   reopen_with_encoding · search_file · follow_tail ·         │ │
│  │   watch_file/unwatch · print_pdf · export_docx · write_text  │ │
│  │  core/encoding (chardetng + encoding_rs, BOM/EOL) ← testli   │ │
│  │  core/line_index (sparse anchor + memchr, mmap)  ← testli    │ │
│  │  grep-searcher/regex (streaming find) · notify (watch)       │ │
│  │  comrak (yedek/CI-referans) · Typst (opsiyonel PDF)          │ │
│  │  plugins: fs · dialog · store · updater                      │ │
│  │  capabilities/main.json (en az ayrıcalık, dar fs scope)      │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
   Telemetri YOK · dış connect-src YOK (updater hariç ayrı host, imzalı)
```

### 3.2 Modül Sınırları (sert kural)

- `editor/*` ve `app/*` **asla** `@tauri-apps/*` import etmez; yalnız `services/*` eder. Editör Tauri'den ayrıdır (ileride web/mobil için mock servis takılabilir).
- Tüm IPC çağrıları tek `services/ipc.ts` wrapper'ından geçer (tipli `call<T>`); UI doğrudan `invoke` çağırmaz.
- Encoding ve satır-indeksi çekirdeği `src-tauri/src/core/` altında Tauri'den bağımsız → WebView'sız birim testi.

### 3.3 Veri Akışı ve Durum Yönetimi

- **Tek doğruluk kaynağı (SSOT) = Markdown/metin string.** İki editör motoru (CM6, Crepe) asla aynı anda canlı değil; mod geçişinde aktif motor SSOT'u serileştirir.
- Durum yönetimi: **hafif signal store** (`@lit-labs/preact-signals`, ~1 KB). React/Vue/Svelte store yok. Lit bileşenleri `SignalWatcher` ile otomatik re-render.
- Büyük dosyada CM6'ya tam metin verilmez; chunk penceresi/satır-indeksi tutulur.

```ts
// state/types.ts
export type EditorMode = 'source' | 'split' | 'wysiwyg' | 'stream';
export type DocKind = 'markdown' | 'text' | 'code';
export type Tier = 'full' | 'degraded' | 'streamViewer';
export interface DocState {
  id: string; path: string | null; title: string;
  encoding: string; hasBom: boolean; eol: 'LF' | 'CRLF' | 'Mixed';
  kind: DocKind; mode: EditorMode; tier: Tier;
  dirty: boolean; activeEngine: 'cm' | 'crepe';
}
```

---

## 4. Repo / Proje Yapısı

```
vael/
├─ Cargo.toml                  # [workspace] kök
├─ package.json                # pnpm.overrides ile CM6/katex pin
├─ pnpm-workspace.yaml
├─ vite.config.ts              # manualChunks: crepe/mermaid/katex/preview
├─ tsconfig.json · index.html
├─ src/                        # FRONTEND
│  ├─ main.ts
│  ├─ app/
│  │  ├─ app-shell.ts          # <app-shell> Lit kök
│  │  ├─ tab-bar.ts · status-bar.ts · command-palette.ts
│  ├─ editor/
│  │  ├─ source-view.ts        # CM6 sarmalayıcı (Lit host)
│  │  ├─ wysiwyg-view.ts       # Crepe (lazy)
│  │  ├─ split-view.ts         # CM6 + preview + scroll-sync
│  │  ├─ stream-viewer.ts      # >1 GB özel virtualized viewer
│  │  ├─ cm-setup.ts           # CM6 extension + Compartment'lar
│  │  ├─ cm-tiers.ts           # full/degraded extension setleri
│  │  ├─ lang-loader.ts        # lazy dil yükleme
│  │  ├─ markdown-lang.ts      # lang-markdown + codeLanguages
│  │  ├─ mode-switch.ts        # EditorController (mod orkestrasyonu)
│  │  ├─ roundtrip-guard.ts    # WYSIWYG lossy tahmini
│  │  └─ preview/
│  │     ├─ renderer.ts        # KANONİK markdown-it + prism
│  │     ├─ slug.ts            # PAYLAŞILAN slug
│  │     ├─ sanitize.ts        # DOMPurify
│  │     ├─ math.ts            # katex (texmath)
│  │     └─ mermaid.ts         # mermaid (lazy, iki-fazlı)
│  ├─ services/
│  │  ├─ ipc.ts                # call<T> tipli wrapper (TEK SINIR)
│  │  ├─ fs.ts · watch.ts · export.ts · inline-assets.ts
│  ├─ state/  store.ts · types.ts
│  └─ styles/  preview.css (preview+export ortak)
│
├─ src-tauri/
│  ├─ Cargo.toml · build.rs · tauri.conf.json
│  ├─ capabilities/main.json
│  ├─ icons/
│  └─ src/
│     ├─ main.rs · lib.rs
│     ├─ commands/
│     │  ├─ mod.rs · file.rs · encoding.rs · bigfile.rs
│     │  ├─ search.rs · tail.rs · watch.rs · export.rs
│     └─ core/                 # saf Rust, test edilebilir
│        ├─ encoding.rs        # BOM/EOL/decode
│        └─ line_index.rs      # sparse anchor + memchr
└─ tests/  roundtrip.spec.ts · render.spec.ts · fixtures/*.md
```

**Kök `Cargo.toml`:** `[workspace] members=["src-tauri"]`, `resolver="2"`, tüm crate sürümleri `[workspace.dependencies]`'te pinli.

**`package.json` kritik pin:**
```jsonc
"pnpm": {
  "overrides": {
    "@codemirror/state": "6.6.0",
    "@codemirror/view": "6.43.0",
    "@codemirror/language": "6",
    "katex": "0.17.0"
  }
}
```
> **Neden zorunlu:** Crepe kendi `@codemirror/*` kopyasını çekerse iki ayrı `@codemirror/state` instance → `Facet`/`StateField` kimlik bozulması, sessiz çökme. Tek-instance build-guard (CI'da `pnpm why @codemirror/state` → tek sürüm).

---

## 5. IPC Sözleşmesi

### 5.1 Hangi işlemler sınırı geçer

Yalnız şunlar Rust'a gider: encoding-tespitli açma, büyük-dosya chunked/satır okuma, encoding+BOM+EOL ile kaydetme, dosya izleme, streaming arama, tail/follow, export paketleme. **markdown-it/Prism/KaTeX/Mermaid/CM6/Milkdown saf frontend** — sınır geçişine gerek yok.

### 5.2 Command listesi

| Command | İmza (özet) | Açıklama |
|---|---|---|
| `open_big` | `(path) -> FileMeta` | Yalnız meta + encoding; tier belirler; içerik DÖNDÜRMEZ |
| `read_lines` | `(path, start_line, count, encoding, Channel<LinesChunk>)` | StreamViewer penceresi, akış |
| `read_chunk` | `(path, byte_offset, max_bytes, encoding) -> Chunk` | Byte-offset chunked okuma (degraded) |
| `read_all` | `(path, encoding) -> OpenResult` | Küçük/degraded dosya tam metin |
| `save_file` | `(path, text, encoding, add_bom, eol) -> FileMeta` | Atomik (temp+fsync+rename), lossy guard |
| `reopen_with_encoding` | `(path, encoding) -> OpenResult` | Diskten yeniden decode (reinterpret, dirty=false) |
| `search_file` | `(path, pattern, is_regex, case_insensitive, Channel<Vec<Hit>>)` | grep-searcher streaming, linear-time |
| `follow_tail` | `(path, Channel<LinesChunk>) -> watcher_id` | Log tail/follow, rotation tespiti |
| `watch_file` / `unwatch` | `(path) -> id` / `(id)` | notify debounce'lu izleme |
| `print_pdf` | `(html, out_path) -> path` | Gizli WebView print_to_pdf |
| `export_docx` | `(html, out_path) -> path` | Pandoc sidecar (opsiyonel) |
| `write_text_file` | `(path, text) -> path` | Standalone HTML export yazma |

### 5.3 Event'ler (backend → frontend)

```
file-changed       { path, kind: "modified"|"removed"|"renamed", watcher_id }
line-count-progress{ path, lines }       // büyük dosya satır sayımı arka planda
read-progress      { path, bytes_read, total }
save-progress      { path, pct }
update-available   { version, notes }    // updater plugin
```

> **Karar:** Büyük dosya pencere/arama/tail akışı tek-seferlik `invoke` dönüşü yerine `tauri::ipc::Channel<T>` ile streaming yapılır — ilk parça anında render (perceived < 500 ms), sıralı, düşük overhead.

---

## 6. Çekirdek Alt Sistemler

### 6.a Editör & Çift-Mod

**Üç düzenleme modu + bir viewer:**

| Mod | Motor | Yükleme | Kapsam |
|---|---|---|---|
| `source` | CM6 EditorView | eager | Her dosya tipi |
| `split` | CM6 + markdown-it preview (**aynı EditorView**) | preview lazy | Markdown/metin |
| `wysiwyg` | Crepe | lazy `import()` | Yalnız markdown |
| `stream` | Özel virtualized viewer | — | >1 GB salt-okunur |

**Mod geçiş sözleşmesi (state machine):**
- `source ↔ split`: aynı `EditorView`, yalnız preview panel toggle → **sıfır serileştirme**, anlık.
- `source/split → wysiwyg`: CM6 `doc.toString()` → Crepe `defaultValue`. CM6 view **destroy edilmez, gizlenir** (undo/scroll korunur). Geçişten önce `roundtrip-guard.predictRoundtrip` çalışır (offscreen Crepe ile md→md diff); lossy ise kullanıcı onayı/diff.
- `wysiwyg → source/split`: `crepe.getMarkdown()` → CM6 tam replace. Crepe **`destroy()`** edilir (Vue/ProseMirror belleği bırakılır → RAM hedefi).

**Round-trip riski:** Yalnız `source→wysiwyg→source` yönünde (Remark normalizasyonu: `*italic*`→`_italic_` vb.). CM6→md kayıpsız. CI invariant'ı **idempotency** (`f(f(x))===f(x)`); fixture seti: tablo, task-list, footnote, KaTeX, mermaid, ham HTML.

**CM6 kurulumu:** `basic-setup` yerine elle extension kompozisyonu + `Compartment`'lar (`language`/`theme`/`readOnly`/`lineWrap`). Çok dilli highlight `@codemirror/language-data` + `desc.load()` (her dil ayrı chunk); yaygın 5-6 dil `requestIdleCallback` ile ısıtma. `.md` için `markdown({ base: markdownLanguage, codeLanguages: languages })`.

**Crepe feature seti:** `CodeMirror/Latex/Table/ListItem/LinkTooltip/ImageBlock/BlockEdit/Toolbar/Placeholder` açık; **`AI` ve `TopBar` KAPALI** (offline/sıfır telemetri). `crepe.on(l=>l.markdownUpdated)` dirty için; `getMarkdown()` try/catch ile sarmalı (Milkdown #1640 koruması).

### 6.b Büyük Dosya / Buffer

**Üç-katmanlı eşik (kullanıcı override edilebilir):**

| Eşik | Mod | Motor | Highlight/Wrap | Find/Replace | Gerekçe |
|---|---|---|---|---|---|
| < 50 MB | Full | CM6 full | açık | Client (CM6 search) | ~3-4x RAM ≈ 200 MB sınırı |
| 50 MB–1 GB | Degraded | CM6 minimal | **KAPALI** (highlight asıl darboğaz; wrap uzun-satır layout patlaması) | **Rust** search_file | UTF-16 2x şişme → 1 GB üstü string tavanı |
| > 1 GB | StreamViewer | **Özel virtualized (CM6 DEĞİL)** | yok | Rust zorunlu | CM6 `Text` rope tüm belgeyi materialize eder, lazy doc yok |

**Neden >1 GB'da özel viewer:** CM6 `EditorState.create({doc})` tam string ister; 1 GB+ string WebView'e sığmaz. Özel viewer yalnız görünür pencere + sparse satır-indeksi + LRU cache tutar → sub-100 MB RAM'de multi-GB açma.

**Satır indeksi:** Sparse anchor (her N. satır offset'i) + `memchr` SIMD newline tarama, `memmap2` üzerinde, tokio arka plan task'ı. 100M satır → ~800 KB (tam offset dizisi 800 MB olurdu). mmap `unsafe` riski `notify` watcher ile harici-değişim tespitiyle yönetilir.

**Degrade'de KAPALI extension'lar:** `syntaxHighlighting`/`lang-*`, `lineWrapping`, `bracketMatching`, `foldGutter`, `highlightActiveLine`, `highlightSelectionMatches`, `indentOnInput`, client `search`. Runtime `Compartment.reconfigure` ile geçiş; `EditorState.changeFilter` ile `MAX_EDIT_LENGTH` guard.

**Find/Replace (Notepad++ çözümü):** `grep-searcher` + `grep-regex` (ripgrep motoru). Rust `regex` **backtracking yapmaz** → catastrophic backtracking imkânsız, multi-GB'da sabit bellek. Sonuçlar Channel'dan 1000'lik batch. Replace = streaming temp dosyaya yaz + atomik rename.

**Tail/follow:** `notify` + `notify-debouncer-full` (saniyede binlerce append → tek batch). `encoding_rs::Decoder` stateful (append sınırında multi-byte koruması). Rotation tespiti (len küçülürse offset sıfırla).

### 6.c Encoding & I/O Spesi

**Tek cümlelik ilke:** *Encoding/BOM/EOL kullanıcının verisidir; uygulama görünür kılar ve yalnız açık komutla değiştirir — asla tahmin edip sessizce yeniden yazmaz.*

**İsim ↔ byte ayrımı (Notepad++ #16814 yapısal önlemi):** `save_file` parametreleri `encoding` (etiket) + `add_bom` (bayrak) **ayrı**; isim ile BOM kararı hiçbir yerde iç içe geçmez. "UTF-8" vs "UTF-8-BOM" yalnız `add_bom` ile ayrışır; Rust tek `UTF_8` kullanır. `encodingBase("UTF-8-BOM")="UTF-8" + addBom=true`.

**BOM sniff sırası (kritik):** `FF FE 00 00` (UTF-32 LE) mutlaka `FF FE` (UTF-16 LE) ÖNCESİNDE kontrol edilir.

**Tespit hattı:** BOM → kesin; BOM yoksa önce katı UTF-8 doğrulaması (hızlı, sık); başarısızsa chardetng (Türkçe legacy 1254/ISO-8859-9). Düşük güvende açılır ama UI uyarı rozeti.

**AÇ davranış tablosu (özet):**

| Girdi | meta.encoding | has_bom | Görüntü |
|---|---|---|---|
| `EF BB BF` | `UTF-8-BOM` | true | BOM soyulmuş |
| Geçerli UTF-8, BOM yok | `UTF-8` | false | metin (High) |
| `FF FE 00 00` | `UTF-32 LE` | true | metin (kaydet UTF-32 kapalı, UTF-8'e dönüştür önerilir) |
| Türkçe legacy | tahmin (1254/ISO-8859-9) | false | uyarı rozeti olası |

**KAYDET mutlak kuralı:** Açılıştaki `encoding+has_bom+eol` üçlüsünü birebir korur. Varsayılan yeni dosya = **BOM'suz UTF-8**. BOM otomatik enjekte/soyulmaz. Lossy karakter (`€` → Windows-1254) → **kaydet öncesi diyalog** (Devam-kayıplı / UTF-8'e geç / İptal); sessiz `?` yok.

**reopen vs convert vs set-bom ayrımı:**

| Komut | Diskten okur | dirty? | Kullanım |
|---|---|---|---|
| Reopen with Encoding (reinterpret) | Evet | Hayır | Yanlış tahmini düzelt |
| Convert to Encoding | Hayır | **Evet** | Bundan sonra UTF-8 yap |
| Set BOM on/off | Hayır | **Evet** | UTF-8 ↔ UTF-8-BOM |

> convert/set-bom anında yazmaz; yalnız `DocState`'i günceller + `dirty=true`. Gerçek serileştirme tek yerde (`save_file`) → ters-çevirme/çift-dönüşüm hatasına yer yok.

**EOL:** Varsayılan = mevcut EOL'u koru. `Mixed` sessizce düzeltilmez (git-diff gürültüsü); uyarı rozeti + tek-tık normalize. CM6 `lineSeparator` doküman EOL'una bağlanır.

**Atomik kaydet:** Aynı-dizin `NamedTempFile` + `write_all` + `sync_all` (fsync) + `persist` (atomik rename) + dizin fsync (POSIX). Symlink `canonicalize` ile korunur. Unix mode / Windows ACL korunur. Save sırasında o path watcher'ı 500 ms susturulur (self-write suppression).

**Çatışma matrisi (disk × bellek):** disk değişti + dirty değil → yumuşak reload; disk değişti + dirty → **çatışma banner'ı** (Disk'i Yükle / Belleğimi Tut / Karşılaştır), otomatik karar YOK.

### 6.d Markdown Pipeline & Export

**TEK RENDER MOTORU = markdown-it (JS).** Hem canlı preview hem TÜM export'lar aynı `renderMarkdown()` kanonik HTML'inden türer. **comrak markdown→HTML üretim yolundan çıkarıldı** (yedek/CI-referans rolüne indirildi).

> **Neden:** comrak math'i (sadece `data-math-style`) ve mermaid'i render etmez, JS plugin'leri (anchor slug, footnote id, task-list, Prism) çalıştıramaz → iki motor **zorunlu drift** üretir. Tek motorla **drift mimari olarak imkânsız** ("gördüğün = aldığın").

**Pipeline:** `markdown-it` 14.2.0 (`html:false`, `linkify:true`, `typographer:false` — determinizm) + `markdown-it-anchor` 9.2.0 (**paylaşılan `slug.ts`** — en sinsi drift kaynağı) + `markdown-it-footnote` 4.0.0 + `@hackmd/markdown-it-task-lists` 2.1.4 (orijinal bakımsız) + `markdown-it-texmath` 1.0.0 (engine KaTeX 0.17, `output:'htmlAndMathml'`) + Prism 1.30 highlight callback. → DOMPurify 3.4 (`USE_PROFILES{html,svg,mathMl}`).

**Matematik:** KaTeX senkron gömülür; export için sadece CSS+fontlar `data:` URI olarak gömülür.

**Mermaid:** İki-fazlı — renderer placeholder (`<pre.mermaid-src>`), sonra asenkron lazy `mermaid` 11.15 (`securityLevel:'strict'`) SVG. Export SVG'yi settle edip gömer → preview↔export birebir aynı.

**Export hedefleri (hepsi aynı kanonik HTML'den):**

| Format | Yol | Gerekçe |
|---|---|---|
| HTML | Standalone (CSS+KaTeX font+Prism gömülü), saf yazma | Offline, taşınabilir |
| PDF (birincil) | **WebView print_to_pdf** (gizli pencere) | Birebir sadakat, sıfır binary, offline |
| PDF (ikincil) | Typst 0.13 gömülü (Apache-2.0) | Deterministik rapor/sayfa no/CI |
| DOCX | Pandoc sidecar (opsiyonel) | Ayrı süreç → GPL bulaşması yok; yoksa UI gri |

**Tutarlılık testi:** Katman A golden snapshot (`renderMarkdown`, hem preview hem export'u korur); Katman B comrak çapraz-kontrol (sapma=uyarı, regresyon dedektörü); Katman C PDF smoke. "Tek motor VEYA round-trip" ikileminde **ikisi birden**.

---

## 7. Gizlilik/Güvenlik, Capabilities/CSP, Eklenti Noktaları

**Tehdit modeli:** Tauri v2 — **WebView untrusted-by-default**. Her IPC yüzeyi pencere+komut+scope bazında izinli.

**Capabilities (`capabilities/main.json`, en az ayrıcalık):**
- `fs:default` YOK; tek tek `allow-read-file`/`allow-write-file`/`allow-stat`/`allow-exists` + dar `fs:scope` (`$HOME`/`$DOCUMENT`/`$DESKTOP` allow; `$HOME/.ssh/**` + `$HOME/.gnupg/**` **deny**).
- Dialog ile açılan dosyalar runtime `FsExt::allow_file()` ile scope'a eklenir → gerçek erişim kullanıcı onayına bağlı.
- `dialog`: yalnız `allow-open`/`allow-save`. `updater`: imzalı (`pubkey`). `store`: ayar.
- `shell` YOK — Pandoc opsiyonel, ayrı capability arkasında `shell:allow-execute` yalnız bilinen `pandoc` binary'sine, kullanıcı onayıyla.

**CSP:** `script-src 'self'` (Mermaid `securityLevel:'strict'`, `'unsafe-eval'` yok), `style-src 'self' 'unsafe-inline'` (KaTeX/Mermaid inline stil), dış `connect-src` YOK. **Sıfır telemetri**; tek dış bağlantı opsiyonel updater (ayrı host, imza zorunlu).

**Eklenti/uzantı noktaları:** Servis katmanı (`services/*`) mock-edilebilir → ileride web/mobil hedef. CEF/Servo backend olgunlaştığında geçiş yolu servis-izolasyonuyla açık. markdown-it eklenti mimarisi yeni sözdizimi için genişletilebilir.

---

## 8. Dağıtım, İmzalama, Oto-Güncelleme, CI/CD

| Konu | Karar |
|---|---|
| Bundle hedefleri | `targets:"all"` — Windows (MSI/NSIS), macOS (.app/.dmg evrensel), Linux (AppImage/deb) |
| İmzalama | macOS notarization, Windows code-sign; updater için `tauri signer` ile imzalı artifact + `pubkey` config |
| Oto-güncelleme | `tauri-plugin-updater`, imza zorunlu, ayrı host (`releases.vael.dev`), sıfır telemetri (yalnız sürüm kontrolü) |
| CI matris | Windows/macOS/Linux runner'lar; `tauri build --target` |
| Build-guard testleri | (1) `pnpm why @codemirror/state` → tek sürüm (yoksa fail); (2) bundle-bütçe testi (eager chunk eşiği); (3) `cargo test -p core` (encoding/line_index, WebView'sız) |
| **Linux görsel smoke** | Gerçek WebKitGTK 2.44+ runner'da render smoke-test (Risk 1) |
| Pandoc | ASLA bundle'lanmaz |

**Vite build:** `manualChunks: { crepe, mermaid, katex, preview }` → ağır modüller ayrı lazy chunk. Eager = Lit + CM6 source + lang-markdown.

---

## 9. UX/UI ve MVP Özellik Seti

### 9.1 UI Düzen Şeması

```
┌────────────────────────────────────────────────────────┐
│ [tab-bar]  doc1.md ×  | log.txt ×  | + │  ☰ cmd-palette │
├────────────────────────────────────────────────────────┤
│                                                        │
│   editor alanı (source | split | wysiwyg | stream)     │
│   ┌──────────────┬──────────────┐  (split modunda)     │
│   │  CM6 source  │  preview      │                      │
│   └──────────────┴──────────────┘                      │
│                                                        │
├────────────────────────────────────────────────────────┤
│ satır 142, sütun 7 │ UTF-8 ▾ │ CRLF ▾ │ ⚠tahmin │ ●mod │
└────────────────────────────────────────────────────────┘
                              [status-bar — encoding/EOL/BOM HER ZAMAN görünür]
```

### 9.2 MVP Özellikleri (önceliklendirilmiş, kabul kriterli)

> Durum kolonu (2026-07-01, main): ✅ tamam · ◑ kısmi · ⬜ başlanmadı. Birim testler: 40 Rust + 43 vitest yeşil.

| # | Özellik | Öncelik | Durum | Kabul kriteri |
|---|---|---|---|---|
| 1 | Dosya aç/kaydet + encoding/BOM/EOL tespiti ve görünür gösterimi | P0 | ✅ | Açılan dosyanın encoding/BOM/EOL'u status-bar'da doğru; kaydet üçlüyü korur. `encoding.rs` golden testleri; name↔byte ayrımı. |
| 2 | CM6 source modu + syntax highlight (lazy diller) | P0 | ✅ | Full tier'da highlight + lazy `language-data`; degraded'da Compartment ile kapanır. |
| 3 | Split live-preview (markdown-it + KaTeX + Prism) | P0 | ✅ | markdown-it→DOMPurify kanonik motoru (preview=export), Source/Split, 150 ms debounce, task-list+footnote. **Prism** highlight (statik token, offline). **KaTeX** math (`$…$`/`$$…$$`, MathML çıktısı — WebView'de native render, font/CSS gerektirmez, offline; KaTeX-HTML pixel render sonraki rafinaj). **Scroll-sync** (oransal, leader-lock). Not: Mermaid P2 (#12). |
| 4 | Atomik kaydet + lossy guard | P0 | ✅ | Atomik tempfile+fsync+rename; lossy hedefte 3-seçenekli diyalog — **UTF-8'e dönüştür (kayıpsız) / yine de kaydet (kayıplı, kullanıcı onayı) / iptal**. Backend `allow_lossy` + `SaveOutcome {saved|lossy}` (lossy bir hata değil, onay ister). name↔byte ayrımı korunur. |
| 5 | Büyük dosya: degraded + StreamViewer | P0 | ✅ | 3-katman; `memmap2`+sparse index+Channel `read_lines`; virtualized viewer; generation/path-tagged yaşam döngüsü. GUI smoke testi (1.2 GB log) ✅; canlı-test + adversarial-review düzeltmeleri uygulandı. |
| 6 | Rust streaming find/replace | P1 | ◑ | **Find** ✅: `search_file` (grep-searcher/grep-regex), linear-time (ReDoS testi), Channel akış, stream-viewer find bar (Ctrl+F); encoding-aware (legacy charset transcode). **CM6 tier find** ✅: `@codemirror/search` (Ctrl+F/G), Full+Degraded'da, dark-themed panel. **Eksik:** replace (CM6 panel'de mevcut ama akış olarak büyük-dosya replace yok). |
| 7 | WYSIWYG (Crepe, lazy) + round-trip guard | P1 | ⬜ | Lossy uyarısı; idempotent geçiş |
| 8 | HTML + PDF export | P1 | ◑ | **HTML** ✅: `buildStandaloneHtml` — canlı preview ile AYNI kanonik `renderMarkdown`'dan türer (drift imkânsız); tek `<style>` bloğunda inline stil (paylaşılan `preview/prose-styles.ts` → pane+export tek kaynak), harici `<link>`/`<script>`/`@import` yok, math native MathML (font/CSS gömme gerektirmez) → tam offline, taşınabilir. Rust `write_text_file` (atomik, encoding policy'siz). `@media print` (ink-friendly açık tema — tarayıcı yazdırırken arka planları düşürür → koyu tema boş sayfa olurdu). Full tier'a kısıtlı (markdown-it sınırsız). 8 golden test (self-contained stil + title-escape/XSS + remote-img limiti + print). Adversarial review (3/3 confirmed): (a) docstring/test "self-contained" iddiası düzeltildi — remote `<img>` offline değil, açılışta URL fetch eder (IP/UA sızıntısı); (b) print tema; (c) unix yeni-dosya modu (umask'lı 0644, canonicalize-fail fallback'inde tempfile 0600 kalıyordu — export+Save-As etkiliydi). **Eksik (PDF):** WebView `print_to_pdf` (birincil) — GUI/platform doğrulaması gerekir; remote görsel `data:` gömme (`inline-assets.ts`) sonraki rafinaj. |
| 9 | Dosya izleme + çatışma banner'ı | P1 | ✅ | `notify`+`notify-debouncer-full` ile harici değişiklik izleme (parent-dir izlenir → atomic temp+rename replace de görülür); debounced `file-changed` eventi. Temiz buffer → sessiz reload; dirty → **3-seçenekli banner** (Reload / Save as… / Keep mine); dosya silindiyse "Save to restore". Kendi kaydımızın watcher echo'su **mtime kimliğiyle** ayırt edilir (kaydettiğimiz mtime = echo → yok say; harici yazma mtime'ı değiştirir → işlenir; sabit zaman penceresi yok, kayıp olay yok). Save-As hedef yolu `trySave`'e paramla geçer — başarısız/iptal Save-As orijinal dosyanın watch'ını ve banner'ını bozmaz. Save-As match ismi canonicalize edilir (case-insensitive FS'te farklı-case ad watch'ı öldürmez). Read-only stream tier izlenmez. (Adversarial review düzeltmeleri.) |
| 10 | Komut paleti + kısayollar | P2 | ✅ | **Ctrl/Cmd+Shift+P** palet (fuzzy-filtre + klavye nav: ↑↓/Enter/Esc, disabled satır atlanır, eşleşen harf highlight). Komutlar app-shell state'inden canlı `enabled` ile üretilir (Open/Save/Save As/Export HTML/Reload/Source/Split). Ranking saf+test-edilir (`commands.ts`: alt-dizi skorlama, ardışık+kelime-sınırı bonusu, uzunluk tiebreak). Uygulama-geneli kısayollar: Ctrl+O/S, Ctrl+Shift+S (window capture, WebView default'larını önler). 16 test (11 ranking + 5 component interaction; component testi çift-keydown bug'ını yakaladı). |
| 11 | DOCX export (Pandoc varsa) | P2 | ⬜ | Pandoc yoksa gri |
| 12 | Mermaid diyagram (lazy) | P2 | ⬜ | İlk diyagramda yüklenir, strict |

### 9.3 Kısayollar

| Kısayol | Eylem |
|---|---|
| Ctrl/Cmd+O · S · Shift+S | Aç · Kaydet · Farklı kaydet |
| Ctrl/Cmd+F · H | Bul · Değiştir (büyük dosyada Rust search) |
| Ctrl/Cmd+P · Shift+P | Hızlı aç · Komut paleti |
| Ctrl/Cmd+1 · 2 · 3 | Source · Split · WYSIWYG modu |
| Ctrl/Cmd+W · Tab | Sekme kapat · Sekme değiştir |

> Kısayol scope'lanır: CM6 keymap yalnız CM aktifken bağlı (Crepe ile çakışma yok).

---

## 10. Yol Haritası

| Milestone | Teslimat | Çıkış kriteri | Sıra/efor |
|---|---|---|---|
| **M0 — PoC/Spike (2-3 hafta)** | (1) **Linux WebKitGTK render PoC**: CM6+Crepe+KaTeX+Mermaid gerçek WebKitGTK 2.44+'da; (2) **Büyük-dosya PoC**: 12 GB log mmap+sparse-index+StreamViewer; (3) CM6+Crepe tek-instance pin doğrulama | Linux render kabul edilebilir VEYA env-var workaround belgelendi; 12 GB dosya sub-100 MB'da scroll; `pnpm why` tek sürüm | EN ÖNCE — engelleyici riskler |
| **M1 — MVP (6-8 hafta)** | P0 seti: aç/kaydet+encoding, CM6 source, split preview, atomik kaydet+lossy, degraded+StreamViewer | Bir kullanıcı kod+markdown açıp düzenleyip doğru encoding'le kaydedebiliyor; büyük dosya açılıyor; <500 ms/sub-100 MB ölçüldü | M0 sonrası |
| **M2 (4-6 hafta)** | P1: Rust find/replace, WYSIWYG+roundtrip-guard, HTML+PDF export, dosya izleme+çatışma | Streaming arama çökmüyor; WYSIWYG idempotent; export preview-aynı; çatışma banner'ı çalışıyor | |
| **M3 (4 hafta)** | P2: komut paleti, DOCX (Pandoc), Mermaid, oto-güncelleme, imzalama, CI matris | İmzalı release artifact'ları üç platformda; updater çalışıyor; tüm CI guard'ları yeşil | |

---

## 11. Risk Kaydı

| # | Risk | Etki | Olasılık | Azaltma |
|---|---|---|---|---|
| 1 | **Linux WebKitGTK render/compositing kararsızlığı** (gölge-DOM kopyaları, NVIDIA/Wayland beyaz ekran, animasyon bulanıklığı) — açık, düzeltmesiz upstream bug'ları | Yüksek (Linux'ta) | Yüksek | Linux "best-effort" tut (ana=Win/macOS); `WEBKIT_DISABLE_DMABUF_RENDERER=1` enjekte; min 2.44+; **M0'da görsel smoke-test**; CSS animasyon minimuma; CEF/Servo geçiş yolu açık |
| 2 | Multi-GB **tam-dosya** WebView yükleme | Engelleyici (yapılırsa) | — | Zaten tasarımda çözüldü: chunked okuma + büyük-dosyada preview/WYSIWYG kapatma + StreamViewer. **Kapsam kararı, engelleyici değil** |
| 3 | Çift `@codemirror/state` instance (Facet/StateField kimlik bozulması) | Yüksek (sessiz çökme) | Orta | `pnpm.overrides` pin + CI build-guard (`pnpm why`) |
| 4 | Performans hedefi delinmesi (ağır modüller eager yüklenirse) | Orta | Orta | Crepe/Mermaid/KaTeX/markdown-it lazy `manualChunks`; Crepe çıkışta `destroy()`; bundle-bütçe CI testi; hedefi "boş+markdown" olarak tanımla |
| 5 | WYSIWYG round-trip kaybı (Remark normalizasyon) | Orta | Orta-Yüksek | `predictRoundtrip` lossy guard + kullanıcı onayı; idempotency CI testi |
| 6 | Export drift (preview≠export) | Orta | Düşük (tek-motor sonrası) | Tek kanonik markdown-it motoru; paylaşılan slug; golden snapshot + comrak çapraz-kontrol |
| 7 | WebView regex catastrophic backtracking (büyük dosya find) | Orta | Düşük (Rust sonrası) | Find/replace Rust `grep-regex` (backtracking yok, linear-time) |
| 8 | Tauri v2 tuzakları (`generate_handler!` unutma, blanket `fs:default`, v1/v2 doküman karışımı, Linux GTK build) | Orta | Orta | En-az-ayrıcalık capability planı; CI'da capability denetimi; v2-only doküman |
| 9 | Sessiz veri kaybı (encoding/BOM/EOL yanlış yazma) | Yüksek (güven kaybı) | Düşük (tasarım sonrası) | İsim↔byte ayrı param; tek yazma yolu; snapshot golden testler (NPP regresyonları) |

---

## 12. İlk Hafta / Hemen Başlanacak İşler

**Sıra kritik: en riskli iki spike ÖNCE (M0).**

1. **(Gün 1-3) Linux WebKitGTK render PoC.** Minimal Tauri v2 iskeletinde CM6 source + lazy Crepe + KaTeX + bir Mermaid diyagramı. Gerçek WebKitGTK 2.44+ (Ubuntu 24.04 + NVIDIA/Wayland dahil) test et. Maximize/un-maximize, scroll, drag-select dene. `WEBKIT_DISABLE_DMABUF_RENDERER=1` ile/olmadan karşılaştır. **Çıktı:** Linux kabul edilebilir mi kararı + env-var workaround belgesi.
2. **(Gün 2-5) Büyük-dosya PoC.** Rust: `memmap2` + `memchr` sparse line index + `read_lines` Channel streaming. Frontend: minimal StreamViewer (sanal scroll, LRU cache). 12 GB üretilmiş log ile test. **Çıktı:** İlk içerik < 500 ms, scroll akıcı, RAM sub-100 MB ölçümü.
3. **(Gün 3-4) Tek-instance doğrulama.** `package.json` `pnpm.overrides` + Crepe lazy mount; `pnpm why @codemirror/state` tek sürüm gösteriyor mu. CM6 source + Crepe kod-bloğu aynı uygulamada `Facet` bozulmadan çalışıyor mu.
4. **(Gün 4-5) Cargo workspace + capabilities iskeleti.** `core/encoding.rs` (BOM sniff + UTF-32/16 sıra testi) + `core/line_index.rs` birim testleri (WebView'sız). `capabilities/main.json` dar scope.
5. **(Gün 5) CSP + sıfır-telemetri doğrulama.** `tauri.conf.json` CSP, dış `connect-src` yok; ağ trafiği yakalayıcı ile sıfır dış istek doğrula.

---

## 13. Açık Sorular / Verilecek Kararlar

1. **Linux desteği seviyesi:** WebKitGTK riski göz önüne alınınca Linux "tam destekli" mi yoksa "best-effort/deneysel" mi etiketlenecek? (M0 PoC sonucu belirleyecek.)
2. **Büyük dosya eşik değerleri:** 50 MB / 1 GB varsayılanları sahada doğru mu? Donanım-bazlı dinamik eşik gerekir mi?
3. **PDF birincil yol:** WebView print_to_pdf üç platformda yeterli sadakat veriyor mu, yoksa Typst M1'e mi çekilmeli? (M0/M1 değerlendirmesi.)
4. **Crepe AI feature:** Tamamen kaldırılsın mı yoksa "tümüyle yerel model" opsiyonu ileride değerlendirilsin mi? (Şu an KAPALI, offline taahhüdü gereği.)
5. **WYSIWYG normalizasyon politikası:** Lossy round-trip'te varsayılan "uyar ve sor" mu, yoksa kullanıcı "her zaman kabul et" tercihi sunulsun mu?
6. **Updater host:** `releases.vael.dev` self-hosted mı, yoksa GitHub Releases tabanlı mı? (İmza zorunlu her durumda.)
7. **EOL/encoding satır-içi göstergesi:** Status-bar dışında satır-sonu görünür işaretleyici (göster/gizle) MVP'de mi M2'de mi?
8. **Tema sistemi:** MVP'de yalnız açık/koyu mu, yoksa özelleştirilebilir token tabanlı tema M3'e mi?

---

Bu plan girdideki tüm kararları tek sesle birleştirir; çözülen başlıca çatışmalar: (a) **comrak'ın export render rolü kaldırıldı** (tek kanonik markdown-it motoru → drift imkânsız), (b) **PDF için WebView print_to_pdf birincil, Typst ikincil** olarak netleştirildi, (c) **performans hedefi dürüstçe "boş+markdown modu" olarak sınırlandı**, (d) **Linux en yüksek artık risk** olarak yol haritasında M0 spike'ına çekildi. Engelleyici tek somut nokta (multi-GB tam-dosya yükleme) zaten chunked/StreamViewer kararıyla kapsam dışına alınmıştır.


