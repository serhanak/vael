# Gizlilik/guvenlik, eklenti sinirlari, dagitim, imzalama, CI/CD

# Mimari Doküman (devam): Güvenlik, Gizlilik, Paketleme & Dağıtım

> Haziran 2026. Önceki dokümandaki kilitli yığın ve kararların (Tauri 2.11.x, Lit chrome, dar `fs:scope`, sıfır telemetri taahhüdü) üzerine inşa edilmiştir. Aşağıdaki tüm sürüm/maliyet/komut verileri araştırılarak doğrulandı.

---

## 1. Tauri v2 Güvenlik Modeli

### 1.1 Tehdit modeli (v2 varsayımı: WebView güvenilmezdir)

Tauri v2, v1'den temel bir kırılma getirdi: **WebView untrusted-by-default**. v1'de `allowlist` düz bir aç/kapa listesiydi — `fs` açıldığında her pencere OS'in izin verdiği her yolu okuyabiliyordu. v2'de her IPC yüzeyi "hangi pencere, hangi komutu, hangi scope ile çağırabilir" diye **capability** içinde açıkça ilan etmek zorunda. Runtime Authority (Tauri Core içinde) tüm permission/capability/scope'u runtime'da tutar ve zorlar.

Bizim için saldırı yüzeyi pratikte şudur: bir markdown dosyası içine gömülmüş kötü niyetli HTML/JS (XSS), bağımlılık zincirinde tehlikeye girmiş bir npm paketi, veya kötü niyetli bir `mermaid`/`katex` girdisi. Savunma katmanları:

| Katman | Önlem | Etki |
|---|---|---|
| 1. CSP | `script-src 'self'`, dış `connect-src` yok | Gömülü/enjekte JS çalışamaz, veri sızdıramaz |
| 2. Capabilities | Dar `fs:scope`, `shell` yok, ağ yok | XSS başarsa bile IPC yüzeyi minimal |
| 3. Isolation pattern | IPC mesajları sandbox iframe'den geçer | Frontend tehlikeye girse bile IPC payload doğrulanır |
| 4. Render sanitizasyonu | markdown-it `html:false` veya DOMPurify; Mermaid `securityLevel:'strict'` | Önizleme XSS'i kaynakta kesilir |

### 1.2 CSP (uzak içerik yok)

`tauri.conf.json` → `app.security.csp`:

```json
{
  "app": {
    "security": {
      "csp": {
        "default-src": "'self'",
        "script-src": "'self'",
        "style-src": "'self' 'unsafe-inline'",
        "img-src": "'self' asset: data: blob:",
        "font-src": "'self' data:",
        "connect-src": "'self' ipc: http://ipc.localhost",
        "object-src": "'none'",
        "base-uri": "'self'",
        "frame-src": "'self'"
      },
      "assetProtocol": {
        "enable": true,
        "scope": { "allow": ["$DOCUMENT/**", "$HOME/**"], "deny": ["$HOME/.ssh/**"] }
      }
    }
  }
}
```

Kritik noktalar ve gerekçeleri:

- **`connect-src` içinde HİÇBİR dış domain yok.** `ipc:` ve `http://ipc.localhost` Tauri'nin kendi IPC kanalı içindir (WebView2 custom-protocol). Bu, "sıfır telemetri"nin teknik kanıtının birinci ayağıdır: WebView'dan `fetch`/`XMLHttpRequest`/`WebSocket` ile **hiçbir uzak host'a** bağlantı CSP tarafından bloklanır. Updater dahi WebView'dan değil, **Rust tarafından** (plugin) ayrı host'a gider — yani WebView'ın CSP'si onu kapsamaz ama WebView'ın kendisi de erişemez.
- **`script-src 'self'`** — `'unsafe-inline'` ve `'unsafe-eval'` YOK. Bu Mermaid için zorluk yaratır (bazı modlar `eval` ister); çözüm Mermaid'i `securityLevel: 'strict'`, `htmlLabels: false` ile ve `mermaid.render()` API'sini (DOM injection yerine string SVG döndüren) kullanarak `eval`'siz çalıştırmaktır.
- **`style-src 'unsafe-inline'`** — KaTeX ve Mermaid runtime'da inline `style` üretir; bu tek taviz. XSS riski düşük (stil enjeksiyonu script çalıştıramaz, `script-src` zaten sıkı).
- **Markdown önizleme:** markdown-it `{ html: false }` varsayılan; kullanıcı HTML-passthrough isterse çıktı **DOMPurify**'dan geçer. Bu CSP'ye ek ikinci savunma (defense-in-depth).

