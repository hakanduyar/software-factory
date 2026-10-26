# Software Factory tamamlama planı — 26 Ekim 2026

## Yönetici özeti

Hedef; planlama, uygulama, test, bağımsız inceleme, kanıt, onay ve teslimi model bağımsız yöneten; kesintiden sonra aynı işi çoğaltmadan sürdüren bir Factory. Sonraki kapsam içerik/medya üretimidir. Tekil araçların ve başarılı PR'ların varlığı bu bütünün tamamlandığını göstermez.

Öncelik yeni altyapı kurmak değil, mevcut parçalarla iki gerçek yararlı işi bağlayan bir dikey akışı kanıtlamaktır: GitHub işi → kabul kriterleri → sahiplik/admission → başlangıçtan önce kayıtlı job ve gerçek ACK → uygulama → kontroller → bağımsız inceleme → yetkili teslim → sonraki uygun iş. Bir kesinti/restart aynı terminali kurtarmalı, ikinci worker başlatmamalıdır.

Bu belge sağlayıcı dispatch veya harcama izni değildir; mevcut insan yetkilerini ve yürütme kapılarını koruyan iş planıdır. Son açık insan talimatı anlamlı iş parçalarını yerel branch commit ile korumayı, tamamlanan branch'i push etmeyi ve exact review/CI sonrası normal PR merge akışını yetkilendirir; eski dar işlem hold'ları bu yeni kapsam için izin eksikliği diye sunulmaz. Önceden yetkilendirilmiş geri alınabilir yerel adımlar için her metadata değişiminde tekrar insan onayı istenmez. Chief yalnız orkestrasyon yapar; dosya/komut işleri kapsamı atanmış controller'lara aittir.

## Tek görev planı, üç farklı sorumluluk

- **GitHub Issues/Projects:** insanın gördüğü tek görev planı; hedef, öncelik, bağımlılık, AC ve ilerleme görünümü. Yeni ayrı bir authoritative backlog kurulmaz.
- **Runtime:** GitHub işine bağlı claim/lease/run/checkpoint/terminal ve crash recovery kayıtları; gerçek yürütme durumu ve yetkisi burada doğrulanır. GitHub etiketi/assignee'si tek başına launch yetkisi veya kilit değildir.
- **Obsidian:** karar, kaynak, ders, accepted-result hafızası ve GitHub görev/kanıt linkleri; ayrı authoritative task status veya ikinci iş kuyruğu değildir.
- **Governance doğrulaması:** Constitution C12/C14 ve ADR-0003 §4/§6 runtime authority'yi ve notes≠execution ayrımını korur; ADR-0001 yerel, geri alınabilir bootstrap'ı destekler. GitHub insan planı, runtime gerçek durumunun yansıtıldığı görünüm olabilir; dokümanla runtime authority GitHub'a taşınmaz. Gerçek authority değişikliği gerekirse ayrı ADR/insan kararı gerekir.
- **Migration bağımlılığı/AC:** mevcut task/issue/run/note kimliklerini birebir map et; uyuşmazlıkları göster, eski kayıtları silme veya tarihi yeniden yazma. Bir mevcut işte idempotent readback, aynı task'a bağlı tek claim ve linklerin bütünlüğünü kanıtladıktan sonra görünüm geçişini yap; eksik kayıt UNKNOWN kalır.
- **Rollback:** mapping/adapter değişikliği geri alınabilir commit ve önceki mapping referansıyla korunur. Kimlik belirsizliği, status drift veya duplicate claim'de yalnız yeni projection yazımını durdur; mevcut runtime claim/terminal'i koru, önceki projection'a dön ve farkı yeniden uzlaştır. Çalışan işi sırf görünüm geri alındı diye yeniden başlatma.

## İş parçalarını kaybetmeden teslim etme

Her anlamlı kaynak/doküman parçası tamamlanmamışsa **WIP** olarak scoped yerel branch commit ile korunur; AC'ye ulaşmamış commit DONE değildir. Secret, credential, kişisel veri, raw runtime artifact/log ve ilgisiz dosyalar stage edilmez. Tek commit tek tutarlı iş parçasını kapsar; boş commit veya toplu ilgisiz commit yoktur. Controller staged path/diff'i kontrol eder; yarım işin kalan dependency ve next action'ı iş kaydında görünür.

