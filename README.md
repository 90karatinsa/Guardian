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

# Docker/systemd healthcheck komutlarının CLI olmadan test edilmesi
pnpm tsx scripts/healthcheck.ts --health
pnpm tsx scripts/healthcheck.ts --ready
```

`pnpm tsx src/cli.ts --health` çıktısı `"status":"ok"` satırını ve `metrics.histograms.pipeline.ffmpeg.restarts`, `metrics.histograms.pipeline.audio.restarts` gibi anahtarları içerir; histogramlar sıfır değerlerle bile görünür. Aynı çıktı içinde `metrics.suppression.histogram.historyCount` ve `metrics.logs.byLevel.error` alanlarını da görebilirsiniz.

Kurulum sonrası hızlı doğrulama için aşağıdaki adımları takip edin:

1. `guardian daemon start` komutuyla süreci arka planda başlatın ve `guardian daemon status --json` çıktısındaki
   `pipelines.ffmpeg.watchdogRestarts` alanının 0 kaldığını doğrulayın.
2. `guardian daemon health --json` çıktısında `metrics.logs.histogram.error` ve `pipelines.ffmpeg.watchdogRestartsByChannel`
   anahtarlarını kontrol ederek log seviyelerinin doğru sayıldığından emin olun.
3. `guardian daemon pipelines list --json` komutuyla `pipelines.ffmpeg.degraded` ve `pipelines.audio.degraded`
   dizilerinin severity önceliğine göre sıralandığını doğrulayın; JSON içinde her kanal için `severity`, `restarts`
   ve `backoffMs` alanları `buildPipelineHealthSummary` ile birebir eşleşir.
4. Watchdog sayaçlarını manuel olarak sıfırlamak için `guardian daemon pipelines reset --channel video:test-camera`
   komutunu çalıştırın; başarılı olduğunda stdout üzerindeki "Reset pipeline health counters" mesajı ve
   `metrics.pipelines.ffmpeg.byChannel['video:test-camera'].health.severity === 'none'` kontrolü devre sağlığının
   sıfırlandığını gösterir.
5. `guardian log-level set debug` ile seviyeyi yükseltip `guardian log-level get` komutuyla geri okuma yapın; metrikler
   `metrics.logs.byLevel.debug` alanına yeni bir artış yazacaktır.
6. Dedektör gecikme dağılımını gözlemlemek için `pnpm exec tsx -e "import metrics from './src/metrics/index.ts';
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
        "person": { "score": 0.5, "nmsThreshold": 0.45 },
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
          "timelineTtlMs": 10000,
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
- `channel` değeri, olayların EventBus üzerinde yayınlanacağı kanalı belirler (`video:lobby`, `video:parking` gibi). Guardian bu değerleri `normalizeChannelId` yardımcı fonksiyonuyla normalize eder; `video:lobby` ve `lobby` girişleri aynı video kanalına, `audio:microphone` ve sadece `microphone` girişleri ise aynı ses kanalına eşlenir. Dashboard filtreleri, HTTP API ve metriklerdeki `pipelines.ffmpeg.byChannel` ile `pipelines.audio.byChannel` haritaları bu normalleştirilmiş değerleri kullanır.
- Prefixsiz girişler video kanalları için `video:` önekiyle, ses kanalları için ise `audio:` önekiyle saklanır. Örneğin `events.suppression.rules` altında `channel: "MICROPHONE"` tanımı yaparsanız Guardian bunu `audio:microphone` olarak kaydeder; CLI ve dashboard filtreleri aynı kimlikle eşleşir. Her kural opsiyonel `timelineTtlMs` değeriyle geçmiş event kimliklerinin ne kadar süre tutulacağını belirler; süre dolduğunda suppress edilmiş kayıtlar otomatik temizlenir.
- `ffmpeg` altındaki `idleTimeoutMs`, `watchdogTimeoutMs`, `startTimeoutMs`, `forceKillTimeoutMs`, `restartDelayMs`, `restartMaxDelayMs` ve `restartJitterFactor` seçenekleri boru hattının yeniden deneme davranışını ve watchdog zamanlamalarını kontrol eder. RTSP hataları art arda yaşandığında, exponential backoff ve jitter uygulaması `pipelines.ffmpeg.restartHistogram.delay` ve `pipelines.ffmpeg.watchdogBackoffByChannel` alanlarına işlenir; maksimum gecikmeye ulaşıldığında devre kesici tetiklenir ve hata logu üretir.
- Kamera bazlı `motion` ve `person` blokları debounce/backoff gibi gürültü bastırma katsayılarını içerir; aynı dosyada birden fazla kamera tanımlayarak her kanal için farklı eşikler uygulayabilirsiniz. `person.nmsThreshold` değeri globalde, kanal altında veya kamera tanımında girildiğinde non-max suppression filtresini sıkılaştırır; yalnızca değer değiştiğinde dedektör yeniden başlatılır.
- Her kamera için tanımlanan `channel` değerinin `video.channels` altında karşılığı bulunmalıdır. Ayrıca `audio.micFallbacks` dizilerindeki `device` alanları boş bırakılamaz ve oran sınırlayıcı (`rateLimit`) tanımlarında `perMs` değeri `count` değerinden küçük olamaz; aksi halde konfigürasyon yüklenmez.
- Opsiyonel `audio.channel` alanını tanımlayarak ses mikserinin hangi EventBus kanalına bağlanacağını belirleyebilirsiniz. Aynı kanalın birden fazla kamera ile paylaşılması engellenir; yapılandırma yeniden yüklendiğinde çakışmalar uyarı olarak CLI ve loglarda görünür.

