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
- Aynı sağlık çıktısındaki `metrics.pipelines.ffmpeg.transportFallbacks.total`, `...byChannel` ve `metricsSummary.pipelines.transportFallbacks.video.byChannel[].lastReason` alanlarını inceleyerek RTSP bağlantılarının TCP↔UDP fallback zincirine kaç kez ve hangi gerekçeyle başvurduğunu takip edin; artış görürseniz `guardian daemon restart --transport`
  komutu ile kanalı sıfırlayabilirsiniz.
- `guardian daemon pipelines reset --channel video:<kanal> --no-restart` komutu çalıştırıldığında stdout üzerindeki
  "Reset pipeline health, circuit breaker, and transport fallback" mesajını ve `guardian daemon health --json`
  çıktısındaki `pipelines.ffmpeg.channels[kanal].severity === 'none'`, `metricsSummary.pipelines.transportFallbacks.video.byChannel`
  listesindeki ilgili kaydın `total === 0` olduğunu ve `metricsSummary.pipelines.transportFallbacks.resets.byChannel[kanal]`
  değerlerinin `backoff === 0`, `circuitBreaker === 0` seviyesine döndüğünü kontrol ederek hem devre kesici hem de fallback sayaçlarının
  temizlendiğini doğrulayın; `--no-restart` bayrağı bekleyen yeniden başlatma zamanlayıcılarını iptal eder. Ayrıntılar için README'deki
  [pipeline sıfırlama akışı](../README.md#pipeline-s%C4%B1f%C4%B1rlama-ak%C4%B1%C5%9F%C4%B1) bölümüne bakın.
- Ses kanalları için `guardian daemon pipelines reset --channel audio:<kanal> --no-restart` komutunu kullanarak hem
  `metrics.pipelines.audio.byChannel[kanal].restarts` hem de `metrics.pipelines.audio.byChannel[kanal].health.severity`
  değerlerinin anında sıfırlandığını doğrulayın; bu işlem audio devre kesicisi yeniden başlatılmadan sayaçları temizler.
- Docker ya da systemd ortamında healthcheck scriptini test etmek için `pnpm tsx scripts/healthcheck.ts --health` ve `--ready`
  seçeneklerini kullanın; `metricsSummary.pipelines.watchdogRestarts` alanı kanal başına devre kesici tetiklerini özetler ve
  `transportFallbackResets.total` değeri fallback resetlerinin durumunu raporlar. Ayrıntılı kullanım README'deki
  [offline tanılama ve sağlık uçları](../README.md#offline-tan%C4%B1lama-ve-sa%C4%9Fl%C4%B1k-u%C3%A7lar%C4%B1) bölümünde belgelenmiştir.

### Docker ve systemd healthcheck pratikleri
- Docker imajınıza `HEALTHCHECK --interval=30s --timeout=5s CMD ["pnpm","tsx","scripts/healthcheck.ts","--health"]` satırını
  ekleyerek guardian daemon'unun liveness durumunu doğrulayın. Komut başarısız olursa `docker inspect --format '{{json .State.Health}}'`
  çıktısı `Status: "unhealthy"` değerini döndürür; konteyneri yeniden başlatmadan önce `docker exec guardian pnpm tsx scripts/healthcheck.ts --ready`
  komutuyla aynı scripti elle tetikleyebilirsiniz.
- systemd ortamında `ExecStartPre=/usr/bin/env pnpm tsx scripts/healthcheck.ts --ready` satırı servis başlamadan önce SSE uçlarının hazır olduğunu kontrol eder.
  `systemd-run --user --wait pnpm tsx scripts/healthcheck.ts --health --pretty` komutu aynı kontrolü interaktif olarak çalıştırır ve JSON çıktısındaki
  `pipelinesSummary.transportFallbacks.video.byChannel[].total` alanları RTSP fallback döngüsünün yoğunluğunu gösterir.
- Uzaktan tanılama senaryolarında `pnpm tsx scripts/healthcheck.ts --pretty -c /etc/guardian/config.json` parametresi ile alternatif konfigürasyon yollarını test edin; script,
  guardian süreci çalışmıyorsa `status: "error"` ve `reason: "guardian-daemon-unreachable"` alanlarını döndürür.

## Periyodik bakım görevleri
- RTSP veya ffmpeg kaynaklı bağlantı sorunları için `guardian daemon hooks --reason watchdog-reset` komutunu kullanarak devre
  kesicileri elle temizleyin.
- Bir kanal sürekli TCP↔UDP fallback döngüsüne giriyorsa `guardian daemon restart --transport video:<kanal>` komutuyla o kanalın
  transport sıralamasını sıfırlayın; komut sonrası `guardian daemon status --json` çıktısında `transportFallbacks.byChannel`
  sayaçlarının sıfırlandığını doğrulayın.
- `pnpm exec tsx src/tasks/retention.ts --run now` komutu ile retention görevini elle tetikleyebilir, ardından
  `scripts/db-maintenance.ts vacuum --mode full` yardımıyla SQLite arşivini sıkıştırabilirsiniz.
- Çalıştırma sonrasında `guardian daemon status --json` çıktısındaki `metricsSummary.retention.runs`, `warnings`, `totals` ve `totalsByCamera` alanlarını inceleyerek bakım görevlerinin ne kadar veri temizlediğini doğrulayın; `totals.diskSavingsBytes` değeri son çalışmada kazanılan alanı gösterir.
- `guardian retention run --config config/production.json` ile farklı konfigürasyon dosyaları için bakım planlayabilirsiniz;
  `pnpm tsx src/cli.ts retention --help` çıktısı güncel seçenekleri listeler.

## Çevrimdışı dağıtımlar için hazırlık
- Edge kutularında Guardian'ı güncellemeden önce build host üzerinde `pnpm fetch --prod` komutunu çalıştırın ve `tar czf guardian-pnpm-store.tar.gz $(pnpm store path --silent)`
  ile pnpm mağazasını arşivleyin. Arşiv, hedef cihazda `tar xzf guardian-pnpm-store.tar.gz -C $(pnpm store path --silent)` ve `pnpm install --offline --prod`
  komutlarıyla açılır.
- Offline cihazlarda healthcheck doğrulaması yapmak için `pnpm tsx scripts/healthcheck.ts --pretty -c config/edge.json` komutunu kullanın; çıkıştaki `metricsSummary.pipelines.watchdogRestarts`
  ve `pipelinesSummary.transportFallbacks` değerleri bağlantı istikrarını gösterir.
- Uzun süreli saha kurulumlarında disk tüketimini kontrol etmek için `guardian retention run --config config/edge.json` komutunu manuel tetikleyin ve
  ardından `pnpm exec tsx src/tasks/retention.ts --run now` ile arşiv vakumlarını planlayın; loglarda `vacuum.summary.ensuredIndexes` ve `diskSavingsBytes`
  satırlarının beklenen değerleri raporladığını doğrulayın.

## Log ve metrik inceleme
- `guardian log-level get` ve `guardian log-level set warn` komutlarıyla log seviyesini değiştirirken, `guardian daemon health`
  çıktısındaki `metrics.logs.byLevel` ve `metrics.logs.histogram` alanlarını izleyin.
- Dashboard mobil görünümü test etmek için tarayıcı geliştirici araçlarıyla genişliği 640 piksel altına düşürün; `main.dashboard-grid`
  elementinin `data-layout="compact"` değerini aldığını ve snapshot panelinin kart listesinin altına indiğini doğrulayın. `Reset filters`
  düğmesi kanal seçimini temizleyerek `state.filters.channels` kümesini boşaltır.
- SSE dashboard'un sağ panelindeki `warnings` tablosu, bastırma timeline TTL prune olaylarını `type: "suppression"` olarak gösterir. `/api/events/stream` uç noktasına bağlandığınızda `{"type":"suppression",...}` payload'larını görürseniz suppression kurallarınızın TTL sınırında olduğunu anlayabilirsiniz; aynı olay `metricsSummary.suppression.historyTotals.ttlPrunedByChannel` artışlarıyla tutarlıdır.
- Bastırma timeline TTL temizlemelerini takip etmek için `guardian daemon health --json` çıktısındaki
  `metricsSummary.suppression.historyTotals.ttlPrunedByChannel` haritasını inceleyin; yüksek değerler belirli kanalların
  timeline kısıtlamalarına takıldığını gösterir.
- Prometheus dışa aktarımı için `pnpm exec tsx -e "import metrics from './src/metrics/index.ts';\nconsole.log(metrics.exportLogLevelCountersForPrometheus({ labels: { site: 'edge-1' } }));"` komutu ile `guardian_log_level_total`
  ve `guardian_log_last_error_timestamp_seconds` gauge değerlerini doğrudan gözlemleyin. Aynı çıktıda `guardian_log_level_state`
  ve `guardian_log_level_change_total` satırları, log seviyesi değişimlerinin ne kadar sık gerçekleştiğini gösterir.
- Prometheus entegrasyonları için `metrics.exportDetectorLatencyHistogram('motion')` çıktısını `pnpm exec tsx` üzerinden
  alabilir, histogram buckets ile dedektör gecikme dağılımını inceleyebilirsiniz.
- Pipeline geri kazanım analizinde `metrics.exportPipelineRestartHistogram('ffmpeg', 'jitter', { metricName: 'guardian_ffmpeg_restart_jitter_ms' })`
  çıktısı, jitter dağılımını histogram olarak raporlar; aynı dizide `metrics.exportDetectorCountersForPrometheus()` çağrısı
  `guardian_detector_counter_total` satırlarıyla dedektör sayaçlarını Prometheus'a hazır hale getirir.
- Transport fallback ve retention tasarruflarını Prometheus formatında görmek için `metrics.exportTransportFallbackMetricsForPrometheus()`
  ve `metrics.exportRetentionDiskSavingsForPrometheus()` çağrılarını kullanın; çıktı `guardian_transport_fallback_total`
  ve `guardian_retention_disk_savings_bytes_total` satırlarını içerir.
- ffmpeg süreçleri hata ürettiğinde loglarda `Video source reconnecting (reason=ffmpeg-error)` satırını arayın; aynı anda
  `guardian daemon status --json` çıktısındaki `pipelines.ffmpeg.byReason['ffmpeg-error']` sayaçlarının arttığını doğrulamak
  toparlanma akışının çalıştığını gösterir.
- Manuel taşıyıcı sıfırlamalarından sonra `guardian daemon restart --transport video:<kanal>` komutunu izleyin; sağlık
  özetindeki `metricsSummary.pipelines.transportFallbacks.video.byChannel` kayıtlarında ilgili `total` değerinin 0'a
  döndüğünü ve `lastReason` alanının temizlendiğini doğrulayın.
- `pipelines.ffmpeg.watchdogRestarts` ve `watchdogBackoffByChannel` değerleri, stream jitter'larını `detector latency histogramlarını`
  takip ederken hangi kameraların desteklenmesi gerektiğini anlamanıza yardımcı olur.

## Sorun giderme
| Belirti | Muhtemel neden | Önerilen komut |
| --- | --- | --- |
| `status: "degraded"` ya da `logs.byLevel.error` artışı | Dedektör hatası veya uzun süreli devre kesici gecikmeleri | `pnpm tsx scripts/healthcheck.ts --health` ve `guardian log-level set debug` |
| `watchdogRestartsByChannel` artıyor | RTSP jitter veya ağ kopması | `guardian daemon pipelines reset --channel video:<kanal> --no-restart`, `guardian daemon pipelines reset --channel audio:<kanal> --no-restart` ve `guardian daemon status --json` |
| `metrics.pipelines.ffmpeg.transportFallbacks.total` artıyor | Transport fallback zinciri sürekli devrede | `guardian daemon restart --transport video:<kanal>` komutunu çalıştırın ve `transportFallbacks.byChannel` sayaçlarını kontrol edin |
| `Audio source recovering (reason=ffmpeg-missing)` sürüyor | Mikrofon fallback zinciri başarısız | `guardian audio devices --json` ve `pnpm tsx scripts/healthcheck.ts --ready` |
| `metricsSummary.suppression.historyTotals.ttlPrunedByChannel` yükseliyor | Bastırma timeline TTL değerleri çok kısa | README'deki [konfigürasyon override rehberi](../README.md#konfig%C3%BCrasyon-override-rehberi) ile `timelineTtlMs` ve kanal listelerini gözden geçirin |

- SSE dashboard bağlantısı hatayla kapandığında Guardian `req.on('error')` ve `res.on('error')` dinleyicileriyle istemciyi hemen listeden düşer; loglarda "stream-status" olayından sonra `clients.size` artmaz ve `HttpSseResponseErrorCleanup` testi bu davranışı doğrular.
- Hot reload sırasında `config.video.channels.<kanal>` için karşılık gelen bir kamera bulunmazsa Guardian reload'u `config.video.channels.video:unused-channel does not match any configured camera channel` hatasıyla reddeder; dosyayı düzeltip tekrar denemeden önce son bilinen yapılandırma kullanılmaya devam eder.
- `guardian health --verbose` ile tüm sağlık kontrollerinin ayrıntılı sonuçlarını gözden geçirin. Özellikle `suppression` ve
  `retention` bölümlerindeki uyarılar yanlış pozitifleri azaltmak veya disk kullanımını kontrol etmek için kritik ipuçları
  sağlar.
- `guardian daemon restart --channel video:lobby` komutuyla yalnızca belirli bir RTSP akışını sıfırlayabilir, eş zamanlı olarak
  `guardian daemon status --json` ile watchdog sayaçlarının azaldığını doğrulayabilirsiniz.
- Mikrofon fallback zincirleri için `pnpm tsx src/cli.ts audio devices --json` çıktısındaki format/candidate sıralamasını
  inceleyerek cihaz keşfi akışını doğrulayın; JSON çıktısı `AudioSource.listDevices` sonuçlarıyla birebir eşleşir.

## Ek kaynaklar
- Daha fazla örnek, `README.md` içindeki Kurulum ve Sorun Giderme bölümlerinde yer alır.
- Konfigürasyon override'ları, pipeline reset akışı ve offline sağlık uçları için README'deki
  [konfigürasyon override rehberi](../README.md#konfig%C3%BCrasyon-override-rehberi),
  [pipeline sıfırlama akışı](../README.md#pipeline-s%C4%B1f%C4%B1rlama-ak%C4%B1%C5%9F%C4%B1) ve
  [offline tanılama ve sağlık uçları](../README.md#offline-tan%C4%B1lama-ve-sa%C4%9Fl%C4%B1k-u%C3%A7lar%C4%B1) bölümlerine bakın.
- API referansı için `docs/api.md` (mevcutsa) ve `tests/http_api.test.ts` dosyalarındaki örnek istekleri inceleyebilirsiniz.
