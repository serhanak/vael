# Markdown pipeline ve dis aktarim (export)

# Mimari Doküman: Markdown Render & Export Hattı (Tauri v2)

> Haziran 2026. Sürümler crates.io/npm üzerinden doğrulandı. Yığın kilitli (Seçenek A); bu doküman render+export hattını ve preview↔export tutarlılığını implementasyon seviyesinde çözer. Önceki tasklerin kararlarına uyumludur (Lit chrome, CM6 source, Crepe WYSIWYG, tek `services/*` IPC sınırı, sıfır telemetri).

## 0. Doğrulanmış Sürüm Matrisi (Haziran 2026)

| Katman | Paket / Crate | Sürüm | Lisans | Not |
|---|---|---|---|---|
| Preview parser | `markdown-it` | 14.2.0 | MIT | CommonMark+GFM çekirdek |
| Tablo/strike/autolink | (markdown-it dahili GFM) | — | MIT | `html:false`, GFM preset |
| Görev listesi | `@hackmd/markdown-it-task-lists` | 2.1.4 | ISC | orijinal 8 yıldır bakımsız → fork seçildi |
| Footnote | `markdown-it-footnote` | 4.0.0 | MIT | |
| Heading id/anchor | `markdown-it-anchor` | 9.2.0 | Unlicense/MIT | `slugify` ile id + permalink |
| Matematik | `markdown-it-texmath` | 1.0.0 | MIT | engine olarak KaTeX alır |
| KaTeX | `katex` | 0.17.0 | MIT | Crepe ile aynı hat (çakışma yok) |
| Kod highlight (preview) | `prismjs` | 1.30.0 | MIT | `markdown-it` `highlight` callback |
| Diyagram | `mermaid` | 11.15.0 | MIT | lazy + `securityLevel:'strict'` |
| Sanitizasyon | `dompurify` | 3.4.x | Apache-2.0/MPL-2.0 | render sonrası HTML temizleme |
| Export parser (Rust) | `comrak` | 0.52.0 | BSD-2-Clause | tek-motor kararının temeli |
| Export PDF (Rust, önerilen) | `typst` + `typst-pdf` | 0.13.x | Apache-2.0 | gömülü; headless Chromium yok |
| Export PDF (alt) | WebView `print_to_pdf` | — | — | OS WebView özelliği |
| Export DOCX | `pandoc` (sidecar, opsiyonel) | sistem/pinned | GPL-2.0+ | yalnız kullanıcı kurarsa |

**Kritik bulgu 1 — comrak math gerçek render YAPMAZ.** `comrak` 0.52.0'da `math_dollars` / `math_code` uzantıları matematiği KaTeX'e çevirmez; yalnızca `data-math-style="inline|display"` attribute'lu bir wrapper üretip TeX kaynağını içeride bırakır. KaTeX'i sonradan biz uygulamak zorundayız.