Çok kameralı kurulumlarda RTSP akışlarını ve kanal eşleştirmelerini aşağıdaki gibi tanımlayabilirsiniz. `pipelines.ffmpeg.watchdogRestartsByChannel`
ve `pipelines.ffmpeg.watchdogBackoffByChannel` metrikleri, her kanalın ne kadar sık yeniden başlatıldığını gösterecektir.

```jsonc
{
  "video": {
    "cameras": [
      {
        "id": "lobby",
        "channel": "video:lobby",
        "input": "rtsp://10.0.0.5/lobby",
        "ffmpeg": {
          "watchdogTimeoutMs": 6000,
          "restartDelayMs": 500
        },
        "motion": {
          "debounceFrames": 3,
          "backoffFrames": 4
        }
      },
      {
        "id": "parking",
        "channel": "video:parking",
        "input": "rtsp://10.0.0.6/parking",
        "ffmpeg": {
          "restartDelayMs": 750,
          "restartJitterFactor": 0.25
        },
        "person": {
          "score": 0.45
        }
      }
    ]
  },
  "audio": {
    "channel": "audio:parking",
    "micFallbacks": {
      "default": [
        { "format": "alsa", "device": "hw:1" },
        { "format": "alsa", "device": "plughw:1" }
      ]
    }
  }
}
```

