# Software Factory — Bootstrap Pack

Bu repo, Hakan'ın kişisel Software Factory sisteminin çekirdeğini kurmak içindir.

Amaç: yazılım, içerik ve ileride medya üretimini tek bir orkestrasyon sistemi üzerinden; doğru görevi doğru modele yönlendirerek, test/review/insan onayı kapılarıyla yürütmek.

## İlk hedef

Önce localde çalışan küçük ama güvenilir bir Factory Core kurulur. Sunucuya taşıma, Telegram/WhatsApp, n8n ve geniş model havuzu daha sonra eklenir.

## Başlangıç sırası

1. `docs/PRODUCT.md`
2. `docs/FACTORY_CONSTITUTION.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DOMAIN_MODEL.md`
5. `docs/MODEL_ROUTING.md`
6. `docs/ROADMAP.md`
7. `docs/tasks/TASK-001-core-skeleton.md`
8. `BOOTSTRAP_PROMPT.md`

## Çalışma ilkesi

Plan -> Ticket -> Implementasyon -> Otomatik test -> Bağımsız review -> İnsan onayı -> Merge/Release -> Evidence -> İçerik türetme

Factory ilk aşamada kendi reposunu geliştiren ilk proje olacaktır.
