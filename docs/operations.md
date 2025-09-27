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
- `guardian retention run --config config/production.json` ile farklı konfigürasyon dosyaları için bakım planlayabilirsiniz;
  `pnpm tsx src/cli.ts retention --help` çıktısı güncel seçenekleri listeler.

## Log ve metrik inceleme
- `guardian log-level get` ve `guardian log-level set warn` komutlarıyla log seviyesini değiştirirken, `guardian daemon health`
  çıktısındaki `metrics.logs.byLevel` ve `metrics.logs.histogram` alanlarını izleyin.
- Prometheus dışa aktarımı için `pnpm exec tsx -e "import metrics from './src/metrics/index.ts';\nconsole.log(metrics.exportLogLevelCountersForPrometheus({ labels: { site: 'edge-1' } }));"` komutu ile `guardian_log_level_total`
  ve `guardian_log_last_error_timestamp_seconds` gauge değerlerini doğrudan gözlemleyin.
- Prometheus entegrasyonları için `metrics.exportDetectorLatencyHistogram('motion')` çıktısını `pnpm exec tsx` üzerinden
  alabilir, histogram buckets ile dedektör gecikme dağılımını inceleyebilirsiniz.
- Pipeline geri kazanım analizinde `metrics.exportPipelineRestartHistogram('ffmpeg', 'jitter', { metricName: 'guardian_ffmpeg_restart_jitter_ms' })`
  çıktısı, jitter dağılımını histogram olarak raporlar; aynı dizide `metrics.exportDetectorCountersForPrometheus()` çağrısı
  `guardian_detector_counter_total` satırlarıyla dedektör sayaçlarını Prometheus'a hazır hale getirir.
- `pipelines.ffmpeg.watchdogRestarts` ve `watchdogBackoffByChannel` değerleri, stream jitter'larını `detector latency histogramlarını`
  takip ederken hangi kameraların desteklenmesi gerektiğini anlamanıza yardımcı olur.

## Sorun giderme
- `guardian health --verbose` ile tüm sağlık kontrollerinin ayrıntılı sonuçlarını gözden geçirin. Özellikle `suppression` ve
  `retention` bölümlerindeki uyarılar yanlış pozitifleri azaltmak veya disk kullanımını kontrol etmek için kritik ipuçları
  sağlar.
- `guardian daemon restart --channel video:lobby` komutuyla yalnızca belirli bir RTSP akışını sıfırlayabilir, eş zamanlı olarak
  `guardian daemon status --json` ile watchdog sayaçlarının azaldığını doğrulayabilirsiniz.
- Mikrofon fallback zincirleri için `pnpm tsx src/cli.ts audio devices --json` çıktısındaki format/candidate sıralamasını
  inceleyerek cihaz keşfi akışını doğrulayın; JSON çıktısı `AudioSource.listDevices` sonuçlarıyla birebir eşleşir.

## Ek kaynaklar
- Daha fazla örnek, `README.md` içindeki Kurulum ve Sorun Giderme bölümlerinde yer alır.
- API referansı için `docs/api.md` (mevcutsa) ve `tests/http_api.test.ts` dosyalarındaki örnek istekleri inceleyebilirsiniz.