Tamamlanan işin branch'i push edilir; exact commit/fingerprint'e bağımsız review ve gerekli CI başarılı olduktan sonra normal PR merge yapılır. CI/review failure'da mevcut branch üzerinden düzeltme, anlamlı yeni commit ve etkilenen kanıtın yenilenmesi gerekir; history reset veya evidence rewrite yapılmaz. Commit/push/merge receipt'leri aynı GitHub işi ve runtime run'a linklenir. Bu planın şu anki teslimi yalnız kendi dosyasının yerel commit'idir; ilgisiz mevcut değişiklikleri içermez.

## Bugünkü durum ve kanıtın sınırı

Durum kesiti: 26 Ekim 18:29 UTC bounded kontrolü ve aynı günkü bağımsız kapsam denetimleri. Tarihsel kayıtlar güncel çalışma yetkisi sayılmaz.

| Alan | Doğrulanmış / tamamlanan | Kalan / bilinmeyen |
| --- | --- | --- |
| Gerçek yazılım teslimi | PR70 config parser/testleri ve PR71 saf UTF-8/JSON decoder/testleri merged; Ubuntu Actions kontrolleri geçti. | Bütün Factory ve #60/#67 kapanışı bu PR'lardan çıkarılamaz. |
| Bütçe davranışı | Kurulu collector/contract, toplam 16000'i advisory uyarı olarak ele aldı; iki yararlı gerçek iş toplam eşikten sonra başladı ve tamamlandı. | Bütün timeout/kill, provider ve restart yollarının uçtan uca sağlıklı olduğu iddia edilmiyor. |
| Kanıt ve geçmiş | Son kayıt 106660 observed output / 16 benzersiz managed terminal; son bilinen owned provider kapalı. | Bu sayaç global fatura veya tasarruf ölçüsü değildir. Eski 2259 bayt noncompliant sonuç korunur; ayrı component kabulü onu geriye dönük düzeltmez. |
| Otomatik devam | Bounded context refresh, scoped checkpoint/recovery ve 20 dakika monitor mevcut. | Scheduler uyanışı, registered job ACK veya gerçek sonuç → sonraki iş dispatch zinciri değildir. Son yararlı işte coreAckMode=false. |
| GitHub | Gerçek PR/CI/merge kanıtı var; Issues/Projects/PR tercih edilen iş sistemi. | Issues/Projects durumlarının kanıt ve canonical state ile tam çift yönlü tutarlılığı doğrulanmış değil. Jira eklenmez. |
| Obsidian/context | MEM01 scoped reader ve issue58 scoped tüketim/local ACK kanıtı var: seçili 4 aralık/7216 bayt, gerçek worker tüketimi. | Sonuç → sonraki yararlı işte recall/MEM03 ve uzak sync doğrulanmamış. Notlar runtime yetkisi değildir. |
| Maliyet/doğruluk | Bounded paket ve native payload bağları için scoped kanıt var. | Context token/fatura/tasarruf ve halüsinasyon azalması ölçülmüş değil; varsayılmaz. |
| Sağlayıcılar | Claude Code uygulama ve OpenAI bağımsız review kullanıldı. | Cloud erişimi/uygunluğu işi başlatma kanıtı değildir. Gemini/OpenCode/Ollama adapterleri mimaride planlı; çalışan entegrasyon kanıtı yok. |
| Ücretsiz/yerel | Ollama executable bulunduğu bildirildi; kullanıcı Evren URL'sini verdi: https://evren.ssyz.org.tr/. | Sürüm/model manifesti doğrulanmadı; Gemini/OpenCode callable bulunmadı. Evren URL-known/API-unverified; teknik kimlik, auth, model, ücret ve işlev doğrulanmadı. |

