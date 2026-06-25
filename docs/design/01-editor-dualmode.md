# Editor cekirdegi ve cift-mod (Source / Live-preview / WYSIWYG)

# Editör & Çift-Mod Tasarımı (CodeMirror 6 + Milkdown/Crepe)

> Haziran 2026. Tüm sürümler aşağıda araştırılarak doğrulandı. Bu bölüm, kilitli mimarinin §5.2/§5.4 kararlarını implementasyon seviyesine indirir.

## 0. Doğrulanmış Sürüm Matrisi (editör katmanı)

| Paket | Sürüm | Not |
|---|---|---|
| `codemirror` (meta) | 6.0.2 | Kullanmıyoruz; ayrı `@codemirror/*` modülleri (tree-shake) |
| `@codemirror/state` | 6.6.0 | `EditorState`, `Compartment`, `Transaction`, `Text` |
| `@codemirror/view` | 6.43.0 | `EditorView`, dekorasyonlar, `ViewPlugin` |
| `@codemirror/commands` | 6.10.3 | `history`, `defaultKeymap`, `indentWithTab` |
| `@codemirror/language` | 6.x | `LanguageSupport`, `syntaxHighlighting`, `HighlightStyle`, `foldGutter` |
| `@codemirror/language-data` | 6.x | `languages: LanguageDescription[]` — **lazy yükleme tablosu** |
| `@codemirror/search` | 6.x | `search`, `searchKeymap`, `highlightSelectionMatches` |
| `@codemirror/autocomplete` | 6.x | `autocompletion`, `completionKeymap`, parantez kapama |
| `@codemirror/lang-markdown` | 6.x | Markdown ana dili (source/split modu için kritik) |
| `@codemirror/lang-javascript` … | 6.x | Yaygın diller; **lazy** import |
| `@lezer/highlight` | 1.x | `tags`, özel `HighlightStyle` etiketleri |
| `@milkdown/crepe` | 7.21.2 | WYSIWYG; içinde Vue 3.5 + ProseMirror + `@codemirror/*` + katex 0.17 |
| `@milkdown/kit` | 7.21.2 | Crepe'in altındaki çekirdek + presetler agregatı |
| `markdown-it` | 14.2.0 | Split preview render |
| `markdown-it-footnote` | 4.0.0 | Dipnot |
| `markdown-it-anchor` | 9.2.0 | Başlık `id` + permalink (scroll-sync hedefleri) |
| `markdown-it-task-lists` | 2.1.1 | GFM görev listesi |
| `@vscode/markdown-it-katex` | 2.x | KaTeX entegrasyonu (bakımı sürüyor; `waylonflinn/markdown-it-katex` arşivlendi) |
| `prismjs` | 1.30.0 | Preview kod bloğu highlight |
| `katex` | 0.17.0 | Crepe ile **aynı hat** — çakışma yok |
| `mermaid` | 11.15.0 | Lazy import |

**Kritik karar:** `@codemirror/*` modüllerini Crepe zaten transitive olarak çeker. `pnpm` ile bunları **kök `dependencies`'e açıkça ekle** ve `package.json` `pnpm.overrides` / `resolutions` ile tek sürüme pinle. Aksi halde Crepe'in kendi CM6 kopyası ile bizim source-mode CM6'mız **iki ayrı `@codemirror/state` instance**'ı yaratır → `Facet`/`StateField` kimlik uyuşmazlığı, sessiz bozulma. Tek instance zorunlu.

```jsonc
// package.json (ilgili kısım)
"pnpm": {
  "overrides": {
    "@codemirror/state": "6.6.0",
    "@codemirror/view": "6.43.0",
    "@codemirror/language": "6",
    "katex": "0.17.0"
  }
}
```

---

## 1. Üç Görünüm Modu — Sözleşme ve Uygunluk Matrisi

```
┌──────────┐   toMarkdown()   ┌──────────┐
│  SOURCE  │ ───────────────► │ WYSIWYG  │
│  (CM6)   │ ◄─────────────── │ (Crepe)  │
└────┬─────┘  setText(md)     └──────────┘
     │  aynı CM6 EditorView paylaşılır
     ▼
┌──────────────────────────┐
│ SPLIT (CM6 | md-it preview)│   preview salt-okunur türev
└──────────────────────────┘
```

| Dosya tipi | Source | Split (live preview) | WYSIWYG |
|---|:--:|:--:|:--:|
| `.md`, `.markdown`, `.mdx*` | ✓ | ✓ | ✓ |
| `.txt` | ✓ | ✓ (markdown olarak render; kullanıcı kapatabilir) | ✗ |
| Kod (`.ts`, `.rs`, `.py`, …) | ✓ | ✗ | ✗ |
| Büyük dosya (`isLarge`, >50 MB) | ✓ (sadece) | ✗ | ✗ |