**Kritik bulgu 2 — comrak JS plugin çalıştırmaz.** markdown-it eko-sistemi (texmath, anchor slug fonksiyonu, task-list DOM'u, Prism highlight, Mermaid) saf JS'tir. comrak bunların hiçbirini bilmez → **iki ayrı motor zorunlu olarak drift üretir** (farklı heading slug algoritması, farklı task-list işaretlemesi, farklı footnote id şeması, matematik/mermaid'in hiç işlenmemesi). Bu, aşağıdaki tek-motor kararını zorunlu kılar.

---

## 1. KRİTİK KARAR: Tek Render Motoru = markdown-it (preview VE export aynı HTML'den türer)

### 1.1 Problem
Görevin çekirdek riski: preview JS `markdown-it` ile, export Rust `comrak` ile yapılırsa **aynı girdi farklı çıktı** verir. Drift kaynakları somut olarak:

| Drift kaynağı | markdown-it | comrak |
|---|---|---|
| Heading slug/id | `markdown-it-anchor` + seçilen `slugify` | kendi `header_ids` algoritması (farklı) |
| Footnote ref id | `fnref1`/`fn1` şeması | `cmark-gfm` (kramdown-modeli) şeması |
| Task-list DOM | `<li class="task-list-item"><input>` | `<input>` farklı sınıf/yapı |
| Matematik | KaTeX → tam HTML | sadece `data-math-style`, TeX ham |
| Mermaid | `<div class="mermaid">`→SVG | hiç (sadece kod bloğu) |
| Kod highlight | Prism sınıfları (`token …`) | yok / dil sınıfı sadece |
| Typografi (smartquotes) | `typographer` opsiyonu | farklı kurallar |

İki motoru "ayarlarla yaklaştırmak" kırılgandır ve her sürüm yükseltmesinde yeniden kayar.

### 1.2 Karar
**Hem canlı önizleme hem de tüm export'lar TEK kanonik HTML'den üretilir; o HTML'i `markdown-it` (JS) üretir.** comrak export hattından **çıkarılır** (markdown→HTML görevi için). Rust tarafı yalnızca HTML→PDF/DOCX *paketlemesini* yapar (Typst veya WebView print veya Pandoc), markdown→HTML dönüşümünü yapmaz.

```
                    ┌──────── kanonik render (TEK motor) ────────┐
   markdown (str) ─►│ markdown-it + eklentiler → DOMPurify → HTML│
                    └───────────────┬─────────────────┬─────────┘
                                    │                 │
                          (1) PREVIEW DOM         (2) EXPORT HTML
                          (WebView'a basılır)     (Rust'a string olarak verilir)
```

Böylece **drift mimari olarak imkânsız** hâle gelir: export edilen HTML, kullanıcının preview'da gördüğü HTML ile byte düzeyinde aynı render fonksiyonundan çıkar (aynı slug, aynı footnote id, aynı KaTeX HTML, aynı Mermaid SVG).

### 1.3 Neden comrak değil de markdown-it kanonik?
- WYSIWYG/preview zaten WebView'de JS ile çalışmak zorunda (CM6/Crepe/KaTeX/Mermaid hepsi JS). Kanonik motoru oraya koymak, render'ın **kullanıcının gördüğü yerde** üretilmesini sağlar — "gördüğün = aldığın" garantisi.
- comrak matematiği ve mermaid'i hiç çözemez; bunları yine JS'te çalıştırmak gerekirdi → motor zaten JS'e bağımlı.
- markdown-it eklenti eko-sistemi (anchor/footnote/texmath/task-list) ihtiyaçların tamamını karşılar.

### 1.4 comrak'ın kalan rolü
comrak silinmez; **ikincil/yedek ve doğrulama** rolünde kalır:
1. **Headless/CLI export** (gelecekte WebView olmadan, ör. CI'da toplu dönüştürme) için saf-Rust yol.
2. **Tutarlılık testi referansı** (§7): comrak çıktısı ile markdown-it çıktısı normalize edilip karşılaştırılır; sapmalar CI'da raporlanır (kanonik motor JS olduğu için bu "güvenlik ağı"dır, üretim yolu değil).

Bu, "tek motor ile hem önizleme hem export" + "round-trip tutarlılık testi" stratejilerinin **ikisini birden** kullanır: üretimde tek motor (drift yok), CI'da çift motor karşılaştırması (regresyon yakalama).

---

## 2. markdown-it Pipeline (kanonik render — `editor/preview/renderer.ts`)

### 2.1 Kompozisyon
```ts
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import taskLists from '@hackmd/markdown-it-task-lists';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import Prism from 'prismjs';
import { slug } from './slug';          // TEK slug fonksiyonu (export ile paylaşılır)

export function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,            // ham HTML kapalı → XSS yüzeyini daraltır (DOMPurify yine de çalışır)
    linkify: true,          // autolink
    typographer: false,     // export determinizmi için kapalı (akıllı tırnak drift'i önlenir)
    breaks: false,
    highlight(code, lang) {
      // Prism: SADECE preview/export HTML için statik token sınıfları üretir
      if (lang && Prism.languages[lang]) {
        const html = Prism.highlight(code, Prism.languages[lang], lang);
        return `<pre class="language-${lang}"><code class="language-${lang}">${html}</code></pre>`;
      }
      return ''; // markdown-it kendi kaçışını yapar
    },
  });

  md.use(anchor, {
    slugify: slug,                         // ← paylaşılan slug
    permalink: anchor.permalink.headerLink(),
    level: [1, 2, 3, 4, 5, 6],
  });
  md.use(footnote);
  md.use(taskLists, { enabled: true, label: true, labelAfter: true });
  md.use(texmath, {
    engine: katex,
    delimiters: 'dollars',                 // $...$ ve $$...$$
    katexOptions: { throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' },
  });

  return md;
}
```

**GFM kapsamı:** tablo, strikethrough, autolink markdown-it çekirdeğinde (`linkify`+GFM preset davranışı) gelir; task-list, footnote, anchor, math eklentilerle tamamlanır. CommonMark+GFM hedefi karşılanır.

**Mermaid burada render EDİLMEZ** (senkron motor matematik gibi inline olamaz, asenkron+worker gerektirir): renderer kod bloğunu `info === 'mermaid'` ise `<pre class="mermaid-src">…</pre>` placeholder'a çevirir; gerçek SVG üretimi §4'te asenkron post-process adımında.

### 2.2 Paylaşılan slug (drift'in en sinsi kaynağını kapatır)
`editor/preview/slug.ts` — hem anchor eklentisi hem (ileride comrak referans karşılaştırması ve manuel TOC) bunu kullanır. Tek tanım = tek davranış.
```ts
export function slug(s: string): string {
  return s.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}
```

### 2.3 Render fonksiyonu (saf, deterministik)
```ts
const md = createRenderer();
export function renderMarkdown(src: string): string {
  return md.render(src);   // KaTeX inline + footnote + anchor + task-list + Prism tümü burada
}
```
Bu fonksiyon **preview ve export tarafından aynen** çağrılır → kanonik HTML.

---

## 3. Güvenlik / Sanitizasyon (DOMPurify 3.4.x)

KaTeX MathML+HTML, Mermaid SVG ve kullanıcı içeriği DOM'a girmeden önce temizlenir.

```ts
import DOMPurify from 'dompurify';

// KaTeX (MathML) ve Mermaid (SVG) için profilleri açık tut
const purify = DOMPurify;            // WebView'de window var
export function sanitize(html: string): string {
  return purify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    ADD_TAGS: ['use'],                          // Mermaid <use> referansları
    ADD_ATTR: ['data-math-style', 'aria-hidden'],
    FORBID_TAGS: ['style'],                      // inline <style> bloklarını kaldır
    FORBID_ATTR: ['onerror', 'onload'],
  });
}
```
- `html:false` markdown-it ile birlikte DOMPurify = derinlik-savunması. Kullanıcı `<script>` veya `onclick` enjekte edemez.
- CSP (önceki task) `script-src 'self'` zaten inline script çalıştırmayı engeller; DOMPurify ikinci kat.
- **Sıra önemli:** önce `renderMarkdown` (KaTeX/Prism üretir) → sonra `sanitize` → sonra DOM'a. Mermaid SVG'si asenkron üretildiği için (§4) o da üretildikten sonra `sanitize` edilir.

---

## 4. Matematik & Diyagram: Preview ve Export'a Gömme

### 4.1 KaTeX (senkron, render anında gömülür)
`markdown-it-texmath` + KaTeX render sırasında **tam HTML** üretir (`output:'htmlAndMathml'` → görsel HTML + erişilebilir MathML). Export için ekstra iş yoktur: kanonik HTML zaten KaTeX işaretlemesini içerir. Tek gereklilik: **KaTeX CSS + fontları export HTML'ine gömmek** (§6).

### 4.2 Mermaid (asenkron, lazy, worker)
Mermaid senkron `md.render` içine sığmaz (asenkron, ağır). İki-fazlı:

**Faz 1 (renderer):** ` ```mermaid ` bloğu → `<pre class="mermaid-src" data-mmd="…base64…"></pre>` placeholder.

**Faz 2 (post-process, asenkron):**
```ts
// editor/preview/mermaid.ts  — lazy + offscreen render
let mermaidP: Promise<typeof import('mermaid')> | null = null;
function loadMermaid() {
  return (mermaidP ??= import('mermaid').then(m => {
    m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
    return m;
  }));
}

export async function renderMermaidIn(container: HTMLElement): Promise<void> {
  const nodes = container.querySelectorAll<HTMLElement>('pre.mermaid-src');
  if (!nodes.length) return;
  const { default: mermaid } = await loadMermaid();
  for (const [i, el] of nodes.entries()) {
    const src = atob(el.dataset.mmd!);
    try {
      const { svg } = await mermaid.render(`mmd-${Date.now()}-${i}`, src);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid';
      wrap.innerHTML = svg;             // sonra sanitize(svg)
      el.replaceWith(wrap);
    } catch (e) {
      el.textContent = `Mermaid error: ${(e as Error).message}`;
    }
  }
}
```
- `securityLevel:'strict'` → `htmlLabels:false`, `'unsafe-eval'` gerekmez (CSP `script-src 'self'` ile uyumlu).
- **Worker:** Mermaid'in dagre layout'u ağır olduğunda büyük diyagramlar için `mermaid` çağrısı bir Web Worker'da `OffscreenCanvas`/DOM-string modunda yapılabilir; basit yaklaşımda ana thread'de `requestIdleCallback` ile sıralanır. Worker'a taşıma, sadece DOM gerektirmeyen `mermaidAPI.render` string çıktısı kullandığı için mümkündür (DOM'a basma ana thread'de kalır).

**Export'ta Mermaid:** export, **render edilmiş SVG'yi** HTML'e gömer (kod bloğunu değil). Yani export akışı da Faz 1+Faz 2'yi tam çalıştırıp DOM'u "settle" ettikten sonra `outerHTML` alır → SVG export'a girer. Bu, preview↔export Mermaid tutarlılığını garanti eder (aynı mermaid sürümü, aynı SVG).

### 4.3 Kod blokları (Prism)
Prism `highlight` callback'inde senkron çalışır → token sınıfları kanonik HTML'e gömülüdür. Export'ta Prism temasının CSS'i gömülür (§6). Dil paketleri preview tarafında lazy (`prismjs/components/...`) yüklenebilir; export öncesi gerekli diller yüklenmiş olmalı (export, kullanılan dilleri tarayıp eksikse yükler).

---

## 5. ÖNERİLEN EXPORT MİMARİSİ

### 5.1 Üç hedef, ortak ön-uç
Export'un girişi her zaman **kanonik HTML** (markdown-it→DOMPurify→Mermaid-settled). Çıkış formatına göre paketleme değişir.

```
kanonik HTML (preview ile aynı)
   │
   ├─ HTML export ........ standalone HTML (CSS+font+SVG gömülü)  → saf JS, Rust gerekmez
   │
   ├─ PDF export ......... A) Typst (Rust, ÖNERİLEN)   ┐
   │                       B) WebView print_to_pdf     ├─ takaslar §5.3
   │                       C) Pandoc→LaTeX (opsiyonel)  ┘
   │
   └─ DOCX export ........ Pandoc sidecar (HTML→docx), opsiyonel + kullanıcı onayı