### Ses fallback ve anomaly ayarları
Guardian, mikrofon fallback zincirlerini ve anomaly dedektör eşiklerini çalışma anında güncelleyebilir:
- `audio.micFallbacks`, platform anahtarları altında `format` ve `device` bilgilerini içeren fallback listeleri kabul eder. Bir cihaz başarısız olduğunda sonraki aday denenir; yapılandırma dosyası kaydedildiğinde aktif boru hattı durdurulmadan yeni liste devreye girer. `events.suppression.rules[].timelineTtlMs` değerini değiştirirseniz guard, sıcak durumda timeline TTL'lerini günceller ve geçmiş event kimliklerini yeni süreye göre prune eder.
- `audio.channel` alanı tanımlanmamışsa varsayılan `audio:microphone` kanalı kullanılır. Birden fazla örneği aynı kanala bağlamak istiyorsanız farklı değerler atayın.
- `audio.anomaly` blokları içinde `rmsWindowMs`, `centroidWindowMs`, `minTriggerDurationMs` veya `thresholds` alanlarını değiştirmeniz halinde dedektör tamponları sıfırlanır ve yeni pencereler hemen uygulanır. `nightHours` aralığı güncellendiğinde profil geçişi bir sonraki karede tetiklenir.
- Fallback ve eşik değişikliklerinin etkisini `guardian daemon status --json` komutuyla veya `/api/metrics/pipelines` uç noktasından alınan metriklerle doğrulayabilirsiniz.
- `audio.silenceCircuitBreakerThreshold`, sessizlik pencereleri art arda bu eşiği aştığında devre kesiciyi tetikler. `0` değeri devre kesiciyi devre dışı bırakır; tetiklemeler sırasında `Audio source recovering (reason=silence-circuit-breaker)` satırlarını ve `guardian daemon status --json` çıktısındaki `pipelines.audio.byReason` sayaç artışlarını bekleyebilirsiniz.
- `audio.deviceDiscoveryTimeoutMs`, fallback listesi taramasının kaç milisaniye sonra zaman aşımına uğrayacağını belirler. Süre dolduğunda loglar `Audio device discovery timed out after 2000ms` benzeri bir mesaj yazar, `pipelines.audio.deviceDiscovery.byReason` metriği denenen platformları sayar ve `guardian audio devices --json` çıktısı aynı zaman aşımı değerini `timeoutMs` alanı altında raporlar.
- Linux ve PipeWire kurulumlarında `PulseAudio fallback` zinciri varsayılan olarak ilk denenir; `pulse` formatı başarısız olursa otomatik olarak ALSA adaylarına geçilir. Loglardaki `PulseAudio fallback activated` satırları ile `metrics.pipelines.audio.deviceDiscovery.byFormat.pulse` ve `pipelines.audio.deviceDiscovery.byReason.pulse` sayaçları bu geçişleri doğrular.

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

Güncel seçenekler ve yardım çıktısı aşağıdaki komutla görüntülenebilir:

```text
$ pnpm tsx src/cli.ts retention --help
Guardian retention commands

Usage:
  guardian retention run [--config path]  Run retention once with current config

Options:
  -c, --config <path>   Use an alternate configuration file
  -h, --help            Show this help message
```

Komut stdout’a `Retention task completed` özetini yazar ve exit kodu 0 döner; `pipelines.ffmpeg.watchdogBackoffByChannel` ve `retention.totals` alanları üzerinden metrik güncellemelerini takip edebilirsiniz. CLI son kapanış nedeni ve hook sonuçlarını da raporlar.

Retention ayarlarını değiştirip dosyayı kaydettiğinizde hot reload mekanizması yeni değerleri uygular.

## Guardian'ı çalıştırma
Guardian CLI, servis kontrolü ve sağlık kontrollerini yönetir:

```text
$ pnpm tsx src/cli.ts --help
Guardian CLI

Usage:
  guardian start        Start the detector daemon (alias of "guardian daemon start")
  guardian stop         Stop the running daemon (alias of "guardian daemon stop")
  guardian status       Print service status summary
  guardian health       Print health JSON
  guardian ready        Print readiness JSON
  guardian daemon <command>  Run daemon lifecycle commands
  guardian audio <command>   Manage audio capture helpers
  guardian log-level    Get or set the active log level
  guardian retention run [--config path]  Run retention once with current config
```

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

# Belirli bir video kanalının devre kesicisini sıfırlar
guardian daemon restart --channel video:lobby

# Bilinmeyen kanal denemesi exit kodu 1 ve anlamlı hata mesajı döndürür
guardian daemon restart --channel video:missing
# channel not found: video:missing

# Belirli bir ses kanalının devre kesicisini sıfırlar ve normalize edilmiş kimliği raporlar
guardian daemon restart --channel audio:microphone
# Requested circuit breaker reset for audio channel audio:microphone

Komut tamamlandığında `metrics.snapshot().pipelines.audio.restarts` sayacı ile
`pipelines.audio.byChannel['audio:microphone'].byReason['manual-circuit-reset']` alanı 1 artar; `guardian daemon status --json`
veya `guardian daemon health` komutlarının çıktılarına yansıyan `Restarts - video: …, audio: …` satırında artışı görebilirsiniz.

# Bağlı mikrofonları JSON olarak listeler
guardian audio devices --json

# Graceful shutdown tetikler
guardian stop

