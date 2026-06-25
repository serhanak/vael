# Buyuk dosya ve buffer modeli

# Mimari Doküman: Büyük Dosya / Multi-GB Log İşleme Stratejisi

> Tarih: Haziran 2026. Bu doküman kilitlenen yığın ve mimari kararlar üzerine, "büyük dosya" farklılaştırıcısının implementasyon seviyesinde tasarımıdır. Sürümler aşağıda araştırılarak doğrulandı.

## 0. Problem Analizi ve Tasarım Tezi

### 0.1 Rakip neden çöküyor (Notepad++/Scintilla)
- **Scintilla'nın bellek modeli:** Tüm belgeyi tek bir gapped buffer'da bellekte tutar; ayrıca her satır için styling/line-position dizileri tutar. Pratikte dosya boyutunun **~3-4 katı RAM** tüketimi ve 32-bit kökenli **~2 GB pratik tavan** buradan gelir.
- **Uzun satır çökmesi:** Satır bazlı veri yapıları (line start array, per-line styling) tek-satırlık multi-MB içerikte (minified JSON, satır sonu olmayan log) O(n) layout ve styling'i her düzenlemede yeniden yapar → donma.
- **Regex find/replace çökmesi:** Tüm belgeyi tek string olarak backtracking regex motoruna verir; multi-GB + catastrophic backtracking → bellek patlaması / hang.