```

### 5.2 Takas tablosu

| Yaklaşım | Boyut | Lisans | Sadakat (preview'a) | Offline | Bağımlılık | Verdict |
|---|---|---|---|---|---|---|
| **HTML (standalone)** | ~0 (gömülü) | — | **Birebir** (aynı HTML) | ✓ | yok | **HTML için seçildi** |
| **PDF: Typst gömülü** (`typst`+`typst-pdf`) | ~birkaç MB binary'ye eklenir | Apache-2.0 (temiz) | Yüksek (HTML→Typst eşleme katmanı) | ✓ | crate, sistem bağımlılığı yok | **PDF için ÖNERİLEN** |
| **PDF: WebView `print_to_pdf`** | 0 (OS WebView) | — | **Birebir** (aynı render motoru!) | ✓ | platform farkı (WebView2/WKWebView) | **PDF için pragmatik 1. tercih** |
| PDF: headless Chromium | +100-150 MB | — | Yüksek | ✓ | dev bundle şişer | Reddedildi (boyut hedefi) |
| PDF/DOCX: Pandoc bundle | +~150 MB | **GPL-2.0+** (kopyala-dağıt riski) | Orta (kendi HTML/LaTeX yorumu) | ✓ | büyük | **Bundle'lanmaz**; opsiyonel sidecar |
| DOCX: Pandoc sidecar | sistem | GPL (ayrı süreç → linking yok) | İyi | ✓ | kullanıcı kurar | **DOCX için seçildi (opsiyonel)** |

### 5.3 PDF kararı: WebView `print_to_pdf` BİRİNCİL, Typst gömülü İKİNCİL

**Birincil: WebView print_to_pdf.** Mantık tek-motor kararının doğal sonucu: PDF'i *kullanıcının gördüğü WebView render'ından* üretirsek, preview↔PDF sadakati **tanım gereği %100**'dür (aynı KaTeX, aynı Mermaid SVG, aynı CSS). Tauri v2'de gizli/offscreen bir WebView penceresine kanonik HTML+CSS yüklenir ve OS WebView'in print-to-PDF API'si çağrılır:
- Windows (WebView2): `ICoreWebView2.PrintToPdf` (WebView2 native).
- macOS (WKWebView): `createPDF` / `WKWebView` print operasyonu.
- Linux (WebKitGTK): `webkit_print_operation` / `print_to_pdf`.

Bu, Rust tarafında ince bir `print_pdf(html, css, out_path)` command'ı olarak sarılır; gizli pencere `services/export.ts` üzerinden tetiklenir. **Sıfır ek binary boyutu, birebir sadakat, tam offline.** Tek dezavantaj: üç platformda üç farklı WebView API'si (kapsüllenebilir abstraksiyon).

**İkincil: Typst gömülü** (`typst` 0.13.x + `typst-pdf`, Apache-2.0). WebView print'in zayıf olduğu yerler için: deterministik sayfa düzeni, başlık/altbilgi, sayfa numarası, profesyonel tipografi, batch/headless (CI) PDF. Burada HTML→Typst eşleme katmanı gerekir (markdown AST'ten Typst markup üretmek, HTML parse etmekten temiz). Typst saf-Rust, sistem bağımlılığı yok, lisansı temiz → bundle boyutu hedefiyle uyumlu. Gelecekte "yazdırılabilir rapor" kalitesi için bu yol.

**Neden Pandoc PDF değil:** Pandoc GPL-2.0+ ve LaTeX zinciri (TeX Live ~GB) gerektirir; "hafif + temiz lisans" hedefiyle çelişir. Yalnızca kullanıcı zaten Pandoc kurmuşsa sidecar olarak sunulur.

### 5.4 DOCX kararı: Pandoc opsiyonel sidecar
DOCX için saf-Rust olgun bir HTML→docx yolu yok. Karar: **kanonik HTML → Pandoc (sidecar subprocess) → docx**, yalnızca kullanıcı Pandoc kurduysa. Pandoc ayrı süreç olarak çağrıldığı için (linking yok) GPL bulaşması yok; bundle'a girmez. Tauri capability'sinde `shell:allow-execute` yalnızca bilinen `pandoc` binary'sine, kullanıcı onayıyla (önceki task kararı 10/13 ile uyumlu).

```rust
// commands/export.rs — DOCX yolu
#[tauri::command]
async fn export_docx(html: String, out_path: String) -> Result<String, String> {
    // Pandoc'a stdin'den HTML, çıktı docx
    let mut child = std::process::Command::new("pandoc")
        .args(["-f", "html", "-t", "docx", "-o", &out_path])
        .stdin(std::process::Stdio::piped())
        .spawn().map_err(|e| format!("Pandoc bulunamadı: {e}"))?;
    use std::io::Write;
    child.stdin.take().unwrap().write_all(html.as_bytes()).map_err(|e| e.to_string())?;
    let st = child.wait().map_err(|e| e.to_string())?;
    if st.success() { Ok(out_path) } else { Err("Pandoc export başarısız".into()) }
}
```
Pandoc yoksa UI bu seçeneği gri gösterir + "Pandoc kurulu değil" rehberi.

### 5.5 Export orkestrasyonu (frontend — `services/export.ts`)
```ts
import { renderMarkdown } from '../editor/preview/renderer';
import { sanitize } from '../editor/preview/sanitize';
import { renderMermaidIn } from '../editor/preview/mermaid';
import { inlineAssets } from './inline-assets';   // §6
import { call } from './ipc';