# Servis durumunu exit kodlarıyla raporlar
guardian status
```

`guardian daemon status --json` çıktısı `"status":"ok"`, `metrics.logs.byLevel.error`, `metrics.logs.histogram.error`,
`pipelines.ffmpeg.watchdogRestartsByChannel` ve `pipelines.ffmpeg.byChannel` gibi alanları içerir. `metricsSummary.pipelines.transportFallbacks.video.byChannel` dizisindeki her kayıt `channel`, `total`, `lastReason` ve `lastAt` alanlarını taşıyarak TCP↔UDP ladder değişimlerini ayrıntılandırır; `metricsSummary.retention` bloğu ise `runs`, `warnings`, `totals` ve `totalsByCamera` anahtarlarıyla son retention görevlerinin özetini paylaşır. Watchdog sayaçları tek tek kanallar için kaç yeniden deneme yaşandığını, `watchdogBackoffByChannel` ise toplam gecikme süresini gösterir. Komut çalıştırıldıktan sonra isterseniz `guardian log-level set info` ile varsayılan seviyeye geri dönebilir, `guardian log-level get` çıkışını `metrics.logs.byLevel` ile karşılaştırabilirsiniz. Geliştirme sırasında `pnpm start` komutu HTTP sunucusunu ve guardian daemon'unu aynı anda başlatan bir kısayol olarak kullanılabilir.

## Dashboard
`pnpm start` komutu HTTP sunucusunu da başlattığından, `http://localhost:3000/` adresinden dashboard'a erişebilirsiniz. SSE feed'i `text/event-stream` başlığıyla metrikleri, yüz eşleşmelerini, pose forecast bilgilerini ve threat özetlerini yayınlar. Filtreler `channel`, `detector` ve `severity` alanlarını temel alır; poz tahminleri `pose.forecast` bloklarıyla, tehdit değerlendirmeleri ise `threat.summary` alanıyla güncellenir. Retention diski tasarruf uyarıları ve RTSP transport fallback bildirimleri de aynı SSE akışında `warnings` kategorisi altında yayınlanır; dashboard sağ panelindeki uyarı kronolojisi her olayda `streamSnapshots` sayaçlarını artırır. `pipelines.ffmpeg.byChannel` girdilerindeki `health.severity`, `health.reason` ve `health.degradedSince` alanları, kanal kartlarındaki badge/tooltip metinlerini güncellerken `transportFallbacks.byChannel[].lastReason` değeri en son TCP↔UDP geçişinin nedenini belirtir.

Yalnızca belirli metrik bölümlerini tüketmek için `metrics` sorgu parametresiyle SSE'yi daraltabilirsiniz. Örneğin sadece ses ve retention metriklerini dinlemek için aşağıdaki komutu çalıştırabilirsiniz; ffmpeg istatistikleri bu akışta gönderilmez:

```bash
curl -N "http://localhost:3000/api/events/stream?metrics=audio,retention"
```

Dashboard filtreleri ve REST uç noktaları, kanalları case-insensitive olarak normalize eder. `channel` sorgu parametresine `microphone`, `AUDIO:MICROPHONE` veya `Video:Lobby` yazmanız fark etmez; Guardian `audio:microphone` ve `video:lobby` kimliklerine dönüştürerek aynı olayları döndürür. Prefixsiz ses kanallarını denemek için `curl "http://localhost:3000/api/events?channel=microphone"` komutu `audio:microphone` kanalına ait kayıtları listeleyecektir.

## Metrikler ve sağlık çıktısı
`pnpm tsx src/cli.ts --health` veya `guardian daemon status --json` komutları, aşağıdaki gibi bir metrik özeti döndürür:

