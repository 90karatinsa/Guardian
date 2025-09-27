# Guardian

Guardian, ağ kameraları ve ses girişleri üzerinden gelen olayları normalize edip tek bir metrik, log ve uyarı yüzeyinde toplayan küçük bir gözlem/otomasyon iskeletidir. Yerleşik CLI, REST API ve SSE dashboard bileşeni sayesinde hem yerel geliştirme hem de saha kurulumlarında servis takibi yapılabilir.

## İçindekiler
- [Gereksinimler](#gereksinimler)
- [Kurulum](#kurulum)
- [Konfigürasyon](#konfigürasyon)
  - [RTSP ve çoklu kamera](#rtsp-ve-çoklu-kamera)
  - [Ses fallback ve anomaly ayarları](#ses-fallback-ve-anomaly-ayarları)
  - [Retention ve arşiv döngüsü](#retention-ve-arşiv-döngüsü)
- [Guardian'ı çalıştırma](#guardiannı-çalıştırma)
- [Dashboard](#dashboard)
- [Metrikler ve sağlık çıktısı](#metrikler-ve-sağlık-çıktısı)
- [Video ve ses boru hatları](#video-ve-ses-boru-hatları)
- [Docker ile çalışma](#docker-ile-çalışma)
- [systemd servisi](#systemd-servisi)
- [Operasyon kılavuzu](#operasyon-kılavuzu)
- [Sorun giderme](#sorun-giderme)

## Gereksinimler
Guardian, Node.js ekosistemi üzerinde çalışır ancak kamera/analiz zinciri için ek araçlara ihtiyaç duyar:

- **Node.js 20** ve **pnpm 8+** (corepack ile etkinleştirebilirsiniz).
- **ffmpeg** ve **ffprobe** ikilileri. RTSP kameralar, yerel dosyalar veya mikrofonlar bu araçlarla okunur.
- **onnxruntime-node** ve uygun bir **YOLOv8 ONNX modeli** (`models/yolov8n.onnx` gibi). Model dosyasını proje dizinine kendiniz kopyalamalısınız.
- (İsteğe bağlı) **SQLite** istemci araçları (`sqlite3`), oluşturulan `data/events.sqlite` dosyasını incelemek için.

> 💡 Linux üzerinde `sudo apt-get install -y ffmpeg libgomp1` komutu, macOS üzerinde `brew install ffmpeg`, Windows üzerinde ise [ffmpeg.org](https://ffmpeg.org) ikilisi gereksinimleri karşılar.

## Kurulum
Projeyi klonladıktan sonra bağımlılıkları yükleyin:

```bash
pnpm install
```

> 🛠️ `pnpm` komutu tanınmıyorsa `corepack enable` komutuyla pnpm'i etkinleştirin ve `pnpm --version` çıktısının en az 8 olduğunu doğrulayın.

İlk çalıştırmada Guardian, örnek konfigürasyon ve veri dizinlerini otomatik oluşturur. `config/default.json` dosyası guard'ın varsayılan akışını tanımlar. Kendi model dosyalarınızı (`models/yolov8n.onnx` vb.) ve RTSP kimlik bilgilerinizi ekledikten sonra aşağıdaki hızlı doğrulamaları yapın:

```bash
# ffmpeg ve onnxruntime erişimini doğrulayın
ffmpeg -version | head -n 1
pnpm exec node -e "require('onnxruntime-node'); console.log('onnxruntime hazır');"

# Guardian CLI kurulumunu test edin
pnpm exec tsx src/cli.ts --help

# Sağlık özeti histogram anahtarlarını içerir ve status: ok döner
pnpm tsx src/cli.ts --health
```

`pnpm tsx src/cli.ts --health` çıktısı `"status":"ok"` satırını ve `metrics.histograms.pipeline.ffmpeg.restarts`, `metrics.histograms.pipeline.audio.restarts` gibi anahtarları içerir; histogramlar sıfır değerlerle bile görünür. Aynı çıktı içinde `metrics.suppression.histogram.historyCount` ve `metrics.logs.byLevel.error` alanlarını da görebilirsiniz.

Kurulum sonrası hızlı doğrulama için aşağıdaki adımları takip edin:

1. `guardian daemon start` komutuyla süreci arka planda başlatın ve `guardian daemon status --json` çıktısındaki
   `pipelines.ffmpeg.watchdogRestarts` alanının 0 kaldığını doğrulayın.
2. `guardian daemon health --json` çıktısında `metrics.logs.histogram.error` ve `pipelines.ffmpeg.watchdogRestartsByChannel`
   anahtarlarını kontrol ederek log seviyelerinin doğru sayıldığından emin olun.
3. `guardian log-level set debug` ile seviyeyi yükseltip `guardian log-level get` komutuyla geri okuma yapın; metrikler
   `metrics.logs.byLevel.debug` alanına yeni bir artış yazacaktır.
4. Dedektör gecikme dağılımını gözlemlemek için `pnpm exec tsx -e "import metrics from './src/metrics/index.ts';
   console.log(metrics.exportDetectorLatencyHistogram('motion'))"` örneğini çalıştırarak Prometheus uyumlu histogram çıktısını
   inceleyin.

## Konfigürasyon
Guardian, `config/default.json` dosyasını okuyarak video, ses, dedektör ve retention politikalarını yapılandırır. Hot reload mekanizması, dosya değişikliklerini izler ve geçersiz JSON bulunduğunda son bilinen iyi yapılandırmaya geri döner.

```jsonc
{
  "video": {
    "testFile": "assets/test-video.mp4",
    "framesPerSecond": 2,
    "ffmpeg": {
      "inputArgs": ["-re"],
      "rtspTransport": "tcp",
      "idleTimeoutMs": 5000,
      "startTimeoutMs": 4000,
      "watchdogTimeoutMs": 5000,
      "forceKillTimeoutMs": 3000,
      "restartDelayMs": 500,
      "restartMaxDelayMs": 5000,
      "restartJitterFactor": 0.2
    },
    "channels": {
      "video:test-camera": {
        "ffmpeg": {
          "inputArgs": ["-use_wallclock_as_timestamps", "1"]
        }
      }
    },
    "cameras": [
      {
        "id": "test-camera",
        "channel": "video:test-camera",
        "input": "assets/test-video.mp4",
        "person": { "score": 0.5 },
        "motion": {
          "diffThreshold": 20,
          "areaThreshold": 0.02,
          "debounceFrames": 2,
          "backoffFrames": 3,
          "noiseMultiplier": 2.5,
          "noiseSmoothing": 0.15,
          "areaSmoothing": 0.2,
          "areaInflation": 1.2,
          "areaDeltaThreshold": 0.015
        }
      }
    ]
  },
  "events": {
    "thresholds": { "info": 0, "warning": 5, "critical": 10 },
    "suppression": {
      "rules": [
        {
          "id": "motion-cooldown",
          "detector": "motion",
          "source": "video:test-camera",
          "suppressForMs": 2000,
          "reason": "Suppress repeated motion events"
        }
      ]
    },
    "retention": {
      "retentionDays": 30,
      "intervalMinutes": 60,
      "archiveDir": "archive",
      "enabled": true,
      "maxArchivesPerCamera": 5,
      "snapshot": {
        "mode": "archive",
        "retentionDays": 21,
        "maxArchivesPerCamera": 3
      },
      "vacuum": {
        "run": "on-change",
        "mode": "auto",
        "analyze": true,
        "reindex": true,
        "optimize": true,
        "target": "main"
      }
    }
  },
  "audio": {
    "idleTimeoutMs": 4000,
    "startTimeoutMs": 3000,
    "watchdogTimeoutMs": 6000,
    "restartDelayMs": 500,
    "restartMaxDelayMs": 4000,
    "restartJitterFactor": 0.2,
    "forceKillTimeoutMs": 2000,
    "micFallbacks": {
      "default": [
        { "format": "alsa", "device": "default" },
        { "format": "alsa", "device": "hw:0" },
        { "format": "alsa", "device": "plughw:0" }
      ],
      "darwin": [
        { "format": "avfoundation", "device": ":0" },
        { "format": "avfoundation", "device": "0:0" }
      ],
      "win32": [
        { "format": "dshow", "device": "audio=\"default\"" },
        { "format": "dshow", "device": "audio=\"Microphone\"" }
      ]
    },
    "anomaly": {
      "sampleRate": 16000,
      "rmsThreshold": 0.25,
      "centroidJumpThreshold": 200,
      "minIntervalMs": 2000,
      "minTriggerDurationMs": 150,
      "rmsWindowMs": 200,
      "centroidWindowMs": 250,
      "thresholds": {
        "night": { "rms": 0.2, "centroidJump": 120 }
      },
      "nightHours": { "start": 21, "end": 6 }
    }
  }
}
```

Varsayılan dosya, örnek video akışını PNG karelere dönüştüren test kamerasını içerir. Üretimde kendi kameralarınızı tanımlamak için aşağıdaki bölümlere göz atın.

### RTSP ve çoklu kamera
- `video.cameras` dizisine her kamera için benzersiz bir nesne ekleyin. `input` alanı RTSP, HTTP MJPEG, yerel dosya veya `pipe:` önekiyle bir ffmpeg komutunu destekler.
- `channel` değeri, olayların EventBus üzerinde yayınlanacağı kanalı belirler (`video:lobby`, `video:parking` gibi). Dashboard filtreleri ve metriklerdeki `pipelines.ffmpeg.byChannel` haritası bu alanı kullanır.
- `ffmpeg` altındaki `idleTimeoutMs`, `watchdogTimeoutMs`, `startTimeoutMs`, `forceKillTimeoutMs`, `restartDelayMs`, `restartMaxDelayMs` ve `restartJitterFactor` seçenekleri boru hattının yeniden deneme davranışını ve watchdog zamanlamalarını kontrol eder. RTSP hataları art arda yaşandığında, exponential backoff ve jitter uygulaması `pipelines.ffmpeg.restartHistogram.delay` ve `pipelines.ffmpeg.watchdogBackoffByChannel` alanlarına işlenir; maksimum gecikmeye ulaşıldığında devre kesici tetiklenir ve hata logu üretir.
- Kamera bazlı `motion` ve `person` blokları debounce/backoff gibi gürültü bastırma katsayılarını içerir; aynı dosyada birden fazla kamera tanımlayarak her kanal için farklı eşikler uygulayabilirsiniz.
- Her kamera için tanımlanan `channel` değerinin `video.channels` altında karşılığı bulunmalıdır. Ayrıca `audio.micFallbacks` dizilerindeki `device` alanları boş bırakılamaz ve oran sınırlayıcı (`rateLimit`) tanımlarında `perMs` değeri `count` değerinden küçük olamaz; aksi halde konfigürasyon yüklenmez.
- Opsiyonel `audio.channel` alanını tanımlayarak ses mikserinin hangi EventBus kanalına bağlanacağını belirleyebilirsiniz. Aynı kanalın birden fazla kamera ile paylaşılması engellenir; yapılandırma yeniden yüklendiğinde çakışmalar uyarı olarak CLI ve loglarda görünür.

### Ses fallback ve anomaly ayarları
Guardian, mikrofon fallback zincirlerini ve anomaly dedektör eşiklerini çalışma anında güncelleyebilir:
- `audio.micFallbacks`, platform anahtarları altında `format` ve `device` bilgilerini içeren fallback listeleri kabul eder. Bir cihaz başarısız olduğunda sonraki aday denenir; yapılandırma dosyası kaydedildiğinde aktif boru hattı durdurulmadan yeni liste devreye girer.
- `audio.channel` alanı tanımlanmamışsa varsayılan `audio:microphone` kanalı kullanılır. Birden fazla örneği aynı kanala bağlamak istiyorsanız farklı değerler atayın.
- `audio.anomaly` blokları içinde `rmsWindowMs`, `centroidWindowMs`, `minTriggerDurationMs` veya `thresholds` alanlarını değiştirmeniz halinde dedektör tamponları sıfırlanır ve yeni pencereler hemen uygulanır. `nightHours` aralığı güncellendiğinde profil geçişi bir sonraki karede tetiklenir.
- Fallback ve eşik değişikliklerinin etkisini `guardian daemon status --json` komutuyla veya `/api/metrics/pipelines` uç noktasından alınan metriklerle doğrulayabilirsiniz.

### Retention ve arşiv döngüsü
Guardian, veritabanı ve snapshot dizinlerini periyodik olarak temizleyen bir retention görevine sahiptir:
- `events.retention.retentionDays`: SQLite üzerindeki olay kayıtlarının kaç gün saklanacağını belirtir. Silinen satır sayısı `VACUUM`/`VACUUM FULL` adımlarının tetiklenip tetiklenmeyeceğini belirler.
- `events.retention.archiveDir`, `events.retention.maxArchivesPerCamera`, `events.retention.snapshot.retentionDays` ve `events.retention.snapshot.maxArchivesPerCamera`: Snapshot arşivleri tarih bazlı klasörlerde toplanır (`archive/2024-03-18/` gibi). Limit aşıldığında en eski klasörler taşınır ve silinir. `snapshot.mode` değeri `archive` veya `cleanup` olarak yapılandırılabilir.
- Görev her çalıştırmada loglara `Retention task completed` satırını bırakır; `archivedSnapshots` değeri 0’dan büyükse arşiv döngüsünün devrede olduğu anlaşılır. `vacuum.mode` değeriniz `auto` ise, önceki çalıştırmada hiçbir satır/snapshot temizlenmediyse VACUUM adımı atlanır. `vacuum.run` alanı `always`, `on-change` veya `never` değerlerini kabul eder ve CLI çıktısında `vacuum=auto (run=on-change)` gibi bir özet gösterilir.

Bakım sırasında retention politikasını manuel olarak tetiklemek için CLI komutunu kullanabilirsiniz:

```bash
# Etkin yapılandırmayı kullanarak retention görevini tek seferlik çalıştırır
guardian retention run

# Alternatif bir konfigürasyon dosyasıyla çalıştırmak için
guardian retention run --config config/production.json
```

Komut stdout’a `Retention task completed` özetini yazar ve exit kodu 0 döner; `pipelines.ffmpeg.watchdogBackoffByChannel` ve `retention.totals` alanları üzerinden metrik güncellemelerini takip edebilirsiniz. CLI son kapanış nedeni ve hook sonuçlarını da raporlar.

Retention ayarlarını değiştirip dosyayı kaydettiğinizde hot reload mekanizması yeni değerleri uygular.

## Guardian'ı çalıştırma
Guardian CLI, servis kontrolü ve sağlık kontrollerini yönetir:

```bash
# Daemon modunu başlatır (arka planda çalışır)
guardian daemon start

# Çalışan sürecin sağlık özetini JSON olarak yazdırır (Docker/systemd healthcheck tarafından kullanılır)
guardian daemon status --json
pnpm exec tsx src/cli.ts status --json

# Sağlık çıktısında "status": "ok" beklenen alanıdır
guardian daemon health

# Readiness bilgisini kontrol eder
guardian daemon ready

# Sağlık çıktısının eski kısa yolu
guardian health

# Log seviyesini dinamik olarak günceller
guardian log-level set debug

# Graceful shutdown hook'larını test etmek için
guardian daemon hooks --reason test-shutdown

# Graceful shutdown tetikler
guardian stop

# Servis durumunu exit kodlarıyla raporlar
guardian status
```

`guardian daemon status --json` çıktısı `"status":"ok"`, `metrics.logs.byLevel.error`, `metrics.logs.histogram.error`,
`pipelines.ffmpeg.watchdogRestartsByChannel` ve `pipelines.ffmpeg.byChannel` gibi alanları içerir. Watchdog sayaçları tek tek
kanallar için kaç yeniden deneme yaşandığını, `watchdogBackoffByChannel` ise toplam gecikme süresini gösterir. Komut
çalıştırıldıktan sonra isterseniz `guardian log-level set info` ile varsayılan seviyeye geri dönebilir, `guardian log-level get`
çıkışını `metrics.logs.byLevel` ile karşılaştırabilirsiniz. Geliştirme sırasında `pnpm start` komutu HTTP sunucusunu ve guardian
daemon'unu aynı anda başlatan bir kısayol olarak kullanılabilir.

## Dashboard
`pnpm start` komutu HTTP sunucusunu da başlattığından, `http://localhost:3000/` adresinden dashboard'a erişebilirsiniz. SSE feed'i `text/event-stream` başlığıyla metrikleri, yüz eşleşmelerini, pose forecast bilgilerini ve threat özetlerini yayınlar. Filtreler `channel`, `detector` ve `severity` alanlarını temel alır; poz tahminleri `pose.forecast` bloklarıyla, tehdit değerlendirmeleri ise `threat.summary` alanıyla güncellenir.

## Metrikler ve sağlık çıktısı
`pnpm tsx src/cli.ts --health` veya `guardian daemon status --json` komutları, aşağıdaki gibi bir metrik özeti döndürür:

- `metrics.logs.byLevel.warn`, `metrics.logs.byLevel.error`: Pino log seviyelerine göre sayaçlar. `metrics.logs.histogram.error` değeri, hata loglarının kaç kez üretildiğini gösterir.
- `metrics.suppression.histogram.historyCount`: Bastırılan olayların tarihçe sayısına göre histogram; `cooldownMs`, `cooldownRemainingMs` ve `windowRemainingMs` alt anahtarları suppression pencerelerinin süre dağılımını raporlar.
- `pipelines.ffmpeg.restartHistogram.delay` ve `pipelines.audio.restartHistogram.attempt`: Watchdog yeniden denemeleri için gecikme ve deneme histogramları. `pipelines.ffmpeg.jitterHistogram` değerleri RTSP geri çekilme jitter'ını raporlar.
- `pipelines.audio.deviceDiscovery` ve `pipelines.audio.deviceDiscoveryByChannel`: Mikrofon fallback zincirlerinin hangi platformlarda denendiğini gösterir.
- `detectors.motion.counters.backoffActivations`, `detectors.light.counters.backoffSuppressedFrames`: Debounce/backoff sayaçları.

`registerHealthIndicator` ile özel health check ekleyebilir, `collectHealthChecks` çağrısında `metrics.logs.byLevel.error` veya `metrics.suppression.lastEvent` gibi alanlara erişebilirsiniz.

## Video ve ses boru hatları
Video için ffmpeg süreçleri, `src/video/source.ts` altında watchdog tarafından izlenir. `Audio source recovering (reason=ffmpeg-missing|stream-idle)` satırlarını loglarda görüyorsanız, fallback listesi üzerinde iterasyon yapıldığını bilirsiniz. Her yeniden başlatma `pipelines.ffmpeg.byReason`, `pipelines.ffmpeg.restartHistogram.delay` ve `pipelines.ffmpeg.jitterHistogram` alanlarını artırır.

Ses tarafında anomaly dedektörü, RMS ve spectral centroid ölçümlerini `audio.anomaly` konfigürasyonu doğrultusunda toplar. `metrics.detectors['audio-anomaly'].latencyHistogram` değeri, pencere hizasının doğruluğunu teyit eder. Sustained sessizlikte devre kesici tetiklendiğinde `pipelines.audio.watchdogBackoffByChannel` ve `pipelines.audio.restartHistogram.delay` artışları görülebilir.

## Docker ile çalışma
`Dockerfile` çok aşamalı build tanımlar. İmajı inşa etmek için:

```bash
pnpm run build
docker build -t guardian:latest .
```

Docker healthcheck'i `guardian daemon health` ve `guardian daemon status --json` komutlarına dayanır ve log seviyeleri konteyner içinde `guardian log-level set warn` ile güncellenebilir. Persistans için `data/` ve `archive/` dizinlerini volume olarak bağlamayı unutmayın.

## systemd servisi
`deploy/guardian.service` ve `deploy/systemd.service` dosyaları, CLI'nin `start`, `stop` ve `health` komutlarını kullanan örnek unit tanımları içerir. `journalctl -u guardian` çıktısında `metrics.logs.byLevel.error` artışını veya `pipelines.audio.watchdogBackoffByChannel` değişikliklerini izleyebilirsiniz.

## Operasyon kılavuzu
Guardian'ı 7/24 çalıştırırken yapılması gereken rutin kontroller ve bakım adımları için [Operasyon kılavuzu](docs/operations.md)
dokümanını takip edin. Bu kılavuzda `guardian daemon health --json` çıktısındaki `watchdogRestarts` sayaçlarını nasıl yorumlayacağı,
`pnpm exec tsx src/tasks/retention.ts --run now` komutuyla bakım tetiklemenin yolları ve dedektör gecikme histogramlarının Prometheus
üzerinden nasıl dışa aktarılacağı gibi örnekler yer alır. README'deki Kurulum, Guardian'ı Çalıştırma ve Sorun giderme bölümleri bu
operasyonel rehber ile birlikte okunmalıdır.

## Sorun giderme
- `guardian daemon status --json` veya `pnpm exec tsx src/cli.ts --health` çıktısında `metrics.logs.byLevel.error` hızla artıyorsa log seviyesini `guardian log-level set debug` ile yükseltip detaylı inceleme yapın.
- `pipelines.ffmpeg.watchdogBackoffByChannel` veya `pipelines.ffmpeg.restartHistogram.delay` değerleri sürekli yükseliyorsa RTSP bağlantılarını kontrol edin; `restartDelayMs`, `restartMaxDelayMs` ve `restartJitterFactor` parametrelerini düşürmek backoff süresini azaltır.
- `Audio source recovering (reason=ffmpeg-missing|stream-idle)` satırları kesintisiz devam ediyorsa `audio.micFallbacks` listesinde çalışan bir cihaz kalmamış olabilir.
- `metrics.suppression.histogram.cooldownRemainingMs` ve `metrics.suppression.histogram.windowRemainingMs` değerleri yüksekse `events.suppression.rules` altındaki `suppressForMs` veya `rateLimit.cooldownMs` değerlerini gözden geçirin.
- CLI komutları beklenen çıktıyı vermiyorsa `guardian daemon status --json` ve `pnpm exec tsx src/cli.ts status --json` komutlarının exit kodunun 0 olduğundan emin olun; farklı bir config dosyasını `--config` parametresiyle doğrulayabilirsiniz. `guardian daemon ready` çıktısı `"status":"ready"` değilse bir shutdown hook'u blokluyor olabilir.
- `pipelines.ffmpeg.watchdogRestarts` veya `pipelines.ffmpeg.watchdogRestartsByChannel` değerleri artıyorsa [Operasyon kılavuzu](docs/operations.md)
  içindeki devre kesici sıfırlama adımlarını uygulayın ve `guardian daemon hooks --reason watchdog-reset` komutuyla manuel toparlanmayı deneyin.

