# Mimari Doküman: Hafif Metin + Markdown + Kod Editörü (Tauri v2)

> Tarih: Haziran 2026. Sürümler aşağıda araştırılarak doğrulandı. Yığın kilitli (Seçenek A); bu doküman onun üzerine somut kararlar koyar.

## 0. Doğrulanmış Sürüm Matrisi (Haziran 2026)

| Katman | Paket / Crate | Sürüm | Not |
|---|---|---|---|
| Kabuk (Rust) | `tauri` | 2.x (CLI/api 2.11.x) | `tauri-cli` 2.11.3, `@tauri-apps/api` 2.11.1 |
| Build (Rust) | `tauri-build` | 2.x | build.rs |
| FS plugin | `tauri-plugin-fs` / `@tauri-apps/plugin-fs` | 2.x | scope tabanlı izinler |
| Dialog | `tauri-plugin-dialog` / `@tauri-apps/plugin-dialog` | 2.x | native open/save |
| Updater | `tauri-plugin-updater` / `@tauri-apps/plugin-updater` | 2.x | imzalı, opsiyonel |
| Store | `tauri-plugin-store` / `@tauri-apps/plugin-store` | 2.4.2 | ayar/oturum kalıcılığı |
| FS watch | `tauri-plugin-fs` watch API veya `notify` crate | — | aşağıda gerekçe |
| Editör çekirdek | `codemirror` (meta) | 6.0.2 | + ayrı `@codemirror/*` modülleri |
| CM6 state/view | `@codemirror/state` / `@codemirror/view` | 6.4.x / 6.x | Crepe da bunları çeker |
| WYSIWYG | `@milkdown/crepe` (+ `@milkdown/kit`) | 7.21.2 | **dahili olarak Vue 3.5 + ProseMirror çeker** |
| Preview render | `markdown-it` | 14.2.0 | |
| Preview highlight | `prismjs` | 1.30.0 | sadece preview blokları |
| Matematik | `katex` | 0.17.0 | Crepe zaten katex 0.17 çeker |
| Diyagram | `mermaid` | 11.15.0 | lazy import |
| Export (Rust) | `comrak` veya `pulldown-cmark` | comrak ~0.x / pulldown ~0.x | + opsiyonel Pandoc subprocess |

**Kritik bulgu:** `@milkdown/crepe` 7.21.2 bağımlılıkları `vue@^3.5.20`, `prosemirror-*`, `@codemirror/*` ve `katex@^0.17` içerir. Yani WYSIWYG modunu açar açmaz Vue + ProseMirror bundle'a giriyor. Bu, frontend framework seçimini doğrudan etkiler (aşağıda).

---

## 1. Frontend Yaklaşımı: Karar = **Vanilla TypeScript + Lit (ada/island bileşenler için)**

### 1.1 Gerekçe

CM6 ve Milkdown'ın ikisi de **framework-agnostik, kendi DOM'unu yöneten imperatif kütüphaneler**. İkisi de "burada bir `<div>` ver, ben içini yönetirim" modelinde çalışır. Bu durumda bir reaktif framework'ün ana faydası (VDOM diffing / fine-grained DOM güncelleme) editörün *içinde* hiç kullanılamaz — sadece editörü saran **chrome** (sekmeler, durum çubuğu, komut paleti, ayar paneli, bulucu) için işe yarar.

Bundan dolayı seçim "hangi framework editörü yönetsin" değil, "chrome'u en hafif şekilde ne yönetsin" sorusudur.

| Seçenek | Runtime (min+gz) | Reaktivite | DX | CM6/Milkdown uyumu | Verdict |
|---|---|---|---|---|---|
| Vanilla TS + **Lit** | ~5 KB (lit-html+reactive) | Web Components + reaktif property | İyi, standartlara yakın, derleyici yok | Mükemmel — Web Component zaten "DOM ver" modeline uyar | **SEÇİLDİ** |
| Svelte 5 (runes) | ~2-5 KB | Compiler + signals | Çok iyi | İyi ama `bind:this` + `$effect` ile imperatif köprü; compiler katmanı | Yakın 2. |
| Solid | ~7 KB | Signals, surgical | İyi | İyi, ama JSX + reaktif graf editöre değmez | 3. |