- `metrics.logs.byLevel.warn`, `metrics.logs.byLevel.error`: Pino log seviyelerine göre sayaçlar. `metrics.logs.histogram.error` değeri, hata loglarının kaç kez üretildiğini gösterir.
- `metrics.suppression.histogram.historyCount`: Bastırılan olayların tarihçe sayısına göre histogram; `cooldownMs`, `cooldownRemainingMs` ve `windowRemainingMs` alt anahtarları suppression pencerelerinin süre dağılımını raporlar.
- `pipelines.ffmpeg.restartHistogram.delay` ve `pipelines.audio.restartHistogram.attempt`: Watchdog yeniden denemeleri için gecikme ve deneme histogramları. `pipelines.ffmpeg.jitterHistogram` değerleri RTSP geri çekilme jitter'ını raporlar.
- `pipelines.audio.deviceDiscovery.byReason`, `pipelines.audio.deviceDiscovery.byFormat` ve `pipelines.audio.deviceDiscoveryByChannel`: Mikrofon fallback zincirlerinin hangi platformlarda denendiğini ve hangi formatların keşfedildiğini gösterir.
- `metrics.pipelines.ffmpeg.transportFallbacks.total`, `metrics.pipelines.ffmpeg.transportFallbacks.byReason` ve `metrics.pipelines.ffmpeg.transportFallbacks.byChannel`: RTSP transport ladder'ının hangi kanallarda TCP↔UDP geçiş yaptığını ve toplam kaç kez denendiğini gösterir; Prometheus çıktısında aynı sayaçlar `guardian_transport_fallback_total` metric adıyla yer alır.
- `metrics.retention.totals.diskSavingsBytes`: Son retention çalışmasında raporlanan disk tasarrufunu bayt cinsinden bildirir ve Prometheus üzerinden `guardian_retention_disk_savings_bytes_total` olarak dışa aktarılır.
- `detectors.motion.counters.backoffActivations`, `detectors.light.counters.backoffSuppressedFrames`: Debounce/backoff sayaçları.

`registerHealthIndicator` ile özel health check ekleyebilir, `collectHealthChecks` çağrısında `metrics.logs.byLevel.error` veya `metrics.suppression.lastEvent` gibi alanlara erişebilirsiniz.
Guardian, Prometheus entegrasyonları için log seviyeleri, pipeline jitter dağılımları ve dedektör sayaçlarını ayrı yüzeyler
olarak dışa aktarır. Aşağıdaki örnekler, CLI yerine `pnpm exec tsx` ile doğrudan Node.js üzerinden metrikleri elde etmeyi
gösterir:

```bash
# Log seviyelerini ve son hata zaman damgasını gauge olarak alın
pnpm exec tsx -e "import metrics from './src/metrics/index.ts';
console.log(metrics.exportLogLevelCountersForPrometheus({ labels: { instance: 'lab-node' } }));"

# Pipeline jitter/deneme histogramlarını Prometheus formatında yazdırın
pnpm exec tsx -e "import metrics from './src/metrics/index.ts';
console.log(metrics.exportPipelineRestartHistogram('ffmpeg', 'jitter', {
  metricName: 'guardian_ffmpeg_restart_jitter_ms',
  labels: { pipeline: 'ffmpeg', region: 'lab' }
}));"

# Dedektör sayaç ve gauge değerlerini inceleyin
pnpm exec tsx -e "import metrics from './src/metrics/index.ts';
console.log(metrics.exportDetectorCountersForPrometheus({ labels: { instance: 'lab-node' } }));"
```

Çıktıda `guardian_log_level_total`, `guardian_log_level_detector_total`,
`guardian_ffmpeg_restart_jitter_ms_bucket`, `guardian_ffmpeg_restarts_total_bucket` ve
`guardian_detector_counter_total` gibi metrikleri göreceksiniz. `guardian_log_last_error_timestamp_seconds`
satırı, son hata logunun Unix zaman damgasını bildirir.

## Video ve ses boru hatları
Video için ffmpeg süreçleri, `src/video/source.ts` altında watchdog tarafından izlenir. RTSP bağlantıları `tcp→udp→tcp` sıralı transport fallback zincirini uygular; `transport-change` logları ve `metrics.pipelines.ffmpeg.transportFallbacks.total` alanı kaç kez geri düşüş yaşandığını gösterir. `Audio source recovering (reason=ffmpeg-missing|stream-idle)` satırlarını loglarda görüyorsanız, fallback listesi üzerinde iterasyon yapıldığını bilirsiniz. Her yeniden başlatma `pipelines.ffmpeg.byReason`, `pipelines.ffmpeg.restartHistogram.delay` ve `pipelines.ffmpeg.jitterHistogram` alanlarını artırır.

