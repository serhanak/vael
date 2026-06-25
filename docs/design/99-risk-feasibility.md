# RISK & FEASIBILITY KAYDI (Adversaryal Doğrulama)

> Haziran 2026. Görev: tasarımın en riskli 6 varsayımını güncel kaynaklarla doğrula, çalışmama nedenlerini ara. Her madde: **verdict** + **kanıt** + **azaltma**. Sonda genel feasibility hükmü.

---

## Risk 1 — Linux WebKitGTK üzerinde CM6 + Milkdown + KaTeX + Mermaid kabul edilebilir render ediyor mu?

**VERDICT: RİSKLİ (ürünün en zayıf ayağı; ana platform Linux DEĞİL tutulmalı)**

Bu, tasarımın en ciddi tehdidi. Sorun bileşen kütüphaneleri değil, **WebKitGTK'nın kendi kararsızlığı**.

**Kanıt:**
- WebKitGTK her sürümle daha kararsız hale geliyor; Tauri ekibinin kendi tartışması Linux için Tauri'yi "%100 öneremeyiz" diyor, CEF/Servo arayışı bu yüzden başladı: [tauri-apps Discussion #8524](https://github.com/orgs/tauri-apps/discussions/8524)
- Aktif render bug'ı (Nisan 2025, hâlâ açık): pencere maximize/un-maximize sonrası DOM elemanlarının "gölge kopyaları", WebKitGTK 2.48.0 + Tauri 2.4.1, "upstream/needs-triage" etiketli, **düzeltme yok**: [tauri Issue #13157](https://github.com/tauri-apps/tauri/issues/13157)
- WebKitGTK 2.40+ Tauri uygulamasını yavaş render ettiren regresyon: [tauri Issue #7021](https://github.com/tauri-apps/tauri/issues/7021)
- DOM-ağır UI'da (CM6/ProseMirror tam da bu) Linux'ta sürükle-seç donması: [tauri Issue #3988](https://github.com/tauri-apps/tauri/issues/3988)
- NVIDIA + Wayland + yeni DMABUF renderer = **boş/beyaz pencere**, yaygın ekosistem sorunu: [tauri Issue #9394](https://github.com/tauri-apps/tauri/issues/9394), [meetily #435](https://github.com/Zackriya-Solutions/meetily/issues/435)

KaTeX (saf CSS/font) ve Mermaid (SVG) WebKitGTK'da çalışır; risk bileşenlerin kendisi değil, alttaki WebView'ın render/compositing kararsızlığıdır.

**Azaltma:**
- Linux'u "ana platform" değil "destekli" tut (tasarım zaten Windows/macOS öncelikli diyor — bunu koru).
- Uygulama başlatmadan önce `WEBKIT_DISABLE_DMABUF_RENDERER=1` (ve gerekirse `WEBKIT_DISABLE_COMPOSITING_MODE=1`) enjekte et; kullanıcı zaten ayarlamadıysa. Bu, beyaz-ekran/flicker'ın ekosistem standardı çözümü: [yaak troubleshooting](https://yaak.app/docs/getting-started/troubleshooting), [netspeed_pc #3](https://github.com/visnkmr/netspeed_pc/issues/3)
- Minimum WebKitGTK sürüm tabanı belirle (2.44+) ve CI'da gerçek WebKitGTK'da görsel smoke-test koş.
- CSS animasyonlarını minimuma indir (WebKitGTK'da animasyon = bulanıklaşma/compositing bug tetikleyici).
- CEF/Servo backend olgunlaştığında geçiş yolunu mimaride açık tut (servis-izolasyon katmanı bunu kolaylaştırıyor).

---

## Risk 2 — CM6 ve Milkdown (ProseMirror) aynı uygulamada çakışır mı (contenteditable/IME/kısayol/bundle)?

**VERDICT: UYGULANABİLİR (tasarımın "tek-instance + tek-motor-canlı" kararı bu riski büyük ölçüde nötrler)**

**Kanıt:**
- CM6+ProseMirror birlikte yaygın ve çalışan bir kombinasyon; resmi ProseMirror örnekleri ve `prosemirror-codemirror-6` köprüsü mevcut: [sibiraj-s/prosemirror-codemirror-6](https://github.com/sibiraj-s/prosemirror-codemirror-6), [emergence-engineering blog](https://emergence-engineering.com/blog/prosemirror-codemirror-block). Crepe'in `CodeMirror` feature'ı bunu zaten dahili yapıyor.
- IME: CM6 contenteditable kullanır ve composition state'i açıkça izler; gömülü CM6-in-ProseMirror senaryosunda IME bilinen ve çözülmüş bir konudur: [CodeMirror guide](https://codemirror.net/docs/guide/)
- Gerçek risk **bundle/çift-instance**: Crepe CodeMirror dilleri devre dışıyken bile bundle'da kalabiliyor: [Milkdown #1533](https://github.com/Milkdown/milkdown/issues/1533) — tasarımın `pnpm.overrides` ile `@codemirror/*` tek-sürüm pinlemesi ve `manualChunks` lazy-Crepe kararı tam da bunu hedefliyor.

**Çakışma kaynakları ve neden bu tasarımda düşük:**
- *İki contenteditable + IME/kısayol çakışması:* Tasarım "iki motor asla aynı anda canlı değil" diyor → aynı anda iki contenteditable yok. Bu en büyük çakışma vektörünü kapatıyor.
- *Çift `@codemirror/state` instance (`Facet`/`StateField` kimlik bozulması):* gerçek ve sinsi; `pnpm.overrides` pinlemesi zorunlu (tasarımda var). Bu yapılmazsa sessiz bozulma olur — **bu maddenin tek "engelleyici olabilir" alt-riski**.

**Azaltma (tasarımda mevcut, korunmalı):**
- `@codemirror/*` ve `katex` tek sürüme pinle (overrides). CI'da `pnpm why @codemirror/state` ile tek-instance doğrula (birden fazla sürüm = build fail).
- Crepe lazy + çıkışta `destroy()` → çift contenteditable ömrü ve bellek çakışması yok.
- Kısayol çakışması: aktif motora göre keymap scope'la (CM6 keymap yalnız CM aktifken bağlı).

---

## Risk 3 — WebView'da multi-GB dosya gerçekten mümkün mü; CM6 sınırı; özel viewer şart mı?

**VERDICT: TAM-DOSYA YÜKLEME ENGELLEYİCİ; CHUNKED/ÖZEL VIEWER İLE UYGULANABİLİR**

**Kanıt:**
- CM6 milyonlarca satırı ve çok uzun satırları viewport-virtualization ile kaldırır: [CM Huge Doc Demo](https://codemirror.net/examples/million/)
- Ancak gerçek darboğaz viewport değil; pratikte ~1.5M satır üstü ve özellikle **syntax highlighting / minified tek-dev-satır** ciddi lag/hang yaratıyor: [Noticable lag, CM forum](https://discuss.codemirror.net/t/noticable-lag-when-dealing-with-large-files/5928), [Content length limit CM6](https://discuss.codemirror.net/t/content-length-limit-codemirror6/4183)
- CM6'da **yerleşik hard limit yok** — limiti uygulama `changeFilter` ile koymalı (tasarım bunu kabul ediyor).
- Asıl kırılma noktası: multi-GB içeriği tek bir JS string olarak WebView belleğine koymak (V8/JSC string boyut + IPC serileştirme tavanı). Bu nedenle tam-yükleme engelleyici.

**Azaltma (tasarımın §büyük-dosya yönü doğru):**
- `isLarge` eşiği (>50 MB) ile **chunked/byte-offset okuma** (Rust `read_chunk`), satır indeksi Rust'ta; WebView'a tam metin verilmez.
- Büyük dosyada Split-preview ve WYSIWYG kapalı (tüm-metin DOM render riskini kapatır) — doğru karar.
- Multi-GB log için CM6'yı düz "editör" yerine **salt-okunur sanal viewer** modunda kullan (highlight kapalı/sınırlı, satır-penceresi besleme). Highlight asıl maliyet olduğundan büyük dosyada kapatılmalı.
- mmap + Rust tarafı satır-tarama; find/replace'i Rust'ta streaming yap (WebView'da catastrophic-backtracking regex'ten kaçın — Notepad++/Scintilla'nın çöktüğü yer burası).

---

## Risk 4 — Export (Pandoc bundle vs headless chromium vs Typst) Tauri'de uygulanabilir mi; bundle/bağımlılık etkisi?

**VERDICT: UYGULANABİLİR (katmanlı yaklaşım; Pandoc'u bundle'lama, sidecar/opsiyonel tut)**

**Kanıt:**
- Tauri v2 + Pandoc GUI gerçek dünyada çalışıyor (Tauri v2 ile PDF/DOCX/HTML/EPUB export): [pandoc-gui-mk2](https://github.com/ivg-design/pandoc-gui-mk2)
- Pandoc + Typst PDF motoru (LaTeX'siz, hızlı, hafif): `pandoc file.md -o file.pdf --pdf-engine=typst`, Pandoc 3.6.4 + Typst 0.13 (2025): [slhck.info](https://slhck.info/software/2025/10/25/typst-pdf-generation-xelatex-alternative.html), [neilzone.co.uk](https://neilzone.co.uk/2025/01/using-pandoc-and-typst-to-convert-markdown-into-custom-formatted-pdfs-with-a-sample-template/)

**Bundle/bağımlılık riski:**
- Pandoc binary'si ~100+ MB; bunu varsayılan bundle'a koymak <10 MB Tauri avantajını yok eder ve "hafif" hedefiyle çelişir.
- Headless Chromium bundle'lamak (PDF için) daha da ağır (~150+ MB) — projenin tüm tezine aykırı, **elenmeli**.

**Azaltma:**
- **Varsayılan export = Rust içi** `comrak`/`pulldown-cmark` ile HTML (sıfır harici bağımlılık, küçük binary).
- PDF/DOCX = **opsiyonel Pandoc sidecar**: kullanıcı sistemde kurulu Pandoc'u kullansın veya isteğe bağlı indirsin; bundle'a gömme. `shell:allow-execute` yalnız bilinen `pandoc` binary'sine, ayrı capability arkasında, kullanıcı onayıyla.
- PDF motoru olarak Typst'i (LaTeX değil) öner — küçük ve hızlı, ama yine opsiyonel.

---

## Risk 5 — Tauri v2 olgunluğu (updater, fs, capabilities, mobil) bu ürün için yeterli mi?

**VERDICT: UYGULANABİLİR (masaüstü için olgun; mobil "nice-to-have" olarak doğru konumlanmış)**

**Kanıt:**
- Tauri v2 stabil (2024 sonu); hat 2.9.x/2.11.x (2025 sonu): [Tauri 2.0 Stable](https://v2.tauri.app/blog/tauri-20/), [Core Ecosystem Releases](https://v2.tauri.app/release/)
- Updater plugin v2'de mevcut, imzalı: [Updater](https://v2.tauri.app/plugin/updater/)
- Capabilities/permissions modeli olgun; fs scope doğrulamasında güvenlik düzeltmeleri yapıldı: [Capabilities](https://v2.tauri.app/security/capabilities/)
- Mobil (iOS/Android) v2'de kapatıldı, aynı Rust çekirdeği: [Mobile Plugin Development](https://v2.tauri.app/develop/plugins/develop-mobile/)

**Bilinen tuzaklar (2026):**
- `generate_handler!`'ı unutmak; blanket `fs:default`/`*` capability vermek (Electron güvenlik modeline geri dönüş); Tauri 1 ile 2 dokümanını karıştırmak; **Linux GTK4 build sorunları**: [tech-insider 2026 tutorial](https://tech-insider.org/tauri-tutorial-cross-platform-rust-app-2026/)

**Azaltma:**
- Tasarımın en-az-ayrıcalık capability planı (tekil `allow-read-file`/`allow-write-file`/`allow-stat` + dar `fs:scope` + `.ssh`/`.gnupg` deny + dialog runtime `allow_file()`) tam da bu tuzaklardan kaçınıyor — koru.
- Updater'ı imza zorunlu + ayrı host + sıfır-telemetri tut (tasarımda var).
- Mobil'i v1 hedefe koyma; masaüstüne odaklan. fs-plugin watch API'sinin mobil/cross-platform tutarsızlığı nedeniyle `notify` crate'i kullanma kararı doğru.

---

## Risk 6 — <500 ms soğuk açılış / sub-100 MB RAM hedefi bu yığınla gerçekçi mi?

**VERDICT: UYGULANABİLİR ama AGRESİF (boş editörde rahat; ağır modüller lazy KALMALI)**

**Kanıt:**
- Tauri tipik soğuk açılış <500 ms, idle RAM ~30-85 MB (Electron 200-450 MB'a karşı): [levminer benchmark](https://www.levminer.com/blog/tauri-vs-electron), [gethopp](https://www.gethopp.app/blog/tauri-vs-electron), [johal.in 2026](https://johal.in/you-use-tauri-20-electron-300-desktop-apps/)
- DİKKAT: bu rakamlar **boş/todo-app** içindir. RAM'in Tauri'de Electron'dan yüksek çıkabildiği durumlar da raporlandı (WebView2 paylaşımı/ölçüm metodolojisi): [tauri Issue #5889](https://github.com/tauri-apps/tauri/issues/5889)

**Riskin gerçeği:** Boş Tauri kabuğu hedefe rahat girer. Sınırı zorlayan şey **bizim yüklediğimiz JS**: Crepe (Vue 3.5 + ProseMirror + CodeMirror + KaTeX), Mermaid, markdown-it. Bunların hepsi eager yüklenirse hem açılış hem RAM hedefi delinir.

**Azaltma (tasarımda mevcut, kritik):**
- Eager bundle = yalnız Lit + CM6 source + `lang-markdown`. Crepe/Mermaid/KaTeX/markdown-it/preview tamamen `manualChunks` lazy. Crepe çıkışta `destroy()`.
- ~140 CM6 dil parser'ı ve Prism dilleri on-demand; yaygın diller `requestIdleCallback` ısıtma.
- RAM hedefini "boş editör, markdown modu" olarak tanımla; WYSIWYG/Mermaid/büyük-dosya açıkken sub-100 MB **garanti edilmez** (dürüst hedef koy, regresyon bütçesiyle CI'da ölç).

---

## GENEL FEASIBILITY HÜKMÜ

**Tasarım bütün olarak UYGULANABİLİR — bir adversaryal "blok" yok, ama iki risk yönetim gerektiriyor: (1) Linux/WebKitGTK kararsızlığı, (2) multi-GB tam-dosya yükleme.**

- **Engelleyici olan tek somut şey** multi-GB dosyanın **tamamını** WebView'a yüklemek. Tasarım bunu zaten chunked okuma + büyük-dosyada preview/WYSIWYG kapatma ile çözüyor → engelleyici değil, **kapsam kararı**.
- **En yüksek artık risk Linux'tur.** WebKitGTK render/compositing bug'ları gerçek, açık ve düzeltmesiz. Bu, ürünü öldürmez çünkü ana platform Windows (WebView2) + macOS (WKWebView). Ama "çapraz platform" vaadini Linux'ta "best-effort" seviyesine indirgemek dürüst olur; env-var workaround'ları ve görsel CI smoke-test şart.
- **CM6 + Milkdown birlikteliği** çözülmüş bir problemdir; tek sinsi nokta çift `@codemirror/state` instance'ıdır ve `pnpm.overrides` pinlemesi bunu kapatır (build-time guard ekle).
- **Export** katmanlı yaklaşımla (Rust comrak varsayılan, Pandoc/Typst opsiyonel sidecar) hem "hafif" hedefini korur hem zengin export sunar.
- **Performans hedefleri** boş/markdown modunda gerçekçi; ağır modüllerin lazy kalması ve hedefin "boş editör" olarak tanımlanması koşuluyla tutar. WYSIWYG+Mermaid+büyük-dosya açık senaryoda sub-100 MB garantisi verme.

**Yeşil ışık veren ön koşullar (CI/mimaride zorunlu kıl):** (1) `@codemirror/*`/`katex` tek-instance build-guard, (2) tüm ağır modüller lazy + bundle-bütçe testi, (3) büyük-dosya yolunda chunked okuma + highlight kapatma, (4) Linux'ta env-var workaround enjeksiyonu + min WebKitGTK 2.44+ + görsel smoke-test, (5) en-az-ayrıcalık capability denetimi, (6) Pandoc'u asla bundle'lamama.