Somut devam boşluğu: `.github/workflows/verify.yml` push/PR için `npm test` çalıştırır, iş seçmez; `scripts/github/*` issue/status yardımcıları claim/CAS/READY/DONE yetkisi vermez. Hazır action kayıtları gerçek registration/request/runDir yerine geçmez. Registered review consumer ve host handoff parçalarını gerçek job bağlamına bağlamak gerekir. Projects adapter'ı bu dar incelemede doğrulanmadı; görünüm entegrasyonu çekirdek lifecycle'ın yerine konulmaz.

## Bağımlılık sırasıyla işler

Her iş yalnız eksik davranışı tamamlar; mevcut schema/helper ve değişmemiş fingerprint kanıtları yeniden kullanılır. Finite output/time/turn/attempt sınırları iş büyüklüğüne göre ticket'ta gerekçelendirilir. Aynı path için tek yazar; kritik değişikliği yazan tek kabul mercii olamaz.

### 1. Mevcut akışın gerçek boşluğunu dondur ve iki yararlı işi seç

- **Sahip:** lifecycle controller; Chief sırayı yönetir, OpenAI bağımsız scope incelemesi yapar.
- **Girdi/çıktı:** mevcut #67/#60 kriterleri, canonical job/lease/terminal/outbox/ACK referansları → eksik seam ve iki mevcut, yetkili, bağımlılıkları sağlanmış iş için kısa ticket'lar. PAUSE-P07 tarihsel recovery kaydı yalnız başlangıç referansıdır; güncel grant değildir.
- **İşlevsel AC:** hangi entrypoint'in kayıt/ACK/dispatch/settlement/next seçiminden sorumlu olduğu; gerçek kalan hata ve sahibi görünür. P11 bekleyişi bağımsız Factory işlerini otomatik durdurmaz. Uygun ikinci iş yoksa dependency/owner/wake açıkça kaydedilir.
- **İlk somut scope adayı:** A mevcut canonical claim–Issue eşlemesi ve gerçek prestart registration bağlantısı; B gerekli restart/event-consumption entegrasyon doğrulaması. P06/P07–Issue39/40 tarihsel eşlemesi güncel source/authority ile uzlaştırılır; eski actual44 işi yeniden koşturulmaz.
- **En küçük kontrol:** mevcut exact referansları karşılaştır; kabul edilmiş component testlerini tekrarlama. Yeni bir shadow queue, ledger veya schema icat etme.

### 2. Kayıtlı başlangıç → gerçek ACK → settlement → sonraki iş dikey dilimi

- **Sahip:** tek lifecycle uygulama controller'ı altında uygun Claude author; OpenAI bağımsız kritik review; ayrı controller deterministik doğrulama.
- **Girdi/çıktı:** iş1 ticket/claim ve mevcut kabul edilmiş parçalar → kayıtlı job kimliği, gerçek start/PID/session, terminal, outbox/ACK ve iş2 seçim/start kanıtı.
- **İşlevsel AC:** provider başlamadan doğru job/claim kayıtlıdır; zorunlu başlangıç ACK'i gerçek consumer'dan aynı kimlikle gelir. Parent/monitor metni veya local dosya varlığı ACK yerine geçmez. Terminal yalnız bir kez settle edilir; yalnız gerçek uygun iş2 başlar; izinsiz/uygunsuz iş başlamaz.
- **Recovery AC:** belirlenen tek kesinti sınırında yeniden başlatma eski terminal/outbox/claim'i kurtarır; aynı işin ikinci child start sayısı sıfırdır. Stale lease, eksik ACK veya belirsiz terminal açık wait/diagnose üretir.
- **Sahiplik AC:** iki yarışan controller'dan yalnız biri canonical claim/lease kazanır; dönen controller aynı claim'i bulur, eski sahip yazamaz. GitHub assignee kilit değildir; GitHub yazma hatası ikinci source run başlatmaz. Review beklerken start0; yanlış candidate/review hash reddedilir; handoff sonrası DONE yazılmadan kesinti de aynı ACK'i kurtarır.
- **En küçük kontrol:** geçerli useful iki iş akışı + ilgili interruption/restart + aynı claim için deterministik overlap/replay; gerçek process/store sınırı iddia ediliyorsa yalnız mock yeterli değildir. Mevcut finite output/deadline kapıları korunur.