**Mod geçiş kuralları (state machine):**
- `source ↔ split`: **aynı `EditorView`** sağ panele preview eklenir/çıkarılır. Metin hiç serileştirilmez — sadece preview DOM mount/unmount. Maliyet yok, anlık.
- `source/split → wysiwyg`: CM6 `view.state.doc.toString()` → Crepe `defaultValue`. CM6 view **destroy edilmez**, gizlenir (`display:none`) ki dirty/scroll/undo korunup geri dönüşte hızlı olsun. Crepe **lazy** mount.
- `wysiwyg → source/split`: `crepe.getMarkdown()` → CM6'ya `dispatch` ile tam-doküman replace. Crepe `destroy()` edilir (Vue/ProseMirror ağırlığını bellekte tutmamak için).
- Büyük dosyada `wysiwyg` ve `split` UI'da **disabled** (gri); tıklanınca tooltip: "Bu dosya canlı önizleme/WYSIWYG için çok büyük."

**Mod ↔ format eşleşmesi:** Mod, doküman tipi `'markdown' | 'text' | 'code'` türevidir. `code` ve `text` için yalnız `source` zorlanır (WYSIWYG markdown-özel). Status-bar mod seçici, mevcut tipe göre seçenekleri filtreler.

---

## 2. Tek Doğruluk Kaynağı (SSOT) — Markdown String

**İlke:** Her belgenin tek otoritesi `doc.text` (string). İki motor **asla aynı anda canlı değil**. Aktif motor SSOT'u tutar; mod geçişinde SSOT serileştirilip karşıya verilir.

```ts
// state/types.ts (editör kısmı)
export type DocKind = 'markdown' | 'text' | 'code';
export interface DocState {
  id: string;
  text: string;                 // SSOT (sadece pasif modda güncel; aktif motor canlı tutar)
  kind: DocKind;
  mode: 'source' | 'split' | 'wysiwyg';
  langDesc?: string;            // CM6 dil id (markdown/code)
  dirty: boolean;
  // hangi motor "owner": geçişte buradan okunur
  activeEngine: 'cm' | 'crepe';
}
```

### 2.1 Round-trip kaybı: nerede olur, nasıl önlenir

Kayıp **Crepe (ProseMirror+Remark)** tarafında oluşur, çünkü Crepe markdown'ı bir AST'e parse edip tekrar serileştirir. CM6 ise düz metin tutar → CM6→md kaybı **yoktur**. Yani tek riskli yön: **`source → wysiwyg → source`**.

Olası kayıp/normalizasyon noktaları (Remark serialize davranışı):

| Kayıp türü | Örnek | Strateji |
|---|---|---|
| Sözdizimi normalizasyonu | `*italic*` → `_italic_`, `---` → `***`, `1.`/`2.` yeniden numaralama, girinti boşlukları | **Kabul et** ve kullanıcıya görünür kıl (aşağıda "dirty-on-roundtrip" uyarısı). Bunlar anlamı korur. |
| Desteklenmeyen yapı | Ham HTML blokları, MDX JSX, bazı container/directive'ler | Crepe ham HTML'i node olarak korur (preset-gfm + html). Yine de **geçiş öncesi guard**: belgede riskli yapı varsa uyar. |
| Genişletme paketi eksikliği | Footnote, `[^1]` — Crepe preset'inde yoksa düz metne düşebilir | Crepe feature setini preview ile **hizala**; footnote'u Crepe tarafında da etkin tut ya da WYSIWYG'i footnote içeren belgede uyarıyla aç. |
| Boşluk/satır sonu | Trailing space, çoklu boş satır sıkışması | Anlamsız; kabul. |

**Korunma mekanizması — geçişten önce kayıp tahmini:**

```ts
// editor/roundtrip-guard.ts
// Crepe'i HEADLESS oluşturup md → md round-trip yap, diff'le.
import { Crepe } from '@milkdown/crepe';

export async function predictRoundtrip(md: string): Promise<{ lossy: boolean; after: string }> {
  const host = document.createElement('div');           // DOM'a eklenmez (offscreen)
  const probe = new Crepe({ root: host, defaultValue: md });
  await probe.create();
  const after = probe.getMarkdown();
  await probe.destroy();
  // Anlamlı diff: whitespace/normalize farklarını eleyip yapısal fark kalıyor mu?
  const lossy = normalize(after) !== normalize(md);     // normalize: emphasis/marker/blank-line eşitleme
  return { lossy, after };
}
```