**Neden Lit, Svelte değil:**
1. **Sıfır derleyici büyüsü / standart platform.** Lit düz TS + Web Components'tir; Vite içinde özel bir plugin gerektirmez, kaynak haritaları temiz, hata ayıklaması DOM seviyesinde nettir. Editör tabanlı imperatif kodla (CM6 `EditorView`, Milkdown `Crepe` instance) en az sürtünmeyi yaratır.
2. **Bundle disiplini.** Hedef <500 ms açılış / sub-100 MB boş RAM. Lit'in runtime'ı sabit ve küçük; chrome'un karmaşıklığı arttıkça lineer büyür, framework "vergisi" minimal.
3. **İzolasyon.** Crepe zaten Vue 3.5 getiriyor. Eğer chrome'u da Svelte/Solid ile yazarsak iki reaktif sistem + Vue = üç farklı reaktivite runtime'ı aynı uygulamada. Lit Web Component olduğu için Vue-temelli Milkdown ile çatışmadan yan yana yaşar (Shadow DOM opsiyonel sınır).

> Pragmatik istisna: Lit bileşenleri için varsayılan **Light DOM** kullan (global CSS teması ve KaTeX/Mermaid stillerinin sızabilmesi için `createRenderRoot() { return this; }`), Shadow DOM'u sadece komut paleti gibi gerçekten izole edilmek istenen overlay'lerde aç.

### 1.2 Tek runtime kuralı
Chrome = Lit. Editör çekirdeği = CM6 (vanilla). WYSIWYG = Crepe (Vue, kapsüllenmiş). Mermaid/KaTeX = lazy. Hiçbir yere React/Vue'yu chrome için ekleme.

---

## 2. Proje / Workspace Yapısı

```
vael/
├─ Cargo.toml                  # [workspace] kök
├─ package.json                # frontend + tauri cli
├─ pnpm-workspace.yaml         # pnpm (sıkı, hızlı, disk-verimli)
├─ vite.config.ts
├─ tsconfig.json
├─ index.html
├─ src/                        # FRONTEND (TS + Lit)
│  ├─ main.ts                  # bootstrap
│  ├─ app/
│  │  ├─ app-shell.ts          # <app-shell> Lit kök
│  │  ├─ tab-bar.ts            # <tab-bar>
│  │  ├─ status-bar.ts         # encoding/EOL/satır göstergesi
│  │  └─ command-palette.ts
│  ├─ editor/
│  │  ├─ source-view.ts        # CM6 sarmalayıcı (Lit host)
│  │  ├─ wysiwyg-view.ts       # Crepe sarmalayıcı (lazy)
│  │  ├─ split-view.ts         # CM6 + preview
│  │  ├─ cm-setup.ts           # CM6 extension kompozisyonu
│  │  └─ preview/
│  │     ├─ renderer.ts        # markdown-it + prism
│  │     ├─ math.ts            # katex (lazy)
│  │     └─ mermaid.ts         # mermaid (lazy import)
│  ├─ services/                # IPC WRAPPER KATMANI (tek sınır)
│  │  ├─ fs.ts                 # openWithEncoding, readChunk, save…
│  │  ├─ watch.ts              # dosya izleme event köprüsü
│  │  ├─ export.ts             # comrak/pandoc çağrıları
│  │  └─ ipc.ts               # invoke<T> tipli sarmalayıcı
│  ├─ state/                   # durum store (aşağıda §5)
│  │  ├─ store.ts              # signal-tabanlı hafif store
│  │  └─ types.ts
│  └─ styles/
│
├─ src-tauri/                  # RUST BACKEND
│  ├─ Cargo.toml               # workspace member
│  ├─ build.rs                 # tauri-build
│  ├─ tauri.conf.json
│  ├─ capabilities/
│  │  └─ main.json             # capability seti (§4)
│  ├─ icons/
│  └─ src/
│     ├─ main.rs               # builder, plugin kaydı, command kaydı
│     ├─ lib.rs
│     ├─ commands/
│     │  ├─ mod.rs
│     │  ├─ file.rs            # open/read_chunk/save
│     │  ├─ encoding.rs        # chardetng + encoding_rs
│     │  ├─ watch.rs           # notify entegrasyonu
│     │  └─ export.rs          # comrak/pulldown + pandoc
│     └─ core/                 # saf Rust (Tauri'den bağımsız)
│        └─ encoding.rs        # test edilebilir çekirdek
```