Ses tarafında anomaly dedektörü, RMS ve spectral centroid ölçümlerini `audio.anomaly` konfigürasyonu doğrultusunda toplar. `metrics.detectors['audio-anomaly'].latencyHistogram` değeri, pencere hizasının doğruluğunu teyit eder. Sustained sessizlikte devre kesici tetiklendiğinde `pipelines.audio.watchdogBackoffByChannel` ve `pipelines.audio.restartHistogram.delay` artışları görülebilir.

## Docker ile çalışma
`Dockerfile` çok aşamalı build tanımlar. İmajı inşa etmek için:

```bash
pnpm run build
docker build -t guardian:latest .
```

Docker healthcheck'i `guardian daemon health` ve `guardian daemon status --json` komutlarına dayanır ve log seviyeleri konteyner içinde `guardian log-level set warn` ile güncellenebilir. Persistans için `data/` ve `archive/` dizinlerini volume olarak bağlamayı unutmayın.

## Offline kullanım
- RTSP kameralarla çalışan saha kutularında guardian imajını ve `models/` klasörünü önceden kopyalayın. `pnpm install --offline` komutunu kullanabilmek için `pnpm fetch` ile bağımlılık önbelleğini hazırlayın.
- İnternet erişimi olmadan sağlık durumunu doğrulamak için `pnpm tsx scripts/healthcheck.ts --pretty` komutu hem Docker hem systemd senaryolarında aynı JSON çıktısını üretir; `status: "ok"` satırı ve `metricsSummary.pipelines.watchdogRestarts` alanları bağlantı stabilitesini gösterir.
- Edge cihazı yeniden çevrimiçi olduğunda `pnpm exec tsx -e "import metrics from './src/metrics/index.ts'; console.log(metrics.exportLogLevelCountersForPrometheus({ labels: { site: 'edge-1' } }))"` komutu ile tamponda tutulan log metriklerini Prometheus uyumlu formatta dışa aktarabilirsiniz.
- `guardian retention run --config` komutuyla arşiv bakımını elle tetikleyerek uzun süre çevrimdışı kalan cihazlarda disk tüketimini kontrol altında tutun; `vacuum=auto (run=on-change)` özetinde `prunedArchives` alanını izleyin.

## systemd servisi
`deploy/guardian.service` ve `deploy/systemd.service` dosyaları, CLI'nin `start`, `stop` ve `health` komutlarını kullanan örnek unit tanımları içerir. `journalctl -u guardian` çıktısında `metrics.logs.byLevel.error` artışını veya `pipelines.audio.watchdogBackoffByChannel` değişikliklerini izleyebilirsiniz.

## Operasyon kılavuzu
Guardian'ı 7/24 çalıştırırken yapılması gereken rutin kontroller ve bakım adımları için [Operasyon kılavuzu](docs/operations.md)
dokümanını takip edin. Bu kılavuzda `guardian daemon health --json` çıktısındaki `watchdogRestarts` sayaçlarını nasıl yorumlayacağı,
`pnpm exec tsx src/tasks/retention.ts --run now` komutuyla bakım tetiklemenin yolları ve dedektör gecikme histogramlarının Prometheus
üzerinden nasıl dışa aktarılacağı gibi örnekler yer alır. README'deki Kurulum, Guardian'ı Çalıştırma ve Sorun giderme bölümleri bu
operasyonel rehber ile birlikte okunmalıdır.