Akış: kullanıcı WYSIWYG'e geçmek isteyince `predictRoundtrip` çalışır.
- `lossy === false` → sessiz geç.
- `lossy === true` → modal: "WYSIWYG editörü bazı biçimlendirmeyi yeniden yazacak (örn. `*` → `_`). Önizle / Devam et / İptal." "Önizle" CM6 merge view ile diff gösterir (`@codemirror/merge` opsiyonel).

**Dirty-on-roundtrip:** WYSIWYG'den çıkışta `getMarkdown()` sonucu, girişteki metinden farklıysa `dirty=true` işaretlenir (kullanıcı hiç yazmasa bile normalize değişikliği kaydedilebilir olmalı).

### 2.2 Round-trip testi (CI)

```ts
// tests/roundtrip.spec.ts (vitest, jsdom)
import fixtures from './fixtures/*.md?raw';   // gerçek dünya md örnekleri
for (const md of fixtures) {
  test(`crepe round-trip stable on second pass`, async () => {
    const once = await crepeRoundtrip(md);
    const twice = await crepeRoundtrip(once);
    // İlk geçiş normalize edebilir; ikinci geçiş SABİT olmalı (idempotent)
    expect(twice).toBe(once);
  });
}
```
Anahtar invariant: **idempotency** — `f(f(x)) === f(x)`. İlk normalizasyonu kabul ederiz; ama tekrar tekrar geçişte metin "kaymamalı". Fixture seti: GFM tablo, task-list, footnote, nested list, code fence + dil, KaTeX inline/blok, ham HTML, mermaid fence.

---

## 3. CodeMirror 6 Kurulumu

### 3.1 Extension kompozisyonu

```ts
// editor/cm-setup.ts
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor,
  keymap, highlightSpecialChars,
} from '@codemirror/view';
import {
  history, defaultKeymap, historyKeymap, indentWithTab,
} from '@codemirror/commands';
import {
  syntaxHighlighting, defaultHighlightStyle, HighlightStyle,
  bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

// Dinamik olarak değişen parçalar → Compartment
export const languageConf = new Compartment();   // lang-markdown / lang-* / boş
export const themeConf    = new Compartment();   // açık/koyu tema
export const readOnlyConf = new Compartment();   // büyük dosya / salt-okunur
export const lineWrapConf = new Compartment();   // metin sarma (md/txt için açık)

// Özel highlight (Lezer tag → CSS sınıfı/stil)
const appHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '600' },
  { tag: t.strong,  fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.keyword], color: 'var(--tok-keyword)' },
  { tag: [t.string],  color: 'var(--tok-string)' },
  { tag: [t.comment], color: 'var(--tok-comment)', fontStyle: 'italic' },
  // ... CSS değişkenleri tema ile değişir
]);

export function baseExtensions(): Extension {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of('  '),                 // 2 boşluk varsayılan
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    syntaxHighlighting(appHighlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    // Compartment slotları (başlangıçta boş/varsayılan)
    languageConf.of([]),
    themeConf.of([]),
    readOnlyConf.of([]),
    lineWrapConf.of([]),
  ];
}

export function makeState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: baseExtensions() });
}
```

> Not: `basic-setup` paketini **kullanmıyoruz** — extension'ları elle kompoze etmek bundle'ı küçültür ve compartment kontrolü verir. `search()`'ü panelli istiyorsak ayrıca `search({ top: true })` eklenir.

### 3.2 Çok dilli highlight — lazy yükleme stratejisi

`@codemirror/language-data` bir `LanguageDescription[]` tablosu verir; her giriş bir `load(): Promise<LanguageSupport>` taşır. Dil parser'ı **ilk gerektiğinde** import edilir (her dil ayrı Rollup chunk → eager bundle'a girmez).

```ts
// editor/lang-loader.ts
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { languageConf } from './cm-setup';
import type { EditorView } from '@codemirror/view';

// Dosya adı / fence info string'ine göre dil bul
export function findLang(filenameOrName: string): LanguageDescription | null {
  return (
    LanguageDescription.matchFilename(languages, filenameOrName) ??
    LanguageDescription.matchLanguageName(languages, filenameOrName)
  );
}

export async function setLanguageFor(view: EditorView, filename: string) {
  const desc = findLang(filename);
  if (!desc) {
    // bilinmeyen → düz metin (highlight yok)
    view.dispatch({ effects: languageConf.reconfigure([]) });
    return;
  }
  const support = await desc.load();          // ← lazy import: ayrı chunk
  view.dispatch({ effects: languageConf.reconfigure(support) });
}
```