### 1.3 Capabilities / Permissions (en az ayrıcalık)

`src-tauri/capabilities/main.json` (önceki dokümanda kilitlenen plan, burada tamamlanmış hali):

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main",
  "description": "Main window — minimal least-privilege surface",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-set-title",
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
        { "path": "$DESKTOP/**" },
        { "path": "$DOWNLOAD/**" }
      ],
      "deny": [
        { "path": "$HOME/.ssh/**" },
        { "path": "$HOME/.gnupg/**" },
        { "path": "$HOME/.aws/**" },
        { "path": "$APPLOCALDATA/**" }
      ]
    },
    "store:default",
    "updater:default"
  ]
}
```

Tasarım ilkeleri:

1. **`fs:default` yok.** Tek tek `allow-read-file` / `allow-write-file` / `allow-stat` / `allow-exists`. Hiçbir `allow-read-dir`/`allow-mkdir`/`allow-remove` yok — editörün ihtiyacı yok.
2. **`$APPLOCALDATA` deny edilir** — Tauri'nin resmi güvenlik tavsiyesi: WebView'ın kendi veri/config'i orada; okuma izni bilgi sızıntısına yol açar.
3. **Dinamik scope (asıl güvenlik mekanizması).** Statik scope sadece dialog'un *başlayabileceği* yerleri kapsar. Gerçek dosya erişimi runtime'da kullanıcı onayıyla verilir:

```rust
use tauri_plugin_fs::FsExt;

