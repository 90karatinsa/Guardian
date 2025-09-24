# Guardian

Guardian, olayları tek bir veri akışında toplayan ve video test kaynağını PNG karelere dönüştüren küçük bir çalışma iskeletidir.

## Kurulum

Projeyi çalıştırmak için bağımlılıkları yükleyin:

```bash
pnpm install
```

## Sistem önyüklemesi

Aşağıdaki komut uygulama omurgasını başlatır. Çalıştırıldığında `data/events.sqlite` veritabanı oluşturulur ve `system up` mesajlı bir kayıt eklenir.

```bash
pnpm tsx src/app.ts
```

Oluşturulan olay günlüğünü `data/events.sqlite` içinde görebilir veya SQLite araçlarıyla sorgulayabilirsiniz.

## Video testi

Varsayılan yapılandırma `assets/test-video.mp4` yoluna yazılan küçük bir örnek videoyu saniyede iki kare olacak şekilde PNG formatında ayrıştırır ve en son kareyi `snapshots/last.png` dosyasına yazar. Dosya mevcut değilse komut otomatik olarak oluşturur. Aşağıdaki komut gerçek zamanlı kareleri üreterek `snapshots/last.png` dosyasını periyodik olarak günceller:

```bash
pnpm tsx src/video/index.ts
```

Farklı bir test videosu veya kare hızı kullanmak isterseniz `config/default.json` altındaki `video.testFile` ve `video.framesPerSecond` ayarlarını güncelleyin.

## Testler

Birimin doğru kare ayrıştırmasını doğrulamak için Vitest testleri bulunmaktadır:

```bash
pnpm vitest run -t Bootstrap
pnpm vitest run -t VideoSource
```

`Bootstrap` testi uygulama başlangıcını, `VideoSource` testi ise sahte bir PNG akışını doğrular.