### 3. GitHub Issues/Projects ve Actions ile teslim zincirini tamamla

- **Sahip:** GitHub delivery controller; implementation author ve bağımsız reviewer ayrıdır.
- **Girdi/çıktı:** kabul edilen dilim → mevcut issue/project alanları, branch/PR, exact commit CI sonuçları ve canonical teslim referansı.
- **İşlevsel AC:** Ready/Running/Blocked/Review/Done görünümü gerçek claim/terminal/review/delivery ile eşleşir; yalnız LLM raporu Done yapamaz. Actions exact SHA üzerinde gerekli build/typecheck/test kapılarını çalıştırır; başarısızlıkta korunan merge kapısı açılmaz. Idempotent readback yinelenen issue/comment üretmez.
- **En küçük kontrol:** tek gerçek issue→PR→CI→yetkili merge/readback; yeniden denemede duplicate0 ve bir temsilî stale SHA/status reddi. PR70/71 CI kanıtları değişmediyse tekrar üretilmez. Yeni issue'lar bu planla otomatik açılmaz.
- **Dış işlem sınırı:** mevcut TASK016 `ZERO_COST/RemoteWriteAuthorization` kapısı korunur; yeni açık commit→push→normal PR merge yetkisi exact task/route'a bağlanır. Bu yetki release/publishing, ücret, credential değişimi veya sınırsız dış veri aktarımı izni değildir. Eski izin artifact'ı eksikliği nedeniyle aynı insan onayı tekrar istenmez; gerçek platform/güvenlik reddi somut raporlanır.

### 4. Obsidian'ı gerçekten kullanılan ikinci beyin yap; yetki katmanı yapma

- **Sahip:** memory/context controller; ayrı bağımsız reviewer.
- **Girdi/çıktı:** issue58/MEM02 yeni scoped kanıtları ile eski MEM02/MEM03 statülerini uzlaştır → sonuçtan üretilen owned note/outbox, gerçek local ACK ve sonraki useful ticket'a seçilmiş recall paketi.
- **İşlevsel AC:** accepted result→kaynak/karar/ders notu→gerçek note ACK→sonraki gerçek görevde ilgili versioned retrieval zinciri gözlenir. İş2 iş1'in ilgili bilgisini version/range/hash ve source attribution ile tüketir; tüm geçmişi yeniden göndermez. Freshness/stale, yanlış pin ve ilgisiz context reddedilir veya açıkça dışlanır; çelişkili kaynaklar görünür kalır ve gerekirse UNKNOWN üretilir. Issue58 scoped başarısı korunur; MEM03 açığı bu gerçek tüketimle kapanır. Not runtime onayı vermez; uzak sync ancak hedef readback/ACK ile kabul edilir.
- **En küçük kontrol:** tek useful sonuç→not→seçim→native payload eşleşmesi; stale/çelişkili kayıt için küçük negatif grup. Değişmemiş reader/yerel ACK testleri tekrarlanmaz; uzak sync bilinmiyorsa UNKNOWN kalır.

### 5. Context/maliyet ve doğruluk hedeflerini ölçülebilir yap

- **Sahip:** cost/evaluation controller; uygulama sahibinden bağımsız ölçüm incelemesi.
- **Girdi/çıktı:** aynı accepted task ve karşılaştırılabilir koşullar → provider interval/model/effort/history mode, seçili/gönderilen bytes/hash, gerçek usage/elapsed ve accepted outcome join'i.
- **İşlevsel AC:** seçili context native gönderimle bağlanır; aynı terminal veya cumulative sayaç iki kez sayılmaz. Tasarruf ancak uygun baseline karşılaştırmasıyla raporlanır; bilinmeyen billing/context alanı UNKNOWN kalır. Doğruluk için önceden sabitlenmiş known-answer, stale ve çelişkili kaynak örneklerinde doğru atıf/unsupported claim davranışı ölçülür.
- **En küçük kontrol:** tek temsili iş karşılaştırması ve dar kaynak doğruluğu grubu; “halüsinasyon bitti”, token sayısından maliyet veya cache sayısından tasarruf sonucu çıkarma. Ölçüm için gereksiz provider işi üretme.