#[tauri::command]
async fn open_file_dialog(app: tauri::AppHandle) -> Result<Option<FileMeta>, String> {
    let Some(file) = app.dialog().file().blocking_pick_file() else { return Ok(None); };
    let path = file.into_path().map_err(|e| e.to_string())?;
    // Kullanıcı dialog'dan SEÇTİĞİ dosyayı runtime'da scope'a ekle:
    app.fs_scope().allow_file(&path).map_err(|e| e.to_string())?;
    Ok(Some(read_meta(&path)?))
}
```

Böylece statik scope dar kalır, **fiili erişim her zaman kullanıcının açık seçimine bağlanır** (consent-based scoping). Bir XSS dialog tetikleyemez (kullanıcı tıklaması gerekir).

4. **`shell` permission YOK.** Pandoc opsiyonel export'u ayrı bir capability (`pandoc.json`) arkasında ve yalnızca kullanıcı Pandoc'u etkinleştirirse `shell:allow-execute` ile *bilinen tek sidecar binary*'ye sınırlı. Varsayılan dağıtımda hiç yok.

### 1.4 Isolation pattern

İkinci bir savunma hattı: frontend tehlikeye girse bile (örn. bir npm bağımlılığı supply-chain saldırısına uğrasa), IPC mesajları Core'a ulaşmadan önce **ayrı sandbox iframe**'deki minimal "isolation app" tarafından doğrulanır ve runtime-üretilmiş bir AES-GCM anahtarıyla şifrelenir.

`tauri.conf.json`:
```json
{
  "app": {
    "security": {
      "pattern": { "use": "isolation", "options": { "dir": "../dist-isolation" } }
    }
  }
}
```

`dist-isolation/index.html` + `index.js` (minimal tutulur — supply-chain yüzeyi):
```javascript
// dist-isolation/index.js  —  klasik script (ES Module DESTEKLENMEZ)
window.__TAURI_ISOLATION_HOOK__ = (payload) => {
  // Beklenen komut beyaz listesi dışındaki her IPC'yi düşür:
  const ALLOWED = new Set([
    'open_file', 'read_chunk', 'save_file',
    'watch_file', 'unwatch', 'export', 'open_file_dialog',
  ]);
  if (payload && typeof payload.cmd === 'string' && !ALLOWED.has(payload.cmd)) {
    throw new Error(`isolation: blocked command ${payload.cmd}`);
  }
  return payload;
};
```

Bilinen sınırlar (tasarımı buna göre yaptık): ES Modules yüklenmez (klasik `<script>` kullan); Windows'ta sandbox iframe'e dış dosya yüklenmez (isolation app'i inline/self-contained tut); küçük şifreleme maliyeti. Bu yüzden isolation app'i **tek dosya, sıfır bağımlılık** tutuyoruz.

### 1.5 Sıfır telemetri TAAHHÜDÜ — nasıl KANITLANIR

Bu farklılaştırıcının inandırıcı olması için iddia değil, **doğrulanabilir** olmalı. Üç katmanlı kanıt:

| Kanıt katmanı | Mekanizma | Kullanıcı/denetçi nasıl doğrular |
|---|---|---|
| 1. CSP | `connect-src 'self' ipc:` — dış host yok | `tauri.conf.json` açık kaynak; DevTools Network sekmesi |
| 2. Capabilities | Hiçbir `http:`/network permission yok; ağ erişimi capability'lerde tanımlı değil | `capabilities/*.json` inceleme |
| 3. Bağımlılık | `reqwest`/`hyper` yalnızca updater plugin'inde, o da opsiyonel ve imzalı tek host | `cargo tree` / `cargo-auditable` ile binary içine gömülü SBOM |

Operasyonel taahhütler:
- **Updater varsayılan KAPALI / kullanıcı onaylı.** İlk açılışta "güncellemeleri otomatik kontrol et?" sorulur; reddedilirse hiçbir ağ çağrısı yapılmaz. Updater tek izinli dış bağlantıdır ve `releases.vael.dev`'e sınırlıdır.
- **Crash reporter / analytics YOK.** Hiçbir Sentry/PostHog/GA bağımlılığı eklenmez; CI'da `package.json` ve `Cargo.lock` için bir lint kuralı (yasak paket listesi: `sentry`, `posthog`, `@amplitude`, `analytics`…) PR'ı bloklar.
- **Reproducible-ish build + SBOM.** `cargo auditable build` ile binary'ye SBOM gömülür; release'e `cargo-cyclonedx` çıktısı ve `pnpm` `node_modules` SBOM (CycloneDX) eklenir. Denetçi "şu binary'de ağ kütüphanesi var mı" sorusunu cevaplayabilir.
- **README'de "Privacy" bölümü** + bu garantilerin testi: bir GitHub Actions job, paketlenmiş uygulamayı ağ-namespace kısıtlı (firewall) ortamda açıp hiçbir giden bağlantı olmadığını assert eder (regression koruması).

---

## 2. Eklenti (Plugin) API — sınırları ŞİMDİ çiz, yüzeyi sonra aç

Tam eklenti sistemi v1 hedefi değil, ama **yanlış genişletilemez** olması için sınırları şimdi kilitliyoruz. Karar: eklentiler **ana WebView'a ASLA** dokunamaz.

### 2.1 Sandbox seçenekleri (değerlendirme)

| Seçenek | İzolasyon | Yetenek | DX | Verdict |
|---|---|---|---|---|
| **WASI runtime (Wasmtime, Rust host)** | Süreç-içi ama capability-based, ağ/FS yok | Saf hesap: lint, formatter, transform | Eklenti dili = WASM derleyen her şey | **TERCİH (v2 hedefi)** |
| İzole WebView/Worker (JS) | Ayrı origin/Worker, `postMessage` köprü | DOM yok, sadece veri transform | JS yazılabilir | İkincil seçenek |
| Native dylib (dlopen) | İzolasyon YOK | Tam yetki | — | **REDDEDİLDİ** (güvenlik/taahhüt ihlali) |

**Neden WASI/Wasmtime:** Eklenti, host'un *açıkça verdiği* fonksiyonlar dışında hiçbir şeye erişemez — varsayılan olarak ne FS, ne ağ, ne saat. "Sıfır telemetri + offline" taahhüdünü eklentiler kıramaz çünkü WASI'ye ağ import'u hiç sağlanmaz. Bu, native dylib'in (kontrol edilemez) tam tersi.

### 2.2 API yüzeyi taslağı (yalnızca uzantı noktaları — implementasyon sonraya)

```rust
// core/plugin/host.rs — ŞİMDİ sadece trait + boundary, runtime sonra
pub enum PluginCapability {
    TransformText,      // input: string -> output: string (saf)
    ProvideLanguage,    // CM6 dil/grammar metadata (veri, kod değil)
    RegisterExportFmt,  // export pipeline'a md->X dönüştürücü
    RegisterCommand,    // komut paletine giriş (host onaylı eylem tetikler)
}

// Eklentiye AÇILAN host fonksiyonları (WASI imports) — kasıtlı olarak minik:
//   host.log(level, msg)
//   host.get_document_text()        // mevcut belge (kopya)
//   host.set_document_text(text)    // ana thread'de KULLANICI onayıyla uygulanır
// AÇILMAYAN: fs, net, env, clock, random(seed dışı), process
```

Manifest (gelecekteki eklenti paketi):
```toml
# plugin.toml
name = "wordcount"
version = "0.1.0"
runtime = "wasi-preview2"
capabilities = ["TransformText"]   # talep edilen; host onaylar
# 'net','fs' gibi anahtarlar runtime tarafından REDDEDILIR (whitelist dışı)
```

### 2.3 Güvenlik modeli (kilitlenen sınırlar)

1. Eklentiler **WASM/WASI**'de koşar; native eklenti yok.
2. Varsayılan capability seti **boş**; her yetenek manifest'te talep edilir ve host whitelist'i ile sınırlanır. `net`/`fs`/`process` **hiçbir zaman** sağlanmaz.
3. Eklentiler **ana WebView DOM'una erişemez** — yalnızca veri (string/JSON) sınırından geçer.
4. Belge yazma (`set_document_text`) eklenti tarafından *önerilir*, ana thread'de **kullanıcı onayı/undo-edilebilir** uygulanır.
5. Eklentiler ayrı **imza/checksum** ister; resmi kanaldan kurulanlar imzalı, yan-yükleme açık uyarı gösterir.

---

## 3. Paketleme & Dağıtım

### 3.1 Platform bundle matrisi

| Platform | Format | Tauri target | Boyut (yaklaşık) | Not |
|---|---|---|---|---|
| Windows | NSIS (`.exe`) | `nsis` | ~3-6 MB | Önerilen varsayılan; per-user kurulum, admin gerekmez |
| Windows | MSI (`.msi`) | `msi` (WiX) | ~3-6 MB | Kurumsal/GPO dağıtım; winget için ikisi de olur |
| macOS | `.app` + `.dmg` | `app`, `dmg` | ~10-15 MB | Universal (x86_64 + aarch64) tek dmg |
| Linux | AppImage | `appimage` | ~76 MB | WebKitGTK gömülü → büyük ama bağımsız |
| Linux | `.deb` | `deb` | ~4 MB | WebKitGTK sistem bağımlılığı |
| Linux | `.rpm` | `rpm` | ~4 MB | Fedora/RHEL |
| Linux | Flatpak | (manuel manifest) | — | Flathub; `/app` prefix, sandbox |

`tauri.conf.json` → `bundle`:
```json
{
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi", "app", "dmg", "appimage", "deb", "rpm"],
    "category": "DeveloperTool",
    "licenseFile": "../LICENSE",
    "windows": { "nsis": { "installMode": "perMachine" } },
    "macOS": {
      "minimumSystemVersion": "10.15",
      "hardenedRuntime": true,
      "entitlements": "./Entitlements.plist"
    },
    "linux": { "deb": { "depends": ["libwebkit2gtk-4.1-0"] } }
  }
}
```

macOS WebView JIT için **zorunlu** `Entitlements.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>
```

### 3.2 Auto-update (updater plugin + minisign imzalama)

Updater **paket imzalaması Authenticode/Apple'dan AYRIDIR** — Tauri'nin kendi minisign anahtar çiftiyle update artifact'ını imzalar (man-in-the-middle koruması).

Anahtar üretimi (bir kez): `pnpm tauri signer generate -w ~/.tauri/vael.key` → public key `tauri.conf.json`'a, private key + parola CI secret'ına.

```json
{
  "plugins": {
    "updater": {
      "endpoints": ["https://releases.vael.dev/{{target}}-{{arch}}/{{current_version}}"],
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6...",
      "windows": { "installMode": "passive" }
    }
  }
}
```

CI ortam değişkenleri: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Çoklu installer formatı için `latest.json` artık `{os}-{arch}-{installer}` anahtarları kullanır — **`tauri-plugin-updater` ≥ 2.10.0 gerekir** (bizim 2.11.x bunu karşılar). Updater varsayılan opsiyonel/onaylı (§1.5).

### 3.3 Kod imzalama

#### Windows (Authenticode)

| Seçenek | Maliyet/yıl (2026) | SmartScreen | Not |
|---|---|---|---|
| **Azure Trusted Signing (Artifact Signing)** | ~$120 (Basic ~$9.99/ay) | Tam güven | **TERCİH.** GA (Nisan 2026), US/CA/EU/UK işletmeleri **ve self-employed bireyler**. Eskiden zorunlu 3-yıl-organizasyon şartı bireysel başvurularda kalktı. Kısa ömürlü (~3 gün) oto-yenilenen sertifika. |
| OV sertifika (Sectigo vb.) | ~$70-200 | Tam güven (zamanla itibar) | HSM/USB token veya Azure Key Vault gerektirir |
| EV sertifika | ~$400-900 | **Artık OV'den avantajsız** | Ağustos 2024'ten beri Microsoft OV/EV ayrımını kaldırdı; EV primi anlamsız. Önerilmez. |

> 2026 değişikliği: kod imzalama sertifikası max geçerliliği 1 Mart 2026'dan itibaren 460 güne (~15 ay) düştü. Azure Trusted Signing'in kısa-ömürlü/oto-yenilenen modeli bu yüzden operasyonel olarak en kolayı.

Azure Trusted Signing config (`tauri.conf.json` → `bundle.windows`):
```json
{ "signCommand": "trusted-signing-cli -e https://eus.codesigning.azure.net -a vaelAcct -c vaelProfile %1" }
```
CI env: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`. Avantaj: Linux/macOS runner'dan bile Windows imzalanabilir (sign command tabanlı).

**SmartScreen etkisi:** İmzasız NSIS/MSI'da kullanıcı "Windows protected your PC" → "More info → Run anyway" görür (caydırıcı). İmzalı (Trusted Signing veya OV) ile bu uyarı ya hiç çıkmaz ya da itibar biriktikçe (indirme sayısı) kaybolur. EV'nin eski "anında bypass" avantajı artık yok.

#### macOS (notarization + hardened runtime)

- **Apple Developer Program: $99/yıl** (zorunlu). "Developer ID Application" sertifikası ile imzala, sonra notarize et.
- `tauri.conf.json` → `bundle.macOS.signingIdentity` + `hardenedRuntime: true` + `entitlements` (JIT, §3.1).
- CI env: `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, ve notarization için `APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH` (App Store Connect API key — `APPLE_ID`/`APPLE_PASSWORD`'dan tercih edilir, CI'da daha güvenli).
- Universal binary: `tauri build --target universal-apple-darwin`.

**Gatekeeper etkisi:** İmzasız/notarize edilmemiş `.app` → "cannot be opened because the developer cannot be verified" (kullanıcı Sistem Ayarları'ndan zorlamalı, çok caydırıcı). Notarize edilince doğrudan açılır. Notarization stapling (`xcrun stapler`) ile offline doğrulama da çalışır.

#### Linux
Authenticode/notarization yok. AppImage GPG ile imzalanabilir; `.deb`/`.rpm` repo imzası (apt/dnf). Flatpak/Flathub kendi imza/build altyapısını sağlar. Updater minisign imzası tüm Linux formatlarını korur.

### 3.4 CI/CD — GitHub Actions matris

`.github/workflows/release.yml` (özet):
```yaml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  build:
    permissions: { contents: write }
    strategy:
      fail-fast: false
      matrix:
        include:
          - { platform: 'macos-latest',  args: '--target universal-apple-darwin' }
          - { platform: 'ubuntu-22.04',   args: '' }
          - { platform: 'windows-latest', args: '' }
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }} }
      - name: Rust cache
        uses: swatinem/rust-cache@v2
        with: { workspaces: './src-tauri -> target' }
      - name: Linux deps
        if: matrix.platform == 'ubuntu-22.04'
        run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - uses: tauri-apps/tauri-action@v0
        env:
          # updater imzası (her platform)
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          # macOS imzalama + notarization
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_PATH: ${{ secrets.APPLE_API_KEY_PATH }}
          # Windows Azure Trusted Signing
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'vael ${{ github.ref_name }}'
          releaseDraft: true
          args: ${{ matrix.args }}
          includeUpdaterJson: true     # latest.json üretir
```

Build süresi/cache notları:
- **`swatinem/rust-cache@v2`** ile `src-tauri/target` cache'lenir; soğuk Rust build ~10-20 dk, cache'li ~2-5 dk.
- `fail-fast: false` → bir platform patlasa diğerleri devam.
- Windows imzalaması Trusted Signing ile runner'da; ayrı imza job'u gerekmez.
- `tauri-action@v0` artifact'ları toplar, GitHub Release'e (draft) yükler, `latest.json` üretir.

### 3.5 Kanal dağıtımı

| Kanal | Format | Otomasyon | Not |
|---|---|---|---|
| **GitHub Releases** | tüm bundle'lar + `latest.json` | tauri-action (otomatik) | Birincil dağıtım + updater kaynağı |
| **winget** | MSI/NSIS | `winget-create` / `wingetcreate.exe` PR otomasyonu (release sonrası job) | İmzalı installer şart; manifest PR'ı `microsoft/winget-pkgs`'e |
| **Homebrew cask** | dmg | `brew bump-cask-pr` (release sonrası job) | Notarize edilmiş dmg gerekir; kendi tap veya homebrew-cask |
| **Flathub** | Flatpak manifest | `flathub/<app-id>` repo, manuel/PR | Ayrı manifest + sandbox izinleri; Flathub build altyapısı imzalar |

winget/Homebrew için release sonrası ayrı bir job, yeni tag'i algılayıp SHA256 ile manifest PR'ını otomatik açar (semi-otomatik onay).

---

## 4. Lisans Uyumu

Hedef lisans: **MIT** (önceki kararda kilitli). Tüm bağımlılıklar permissive ve MIT ile uyumlu:

| Bağımlılık | Lisans | MIT ile uyum |
|---|---|---|
| Tauri (core + plugins) | MIT / Apache-2.0 | ✅ |
| CodeMirror 6 (`@codemirror/*`) | MIT | ✅ |
| markdown-it | MIT | ✅ |
| Milkdown / Crepe (+ ProseMirror) | MIT | ✅ |
| Prism | MIT | ✅ |
| KaTeX | MIT | ✅ |
| Mermaid | MIT | ✅ |
| Lit | BSD-3-Clause | ✅ (permissive) |
| comrak | BSD-2-Clause | ✅ |
| pulldown-cmark | MIT | ✅ |
| encoding_rs | MIT / Apache-2.0 | ✅ |
| chardetng | MIT / Apache-2.0 | ✅ |
| notify | CC0 / Artistic-2.0 | ✅ |
| Vue (Crepe transitif) | MIT | ✅ |

**Tek dikkat noktası — Pandoc (GPL-3.0):** Pandoc kopyleft'tir. Çözüm: Pandoc'u **bundle etme**; opsiyonel olarak kullanıcının *kendi sistemine kurduğu* Pandoc binary'sini sidecar olarak çağır (subprocess). GPL kodu bizim binary'mize linklenmediği için (ayrı süreç, sadece CLI çağrısı) MIT lisansımız etkilenmez. UI'da "Pandoc export (sisteminizde kurulu Pandoc gerekir, GPL)" uyarısı gösterilir. Varsayılan export (comrak/pulldown-cmark) tamamen permissive kalır.

**Uyum otomasyonu:** CI'da `cargo-deny` (lisans whitelist: MIT/Apache-2.0/BSD/CC0/ISC; GPL/AGPL **deny**) ve `license-checker` (npm) PR'ı bloklar. SBOM (`cargo-cyclonedx` + npm CycloneDX) her release'e eklenir → §1.5 telemetri kanıtıyla aynı çıktı.

---

## 5. KİLİTLENEN KARARLAR (Güvenlik & Dağıtım)

1. **CSP sıkı:** `script-src 'self'` (eval/inline yok), `connect-src 'self' ipc:` (dış host yok), `style-src 'unsafe-inline'` (sadece KaTeX/Mermaid). Mermaid `securityLevel:'strict'` + `mermaid.render()` ile eval'siz. markdown-it `html:false` + DOMPurify fallback.
2. **Capabilities en az ayrıcalık:** `fs:default` yok; tek tek `allow-read-file`/`allow-write-file`/`allow-stat`/`allow-exists` + dar `fs:scope` (`$HOME`/`$DOCUMENT`/`$DESKTOP`/`$DOWNLOAD`), deny `.ssh`/`.gnupg`/`.aws`/`$APPLOCALDATA`. **Consent-based dynamic scope:** dialog'la seçilen dosya runtime'da `allow_file()` ile eklenir. `shell` yok.
3. **Isolation pattern AÇIK:** minimal, sıfır-bağımlılık, tek-dosya isolation app; komut whitelist'i ile IPC doğrular. Klasik script (ES Module değil).
4. **Sıfır telemetri kanıtlanabilir:** (a) CSP dış bağlantıyı bloklar, (b) capability'lerde ağ yok, (c) yasak-paket lint (sentry/posthog/ga) + cargo-deny, (d) SBOM gömülü (`cargo auditable`), (e) CI'da ağ-izole çalışma testi. Updater varsayılan opsiyonel/onaylı, tek host.
5. **Eklenti sınırları (yüzey sonra):** WASI/Wasmtime sandbox; native eklenti REDDEDİLDİ; default capability boş; `net`/`fs`/`process` asla sağlanmaz; ana DOM erişimi yok; belge yazma kullanıcı-onaylı/undo'lu; eklenti imzası.
6. **Bundle hedefleri:** Windows NSIS+MSI, macOS universal .app+.dmg (hardened runtime + JIT entitlement), Linux AppImage+deb+rpm; Flatpak ayrı manifest.
7. **Auto-update:** updater plugin (≥2.10 / bizde 2.11.x), minisign anahtar çifti (`TAURI_SIGNING_*`), `{os}-{arch}-{installer}` latest.json, GitHub Releases kaynak. Varsayılan opsiyonel.
8. **Windows imzalama = Azure Trusted Signing** (~$120/yıl, GA Nisan 2026, bireysel/3-yıl-şartsız), `signCommand` ile Linux runner'dan bile. EV REDDEDİLDİ (artık avantajsız). SmartScreen tam güven.
9. **macOS imzalama = Apple Developer ($99/yıl)** + Developer ID + notarization (App Store Connect API key), hardened runtime + allow-jit entitlement. Gatekeeper temiz açılış + stapling.
10. **CI/CD:** GitHub Actions 3-platform matris (`fail-fast:false`), `tauri-action@v0`, `swatinem/rust-cache@v2`, tüm imza secret'ları env'de, draft release + `latest.json`.
11. **Kanallar:** GitHub Releases (birincil), winget (`wingetcreate` PR), Homebrew cask (`brew bump-cask-pr`, notarize dmg), Flathub (ayrı manifest) — release sonrası semi-otomatik PR job'ları.
12. **Lisans = MIT;** tüm bağımlılıklar permissive. **Pandoc GPL bundle EDİLMEZ** — yalnızca kullanıcının kurduğu binary'ye opsiyonel subprocess sidecar (uyarılı). Varsayılan export comrak/pulldown (permissive). CI'da cargo-deny + license-checker GPL/AGPL bloklar; SBOM her release'de.

Sources: [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/), [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/), [Tauri updater plugin](https://v2.tauri.app/plugin/updater/), [Tauri isolation pattern](https://v2.tauri.app/concept/inter-process-communication/isolation/), [Tauri security/CSP](https://v2.tauri.app/security/csp/), [Tauri capabilities](https://v2.tauri.app/security/capabilities/), [Tauri GitHub pipelines](https://v2.tauri.app/distribute/pipelines/github/), [Azure Artifact/Trusted Signing pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/), [Trusted Signing individual developers](https://techcommunity.microsoft.com/blog/microsoft-security-blog/trusted-signing-is-now-open-for-individual-developers-to-sign-up-in-public-previ/4273554), [Azure Trusted Signing 3-year eligibility](https://learn.microsoft.com/en-us/answers/questions/2261318/is-there-any-exception-process-for-the-azure-trust), [Tauri Linux distribute](https://v2.tauri.app/distribute/), [tauri-action releases](https://github.com/tauri-apps/tauri-action/releases)