### 2.1 Cargo workspace (kök `Cargo.toml`)
```toml
[workspace]
members = ["src-tauri"]
resolver = "2"

[workspace.dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-fs = "2"
tauri-plugin-dialog = "2"
tauri-plugin-store = "2.4"
tauri-plugin-updater = "2"
encoding_rs = "0.8"
chardetng = "0.1"
notify = "8"
comrak = "0.x"        # export motoru
serde = { version = "1", features = ["derive"] }
```

`src-tauri/Cargo.toml` bu dependency'leri `{ workspace = true }` ile çeker. Çekirdek encoding mantığı `core/` altında Tauri'den bağımsız tutulur → birim testleri Tauri WebView olmadan koşar.

### 2.2 Vite (`vite.config.ts`)
```ts
import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] }, // Rust'ı Vite izlemesin
  },
  // Tauri WebView'ları modern → küçük polyfill, daha hızlı build
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        manualChunks: {
          // ağır WYSIWYG/diyagram/matematik ayrı chunk → lazy
          crepe: ['@milkdown/crepe', '@milkdown/kit'],
          mermaid: ['mermaid'],
          katex: ['katex'],
        },
      },
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
});
```

### 2.3 `tauri.conf.json` kritik alanlar
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "vael",
  "version": "0.1.0",
  "identifier": "dev.vael.app",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build"
  },
  "app": {
    "windows": [
      { "title": "vael", "width": 1200, "height": 800, "dragDropEnabled": true }
    ],
    "security": {
      "csp": "default-src 'self'; img-src 'self' asset: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost",
      "assetProtocol": { "enable": true, "scope": ["$DOCUMENT/**", "$HOME/**"] }
    }
  },
  "plugins": {
    "updater": {
      "endpoints": ["https://releases.vael.dev/{{target}}/{{arch}}/{{current_version}}"],
      "pubkey": "MASAUSTU_PUBLIC_KEY"
    }
  },
  "bundle": { "active": true, "targets": "all" }
}
```
- `style-src 'unsafe-inline'`: KaTeX ve Mermaid runtime inline stil enjekte eder → gerekli. `script-src 'self'` sıkı tutulur (Mermaid'i `'unsafe-eval'` olmadan kullanmak için `securityLevel: 'strict'` + `htmlLabels:false`).
- Telemetri yok: hiçbir `connect-src` dış domain yok (updater hariç, ayrı host).

---

## 3. Rust ↔ JS IPC Sözleşmesi

### 3.1 Sınırı hangi işlemler geçmeli

| İşlem | Neden Rust'ta | Yön |
|---|---|---|
| Encoding tespitli aç | `chardetng`/`encoding_rs` Rust'ta; JS'te güvenilir BOM/charset tespiti yok | command |
| Büyük dosya parçalı oku | Multi-GB log: byte-range okuma, satır indeksleme, mmap; JS bellek sınırı | command (offset/len) |
| Tüm dosya kaydet (encoding+EOL+BOM ile) | Doğru byte serileştirme | command |
| Dosya izle | `notify` crate native FS event; debounce | event (backend→frontend) |
| Export (md→html/pdf/docx) | `comrak`/`pulldown-cmark`, opsiyonel Pandoc subprocess | command |
| Dialog (open/save) | native plugin | plugin command |
| Büyük dosya satır indeksi | newline tarama Rust'ta hızlı | command |

**Kalan her şey frontend'de:** markdown-it preview render, Prism highlight, KaTeX, Mermaid, CM6/Milkdown editing — bunlar saf JS, sınır geçişine gerek yok.

### 3.2 Command imzaları (Rust)
```rust
// commands/encoding.rs
#[derive(serde::Serialize)]
pub struct FileMeta {
    pub path: String,
    pub encoding: String,   // "UTF-8", "windows-1254", ...
    pub has_bom: bool,
    pub eol: String,        // "LF" | "CRLF" | "Mixed"
    pub byte_len: u64,
    pub line_count: Option<u64>,  // küçük dosyalarda eager, büyükte None
    pub is_large: bool,     // > eşik (örn. 50 MB) → chunked mod
}