### 6. Code/Cloud ve OpenAI rollerini gerçek uygunlukla bağla

- **Sahip:** provider controller; uygulama Claude, kritik semantik review uygun farklı OpenAI model/agent; Chief yalnız yönlendirir.
- **Girdi/çıktı:** güncel client/model/effort/account ve normal transport durumu → exact adapter/route seçimi veya durable wait.
- **İşlevsel AC:** Code ve Cloud ayrı actual submit/run/session/terminal kanıtıyla tanımlanır. Kota/transport engelinde kaynak sahipliği açık release/claim ile aktarılır; eski owner yeniden başlatmaz. Erişilebilir sayfa, katalog modeli ve promo kredi bakiye bilgisi actual admission yerine geçmez.
- **En küçük kontrol:** mevcut normal route üzerinden tek useful canary/iş; timeout/cancel/receipt bağları için değişen adapter sınırında odaklı kontrol. Geçici failure sonsuz prepare/poll döngüsüne dönüşmez; iki başarısız correction sonrası C13 diagnosis/replan uygulanır.

### 7. Ollama, Gemini ücretsiz ve Evren için dürüst adapter seçimi

- **Sahip:** provider inventory/adapter controller; benchmark reviewer bağımsızdır.
- **Girdi/çıktı:** mevcut `workerModelConfig.ts` ve adapter sözleşmeleri → yerel/remote ayrımı, exact model kimliği, erişim/ücret/mahremiyet şartları ve destek matrisi. [Evren](https://evren.ssyz.org.tr/) kullanıcıdan gelen exact başlangıç URL'sidir; teknik incelemede gerçek API/CLI, model, auth, quota/ücret ve veri aktarımı sınırı belirlenir. Şimdilik API-unverified; Gemini/Ollama ile eşitlenmez, tahminle entegrasyon yapılmaz.
- **İşlevsel AC:** yalnız kurulu executable “çalışan model” sayılmaz. Onaylı düşük riskli görev için uygun ücretsiz/yerel model normal adapter'den bounded sonuç üretir, timeout/cancel/PaidOFF korunur ve independent quality check'i geçer. Secret/credential yalnız secret store'dadır; ücretsiz kota aşımı sessiz ücretli fallback başlatmaz.
- **En küçük kontrol:** mevcut adapter interface fixture'ları ve bir useful finite task; kalite yetersizse kanıta göre minimum uygun included modele escalation. Yeni servis/fleet kurulumu mevcut görev gerektirmedikçe ertelenir.

### 8. Kaynak uyumunu ve sonraki ürün kapsamını kapat

- **Sahip:** plan/source reviewer; Chief yalnız onaylanmış sırayı yönetir.
- **Girdi/çıktı:** aşağıdaki seçilmiş kaynak pasajları → recommendation→uygulanan davranış→kanıt→kalan gap matrisi.
- **İşlevsel AC:** selective reading açık etiketlenir; kaynakta olmayan test oranı, daemon garantisi veya sağlayıcı tercihi uydurulmaz. İlk yararlı uçtan uca dilim tamamlanınca Control Room/Telegram gibi arayüzler ve daha sonra içerik/medya için ayrı gerçek AC hazırlanır; bugün genel Factory tamamlandı denmez.
- **En küçük kontrol:** mevcut pasaj/kanıt eşleştirmesinin bağımsız doküman incelemesi; bütünü yeniden okutma veya sırf sayıyı artırmak için test yazdırma yok.

## P11/P12: ayrı operasyonel bekleyiş

P11 için onaylı bot sahipliği, secret-store referansı (secret değeri değil), izinli kimlikler ve proje binding'i gerekir. P12 bunun yanında resmi retrieval/offset sözleşmesine bağlıdır. Bu gerçek girişler gelmeden Telegram operasyonu başlatılmaz. Bu bekleyiş registered-job/recovery, GitHub, context veya uygun bağımsız adapter işlerinin otomatik genel blokajı değildir. Girdi sahibi ROOT üzerinden insandır; teknik IO kapsam kararları controller/Chief planlama işidir, gereksiz tekrar izin sorusu değildir.

## Kaynaklar ve sınırlı okuma beyanı

- [Özcan Acar, Yapay Zeka Çağında Yazılım Geliştirme](https://pratikprogramci.com/wp-content/downloads/Yapay_Zeka_Caginda_Yazilim_Gelistirme.pdf): retained 202 sayfa PDF SHA `A6875264A6DB753AF2CA9D14CA488866EC5C8133192532E663CAB22ED9B8C22C`; seçilmiş source-map okumaları. PDF55,57–58/basılı52,54–55: çapraz review ve regresyon/entegrasyon/kabul korumaları; PDF111–112/basılı108–109: polling maliyeti ve bağımlılık/entegrasyon; PDF158/basılı155: shared-trunk çatışmaları; PDF164–167/basılı161–164: test/hardening ve handoff. Kitap evrensel “az test” oranı veriyor diye sunulmaz; tamamı yakın okunmuş değildir.
- [Avenox, Kendi Yapay Zeka Ekibimi Kurdum. Ben Kod Yazmıyorum.](https://www.youtube.com/watch?v=MFqtKpzttGA): açıklama/yazar bölümleri incelenmiş; konuşma/transkript doğrulanmamış. 1:55 context, 7:44 sahiplik, 14:31 worktree, 26:49 her işin paralel olmaması yalnız chapter dayanaklarıdır.
- [Forn, Bir Ay Boyunca Yapay Zekayla Çalışınca Ne Öğrendim?](https://www.youtube.com/watch?v=X1S8fi-mwTw): seçilmiş otomatik altyazılar; 7:40 saklamak≠retrieve etmek, 8:14 ilgisiz context'i dışlamak, 12:50 read/forbidden/return, 13:32 entegrasyon. Tam video/anlamsal transcript okuması iddia edilmez.
- Retained araştırma: `.factory-data/chief/research-ebook-methods-20261007/source-map.json`, `avenox-parallel-research-76/notes.md`, `forn-parallel-research-76/notes.md`; seçilmiş hash/range paketi `controller-runtime/control/cost-only-recovery-20261019/source-comparison-packet.json`. Bunlar araştırma referansıdır, runtime authority değildir; kaynak indirme gözlemleri Ekim7–20 tarihlidir.
- Scoped memory kanıtları: `controller-runtime/control/cost-clean-controller-20261020/mixed-newline-native-review-20261020/independent-review/actual-post-admit.json`, aynı yerde `task65-58-ac-matrix-final.json` ve `controller-runtime/control/resume-20261020/acceptance-progress-sync/issue58/actual-ack.json`. Kanıt deposu araştırma yolları `.factory-data/chief/` altındadır; consumer/delivery scope'u genişletilmez.
- Governing belgeler: `docs/FACTORY_CONSTITUTION.md`, `docs/ARCHITECTURE.md`, `docs/MODEL_ROUTING.md`, `docs/tasks/NO-CODE-CHIEF.md` test selection ve WorkerTicket/WorkerResult kuralları. Güncel açık insan talimatı eski routing hold'larından ayrılır; bir tarihsel instruction bugünün uygunluk kanıtı değildir.

## Tamamlanma standardı

Her adım intent/AC, exact kaynak ve artifact fingerprint'i, gerçek command/exit, provider start/terminal (varsa), ilgili test sonucu, bağımsız review ve next owner/dependency/wake ile kapanır. Structured WorkerResult ≤2048 UTF-8 bayt kalır; büyük kanıt referansla taşınır. Geçmiş, başarısızlık ve gerçek tüketim sıfırlanmaz. Security/audit/secret, PaidOFF, tek yazar ve protected release/remote işlem kapıları korunur; değişmemiş kanıt yalnız ilgili fingerprint hâlâ aynıysa yeniden kullanılır.