**Markdown ana dili özel:** `.md` için `language-data`'nın markdown girişini kullanmak yerine doğrudan `@codemirror/lang-markdown` eager veririz; çünkü split/source markdown ana akış ve fenced-code içi gömülü highlight için `codeLanguages` parametresi gerekir:

```ts
// editor/markdown-lang.ts
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';

export function markdownSupport() {
  return markdown({
    base: markdownLanguage,              // GFM dahil
    codeLanguages: languages,            // ```ts blokları lazy highlight'lansın
    addKeymap: true,
  });
}
```
Böylece `.md` içindeki ` ```rust ` bloğu, kullanıcı o dosyayı açtığında Rust parser'ını **otomatik lazy** yükler (markdown eklentisi `languages` tablosunu kullanır).

**Yaygın dil önyükleme (opsiyonel ısınma):** En çok kullanılan 5-6 dil (`javascript`, `typescript`, `json`, `python`, `rust`, `markdown`) için `requestIdleCallback` içinde sessiz prefetch — açılış yolunu yavaşlatmadan ilk dil değişimini anlık yapar. Diğer ~140 dil tamamen on-demand.

### 3.3 Lit host bileşeni (CM6)

```ts
// editor/source-view.ts
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { EditorView } from '@codemirror/view';
import { makeState, readOnlyConf, lineWrapConf } from './cm-setup';
import { EditorState } from '@codemirror/state';
import { setLanguageFor } from './lang-loader';
import { markdownSupport } from './markdown-lang';
import { languageConf } from './cm-setup';

@customElement('source-view')
export class SourceView extends LitElement {
  createRenderRoot() { return this; }        // Light DOM (global tema + CM stilleri)
  @property({ attribute: false }) doc!: DocState;
  view!: EditorView;

  firstUpdated() {
    const host = this.querySelector('.cm-host') as HTMLElement;
    this.view = new EditorView({
      state: makeState(this.doc.text),
      parent: host,
      dispatch: (tr) => {
        this.view.update([tr]);
        if (tr.docChanged) this.onDocChanged();
      },
    });
    this.applyLanguage();
    if (this.doc.kind !== 'code')
      this.view.dispatch({ effects: lineWrapConf.reconfigure(EditorView.lineWrapping) });
  }

  private applyLanguage() {
    if (this.doc.kind === 'markdown' || this.doc.kind === 'text')
      this.view.dispatch({ effects: languageConf.reconfigure(markdownSupport()) });
    else
      setLanguageFor(this.view, /* path/filename */ this.doc.id);
  }

  getText() { return this.view.state.doc.toString(); }

  setText(text: string) {     // WYSIWYG'den dönüşte tam replace
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
  }

  private onDocChanged() { /* dirty=true, debounce preview, autosave */ }

  disconnectedCallback() { super.disconnectedCallback(); this.view?.destroy(); }
  render() { return html`<div class="cm-host"></div>`; }
}
```

---

## 4. Split Live-Preview (CM6 + markdown-it)

### 4.1 markdown-it pipeline

```ts
// editor/preview/renderer.ts
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import anchor from 'markdown-it-anchor';
import taskLists from 'markdown-it-task-lists';
import katexPlugin from '@vscode/markdown-it-katex';   // KaTeX 0.17
import Prism from 'prismjs';

// Mermaid fence'leri RENDER ETME — sadece işaretle; mermaid lazy & async (§4.3)
function highlight(code: string, lang: string): string {
  if (lang === 'mermaid') {
    // ham metni kaçışla sakla; async render sonradan DOM'da yapılacak
    return `<pre class="mermaid-pending" data-src="${escapeAttr(code)}"></pre>`;
  }
  const grammar = lang && Prism.languages[lang];
  if (grammar) {
    const html = Prism.highlight(code, grammar, lang);
    return `<pre class="language-${lang}"><code>${html}</code></pre>`;
  }
  return ''; // boş → markdown-it kendi kaçışını yapar
}

export const md = new MarkdownIt({
  html: true,            // ham HTML (preview; sanitize aşağıda)
  linkify: true,
  breaks: false,         // GFM: tek satır sonu <br> değil
  typographer: true,
  highlight,
})
  .use(footnote)
  .use(taskLists, { enabled: true, label: true, labelAfter: true })
  .use(anchor, {
    permalink: anchor.permalink.headerLink(),
    slugify: (s: string) => slugify(s),   // scroll-sync için deterministik id
  })
  .use(katexPlugin, { throwOnError: false, errorColor: 'var(--err)' });

export function renderMarkdown(src: string): string {
  return md.render(src);   // string HTML döner
}
```