export type ExportFormat = 'html' | 'pdf' | 'docx';

export async function exportDocument(md: string, fmt: ExportFormat, outPath: string) {
  // 1) KANONİK HTML — preview ile birebir aynı fonksiyon
  let html = sanitize(renderMarkdown(md));

  // 2) Mermaid'i settle et (offscreen container'da)
  const host = document.createElement('div');
  host.innerHTML = html;
  await renderMermaidIn(host);              // <pre.mermaid-src> → <div.mermaid><svg>
  html = sanitize(host.innerHTML);          // SVG dahil yeniden temizle

  // 3) Tema CSS + KaTeX/Prism font/CSS göm → standalone belge
  const doc = await inlineAssets(html);     // tam <html>…</html>

  // 4) Formata göre paketle
  if (fmt === 'html') return call<string>('write_text_file', { path: outPath, text: doc });
  if (fmt === 'pdf')  return call<string>('print_pdf', { html: doc, outPath });   // gizli WebView
  if (fmt === 'docx') return call<string>('export_docx', { html: doc, outPath }); // Pandoc sidecar
}
```
Üç format da **aynı `doc` string'inden** türer → format hedefleri arası tutarlılık da garanti.

---

## 6. Tema/CSS ve Font Gömme (export'un "standalone" olması)

Export'un offline ve taşınabilir olması için CSS + KaTeX fontları + Prism teması belgeye **gömülür** (dış istek yok, CSP `connect-src` dış yok ile uyumlu).

`services/inline-assets.ts`:
```ts
import appCss   from '../styles/preview.css?inline';        // Vite ?inline → string
import katexCss from 'katex/dist/katex.min.css?inline';
import prismCss from 'prismjs/themes/prism.css?inline';
// KaTeX fontları: katex.min.css'teki url(fonts/...) → base64 data: URI'ye çevrilir (build adımı)