#[tauri::command]
async fn open_file(path: String, force_encoding: Option<String>)
    -> Result<OpenResult, String>;     // küçük dosya: tam içerik + meta

#[derive(serde::Serialize)]
pub struct OpenResult { pub meta: FileMeta, pub text: Option<String> }

// Büyük dosya: sadece meta + chunked okuma
#[tauri::command]
async fn read_chunk(path: String, byte_offset: u64, max_bytes: u64,
                    encoding: String) -> Result<Chunk, String>;

#[derive(serde::Serialize)]
pub struct Chunk { pub text: String, pub next_offset: u64, pub eof: bool }

#[tauri::command]
async fn save_file(path: String, text: String, encoding: String,
                   add_bom: bool, eol: String) -> Result<FileMeta, String>;

// commands/watch.rs  → event yayar, command sadece abone olur/keser
#[tauri::command]
async fn watch_file(app: tauri::AppHandle, path: String) -> Result<u32, String>; // watcher id
#[tauri::command]
async fn unwatch(id: u32) -> Result<(), String>;

// commands/export.rs
#[tauri::command]
async fn export(path_in: String, format: ExportFormat,
                opts: ExportOpts) -> Result<String, String>; // çıktı yolu
// ExportFormat = Html | PdfViaPandoc | DocxViaPandoc | StandaloneHtml
```

### 3.3 Event akışı (backend → frontend)
```
file-changed   { path, kind: "modified"|"removed"|"renamed" }   // notify debounce'lu
read-progress  { path, bytes_read, total }                      // büyük dosya akışı
export-progress{ stage, pct }
update-available { version, notes }                             // updater plugin
```
Frontend `services/watch.ts` içinde `listen('file-changed', …)` ile abone olur; UI'da "disk'te değişti, yeniden yükle?" uyarısı.

### 3.4 IPC wrapper (frontend tek sınır — `services/ipc.ts`)
```ts
import { invoke } from '@tauri-apps/api/core';

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(cmd, args); }
  catch (e) { throw new IpcError(cmd, e); }
}
```
Tüm `services/*` bunun üzerinden geçer; UI doğrudan `invoke` çağırmaz → test edilebilirlik + tek noktadan hata yönetimi.

---

## 4. Tauri v2 Capabilities / Permissions Planı (en az ayrıcalık)

`src-tauri/capabilities/main.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main",
  "description": "Main window minimal permissions",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "fs:allow-read-file",
    "fs:allow-write-file",
    "fs:allow-stat",
    "fs:allow-exists",
    {
      "identifier": "fs:scope",
      "allow": [
        { "path": "$HOME/**" },
        { "path": "$DOCUMENT/**" },
        { "path": "$DESKTOP/**" }
      ],
      "deny": [
        { "path": "$HOME/.ssh/**" },
        { "path": "$HOME/.gnupg/**" }
      ]
    },
    "store:default",
    "updater:default"
  ]
}
```

İlkeler:
- **fs**: `fs:default` toptan değil; tek tek `allow-read-file`/`allow-write-file`/`allow-stat` + dar `fs:scope`. Hassas dizinler (`.ssh`, `.gnupg`) `deny` ile dışlanır.
- **Dynamic scope:** Dialog ile seçilen dosyalar runtime'da `tauri_plugin_fs::FsExt::allow_file()` ile scope'a eklenir → kullanıcı dialog'dan ne açtıysa yalnızca ona erişim. Bu, statik scope'u dar tutup gerçek erişimi kullanıcı onayına bağlar.
- **dialog**: sadece `open` + `save`, mesaj dialogları gerekmedikçe yok.
- **updater**: `updater:default`; imza zorunlu (`pubkey`). Telemetri yok, sadece sürüm kontrolü.
- **store**: ayar/oturum kalıcılığı için.
- Hiçbir `shell:execute` yok — Pandoc opsiyonel ve ayrı capability arkasında (`shell:allow-execute` sadece bilinen `pandoc` binary'sine sidecar olarak) yalnızca kullanıcı Pandoc export'unu açarsa.

CSP §2.3'te tanımlı; `script-src 'self'`, dış `connect-src` yok.

---

## 5. Frontend Mimari

### 5.1 Durum yönetimi: hafif signal store (framework'süz)
Lit reactive property'leri bileşen-içi yeterli; uygulama-geneli durum için minik bir signal store (örn. ~1 KB; `@lit-labs/signals` veya el yapımı `Signal`). React/Vue store'u yok.

```ts
// state/types.ts
export type EditorMode = 'source' | 'split' | 'wysiwyg';
export interface DocState {
  id: string;
  path: string | null;
  title: string;
  encoding: string;
  hasBom: boolean;
  eol: 'LF' | 'CRLF' | 'Mixed';
  dirty: boolean;
  isLarge: boolean;          // chunked mod
  mode: EditorMode;
  // büyük dosyada CM6'ya tam metin verilmez; chunk penceresi tutulur
}
export interface AppState {
  docs: Map<string, DocState>;
  activeId: string | null;
}
```

```ts
// state/store.ts  (signal-tabanlı)
import { signal } from '@lit-labs/preact-signals';
export const docs = signal<Map<string, DocState>>(new Map());
export const activeId = signal<string | null>(null);
// Lit bileşenleri SignalWatcher mixin'i ile otomatik re-render
```

### 5.2 Editör mod yönetimi (Source / Split / WYSIWYG)

| Mod | Motor | Yükleme | Notlar |
|---|---|---|---|
| Source | CM6 (`EditorView`) | eager | her dosya tipi; büyük dosya = sadece bu mod |
| Split | CM6 + markdown-it preview (sağ panel) | eager (preview lazy modüller) | scroll-sync, debounced render |
| WYSIWYG | Milkdown Crepe | **lazy** (`import()`) | sadece markdown; büyük dosyada devre dışı |

```ts
// editor/wysiwyg-view.ts (Lit host, lazy Crepe)
async mountCrepe(root: HTMLElement, markdown: string) {
  const { Crepe } = await import('@milkdown/crepe');            // ayrı chunk
  await import('@milkdown/crepe/theme/common/style.css');
  this.crepe = new Crepe({ root, defaultValue: markdown });
  await this.crepe.create();
}
```

**Mod geçişi sözleşmesi:** kaynak-of-truth daima **markdown metni** (string). Source↔WYSIWYG geçişinde metin serileştirilip karşı motora verilir; iki motor aynı anda canlı değil (bellek + senkron sorunlarını önler). WYSIWYG → Source: `crepe.getMarkdown()`. CM6 → WYSIWYG: CM6 `state.doc.toString()`.

**Büyük dosya politikası:** `isLarge` ise WYSIWYG ve Split-preview kapatılır (preview render tüm metni ister). Sadece CM6 source, chunked/satır-pencereli besleme. CM6 milyonlarca satırı kaldırır; asıl risk preview/Crepe'in tüm metni DOM'a koymasıdır — bu yüzden engellenir.

### 5.3 Modül sınırları
```
chrome (Lit)  ──> services/* (IPC wrapper)  ──> invoke ──> Rust commands
   │                    │
   └─ editor/*  ────────┘  (editör motorları services üzerinden FS'e gider,
                            doğrudan Tauri API çağırmaz)
```
- `editor/*` ve `app/*` **asla** `@tauri-apps/*` import etmez; yalnızca `services/*` eder. Bu, editörü Tauri'den ayırır (ileride web/mobil hedefte mock servis takılabilir).
- `preview/`, `math.ts`, `mermaid.ts` ayrı dynamic chunk.

### 5.4 CM6 extension kompozisyonu (`editor/cm-setup.ts`)
```ts
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';

export const languageConf = new Compartment(); // dil dinamik değişir
export const themeConf = new Compartment();

export function makeState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(), highlightActiveLine(), drawSelection(),
      history(), bracketMatching(), highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle),
      languageConf.of([]), themeConf.of([]),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    ],
  });
}
```
Dil paketleri (`@codemirror/lang-*`) lazy yüklenir, `Compartment` ile `languageConf.reconfigure(...)`.

---

## 6. Build & Dev Akışı

| Komut | Ne yapar |
|---|---|
| `pnpm tauri dev` | `beforeDevCommand: pnpm dev` (Vite :1420) başlatır, Rust'ı debug derler, WebView açar, HMR aktif |
| `pnpm tauri build` | `pnpm build` (Vite prod → `dist/`), Rust release derler, platform bundle üretir |
| `pnpm dev` | yalnız Vite (tarayıcıda chrome geliştirme; Tauri API'leri mock'lanmalı) |
| `cargo test -p vael` (core) | encoding çekirdek testleri, WebView gerektirmez |

- **HMR:** Frontend değişiklikleri Vite HMR ile anlık; Rust değişiklikleri `tauri dev` watcher ile yeniden derlenip uygulamayı yeniden başlatır. `vite.config` içinde `watch.ignored: ['**/src-tauri/**']` ile çift watch önlenir.
- **Soğuk açılış hedefi (<500 ms):** eager bundle minimal (Lit + CM6 source), Crepe/Mermaid/KaTeX/markdown-it-preview lazy. `manualChunks` ile WYSIWYG yolu tamamen ertelenir.
- **CI bundle:** `tauri build --target` ile Windows (MSI/NSIS), macOS (.app/.dmg, evrensel), Linux (AppImage/deb) — `targets: "all"`.

---

## Mimari Şema (text)

```
┌──────────────────────────────────────────────────────────────────┐
│  OS WebView (WebView2 / WKWebView / WebKitGTK)                     │
│                                                                    │
│  ┌─ FRONTEND (TS) ──────────────────────────────────────────────┐ │
│  │  Lit chrome:  app-shell · tab-bar · status-bar · cmd-palette  │ │
│  │       │ signal store (docs, activeId, mode)                   │ │
│  │       ▼                                                       │ │
│  │  editor/   ┌─ source-view  → CM6 EditorView (eager)           │ │
│  │            ├─ split-view   → CM6 + markdown-it+Prism preview   │ │
│  │            └─ wysiwyg-view → Crepe (Vue/ProseMirror) [lazy]    │ │
│  │            preview: KaTeX[lazy] · Mermaid[lazy]                │ │
│  │       │  (editör/chrome ASLA tauri-api import etmez)          │ │
│  │       ▼                                                       │ │
│  │  services/ fs · watch · export · ipc  ──┐  (TEK IPC SINIRI)   │ │
│  └─────────────────────────────────────────┼──────────────────-─┘ │
│        invoke(cmd) ▲ | event listen ▲       │ invoke ▼              │
├────────────────────┼─────────────────-──────┼─────────────────────┤
│  ┌─ RUST (Tauri v2 core) ───────────────────▼───────────────────┐ │
│  │  commands: open_file · read_chunk · save_file ·              │ │
│  │            watch_file/unwatch · export                       │ │
│  │  core/encoding (chardetng + encoding_rs, BOM/EOL)  ← testli  │ │
│  │  notify (FS watch) ─emit→ file-changed event                 │ │
│  │  comrak/pulldown-cmark (export)  · [opsiyonel pandoc sidecar]│ │
│  │  plugins: fs · dialog · store · updater                      │ │
│  │  capabilities/main.json  (en az ayrıcalık, dar fs scope)     │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
         Telemetri YOK · dış connect-src YOK (updater hariç ayrı host)
```

---

## KILITLENEN KARARLAR

1. **Frontend UI katmanı = Vanilla TypeScript + Lit** (chrome için Web Components). React/Vue/Svelte/Solid chrome'a alınmaz. Gerekçe: CM6 + Milkdown framework-agnostik imperatif; framework yalnızca chrome'a değer ve Lit en hafif/standart/izole seçenek. Crepe zaten Vue 3.5 getirdiği için ikinci bir reaktif runtime eklenmez.
2. **Tek runtime kuralı:** Chrome=Lit, editör=CM6 (vanilla), WYSIWYG=Crepe (Vue, kapsüllü, lazy). Lit bileşenleri varsayılan **Light DOM**; Shadow DOM sadece overlay'lerde.
3. **Paket yöneticisi = pnpm**, **Cargo workspace** kökte; encoding çekirdeği `src-tauri/src/core/` altında Tauri'den bağımsız ve birim-testli.
4. **Sürüm kilidi (Haziran 2026):** Tauri 2.11.x, `@tauri-apps/api` 2.11.1, plugin-store 2.4.x, `@milkdown/crepe` 7.21.2, `codemirror` 6.0.2 + ayrı `@codemirror/*`, `markdown-it` 14.2.0, `prismjs` 1.30.0, `katex` 0.17.0, `mermaid` 11.15.0. KaTeX'i Crepe ile aynı 0.17 hattında tut (çakışma yok).
5. **IPC sınırı dar ve tipli:** Sadece `open_file`, `read_chunk` (byte-offset chunked), `save_file` (encoding+BOM+EOL ile), `watch_file`/`unwatch`, `export` sınırı geçer. markdown-it/Prism/KaTeX/Mermaid/CM6/Milkdown saf frontend. Tüm çağrılar tek `services/ipc.ts` wrapper'ından; UI/editör doğrudan `invoke` çağırmaz.
6. **Encoding/BOM Rust'ta:** `chardetng` (tespit) + `encoding_rs` (dönüşüm); meta'da `encoding`, `has_bom`, `eol`, `is_large` döner ve status-bar'da görünür/düzenlenebilir.
7. **Büyük dosya politikası:** `is_large` (örn. >50 MB) ise yalnızca CM6 source modu, chunked/satır-pencereli besleme; Split-preview ve WYSIWYG kapatılır (tam-metin DOM render riskini önlemek için).
8. **Mod sözleşmesi:** Kaynak-of-truth = markdown string. Source↔WYSIWYG geçişinde iki motor aynı anda canlı tutulmaz; geçişte `getMarkdown()` / `doc.toString()` ile serileştirme.
9. **Lazy-load sınırları:** Crepe, Mermaid, KaTeX ve preview render ayrı Rollup `manualChunks`. Eager bundle = Lit + CM6 source → <500 ms soğuk açılış hedefi.
10. **Capabilities (en az ayrıcalık):** `fs:default` yok; tek tek `allow-read-file`/`allow-write-file`/`allow-stat`/`allow-exists` + dar `fs:scope` (`$HOME/$DOCUMENT/$DESKTOP`, `.ssh`/`.gnupg` deny). Dialog'la açılan dosyalar runtime `allow_file()` ile scope'a eklenir. `dialog`: open/save; `updater`: imzalı; `store`: ayar. `shell` yok (Pandoc opsiyonel sidecar, ayrı capability + kullanıcı onayı).
11. **CSP sıkı:** `script-src 'self'` (Mermaid `securityLevel:'strict'`, `'unsafe-eval'` yok), `style-src 'self' 'unsafe-inline'` (KaTeX/Mermaid inline stil), dış `connect-src` yok. **Sıfır telemetri**, offline-by-default; tek dış bağlantı opsiyonel updater (ayrı host, imza zorunlu).
12. **FS watch = `notify` crate** (Rust), debounce'lu, `file-changed` event ile frontend'e; disk-dışı değişiklikte "yeniden yükle?" uyarısı.
13. **Export = Rust `comrak`/`pulldown-cmark`** dahili; Pandoc opsiyonel ve yalnızca kullanıcı seçerse sidecar.
14. **Modül izolasyonu:** `editor/*` ve `app/*` `@tauri-apps/*` import edemez; yalnızca `services/*` eder (ileride web/mobil için mock-edilebilir servis katmanı).
15. **Lisans = MIT** (en geniş ekosistem uyumu; tüm yığın MIT/Apache-2.0 uyumlu).

Sources: [Tauri FS plugin](https://v2.tauri.app/plugin/file-system/), [Tauri plugins-workspace](https://github.com/tauri-apps/plugins-workspace), [tauri crate](https://crates.io/crates/tauri), [tauri-plugin-store docs.rs](https://docs.rs/crate/tauri-plugin-store/latest), [@milkdown/crepe npm](https://www.npmjs.com/package/@milkdown/crepe), [CodeMirror huge doc demo](https://codemirror.net/examples/million/), [CodeMirror ref](https://codemirror.net/docs/ref/), [Solid vs Svelte 5 reactivity 2026](https://www.pkgpulse.com/guides/solidjs-vs-svelte-5-vs-react-reactivity-2026)