**Prism dil yükleme:** Prism çekirdeği eager; ama her dil komponenti (`prismjs/components/prism-rust` …) ağır. Strateji: preview'de görünen fence dillerini **on-demand** yükle (CM6'daki gibi). Bir `loadPrismLang(lang)` haritası ile `import('prismjs/components/prism-' + lang)` lazy. Yüklenene kadar blok highlight'sız gösterilir, yüklendiğinde re-render.

**Güvenlik:** `html: true` açık olduğundan preview HTML'i `connect-src 'none'` CSP + bir sanitizer'dan (örn. DOMPurify, offline) geçirilir; `<script>`, `on*` attribute, `javascript:` URL'leri temizlenir. Offline-by-default ilkesi gereği preview'deki `<img src="http…">` opsiyonel "uzak içerik engelle" anahtarına bağlanır.

### 4.2 Debounce + sadece görünür render + scroll-sync

```ts
// editor/split-view.ts (özet)
import { renderMarkdown } from './preview/renderer';
import { renderPendingMermaid } from './preview/mermaid';   // lazy
import { typesetKatexIfNeeded } from './preview/math';

const DEBOUNCE = 120; // ms

class SplitController {
  private timer = 0;
  private lastHTML = '';

  onCmChange(text: string) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(text), DEBOUNCE);
  }

  private render(text: string) {
    const html = renderMarkdown(text);
    if (html === this.lastHTML) return;       // değişmediyse DOM'a dokunma
    this.lastHTML = html;
    morphdom(this.previewEl, `<div>${html}</div>`, { childrenOnly: true }); // diff-patch
    renderPendingMermaid(this.previewEl);     // lazy & async, sadece .mermaid-pending
    // KaTeX zaten md-it-katex ile string'e gömülü; ek typeset gerekmez
  }
}
```

- **Debounce 120 ms:** yazarken her tuşta render etmeyiz; durakta render.
- **Diff-patch (morphdom):** `innerHTML =` yerine DOM ağacını fark-yamala → scroll pozisyonu/seçim korunur, layout thrash azalır.
- **Sadece görünür / büyük belge:** Belge çok uzunsa preview'i blok-bazlı sanal kaydırma (IntersectionObserver) ile render et; ekran dışı blokları placeholder yükseklikle tut. (Markdown belgeleri için genelde gereksiz; >X bin satırda devreye girer. Multi-GB log zaten `isLarge` → split kapalı.)

**Scroll-sync (CM6 satır ↔ preview elementi):**
```ts
// markdown-it satır eşlemesi: token.map ile her blok başına data-line ekle
md.core.ruler.push('inject-line', (state) => {
  for (const tok of state.tokens)
    if (tok.map && tok.level === 0) tok.attrSet('data-line', String(tok.map[0]));
});
// CM6 scroll → görünür ilk satır → preview'de en yakın [data-line] elementine kaydır
view.scrollDOM.addEventListener('scroll', throttle(() => {
  const line = view.state.doc.lineAt(view.elementAtHeight(view.scrollDOM.scrollTop).from).number - 1;
  const target = preview.querySelector(`[data-line="${nearest(line)}"]`);
  target?.scrollIntoView({ block: 'start' });
}, 50));
```
Çift yönlü sync için bir "scroll origin" kilidi (programatik scroll'u kullanıcı scroll'undan ayır) ile geri besleme döngüsü engellenir.

### 4.3 Mermaid lazy

```ts
// editor/preview/mermaid.ts
let mermaidMod: typeof import('mermaid')['default'] | null = null;

export async function renderPendingMermaid(root: HTMLElement) {
  const nodes = root.querySelectorAll<HTMLElement>('pre.mermaid-pending');
  if (nodes.length === 0) return;
  if (!mermaidMod) {
    mermaidMod = (await import('mermaid')).default;   // ← ilk diyagramda yüklenir
    mermaidMod.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
  }
  for (const el of nodes) {
    const src = decodeAttr(el.dataset.src!);
    try {
      const { svg } = await mermaidMod.render('mmd-' + uid(), src);
      el.outerHTML = `<div class="mermaid">${svg}</div>`;
    } catch (e) {
      el.outerHTML = `<pre class="mermaid-error">${escapeHtml(String(e))}</pre>`;
    }
  }
}
```
- `securityLevel: 'strict'` → CSP `script-src 'self'` ile uyumlu (htmlLabels kapalı, `'unsafe-eval'` gerekmez).
- Mermaid bundle (~weighty) yalnızca belgede `mermaid` fence varsa indirilir.