## Sorun giderme
| Belirti | Muhtemel neden | Önerilen komut |
| --- | --- | --- |
| `status: "degraded"` veya artan `metrics.logs.byLevel.error` değerleri | Dedektörler hata üretiyor veya log seviyesi çok düşük | `pnpm tsx scripts/healthcheck.ts --health` çıktısını ve `guardian log-level set debug` komutunu kontrol edin |
| `pipelines.ffmpeg.watchdogRestartsByChannel` hızla artıyor | RTSP bağlantısı kopuyor ya da jitter yüksek | `guardian daemon restart --channel video:lobby` ve `pnpm exec tsx src/cli.ts daemon status --json` |
| `metrics.pipelines.ffmpeg.transportFallbacks.total` artıyor veya `transport-change` logları sıklaşıyor | TCP↔UDP transport zinciri sürekli geri düşüyor | `guardian daemon restart --transport video:lobby` ile kanalın taşıyıcı sırasını sıfırlayın ve `guardian daemon status --json` çıktısındaki `pipelines.ffmpeg.transportFallbacks.byChannel` ile `metricsSummary.pipelines.transportFallbacks.video.byChannel[].lastReason` alanlarını izleyin |
| `Audio source recovering (reason=ffmpeg-missing)` mesajları | Mikrofon fallback listesi tükeniyor veya cihaz keşfi zaman aşımına düşüyor | `guardian audio devices --json` ve `pnpm tsx scripts/healthcheck.ts --ready` |

- `guardian daemon status --json` veya `pnpm exec tsx src/cli.ts --health` çıktısında `metrics.logs.byLevel.error` hızla artıyorsa log seviyesini `guardian log-level set debug` ile yükseltip detaylı inceleme yapın.
- `guardian daemon pipelines list --json` çıktısındaki `pipelines.ffmpeg.channels`, `pipelines.ffmpeg.degraded` ve `pipelines.audio.degraded` alanlarını takip ederek hangi kanalların watchdog tarafından sınırlandığını görün; bir kanal manuel temizlik gerektirdiğinde `guardian daemon pipelines reset --channel video:lobby` komutu çalışan guard runtime'ına watchdog sıfırlaması gönderir ve `metrics.pipelines.ffmpeg.byChannel['video:lobby'].health.severity` değerini `none` seviyesine çeker.
- `pipelines.ffmpeg.watchdogBackoffByChannel` veya `pipelines.ffmpeg.restartHistogram.delay` değerleri sürekli yükseliyorsa RTSP bağlantılarını kontrol edin; `restartDelayMs`, `restartMaxDelayMs` ve `restartJitterFactor` parametrelerini düşürmek backoff süresini azaltır.
- `Audio source recovering (reason=ffmpeg-missing|stream-idle)` satırları kesintisiz devam ediyorsa `audio.micFallbacks` listesinde çalışan bir cihaz kalmamış olabilir.
- `Audio source recovering (reason=ffmpeg-missing)` hataları devre kesiciyi tetiklemişse `guardian daemon restart --channel audio:microphone` komutunu çalıştırarak `audio:microphone` kanalının devre kesicisini sıfırlayın. Komut başarılı olduğunda loglar manuel devre sıfırlamasını, metrikler ise `pipelines.audio.byReason['manual-circuit-reset']` artışını rapor eder; ardından ffmpeg ikililerinin PATH'te erişilebilir olduğunu `ffmpeg -version` ile doğrulayın.
- `metrics.suppression.histogram.cooldownRemainingMs` ve `metrics.suppression.histogram.windowRemainingMs` değerleri yüksekse `events.suppression.rules` altındaki `suppressForMs`, `timelineTtlMs` veya `rateLimit.cooldownMs` değerlerini gözden geçirin; TTL ne kadar kısa olursa geçmiş event kimlikleri o kadar hızlı temizlenir.
- CLI komutları beklenen çıktıyı vermiyorsa `guardian daemon status --json` ve `pnpm exec tsx src/cli.ts status --json` komutlarının exit kodunun 0 olduğundan emin olun; farklı bir config dosyasını `--config` parametresiyle doğrulayabilirsiniz. `guardian daemon ready` çıktısı `"status":"ready"` değilse bir shutdown hook'u blokluyor olabilir.
- `pipelines.ffmpeg.watchdogRestarts` veya `pipelines.ffmpeg.watchdogRestartsByChannel` değerleri artıyorsa [Operasyon kılavuzu](docs/operations.md)
  içindeki devre kesici sıfırlama adımlarını uygulayın ve `guardian daemon hooks --reason watchdog-reset` komutuyla manuel toparlanmayı deneyin.