### 0.2 CM6'nın gerçek sınırları (araştırma bulgusu)
- CM6 `Text` rope-benzeri immutable ağaçtır; **birkaç milyon satırı** ve viewport virtualization'ı kaldırır ([huge doc demo](https://codemirror.net/examples/million/) milyon satır gösterir). State oluşturma ~47 ms, view ~9 ms ölçülmüştür.
- **Yerleşik hard limit YOK.** Marijn'in net tavsiyesi: limiti **kendin** `changeFilter`/`EditorState.changeFilter` ile koy (`tr.newDoc.length < MAX`). Yani uygulama eşiği biz koyacağız.
- **Gerçek darboğazlar viewport değil, extension'lar:** `lang-json` gibi parser highlight, tema, ve `dispatch` ile dev içerik replace 3-4 sn'ye çıkabiliyor. Yani **highlighting/tema** asıl maliyet.
- **Uzun satır (newline'sız multi-MB satır) CM6'nın da zayıf noktası:** viewport virtualization satır-bazlıdır; tek dev satır viewport'a sığmaz, line-wrapping açıkken layout O(satır uzunluğu) olur.

### 0.3 Tasarım tezi
> CM6 "çok satırlı büyük dosyayı" (örn. 200 MB, 5M satır) editleme modunda kaldırabilir ama **multi-GB dosyanın tamamını WebView belleğine koymak** hem WebView string limiti (V8/JSC ~512 MB-1 GB string tavanı) hem de IPC serialize maliyeti yüzünden imkânsız. Dolayısıyla **iki ayrı yol** gerekir:
> 1. **CM6-degrade yolu** (eşik altı, editlenebilir, tüm metin bellekte).
> 2. **Özel virtualized read-only stream viewer** (eşik üstü, asla tüm metni belleğe almaz). Bu, multi-GB log farklılaştırıcısının kalbidir.

---

## 1. Eşikli Strateji (gerekçeli)

| Eşik | Mod | CM6 / Viewer | Açık extension'lar | Encoding | Find/Replace | Gerekçe |
|---|---|---|---|---|---|---|
| **< 50 MB** | Tam özellik, editlenebilir | CM6 full | highlight + lang + wrap + bracket + activeLine + search match | tam tespit (eager satır sayımı) | client-side (CM6 `@codemirror/search`) | 50 MB metin WebView'de rahat; full highlight maliyeti kabul edilebilir. UTF-8'de ~50 MB ≈ on milyonlarca karakter, CM6 sınırının altında. |
| **50 MB – 1 GB** | Degrade, editlenebilir | CM6 "minimal" | satır no + selection; **highlight KAPALI, wrap KAPALI, bracketMatching KAPALI, activeLineHighlight KAPALI, foldGutter KAPALI** | tespit var, satır sayımı **lazy** (Rust streaming) | **Rust tarafı** (grep-searcher) → eşleşmelere atla | Highlight asıl darboğaz (bulgu §0.2). Wrap kapalı = uzun satır layout patlaması engellenir. CM6 hâlâ tüm metni tutar ama parser/styling yükü olmadan birkaç yüz MB / milyonlarca satır akıcı. |
| **> 1 GB** | **Salt-okunur stream viewer** | **Özel virtualized viewer** (CM6 değil) | yok (kendi minimal render'ımız) | tespit ilk 64 KB'tan; satır indeksi Rust'ta arka planda | **Rust tarafı zorunlu** (grep-searcher streaming, mmap) | Tüm metni belleğe almak imkânsız (V8 string limiti + RAM). Sadece görünür pencere + indeks bellekte. Bu mod editlemeyi feda eder, multi-GB'ı sub-100 MB RAM'de açar → farklılaştırıcı. |

**Eşik gerekçelendirmesi (sayısal):**
- **50 MB:** WebView'e gönderilen string + CM6 rope + highlight styling ≈ 3-4x → ~200 MB; sub-100 MB hedefini zorlamaya başladığı nokta. Highlight'ın değdiği son boyut.
- **1 GB:** UTF-8 → UTF-16 dönüşümü WebView'de ~2x şişer (1 GB → ~2 GB JS string), V8/JSC string tavanına çarpar. Bu yüzden 1 GB üstü asla full-load edilmez.
- Eşikler **kullanıcı tarafından override edilebilir** (ayar) ama varsayılan bu.

---

## 2. Rust Tarafı: Dosya Okuma, İndeksleme, Streaming

### 2.1 Crate listesi (doğrulanmış, Haziran 2026)

| Crate | Sürüm | Rol |
|---|---|---|
| `memmap2` | **0.9.10** | >1 GB dosyada zero-copy random access (byte-range okuma, satır indeksi tarama). `unsafe Mmap::map` — dosya harici değişim riskine karşı watcher ile koruma. |
| `grep-searcher` | **0.1.16** | Hızlı satır-yönelimli arama; `Searcher` + `Sink` ile multi-GB üzerinde streaming search (mmap veya buffered, otomatik seçim). |
| `grep-regex` | 0.1.x | `Matcher` impl (Rust `regex` crate — finite automata, backtracking YOK → catastrophic backtracking imkânsız, Notepad++ sorununun kökten çözümü). |
| `grep-matcher` | 0.1.x | `Matcher` trait soyutlaması. |
| `regex` | 1.x | Find/replace + satır tarama (linear-time garanti). |
| `memchr` | 2.x | SIMD'li newline (`\n`) tarama — satır indeksi oluşturmanın çekirdeği. |
| `encoding_rs` | 0.8.x | Decode/encode (chunk decode için `Decoder` streaming API). |
| `chardetng` | 0.1.x | İlk 64 KB'tan charset tespiti. |
| `notify` | **8.2.0** (stable; 9.0.0-rc mevcut) | FS watch — tail/follow log modu + harici değişim tespiti. |
| `notify-debouncer-full` | 0.x (notify ile eşli) | Watch event debounce (log'a saniyede binlerce append → tek event). |
| `tokio` | 1.x | Async command'lar, arka plan indeksleme task'ı, `mpsc` ile streaming. |

> Neden `grep-searcher`/`grep-regex`: ripgrep'in motoru. Rust `regex` crate **backtracking kullanmaz** (Thompson NFA + lazy DFA), bu yüzden multi-GB + kötü pattern'de bile linear-time, bellek sabittir → Notepad++ regex çökmesinin yapısal çözümü. mmap vs buffered seçimini otomatik yapar.

### 2.2 Satır indeksi (sayfalama / hızlı seek'in çekirdeği)

> 16 byte/satır yerine **sparse index**: her N'inci satırın byte offset'ini tut. Multi-GB'da tüm satır offset'lerini tutmak (örn. 100M satır × 8 byte = 800 MB) sub-100 MB hedefini bozar. Sparse + lokal tarama optimaldir.

```rust
// core/line_index.rs  — Tauri'den bağımsız, test edilebilir
pub struct SparseLineIndex {
    /// her STRIDE'inci satırın byte offset'i
    anchors: Vec<u64>,
    stride: u64,          // örn. 1000 satır
    total_lines: u64,
    total_bytes: u64,
}

impl SparseLineIndex {
    /// mmap üzerinde memchr ile newline say — arka plan task'ında akış
    pub fn build(data: &[u8], stride: u64) -> Self {
        let mut anchors = vec![0u64];
        let mut line: u64 = 0;
        let mut start = 0usize;
        while let Some(pos) = memchr::memchr(b'\n', &data[start..]) {
            let abs = (start + pos + 1) as u64;
            line += 1;
            if line % stride == 0 { anchors.push(abs); }
            start += pos + 1;
        }
        Self { anchors, stride, total_lines: line + 1, total_bytes: data.len() as u64 }
    }

    /// satır numarasından byte offset: en yakın anchor + lokal tarama
    pub fn offset_of_line(&self, data: &[u8], line: u64) -> u64 {
        let anchor_idx = (line / self.stride) as usize;
        let mut off = self.anchors[anchor_idx] as usize;
        let mut cur = anchor_idx as u64 * self.stride;
        while cur < line {
            match memchr::memchr(b'\n', &data[off..]) {
                Some(p) => { off += p + 1; cur += 1; }
                None => break,
            }
        }
        off as u64
    }
}
```
Bellek: 100M satır, stride 1000 → 100K anchor × 8 byte = **800 KB**. mmap'in kendisi RAM saymaz (OS page cache, lazy).

### 2.3 Command'lar ve streaming IPC

```rust
// commands/bigfile.rs
use tauri::{ipc::Channel, AppHandle, State};

#[derive(serde::Serialize, Clone)]
pub struct FileMeta {
    pub path: String,
    pub byte_len: u64,
    pub encoding: String,
    pub has_bom: bool,
    pub eol: String,
    pub tier: Tier,              // Full | Degraded | StreamViewer
    pub line_count: Option<u64>, // büyük dosyada None (arka planda dolar)
}

#[derive(serde::Serialize, Clone)]
pub enum Tier { Full, Degraded, StreamViewer }

/// Açılış: yalnız meta + encoding. ASLA tüm metni döndürmez (büyükse).
#[tauri::command]
async fn open_big(path: String, app: AppHandle) -> Result<FileMeta, String> {
    let len = std::fs::metadata(&path).map_err(e2s)?.len();
    let tier = match len {
        0..=52_428_800            => Tier::Full,        // < 50 MB
        52_428_801..=1_073_741_824 => Tier::Degraded,   // 50 MB–1 GB
        _                          => Tier::StreamViewer,// > 1 GB
    };
    // ilk 64 KB ile encoding tespiti (chardetng)
    let head = read_head(&path, 64 * 1024).map_err(e2s)?;
    let (encoding, has_bom) = detect_encoding(&head);
    // StreamViewer/Degraded: satır indeksini ARKA PLANDA kur, ilerlemeyi event'le
    if !matches!(tier, Tier::Full) {
        spawn_index_build(app.clone(), path.clone()); // tokio task, line-count-progress emit
    }
    Ok(FileMeta { path, byte_len: len, encoding, has_bom, eol: detect_eol(&head),
                  tier, line_count: None })
}

/// Viewer penceresi: satır aralığı → decode edilmiş metin. Channel ile akış.
#[tauri::command]
async fn read_lines(
    path: String, start_line: u64, line_count: u64,
    encoding: String, on_chunk: Channel<LinesChunk>,
) -> Result<(), String> {
    // mmap aç, sparse index'ten start_line offset'i bul, line_count kadar tara,
    // encoding_rs Decoder ile decode et, parça parça Channel'a yaz.
    // ...
    Ok(())
}

#[derive(serde::Serialize, Clone)]
pub struct LinesChunk {
    pub start_line: u64,
    pub lines: Vec<String>,   // decode edilmiş, satır başına bir String
    pub eof: bool,
}
```

**Tauri v2 `Channel` neden:** Tek seferlik `invoke` dönüşü yerine `tauri::ipc::Channel<T>` ile **streaming** yapılır — büyük pencere parça parça akar, frontend ilk parçayı hemen render eder (perceived <500 ms). Channel, normal event'ten daha düşük overhead'li ve sıralı.

### 2.4 Tail / Follow (log modu)

```rust
// commands/tail.rs
use notify::{RecommendedWatcher, RecursiveMode, Watcher, EventKind};
use notify_debouncer_full::new_debouncer;

#[tauri::command]
async fn follow_tail(path: String, on_append: Channel<LinesChunk>) -> Result<u32, String> {
    // 1) dosya sonundan başlayan offset'i kaydet
    // 2) notify-debouncer-full ile path'i izle (Modify event'leri debounce'lu)
    // 3) her event'te: son offset'ten EOF'a kadar yeni byte'ları oku,
    //    encoding_rs Decoder (stateful, çok-byte sınırında bölünmeyi korur) ile decode,
    //    yeni satırları Channel'a yaz, offset'i güncelle
    // 4) truncation tespiti: yeni len < kaydedilen offset → dosya rotate edildi, baştan
    Ok(watcher_id)
}
```
- **Debounce zorunlu:** Aktif log saniyede binlerce append yapar; `notify-debouncer-full` bunları tek batch'e indirir → UI flood'u önlenir.
- **Encoding stateful decode:** `encoding_rs::Decoder` append sınırında yarım kalan multi-byte karakteri taşır (UTF-8 sequence ortadan bölünmesin diye).
- **Rotation tespiti:** len küçülürse logrotate olmuş → offset sıfırla.

### 2.5 Find/Replace (Notepad++ regex çökmesinin çözümü — Rust tarafı)

```rust
// commands/search.rs
use grep_regex::RegexMatcher;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};

#[derive(serde::Serialize, Clone)]
pub struct Hit { pub line: u64, pub byte_offset: u64, pub preview: String }

#[tauri::command]
async fn search_file(
    path: String, pattern: String, is_regex: bool, case_insensitive: bool,
    on_hit: Channel<Vec<Hit>>,   // batch'li akış (1000'lik)
) -> Result<u64, String> {
    let pat = if is_regex { pattern } else { regex::escape(&pattern) };
    let matcher = RegexMatcher::new_line_matcher(&pat).map_err(e2s)?; // linear-time NFA
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .memory_map_unsafe()   // büyük tek dosya → mmap
        .build();
    let mut sink = BatchSink::new(on_hit, 1000);
    searcher.search_path(&matcher, &path, &mut sink).map_err(e2s)?;
    Ok(sink.total)
}
```
- **Neden Rust:** Rust `regex` **backtracking yapmaz** → catastrophic backtracking imkânsız, multi-GB'da sabit bellek, linear time. Notepad++'ın çöktüğü tam senaryo (`(a+)+$` tarzı pattern, dev dosya) burada güvenle çalışır.
- **Streaming sonuç:** Hit'ler 1000'lik batch'lerle Channel'dan akar; UI eşleşmeleri gelirken gösterir, ilk sonuç anında.
- **Replace büyük dosyada:** salt-okunur viewer modunda in-place edit yapılmaz; replace = **yeni dosyaya streaming yaz** (`grep` ile bul → `regex::Captures` ile değiştir → temp dosyaya akıt → atomik rename). Bellekte tutulmaz.

---

## 3. Frontend: CM6 Degrade ve Özel Viewer

### 3.1 CM6 degrade konfigürasyonu (`Compartment` tabanlı runtime switch)

```ts
// editor/cm-tiers.ts
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, drawSelection,
         highlightActiveLineGutter } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching,
         foldGutter, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, search } from '@codemirror/search';
import { history } from '@codemirror/commands';

export const featureConf = new Compartment();   // ağır özellikler tek compartment'ta
export const wrapConf = new Compartment();

// TAM (<50MB): her şey açık
export const fullFeatures = () => [
  lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(),
  drawSelection(), history(), bracketMatching(), foldGutter(),
  indentOnInput(), highlightSelectionMatches(),
  syntaxHighlighting(defaultHighlightStyle),
  search({ top: true }),
];

// DEGRADE (50MB–1GB): pahalı olanlar KAPALI
export const degradedFeatures = () => [
  lineNumbers(),            // ucuz, viewport-only
  drawSelection(),
  history(),                // tut ama limit'le (aşağıda)
  // KAPALI: syntaxHighlighting, bracketMatching, foldGutter,
  //         highlightActiveLine, highlightSelectionMatches, indentOnInput
  // search: client-side KAPALI → Rust search_file kullanılır
];

export function makeBigState(doc: string, degraded: boolean) {
  return EditorState.create({
    doc,
    extensions: [
      featureConf.of(degraded ? degradedFeatures() : fullFeatures()),
      wrapConf.of([]),                              // wrap KAPALI (uzun satır koruması)
      EditorView.editable.of(true),
      // satır uzunluğu / belge boyutu guard'ı:
      EditorState.changeFilter.of((tr) =>
        tr.newDoc.length <= MAX_EDIT_LENGTH),       // Marijn'in önerdiği limit
    ],
  });
}
```

**Degrade'de kapatılanlar ve gerekçesi:**

| Extension | Degrade'de | Neden |
|---|---|---|
| `syntaxHighlighting` / `lang-*` | **KAPALI** | Asıl darboğaz (bulgu §0.2: 3-4 sn). Lezer parser tüm görünür + buffer alanı parse eder. |
| `lineWrapping` | **KAPALI** | Uzun satırda layout O(satır uzunluğu); kapalıyken yatay scroll, viewport satır-bazlı kalır. CM6 uzun satır korumasının anahtarı. |
| `bracketMatching` | **KAPALI** | Her cursor hareketinde belge tarar. |
| `foldGutter` / fold | **KAPALI** | Fold hesabı satır yapısı tarar. |
| `highlightActiveLine(Gutter)` | **KAPALI** | Her hareket DOM repaint. |
| `highlightSelectionMatches` | **KAPALI** | Tüm belgede eşleşme arar → büyükte pahalı. |
| `indentOnInput` | **KAPALI** | Her input syntax sorgular. |
| `@codemirror/search` (client) | **KAPALI** | Yerine Rust `search_file` (§2.5). |
| `history` | **SINIRLI** | `EditorState` tutar ama `historyField` limit'le; çok büyük undo stack RAM yer. |

Runtime'da yükseltme/düşürme: `view.dispatch({ effects: featureConf.reconfigure(degradedFeatures()) })` — belge atılmadan extension seti değişir.

### 3.2 >1 GB: Neden CM6 değil, özel virtualized read-only viewer

**Karar: >1 GB için CM6 KULLANMA; kendi virtualized viewer'ımızı yaz.**

Gerekçe:
1. CM6 `Text` rope **tüm belgeyi bellekte** ister (`EditorState.create({ doc })` string alır). 1 GB+ string WebView'e sığmaz (V8/JSC string tavanı + UTF-16 2x şişme).
2. CM6'da "lazy doc" / virtual document yok — belge tam materialize olmalı. Topluluk da bunu doğruluyor ([lazy-loading >100MB thread](https://discuss.codemirror.net/t/lazy-loading-data-for-very-large-files-100mb/1263) çözümsüz).
3. Read-only viewer'ın ihtiyaçları minimal: satır numarası gutter + monospace satırlar + dikey scrollbar + arama vurgusu. CM6'nın edit/transaction/extension makinesi gereksiz ağırlık.

**Özel viewer tasarımı (`editor/stream-viewer.ts`):**
```ts
// Sadece görünür pencere + küçük overscan bellekte. Toplam satır = meta.line_count.
class StreamViewer {
  private lineHeight = 18;            // sabit monospace satır yüksekliği
  private cache = new Map<number, string>();  // LRU, ~yüzlerce satır
  private channel = new Channel<LinesChunk>();

  // sanal scroll yüksekliği: total_lines * lineHeight
  // scroll event → görünür satır aralığı hesapla → eksikse Rust read_lines çağır
  async onScroll(scrollTop: number) {
    const first = Math.floor(scrollTop / this.lineHeight);
    const visible = Math.ceil(this.viewportH / this.lineHeight);
    const need = this.missingRange(first - OVERSCAN, visible + 2 * OVERSCAN);
    if (need) {
      await call('read_lines', {
        path: this.path, startLine: need.start, lineCount: need.len,
        encoding: this.encoding, onChunk: this.channel,
      }); // Channel'dan gelen satırlar cache'e, görünür olanlar DOM'a
    }
    this.renderWindow(first, visible);
  }
}
```
- **Bellek:** Sadece görünür ~50 satır + overscan + LRU cache (birkaç bin satır) DOM'da/JS'te. Multi-GB dosya **sub-100 MB RAM**'de açılır → farklılaştırıcı gerçekleşir.
- **Sabit satır yüksekliği** ile sanal scrollbar O(1) hesaplanır (gerçek satır uzunluklarını bilmeye gerek yok; uzun satırlar yatay scroll/truncate ile).
- Render: ucuz `<div>` listesi veya tek `<pre>` + transform; CM6 overhead'i yok.

### 3.3 Akış özeti (tier'a göre frontend davranışı)

```
open_big(path) ──► FileMeta { tier }
   │
   ├─ Full        → invoke('read_all') tüm metin → CM6 fullFeatures
   ├─ Degraded    → invoke('read_all') tüm metin → CM6 degradedFeatures (wrap off, highlight off)
   │                 + line-count-progress event ile satır sayısı arka planda
   └─ StreamViewer → CM6 YOK → StreamViewer
                       scroll → read_lines(start,count) [Channel akışı] → görünür pencere
                       find   → search_file(pattern) [Channel batch] → hit listesi + atla
                       follow → follow_tail() [Channel append] → tail moduna geç
```

---

## 4. IPC Akış Örneği (uçtan uca, >1 GB viewer scroll)

```
┌─ FRONTEND ─────────────────────────────┐         ┌─ RUST ──────────────────────────┐
│ user 12 GB log açar                     │         │                                  │
│ invoke('open_big', {path}) ────────────────────► │ metadata: len=12GB → StreamViewer│
│                                         │ ◄──────── FileMeta{tier:StreamViewer,enc} │
│                                         │         │ spawn: SparseLineIndex::build    │
│ StreamViewer mount, sanal yükseklik=?   │         │   (tokio task, mmap + memchr)    │
│ listen('line-count-progress') ◄─────────────────── emit her %1: {lines: 8.2M ...}   │
│   scrollbar yüksekliği güncellenir      │         │                                  │
│                                         │         │                                  │
│ user satır 5,000,000'a scroll           │         │                                  │
│ const ch = new Channel<LinesChunk>()    │         │                                  │
│ invoke('read_lines',{start:4_999_950,   │         │ index.offset_of_line(5M)         │
│   count:120, enc, onChunk: ch}) ───────────────► │  → mmap[off..]                   │
│                                         │         │  decode (encoding_rs)            │
│ ch.onmessage = c => {                   │ ◄═══════  Channel: LinesChunk{lines[0..60]}│ (akış)
│   cache.set(...); renderWindow()        │ ◄═══════  Channel: LinesChunk{lines[60..120],eof}
│ }                                       │         │                                  │
│ ilk parça <50ms içinde DOM'da           │         │                                  │
└─────────────────────────────────────────┘         └──────────────────────────────────┘
```

---

## 5. Bu Görev İçin Kilitlenen Kararlar

1. **Üç katmanlı eşik:** `<50 MB` Full / `50 MB–1 GB` Degraded / `>1 GB` StreamViewer. Eşikler ayarla override edilebilir; gerekçe §1 (WebView string tavanı + highlight maliyeti + RAM hedefi).
2. **>1 GB'da CM6 KULLANILMAZ.** Özel virtualized read-only StreamViewer yazılır; sebep: CM6 `Text` rope tüm belgeyi materialize eder, lazy doc desteği yok, 1 GB+ string WebView'e sığmaz. Sadece görünür pencere + sparse index + LRU cache bellekte → sub-100 MB RAM.
3. **CM6 degrade = extension kapatma, `Compartment` ile runtime switch.** Degrade'de KAPALI: `syntaxHighlighting`/`lang-*`, `lineWrapping`, `bracketMatching`, `foldGutter`, `highlightActiveLine`, `highlightSelectionMatches`, `indentOnInput`, client `search`. Açık: `lineNumbers`, `drawSelection`, sınırlı `history`. Gerekçe: bulgu — highlight asıl darboğaz, wrap uzun-satır layout patlaması.
4. **Tüm metin asla eager döndürülmez (büyük dosyada).** `open_big` yalnız meta + encoding döner; içerik `read_lines`/`read_all` ile sonradan, **`tauri::ipc::Channel<T>` streaming** ile parça parça gelir.
5. **Satır indeksi = sparse anchor (her N. satır) + `memchr` SIMD tarama, mmap üstünde, tokio arka plan task'ında.** Tam offset dizisi tutulmaz (100M satır → 800 MB olurdu); sparse → ~800 KB.
6. **Büyük dosya okuma = `memmap2` 0.9.10** (zero-copy random access). mmap `unsafe` riski `notify` watcher ile harici-değişim tespiti yapılarak yönetilir.
7. **Find/Replace büyük dosyada Rust tarafında = `grep-searcher` 0.1.16 + `grep-regex`** (ripgrep motoru). Rust `regex` backtracking yapmaz → catastrophic backtracking imkânsız, linear-time, sabit bellek. Notepad++ regex çökmesinin yapısal çözümü. Sonuçlar Channel'dan 1000'lik batch akar. Replace = streaming temp dosyaya yaz + atomik rename.
8. **Tail/follow log modu = `notify` 8.2.0 + `notify-debouncer-full`.** Debounce zorunlu (saniyede binlerce append → tek batch). `encoding_rs::Decoder` stateful decode ile append sınırında multi-byte koruması. Truncation/rotation tespiti (len küçülürse offset sıfırla).
9. **Encoding tespiti büyük dosyada ilk 64 KB'tan** (`chardetng`); satır sayımı lazy, arka planda `line-count-progress` event ile dolar.
10. **Crate sürümleri (Haziran 2026):** `memmap2` 0.9.10, `grep-searcher` 0.1.16, `notify` 8.2.0, `notify-debouncer-full` (eşli), `memchr` 2.x, `encoding_rs` 0.8.x, `chardetng` 0.1.x, `regex` 1.x, `tokio` 1.x.

Sources: [CodeMirror huge doc demo](https://codemirror.net/examples/million/), [CM6 content length limit thread](https://discuss.codemirror.net/t/content-length-limit-codemirror6/4183), [CM6 large file lag thread](https://discuss.codemirror.net/t/noticable-lag-when-dealing-with-large-files/5928), [CM6 lazy-loading >100MB thread](https://discuss.codemirror.net/t/lazy-loading-data-for-very-large-files-100mb/1263), [memmap2 crates.io](https://crates.io/crates/memmap2), [grep-searcher lib.rs](https://lib.rs/crates/grep-searcher), [grep-searcher docs.rs](https://docs.rs/grep-searcher), [ripgrep GitHub](https://github.com/burntsushi/ripgrep), [notify lib.rs](https://lib.rs/crates/notify)