**KaTeX lazy:** `@vscode/markdown-it-katex` KaTeX'i parse anında çağırır; KaTeX'i ayrı chunk tutmak için preview render'ı dynamic-import et (`const { renderMarkdown } = await import('./preview/renderer')`). Böylece markdown belgesi açılmadan KaTeX/markdown-it eager bundle'a girmez. Split'e ilk geçişte yüklenir. KaTeX CSS'i de aynı anda lazy import (`katex/dist/katex.min.css`).

---

## 5. Milkdown / Crepe Kurulumu (WYSIWYG)

### 5.1 Paketler ve feature seti

`@milkdown/crepe` 7.21.2 "batteries-included"tır; `@milkdown/kit` (çekirdek + GFM/commonmark preset + listener vb.) üzerine kuruludur. Ek olarak GFM zaten Crepe içinde. Ayrıca CrepeFeature enum'u şu özellikleri kapsar (kaynak doğrulandı):

`CodeMirror, ListItem, LinkTooltip, Cursor, ImageBlock, BlockEdit, Toolbar, Placeholder, Table, Latex, TopBar, AI`.

```ts
// editor/wysiwyg-view.ts
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('wysiwyg-view')
export class WysiwygView extends LitElement {
  createRenderRoot() { return this; }                 // Light DOM (Crepe global teması)
  @property({ attribute: false }) doc!: DocState;
  private crepe?: import('@milkdown/crepe').Crepe;
  private lastMarkdown = '';

  async firstUpdated() {
    const root = this.querySelector('.crepe-host') as HTMLElement;
    const { Crepe, CrepeFeature } = await import('@milkdown/crepe');   // ← LAZY chunk
    await import('@milkdown/crepe/theme/common/style.css');
    await import('@milkdown/crepe/theme/frame.css');                   // tema

    this.crepe = new Crepe({
      root,
      defaultValue: this.doc.text,                    // SSOT → WYSIWYG
      features: {
        [CrepeFeature.CodeMirror]: true,              // kod blokları CM6 ile (tek instance!)
        [CrepeFeature.Latex]: true,                   // KaTeX 0.17
        [CrepeFeature.Table]: true,
        [CrepeFeature.ListItem]: true,
        [CrepeFeature.LinkTooltip]: true,
        [CrepeFeature.ImageBlock]: true,
        [CrepeFeature.BlockEdit]: true,               // "/" slash menü
        [CrepeFeature.Toolbar]: true,                 // seçim baloncuğu
        [CrepeFeature.Placeholder]: true,
        [CrepeFeature.AI]: false,                     // OFFLINE/sıfır telemetri → KAPALI
        [CrepeFeature.TopBar]: false,
      },
      featureConfigs: {
        [CrepeFeature.Placeholder]: { text: 'Yazmaya başla…' },
        [CrepeFeature.CodeMirror]: {
          // Crepe'in kod-bloğu CM6'sı bizimle aynı @codemirror/* sürümünü kullanır
          languages: /* @codemirror/language-data languages */ undefined,
        },
      },
    });

    // Markdown değişimini dinle (dirty + opsiyonel canlı SSOT)
    this.crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        this.lastMarkdown = markdown;
        this.dispatchEvent(new CustomEvent('doc-changed', { detail: markdown }));
      });
    });

    await this.crepe.create();
  }

  getMarkdown(): string {
    return this.crepe ? this.crepe.getMarkdown() : this.lastMarkdown;
  }

  async dispose() { await this.crepe?.destroy(); this.crepe = undefined; }
  disconnectedCallback() { super.disconnectedCallback(); void this.dispose(); }
  render() { return html`<div class="crepe-host"></div>`; }
}
```