export async function inlineAssets(bodyHtml: string): Promise<string> {
  const css = [appCss, katexFontsAsDataUris(katexCss), prismCss].join('\n');
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style></head><body class="markdown-body">${bodyHtml}</body></html>`;
}
```
- **KaTeX fontları:** `katex.min.css` `url(fonts/KaTeX_*.woff2)` referansları içerir; build-time bir Vite plugin/script bunları `data:font/woff2;base64,…` gömer → PDF/HTML'de matematik fontları eksiksiz. (Aksi hâlde print-to-PDF'de matematik bozulur.)
- **Mermaid:** SVG zaten kendi inline stilini taşır (`securityLevel:'strict'` ile güvenli); ek CSS gerekmez.
- **Tema parite:** preview ve export aynı `preview.css`'i kullanır → görsel tutarlılık. Tek fark `@media print` ek kuralları (sayfa kenar boşluğu, `break-inside: avoid` kod/diyagram için).

---

## 7. Preview↔Export Tutarlılık Test Stratejisi (güvenlik ağı)

Üretim yolunda drift yok (tek motor), ama regresyonları yakalamak için CI'da çift katmanlı test:

**Katman A — Golden snapshot (asıl test).** Bir korpus markdown dosyası (`fixtures/*.md`: tablo, footnote, task-list, $math$, ```mermaid, nested list, GFM kenar durumları). `renderMarkdown` çıktısı normalize edilip (whitespace/attribute sırası) golden HTML ile karşılaştırılır. Aynı fonksiyon export'u beslediği için bu test hem preview hem export'u korur.
```ts
// test/render.spec.ts  (vitest)
for (const f of fixtures) {
  test(`render ${f.name}`, () => {
    expect(normalize(renderMarkdown(f.src))).toMatchSnapshot();
  });
}
```

**Katman B — comrak çapraz kontrol (regresyon dedektörü).** Aynı korpus comrak ile (Rust testinde) render edilip, yapısal olarak normalize edilir (DOM ağacı; metin içeriği + heading id + footnote sırası karşılaştırılır, byte değil). Sapma → **uyarı** (hata değil), çünkü kanonik motor JS. Bu, "markdown-it bir GFM kenar durumunu comrak'tan farklı yorumladı" durumunu erkenden gösterir; ekip kanonik davranışı bilinçli seçer.

**Katman C — PDF smoke.** `print_pdf` ile üretilen PDF'in sayfa sayısı + metin çıkarımı (footnote/heading metinleri mevcut mu) kontrol edilir; matematik için KaTeX'in MathML kopyasından metin doğrulanır.

Bu, görevin "tek motor VEYA round-trip test" ikileminde **her ikisini** seçer: tek motor üretimde drift'i yok eder, çapraz test gizli regresyonu yakalar.

---

## Pipeline Diyagramı (text)

```
                       ┌──────────────────────── FRONTEND (WebView, TS) ───────────────────────┐
 markdown (kaynak str) │                                                                       │
        │              │   editor/preview/renderer.ts  =  KANONİK MOTOR (TEK)                  │
        ├──────────────┼─►  markdown-it 14.2.0                                                 │
        │              │     ├─ GFM: tablo · strikethrough · autolink(linkify)                 │
        │              │     ├─ markdown-it-anchor 9.2.0  (slug.ts ← PAYLAŞILAN)                │
        │              │     ├─ markdown-it-footnote 4.0.0                                      │
        │              │     ├─ @hackmd/markdown-it-task-lists 2.1.4                            │
        │              │     ├─ markdown-it-texmath 1.0.0 → KaTeX 0.17 (HTML+MathML, senkron)   │
        │              │     └─ highlight() → Prism 1.30 (token sınıfları, senkron)             │
        │              │            │  (```mermaid → <pre.mermaid-src> placeholder)             │
        │              │            ▼                                                           │
        │              │     DOMPurify 3.4 (html+svg+mathml profil)  ── sanitize ──►  HTML       │
        │              │            │                                                           │
        │              │     ┌──────┴───────────────────────────────┐                          │
        │              │     ▼                                       ▼                          │
        │              │  (1) PREVIEW PANE                      (2) EXPORT ön-uç                 │
        │              │   DOM'a bas → renderMermaidIn()         offscreen host → renderMermaidIn│
        │              │   (lazy mermaid 11.15, strict)          (SVG settle) → sanitize         │
        │              │                                         → inlineAssets (CSS+KaTeX font  │
        │              │                                            +Prism, data: gömülü)        │
        │              │                                              │ standalone <html>        │
        │              │   services/export.ts ─────────────┬─────────┴──────────┐               │
        └──────────────┼──── services/ipc.ts (TEK SINIR) ──┼────────────────────┼───────────────┘
                       │                                    │                    │
                       ▼ html export                        ▼ pdf                ▼ docx
              ┌─ RUST (Tauri v2) ─────────────────────────────────────────────────────────────┐
              │  write_text_file              print_pdf (gizli WebView           export_docx     │
              │  (saf, Rust paketleme)        print_to_pdf — BİREBİR sadakat)    (Pandoc sidecar │
              │                               [alt: Typst 0.13 gömülü PDF]        opsiyonel, GPL  │
              │                                Apache-2.0, headless rapor]        ayrı süreç)     │
              │                                                                                 │
              │  comrak 0.52.0  ──► YEDEK/headless md→HTML + CI çapraz-kontrol referansı (§7-B)  │
              └─────────────────────────────────────────────────────────────────────────────────┘
            Tüm formatlar AYNI kanonik HTML'den türer → preview↔export drift mimari olarak yok.
```

---

## KİLİTLENEN KARARLAR (bu görev)

1. **TEK RENDER MOTORU = markdown-it (JS).** Hem canlı preview hem TÜM export'lar aynı `renderMarkdown()` fonksiyonunun ürettiği kanonik HTML'den türer. comrak markdown→HTML *üretim* yolundan çıkarılır. Gerekçe: comrak math'i (sadece `data-math-style`) ve mermaid'i render etmez, JS eklentilerini (anchor slug, footnote id, task-list, Prism) çalıştıramaz → iki motor zorunlu drift üretir. Tek motorla drift **mimari olarak imkânsız**.
2. **markdown-it pipeline (kanonik):** `markdown-it` 14.2.0 (`html:false`, `linkify:true`, `typographer:false` — determinizm) + `markdown-it-anchor` 9.2.0 + `markdown-it-footnote` 4.0.0 + `@hackmd/markdown-it-task-lists` 2.1.4 (orijinal bakımsız) + `markdown-it-texmath` 1.0.0 (engine: KaTeX 0.17, `output:'htmlAndMathml'`) + Prism 1.30.0 highlight callback.
3. **Paylaşılan `slug.ts`:** heading id'leri anchor eklentisi ve tüm referanslar tek slug fonksiyonundan üretir (en sinsi drift kaynağını kapatır).
4. **Matematik:** KaTeX render anında senkron gömülür (HTML+MathML); export için ek iş yok, sadece KaTeX CSS+fontlar `data:` URI olarak gömülür.
5. **Mermaid:** iki-fazlı — renderer placeholder (`<pre.mermaid-src>`), sonra asenkron lazy `mermaid` 11.15.0 (`securityLevel:'strict'`, `'unsafe-eval'` yok, CSP uyumlu) SVG üretir. Export, SVG'yi settle edip gömer → preview↔export mermaid birebir aynı.
6. **Sanitizasyon:** `dompurify` 3.4.x, `USE_PROFILES{html,svg,mathMl}`; render→sanitize→DOM sırası; `html:false` ile derinlik-savunması.
7. **HTML export = standalone** (CSS+KaTeX fontları+Prism teması `data:` URI gömülü), saf JS+Rust dosya yazma, dış istek yok (offline).
8. **PDF export — BİRİNCİL: WebView `print_to_pdf`** (WebView2 `PrintToPdf` / WKWebView `createPDF` / WebKitGTK `print_to_pdf`), gizli pencere üzerinden. Preview render motorundan üretildiği için sadakat **tanım gereği %100**, sıfır ek binary boyutu, tam offline.
9. **PDF export — İKİNCİL: Typst 0.13.x gömülü** (`typst`+`typst-pdf`, Apache-2.0, saf-Rust, sistem bağımlılığı yok) — deterministik sayfa düzeni/başlık-altbilgi/sayfa no/headless-CI raporları için. Headless Chromium (+100-150 MB) ve Pandoc-PDF (GPL + TeX Live) boyut/lisans hedefiyle çeliştiği için **reddedildi**.
10. **DOCX export = Pandoc sidecar (opsiyonel).** Kanonik HTML → `pandoc -f html -t docx` ayrı süreç (linking yok → GPL bulaşması yok); bundle'a girmez; yalnız kullanıcı Pandoc kurduysa, `shell:allow-execute` dar capability + onayla. Pandoc yoksa UI seçeneği devre dışı.
11. **comrak 0.52.0 kalır ama ikincil:** (a) gelecekte WebView'siz headless/CLI md→HTML, (b) CI çapraz-kontrol referansı.
12. **Tutarlılık testi (iki katman):** Katman A golden snapshot (`renderMarkdown` çıktısı, hem preview hem export'u korur) = asıl test; Katman B comrak çapraz-kontrol (yapısal normalize, sapma=uyarı) = regresyon dedektörü; Katman C PDF smoke. Görevin "tek motor VEYA round-trip" ikileminde **ikisi birden** kullanılır.
13. **Tema gömme:** preview ve export aynı `preview.css`; export'a `@media print` kuralları (`break-inside:avoid` kod/diyagram, sayfa kenar boşluğu) eklenir; KaTeX fontları build-time `data:font/woff2;base64` olarak gömülür (print-to-PDF'de matematik fontu bozulmasını önler).
14. **Tek IPC sınırı korunur:** export `services/export.ts` → `services/ipc.ts` üzerinden `write_text_file`/`print_pdf`/`export_docx` command'larını çağırır; editör/chrome doğrudan `invoke` etmez (önceki task kararı 5/14 ile uyumlu).
15. **Sıfır telemetri / offline:** tüm asset'ler gömülü, hiçbir export adımı dış ağ isteği yapmaz; CSP `connect-src` dış-yok ile uyumlu.

Sources: [comrak crates.io](https://crates.io/crates/comrak) · [comrak Extension docs](https://docs.rs/comrak/latest/comrak/options/struct.Extension.html) · [markdown-it npm](https://www.npmjs.com/package/markdown-it) · [markdown-it-texmath](https://github.com/goessner/markdown-it-texmath) · [markdown-it-anchor](https://github.com/valeriangalliat/markdown-it-anchor) · [markdown-it-footnote](https://www.npmjs.com/package/markdown-it-footnote) · [@hackmd/markdown-it-task-lists](https://www.npmjs.com/package/@hackmd/markdown-it-task-lists) · [DOMPurify](https://github.com/cure53/DOMPurify) · [typst crate](https://crates.io/crates/typst) · [Typst open source/license](https://typst.app/open-source/)
