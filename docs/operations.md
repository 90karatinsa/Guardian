# Guardian Operasyon Kılavuzu

Guardian servisinin sahada sürekli gözlem yaparken sağlıklı kalmasını sağlamak için bu kılavuz, günlük rutinleri, bakım
komutlarını ve sorun giderme ipuçlarını tek bir yerde toplar. Aşağıdaki bölümler Guardian'ın CLI, metrik ve log yüzeylerinden
nasıl yararlanacağınızı adım adım anlatır.

## Gündelik sağlık kontrolleri
- `guardian daemon health --json` komutu ile servisinizin geri dönen tüm sağlık indikatörlerini görüntüleyin. JSON çıktısında
  `metrics.logs.byLevel.error`, `metrics.logs.histogram.error` ve `watchdogRestarts` alanlarını takip ederek yeni hataları veya
  sıklaşan watchdog tetiklerini yakalayabilirsiniz.
- `guardian daemon ready` komutu, SSE ve HTTP API uçlarının trafik kabul etmeye hazır olup olmadığını bildirir.
- `guardian daemon status --json` çıktısında `pipelines.ffmpeg.watchdogRestartsByChannel` ve
  `pipelines.audio.watchdogRestartsByChannel` metrikleri ile hangi kameranın yeniden başlatma döngüsüne girdiğini belirleyin.

## Periyodik bakım görevleri
- RTSP veya ffmpeg kaynaklı bağlantı sorunları için `guardian daemon hooks --reason watchdog-reset` komutunu kullanarak devre
  kesicileri elle temizleyin.
- `pnpm exec tsx src/tasks/retention.ts --run now` komutu ile retention görevini elle tetikleyebilir, ardından
  `scripts/db-maintenance.ts vacuum --mode full` yardımıyla SQLite arşivini sıkıştırabilirsiniz.
- `guardian retention run --dry-run` çıktısı arşivde kaç fotoğrafın taşınacağını ve `maxArchivesPerCamera` sınırına ne kadar
  yaklaşıldığını gösterir.

## Log ve metrik inceleme
- `guardian log-level get` ve `guardian log-level set warn` komutlarıyla log seviyesini değiştirirken, `guardian daemon health`
  çıktısındaki `metrics.logs.byLevel` ve `metrics.logs.histogram` alanlarını izleyin.
- Prometheus entegrasyonları için `metrics.exportDetectorLatencyHistogram('motion')` çıktısını `pnpm exec tsx` üzerinden
  alabilir, histogram buckets ile dedektör gecikme dağılımını inceleyebilirsiniz.
- `pipelines.ffmpeg.watchdogRestarts` ve `watchdogBackoffByChannel` değerleri, stream jitter'larını `detector latency histogramlarını`
  takip ederken hangi kameraların desteklenmesi gerektiğini anlamanıza yardımcı olur.

## Sorun giderme
- `guardian health --verbose` ile tüm sağlık kontrollerinin ayrıntılı sonuçlarını gözden geçirin. Özellikle `suppression` ve
  `retention` bölümlerindeki uyarılar yanlış pozitifleri azaltmak veya disk kullanımını kontrol etmek için kritik ipuçları
  sağlar.
- `guardian daemon restart --channel video:lobby` komutuyla yalnızca belirli bir RTSP akışını sıfırlayabilir, eş zamanlı olarak
  `guardian daemon status --json` ile watchdog sayaçlarının azaldığını doğrulayabilirsiniz.
- Mikrofon fallback zincirleri için `pnpm exec tsx src/cli.ts audio devices --json` çıktısındaki `fallbacks` sıralamasını ve
  `watchdogRestarts` değerini analiz ederek sessizlik devre kesicisinin tetiklendiği durumları yakalayın.

## Ek kaynaklar
- Daha fazla örnek, `README.md` içindeki Kurulum ve Sorun Giderme bölümlerinde yer alır.
- API referansı için `docs/api.md` (mevcutsa) ve `tests/http_api.test.ts` dosyalarındaki örnek istekleri inceleyebilirsiniz.