**Notlar:**
- `crepe.on(listener => listener.markdownUpdated(...))` → listener plugin Crepe içinde dahili; her değişimde markdown verir → `dirty` ve canlı kaydetme için.
- `crepe.getMarkdown()` → anlık serialize (mod çıkışında SSOT'a yazılır).
- **AI feature kapalı** — proje sıfır-telemetri/offline; Crepe'in AI özelliği dış servise gidebilir, kapatılır.
- `CrepeFeature.CodeMirror` Crepe'in kod bloklarını **bizim CM6 ile aynı paketlerden** render eder → §0'daki tek-instance pinleme bu yüzden zorunlu.
- Bilinen kenar durum (Milkdown #1640): kod bloğunda dil seçilmezse eski sürümlerde `getMarkdown()` `blockLatexSchema` ile patlayabiliyordu; 7.21.2'de giderildi — yine de `getMarkdown()` try/catch ile sarmalanır, hata olursa son `markdownUpdated` değerine düşülür.

### 5.2 Tema

Crepe hazır temalar sunar (`@milkdown/crepe/theme/*`): `common/style.css` (zorunlu temel) + bir görünüm teması (`frame.css`, `nord.css`, vb.). Açık/koyu, uygulamanın `themeConf`'una bağlanır; CSS değişkenleri (`--crepe-color-*`) global tema token'ları ile override edilir. Tema CSS'i de **lazy** (WYSIWYG ile birlikte) yüklenir.

---

## 6. Mod Geçiş Orkestrasyonu (kritik kod)

```ts
// editor/mode-switch.ts
import type { SourceView } from './source-view';
import type { WysiwygView } from './wysiwyg-view';
import { predictRoundtrip } from './roundtrip-guard';

type Mode = 'source' | 'split' | 'wysiwyg';

export class EditorController {
  private cm?: SourceView;          // source/split paylaşır
  private wys?: WysiwygView;
  mode: Mode = 'source';

  async switchTo(next: Mode, doc: DocState): Promise<void> {
    if (next === this.mode) return;
    if (doc.isLargeBlocked(next))   // büyük dosya → wysiwyg/split engelli
      throw new Error('Bu dosya için kullanılamaz mod');

    // 1) source <-> split: aynı CM, sadece preview panel toggle — serialize YOK
    if (isCmMode(this.mode) && isCmMode(next)) {
      this.togglePreview(next === 'split');
      this.mode = next;
      return;
    }

    // 2) CM -> WYSIWYG
    if (isCmMode(this.mode) && next === 'wysiwyg') {
      const md = this.cm!.getText();
      const { lossy, after } = await predictRoundtrip(md);
      if (lossy && !(await confirmLossy(md, after))) return;  // kullanıcı iptal edebilir
      doc.text = md;                       // SSOT güncelle
      this.cm!.hide();                     // destroy DEĞİL (undo/scroll korunur)
      await this.mountWysiwyg(doc);
      this.mode = next;
      return;
    }

    // 3) WYSIWYG -> CM (source/split)
    if (this.mode === 'wysiwyg' && isCmMode(next)) {
      const md = this.wys!.getMarkdown();
      if (md !== doc.text) doc.dirty = true;   // normalize bile olsa kaydedilebilir
      doc.text = md;
      await this.wys!.dispose();               // Vue/PM belleğini bırak
      this.wys = undefined;
      this.cm!.setText(md);                    // tam replace (tek undo adımı)
      this.cm!.show();
      this.togglePreview(next === 'split');
      this.mode = next;
      return;
    }
  }
}
const isCmMode = (m: Mode) => m === 'source' || m === 'split';
```

**Garanti edilen invariant'lar:**
1. Aynı anda yalnız bir motor SSOT'a yazar (`activeEngine`).
2. `source↔split` geçişi **sıfır serileştirme** (anlık, kayıpsız).
3. WYSIWYG'e giriş **lossy-guard**'dan geçer; çıkış idempotency testli serialize ile.
4. CM view WYSIWYG sırasında **yaşar** (gizli) → undo history/scroll korunur; Crepe ise her çıkışta **destroy** → bellek hedefi (sub-100 MB) korunur.

---

## 7. Performans Özeti (editör katmanı)

| Teknik | Uygulama |
|---|---|
| Eager bundle minimal | Lit + CM6 (state/view/commands/language/search/autocomplete) + `lang-markdown`. markdown-it/Prism/KaTeX/Mermaid/Crepe **hepsi lazy** (`manualChunks`). |
| Dil parser'ları on-demand | `@codemirror/language-data` + `desc.load()`; Prism `import('prismjs/components/...')`. ~140 dil eager girmez. |
| Preview debounce | 120 ms; değişmeyen HTML → DOM'a dokunma; morphdom diff-patch. |
| Görünür-render | Uzun belgede IntersectionObserver blok sanallaştırma; multi-GB log split-dışı. |
| Mermaid/KaTeX lazy | İlk diyagram/ilk matematik anına kadar indirilmez; CSS de lazy. |
| Crepe lazy + destroy | WYSIWYG'e ilk geçişte indir; çıkışta `destroy()` → Vue/PM bellekte kalmaz. |
| Tek CM6 instance | Crepe + source aynı `@codemirror/state` (pin) → çift parser/çift bellek yok. |
| Idle prefetch | Yaygın 5-6 dil `requestIdleCallback`'te sessiz ısıtma (açılışı yavaşlatmadan). |

---

## KİLİTLENEN KARARLAR (Editör & Çift-Mod)

1. **Üç mod:** `source` (CM6), `split` (CM6 + markdown-it preview, **aynı EditorView**), `wysiwyg` (Crepe, lazy). `source↔split` geçişi serileştirmesiz (sadece preview panel toggle).
2. **SSOT = markdown string.** İki motor asla aynı anda canlı değil. CM6→md kayıpsız; tek riskli yön `source→wysiwyg→source` (Remark normalizasyonu).
3. **Round-trip koruması:** WYSIWYG'e geçişten önce offscreen Crepe ile `predictRoundtrip`; lossy ise kullanıcı onayı/diff. CI invariant'ı **idempotency** (`f(f(x))===f(x)`), gerçek-dünya fixture seti (tablo, task-list, footnote, KaTeX, mermaid, ham HTML).
4. **Tek CM6 instance zorunlu:** `@codemirror/*` ve `katex` `pnpm.overrides` ile tek sürüme pinli (state 6.6.0, view 6.43.0, commands 6.10.3, katex 0.17.0). Crepe kendi CM6 kopyasını kullanmaz → `Facet`/`StateField` kimlik bozulması önlenir.
5. **CM6 kurulumu:** `basic-setup` yerine elle extension kompozisyonu + `Compartment`'lar (`language/theme/readOnly/lineWrap`). `lang-markdown` `{ base: markdownLanguage, codeLanguages: languages }` ile fence-içi highlight lazy.
6. **Çok dilli highlight lazy:** `@codemirror/language-data` `LanguageDescription.matchFilename/matchLanguageName` + `desc.load()`; her dil ayrı chunk; yaygın diller idle-prefetch. Preview tarafında Prism dilleri de on-demand.
7. **Crepe kurulumu:** `@milkdown/crepe` 7.21.2; feature seti `CodeMirror/Latex/Table/ListItem/LinkTooltip/ImageBlock/BlockEdit/Toolbar/Placeholder` açık; **`AI` ve `TopBar` kapalı** (offline/sıfır telemetri). `crepe.on(l=>l.markdownUpdated)` dirty için, `getMarkdown()` çıkışta SSOT'a yazar, `destroy()` çıkışta bellek için.
8. **markdown-it pipeline (14.2.0):** `+footnote(4.0.0) +anchor(9.2.0, deterministik slug → scroll-sync) +task-lists(2.1.1) +@vscode/markdown-it-katex(throwOnError:false)`. Kod blokları **Prism**; **mermaid fence render edilmez**, `mermaid-pending` ile işaretlenip async lazy render edilir. `html:true` + offline DOMPurify sanitize.
9. **Split performansı:** 120 ms debounce, değişmeyen HTML atla, morphdom diff-patch (scroll/seçim korunur), `data-line` tabanlı çift-yönlü scroll-sync (origin kilidi ile geri-besleme önlenir).
10. **Mermaid/KaTeX/Crepe/markdown-it tamamen lazy** (`manualChunks`: `crepe`, `mermaid`, `katex`, `preview`). Eager = Lit + CM6 source + lang-markdown → <500 ms açılış hedefi.
11. **Büyük dosya (`isLarge`):** yalnız `source` modu; `split` ve `wysiwyg` UI'da disabled (tüm-metin DOM render riski). Multi-GB log CM6 source + chunked besleme.
12. **Mod geçişinde CM view yaşatılır (gizlenir), Crepe destroy edilir** → undo/scroll korunur + sub-100 MB RAM hedefi korunur.

Kaynaklar: [@codemirror/view npm](https://www.npmjs.com/package/@codemirror/view), [@codemirror/state npm](https://www.npmjs.com/package/@codemirror/state), [@codemirror/commands npm](https://www.npmjs.com/package/@codemirror/commands), [CodeMirror lang-package örneği](https://codemirror.net/examples/lang-package/), [codemirror/language-data](https://github.com/codemirror/language-data), [lang-markdown](https://github.com/codemirror/lang-markdown), [@milkdown/crepe npm](https://www.npmjs.com/package/@milkdown/crepe), [Crepe API](https://milkdown.dev/docs/api/crepe), [Using Crepe](https://milkdown.dev/docs/guide/using-crepe), [Plugin Listener](https://milkdown.dev/docs/api/plugin-listener), [Crepe getMarkdown blockLatexSchema bug #1640](https://github.com/Milkdown/milkdown/issues/1640), [markdown-it npm](https://www.npmjs.com/package/markdown-it), [markdown-it-footnote](https://www.npmjs.com/package/markdown-it-footnote), [markdown-it-anchor](https://www.npmjs.com/package/markdown-it-anchor), [markdown-it-task-lists](https://www.npmjs.com/package/markdown-it-task-lists), [@vscode/markdown-it-katex](https://www.npmjs.com/package/@vscode/markdown-it-katex), [prismjs npm](https://www.npmjs.com/package/prismjs).
