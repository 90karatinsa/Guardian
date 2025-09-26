# Guardian

Guardian, ağ kameraları ve ses girişleri üzerinden gelen olayları normalize edip tek bir metrik ve uyarı yüzeyinde toplayan, örnek dashboard ile izlenebilen küçük bir gözetleme iskeletidir.

## İçindekiler
- [Gereksinimler](#gereksinimler)
- [Kurulum](#kurulum)
- [Konfigürasyon](#konfigürasyon)
  - [RTSP ve çoklu kamera](#rtsp-ve-çoklu-kamera)
  - [Retention ve arşiv döngüsü](#retention-ve-arşiv-döngüsü)
- [Guardian'ı çalıştırma](#guardiannı-çalıştırma)
- [Dashboard](#dashboard)
- [Metrikler ve sağlık çıktısı](#metrikler-ve-sağlık-çıktısı)
- [Video ve ses boru hatları](#video-ve-ses-boru-hatları)
- [Docker ile çalışma](#docker-ile-çalışma)
- [systemd servisi](#systemd-servisi)
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

`pnpm tsx src/cli.ts --health` çıktısı `status: "ok"` satırını ve `metrics.histograms.pipeline.ffmpeg.restarts`,
`metrics.histograms.pipeline.audio.restarts` gibi anahtarları içerir; histogramlar sıfır değerlerle bile görünür.

Bu adımlar tamamlandıktan sonra Guardian boru hattını çalıştırmaya hazırsınız.

## Konfigürasyon
Guardian, `config/default.json` dosyasını okuyarak video, ses, dedektör ve retention politikalarını yapılandırır. Hot reload mekanizması, dosya değişikliklerini izler ve geçersiz JSON bulunduğunda son bilinen iyi yapılandırmaya geri döner.

```jsonc
{
  "video": {
    "framesPerSecond": 5,
    "ffmpeg": {
      "rtspTransport": "tcp",
      "idleTimeoutMs": 6000,
      "startTimeoutMs": 4000,
      "watchdogTimeoutMs": 8000,
      "forceKillTimeoutMs": 5000,
      "restartDelayMs": 500,
      "restartMaxDelayMs": 5000,
      "restartJitterFactor": 0.2
    },
    "cameras": [
      {
        "id": "lobby",
        "channel": "video:lobby",
        "input": "rtsp://192.168.1.10/stream1",
        "framesPerSecond": 5,
        "motion": {
          "diffThreshold": 18,
          "debounceFrames": 2,
          "backoffFrames": 4,
          "noiseMultiplier": 1.4,
          "noiseSmoothing": 0.2
        },
        "person": {
          "score": 0.35,
          "maxDetections": 3,
          "minIntervalMs": 2000
        },
        "ffmpeg": {
          "idleTimeoutMs": 7000,
          "watchdogTimeoutMs": 9000,
          "restartDelayMs": 500,
          "restartMaxDelayMs": 6000
        }
      }
    ]
  },
  "audio": {
    "idleTimeoutMs": 4000,
    "startTimeoutMs": 3000,
    "watchdogTimeoutMs": 7000,
    "restartDelayMs": 2000,
    "restartMaxDelayMs": 6000,
    "restartJitterFactor": 0.3,
    "forceKillTimeoutMs": 4000,
    "micFallbacks": {
      "linux": [
        { "device": "hw:1,0" },
        { "device": "hw:2,0" }
      ]
    },
    "anomaly": {
      "minTriggerDurationMs": 2500,
      "rmsWindowMs": 1200,
      "centroidWindowMs": 1200,
      "thresholds": {
        "day": { "rms": 0.28, "centroidJump": 180 },
        "night": { "rms": 0.35, "centroidJump": 220 }
      }
    }
  },
  "events": {
    "suppression": {
      "rules": [
        {
          "id": "lobby-motion-cooldown",
          "channel": "video:lobby",
          "detector": "motion",
          "suppressForMs": 30000,
          "maxEvents": 3,
          "reason": "cooldown window"
        }
      ]
    },
    "retention": {
      "retentionDays": 14,
      "archiveDir": "snapshots",
      "vacuum": "auto"
    }
  }
}
```

Varsayılan dosya, örnek video akışını PNG karelere dönüştüren test kamerasını içerir. Üretimde kendi kameralarınızı tanımlamak için aşağıdaki bölümlere göz atın.

### RTSP ve çoklu kamera
- `video.cameras` dizisine her kamera için benzersiz bir nesne ekleyin. `input` alanı RTSP, HTTP MJPEG, yerel dosya veya `pipe:` önekiyle bir ffmpeg komutunu destekler.
- `channel` değeri, olayların EventBus üzerinde yayınlanacağı kanalı belirler (`video:lobby`, `video:parking` gibi). Dashboard filtreleri ve metriklerdeki `pipelines.ffmpeg.byChannel` haritası bu alanı kullanır.
- `ffmpeg` altındaki `idleTimeoutMs`, `watchdogTimeoutMs`, `startTimeoutMs`, `forceKillTimeoutMs`, `restartDelayMs`, `restartMaxDelayMs` ve `restartJitterFactor` seçenekleri boru hattının yeniden deneme davranışını ve watchdog zamanlamalarını kontrol eder.
- Kamera bazlı `motion` ve `person` blokları debounce/backoff gibi gürültü bastırma katsayılarını içerir; aynı dosyada birden fazla kamera tanımlayarak her kanal için farklı eşikler uygulayabilirsiniz.
- Her kamera için tanımlanan `channel` değerinin `video.channels` altında karşılığı bulunmalıdır. Ayrıca `audio.micFallbacks` dizilerindeki `device` alanları boş bırakılamaz ve oran sınırlayıcı (`rateLimit`) tanımlarında `perMs` değeri `count` değerinden küçük olamaz; aksi halde konfigürasyon yüklenmez.
- Opsiyonel `audio.channel` alanını tanımlayarak ses mikserinin hangi EventBus kanalına bağlanacağını belirleyebilirsiniz. Aynı kanalın birden fazla kamera ile paylaşılması engellenir; yapılandırma yeniden yüklendiğinde çakışmalar uyarı olarak CLI ve loglarda görünür.

### Ses fallback ve anomaly ayarları
Guardian, mikrofon fallback zincirlerini ve anomaly dedektör eşiklerini çalışma anında güncelleyebilir:
- `audio.micFallbacks`, platform anahtarları altında `format` ve `device` bilgilerini içeren fallback listeleri kabul eder. Bir cihaz başarısız olduğunda sonraki aday denenir; yapılandırma dosyası kaydedildiğinde aktif boru hattı durdurulmadan yeni liste devreye girer.
- `audio.channel` alanı tanımlanmamışsa varsayılan `audio:microphone` kanalı kullanılır. Birden fazla örneği aynı kanala bağlamak istiyorsanız farklı değerler atayın.
- `audio.anomaly` blokları içinde `rmsWindowMs`, `centroidWindowMs`, `minTriggerDurationMs` veya `thresholds` alanlarını değiştirmeniz halinde dedektör tamponları sıfırlanır ve yeni pencereler hemen uygulanır. `nightHours` aralığı güncellendiğinde profil geçişi bir sonraki karede tetiklenir.
- Fallback ve eşik değişikliklerinin etkisini `guardian status --json` komutuyla veya `/api/metrics/pipelines` uç noktasından alınan metriklerle doğrulayabilirsiniz.

### Retention ve arşiv döngüsü
Guardian, veritabanı ve snapshot dizinlerini periyodik olarak temizleyen bir retention görevine sahiptir:
- `events.retention.retentionDays`: SQLite üzerindeki olay kayıtlarının kaç gün saklanacağını belirtir. Silinen satır sayısı `VACUUM`/`VACUUM FULL` adımlarının tetiklenip tetiklenmeyeceğini belirler.
- `events.retention.archiveDir`, `events.retention.maxArchivesPerCamera` ve `events.retention.snapshot.maxArchivesPerCamera`: Snapshot arşivleri tarih bazlı klasörlerde toplanır (`snapshots/2024-03-18/` gibi). Limit aşıldığında en eski klasörler taşınır ve silinir. `snapshot.maxArchivesPerCamera` anahtarı `snapshot.perCameraMax` ile eşdeğer olup kamera kimliği → kota eşlemesini kabul eder; tanımlanmadığında üst düzey `maxArchivesPerCamera` değeri kullanılır.
- Görev her çalıştırmada loglara `Retention task completed` satırını bırakır; `archivedSnapshots` değeri 0’dan büyükse arşiv döngüsünün devrede olduğu anlaşılır. `vacuum.run` değeriniz `on-change` ise, önceki çalıştırmada hiçbir satır/snapshot temizlenmediyse VACUUM adımı atlanır.

Bakım sırasında retention politikasını manuel olarak tetiklemek için artık doğrudan CLI komutunu kullanabilirsiniz:

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
# Guard boru hattını başlatır (arka planda çalışır)
pnpm start

# Çalışan sürecin sağlık özetini JSON olarak yazdırır (Docker/systemd healthcheck tarafından kullanılır)
guardian status --json

# Sağlık çıktısının eski kısa yolu
guardian health

# Graceful shutdown tetikler
guardian stop

# Servis durumunu exit kodlarıyla raporlar
guardian status

# Tek seferlik retention bakımı
guardian retention run
```

Guardian log düzeyini çalışma anında değiştirmek için `guardian log-level` ailesini kullanabilirsiniz:

```bash
# Geçerli log seviyesini yazdırır ("guardian log-level" kısa yolu da aynı çıktıyı üretir)
guardian log-level get

# Daha ayrıntılı loglama için seviyi günceller
guardian log-level set debug
```

- `guardian status --json` çıktısı `metrics` anlık görüntüsüne ek olarak `runtime.pipelines.videoChannels`, `runtime.pipelines.audioChannels` ve her boru hattının yeniden başlatma sayaçlarını (`videoRestarts`, `audioRestarts`) içerir. Ayrıca `application.shutdown` alanında son kapanış nedeni, sinyali ve hook özetleri raporlanır. Sağlık kodları; `0=ok`, `1=degraded`, `2=starting`, `3=stopping` olarak döner.
- `guardian health` komutu aynı JSON gövdesini döndürmeye devam eder ancak yeni kurulamlarda `guardian status --json` tercih edilmelidir.

Örnek bir sağlık çıktısı aşağıdaki gibidir:

```jsonc
{
  "status": "ok",
  "state": "idle",
  "application": {
    "name": "guardian",
    "version": "0.0.0",
    "shutdown": {
      "lastAt": null,
      "lastReason": null,
      "lastSignal": null,
      "lastError": null,
      "hooks": []
    }
  },
  "runtime": {
    "pipelines": {
      "videoChannels": 0,
      "audioChannels": 0,
      "videoRestarts": 0,
      "audioRestarts": 0
    }
  },
  "metrics": {
    "logs": {
      "byLevel": {},
      "histogram": {}
    },
    "pipelines": {
      "ffmpeg": {
        "restarts": 0,
        "attempts": {},
        "delayHistogram": {},
        "attemptHistogram": {},
        "byChannel": {}
      },
      "audio": {
        "restarts": 0,
        "attempts": {},
        "delayHistogram": {},
        "attemptHistogram": {}
      }
    }
  }
}
```

`guardian status` komutu ise kısa bir özet döndürür:

```text
Guardian status: idle
Health: ok
```

Servis arka planda çalışırken logları `pnpm exec tsx src/cli.ts status --json` çıktısı ve `logs/guardian.log` dosyası üzerinden takip edebilirsiniz.

### REST API örnekleri
HTTP sunucusu (`pnpm exec tsx src/server/http.ts`) aşağıdaki uç noktaları sağlar:

```bash
# Son olayları listeleyin
curl -s http://localhost:3000/api/events?limit=5 | jq '.[].detector'

# Belirli bir olayın snapshot'ını indirin
curl -o snapshot.jpg http://localhost:3000/api/events/<event-id>/snapshot

# Canlı SSE akışını test edin
curl -N http://localhost:3000/api/events/stream
```

REST API cevapları, pose tahminleri ve suppress edilmiş olayları `metrics.suppression.rules` alanlarıyla birlikte döndürerek dashboard’da kullanılan aynı veriyi sunar.

## Platform farklılıkları
Platform farklılıkları (ALSA/CoreAudio/Video4Linux) Guardian’ın mikrofon ve kamera kaynaklarını nasıl yönettiğini doğrudan etkiler:

- **Linux (ALSA + Video4Linux2)**: `audio.micFallbacks.linux` listesine `hw:1,0` veya `plughw:2,0` gibi ALSA tanımlayıcıları ekleyin.
  Video tarafında `Video4Linux2` cihazları (`/dev/video0`) ffmpeg tarafından okunur; `v4l2-ctl --list-devices` komutu mevcut girişleri
  listeler. `sudo apt-get install -y ffmpeg alsa-utils v4l-utils` paketleri eksik sürücüleri tamamlar ve `guardian log-level set trace`
  komutu ayrıntılı hata ayıklama sağlar.
- **macOS (CoreAudio)**: `audio.micFallbacks.macos` altında `Built-in Microphone` gibi cihaz adları kullanılır. Homebrew üzerinden
  `brew install ffmpeg` ile sağlanan ffmpeg, CoreAudio kaynaklarını otomatik tanır. Sorun giderirken `guardian log-level set debug`
  komutu ve `pnpm tsx src/cli.ts --health` çıktısı (ör. `metrics.histograms.pipeline.audio.restarts`) hızlı geri bildirim verir.
- **Windows (DirectShow/WASAPI)**: `audio.micFallbacks.win32` öğelerini `audio="Microphone (USB Audio Device)"` biçiminde
  yazabilirsiniz. PATH’e ffmpeg eklenmediğinde CLI loglarında `Audio source recovering (reason=ffmpeg-missing)` ve `Video source
  recovering (reason=ffmpeg-missing)` satırları görünür; `guardian log-level get` ve `guardian log-level set warn` komutlarıyla
  seviye değiştirilebilir.

Her platformda `pnpm tsx src/cli.ts --health` komutu `status: "ok"` satırıyla birlikte `metrics.histograms.pipeline.ffmpeg.restarts`
ve `metrics.histograms.pipeline.audio.restarts` anahtarlarının çıktıda yer aldığını doğrular; bu bilgiler Docker veya systemd ortamlarında
hazırlık kontrollerine entegre edilebilir.

## Dashboard
`pnpm exec tsx src/server/http.ts` komutu HTTP sunucusunu başlatır. Ardından `http://localhost:3000` adresine giderek dashboard’u açabilirsiniz:

- Üstteki filtre alanları kaynak, kamera veya şiddete göre REST API istekleri yapar (`/api/events?camera=video:lobby`). Canlı akıştan gelen kanallar ve yüz kayıtları, filtre panelinin altındaki rozetlere (`Channels` bölümündeki onay kutuları) otomatik eklenir.
- Sağ taraftaki snapshot önizlemesi seçilen olayın en güncel görüntüsünü `/api/events/<id>/snapshot` üzerinden yükler ve görüntünün ait olduğu kanal bilgisi `data-channel` niteliğinde tutulur.
- SSE akışı (`/api/events/stream`) heartbeat ile açık tutulur; bağlantı koptuğunda istemci otomatik yeniden bağlanır ve son filtreleri uygular. Aynı akış, `faces` olaylarıyla yüz kayıtlarının etiketlerini de yayınlar.

Bu sayfa, guard’ın gerçek zamanlı olaylarını izlemenin en hızlı yoludur.

## Metrikler ve sağlık çıktısı
Guardian tüm metrikleri JSON olarak üretir:

- CLI `--health` komutu saniyelik özet verir.
- HTTP sunucusu `/api/metrics` uç noktasıyla Prometheus uyumlu bir çıktıyı paylaşacak şekilde genişletilebilir.
- `metrics.events` altında dedektör başına tetik sayıları, `metrics.detectors.pose.counters.forecasts` / `metrics.detectors.face.counters.matches` / `metrics.detectors.object.counters.threats` gibi değerler gerçek zamanlı çıkarımları raporlar.
- `metrics.latency.detector.person` altında histogramlar, `metrics.pipelines.ffmpeg.byChannel['video:lobby']` altında kanal bazlı yeniden başlatma sayaçları bulunur.
- `metrics.histograms.pipeline.ffmpeg.restarts` ve `metrics.histograms.detector.motion.counter.detections` anahtarları, boru hattı yeniden başlatma denemeleri ile dedektör sayaçlarının dağılımını gösterir; bu alanlar `guardian log-level set debug` sonrası artan olaylarda dolmaya devam eder.
- Log düzeyleri `metrics.logs.byLevel.error` ve `metrics.logs.byDetector.motion.warning` gibi anahtarlarla etiketlenir; suppression kuralları için `metrics.suppression.rules['rule-id'].total` değeri takip edilir.

## Video ve ses boru hatları
- `pnpm tsx src/run-video-detectors.ts` komutu test videosunu çalıştırır ve motion/light/person dedektörlerini tetikleyerek snapshot üretir. Kare akışı 5 saniye durursa loglarda `Video source reconnecting (reason=watchdog-timeout)` mesajı görülür; artan gecikmeli yeniden denemeler `delayMs` alanında raporlanır.
- `pnpm tsx src/run-audio-detector.ts` komutu platforma özel ffmpeg argümanlarıyla mikrofonu okur. Cihaz bulunamadığında veya akış sessiz kaldığında `Audio source recovering (reason=ffmpeg-missing|stream-idle)` logları üretilir, watchdog zamanlayıcıları tetiklenir ve metriklerde ilgili kanalın yeniden deneme sayaçları artar.
- FFmpeg kaynağı ardışık start/watchdog hatalarında `circuit-breaker` korumasına geçer. CLI’nin `guardian status --json` çıktısında `pipelines.ffmpeg.lastRestart.reason` alanı `circuit-breaker` olduğunda yeni süreç başlatılmaz; `pipelines.ffmpeg.lastWatchdogJitterMs` ve `pipelines.ffmpeg.watchdogBackoffByChannel[channel]` değerleri artan bekleme sürelerini gösterir.
- Ses boru hattı için aynı devre kesici mantığı `pipelines.audio.lastRestart.reason`, `pipelines.audio.watchdogBackoffByChannel` ve `pipelines.audio.byChannel[channel].watchdogBackoffMs` alanlarında izlenebilir; loglarda `Audio source fatal (reason=circuit-breaker)` satırı görünür.

## Docker ile çalışma
Proje kökünde çok aşamalı bir Dockerfile bulunur:

```bash
docker build -t guardian:latest .
docker run --rm -p 3000:3000 -v $(pwd)/config:/app/config guardian:latest
```

- İmaj derlemesi sırasında `ffmpeg` ve `onnxruntime-node` varlığı doğrulanır; eksik olduklarında build başarısız olur. Runner katmanı `pnpm start` ile CLI’yi başlatır, `SIGTERM/SIGQUIT` sinyallerini yakalayıp graceful shutdown tetikler ve healthcheck `pnpm exec tsx src/cli.ts status --json` komutunu çağırarak `status: "ok"` bekler.
- Konfigürasyon ve model dosyalarını volume olarak bağlayın: `-v $(pwd)/models:/app/models -v $(pwd)/snapshots:/app/snapshots`. Böylece container yeniden başladığında guard geçmişi ve ONNX modeli korunur.
- Docker healthcheck çıktısı `guardian status --json` ile uyumlu olduğundan Kubernetes veya docker-compose liveness tanımlarına doğrudan eklenebilir. `docker inspect --format='{{json .State.Health}}' guardian` ile son sağlık denetimlerini görebilirsiniz.

Guard’ı donanım hızlandırma veya RTSP kimlik bilgileriyle çalıştırmak için `config/` klasörünü volume olarak bağlayabilirsiniz.

## systemd servisi
- `deploy/systemd.service` unit dosyası aşağıdaki adımlarla devreye alınabilir (çalışan servis `guardian stop` komutuyla ve `SIGTERM/SIGQUIT` sinyalleriyle aynı shutdown hook’larını çağırır):

```bash
sudo cp deploy/systemd.service /etc/systemd/system/guardian.service
sudo systemctl daemon-reload
sudo systemctl enable --now guardian
```

Servis, ortam değişkenlerini unit dosyasındaki `Environment=` satırlarından alır ve `ExecStop=/usr/bin/env pnpm exec tsx src/cli.ts stop` satırı sayesinde CLI’nın graceful shutdown yolunu kullanır.

`systemctl status guardian` çıktısında `Main PID` bölümündeki süreç Guardian CLI’yı gösterir. Unit dosyası `KillSignal=SIGTERM` kullanır ve `TimeoutStopSec=30` değerine kadar shutdown hook’larının tamamlanmasını bekler. Journal’da sağlık tetiklerinin sonuçlarını `journalctl -u guardian` komutuyla takip edebilirsiniz.

`ExecReload` satırı `guardian status --json` komutunu çağırarak son sağlık anlık görüntüsünü systemd journal'ına yazar; böylece Docker ile aynı JSON formatında liveness denetimleri alınabilir.

## Sorun giderme
### ffmpeg / onnxruntime hatası
1. Sistem paketlerini kurun: Debian/Ubuntu için `sudo apt-get install -y ffmpeg libgomp1`, macOS için `brew install ffmpeg`, Windows için resmi ffmpeg paketini PATH’e ekleyin.
2. ONNX modeli için doğru mimariye uygun dosyayı indirin (`models/yolov8n.onnx`). Yanlış bir dosya `onnxruntime: Failed to load model` hatasına yol açar.
3. Değişikliklerden sonra `pnpm install` komutunu yeniden çalıştırıp CLI’yi `pnpm exec tsx src/cli.ts status --json` ile doğrulayın; sağlık çıktısında `status: "ok"` ve `application.shutdown.hooks` bölümünde hook sonuçları görülmelidir.
4. ffmpeg hâlâ bulunamazsa `guardian log-level set debug` veya `guardian log-level set trace` komutlarıyla log seviyesini yükseltip `pnpm tsx src/cli.ts --health` çıktısındaki `metrics.histograms.pipeline.ffmpeg.restarts` değerlerini kontrol edin; artış, yeniden deneme döngülerinin devam ettiğini gösterir.

### RTSP akışı bağlanmıyor
- `ffmpeg -rtsp_transport tcp -i rtsp://...` komutunu elle çalıştırarak ağ gecikmesini test edin.
- Konfigürasyonda `ffmpeg.inputArgs` içerisine `-stimeout 5000000` gibi değerler ekleyerek bağlantı süresini kısaltın.
- Watchdog yeniden bağlanmayı tetikliyorsa loglar ve `pipelines.ffmpegRestarts` metriği artacaktır; çok sık artıyorsa ağ veya kamera ayarlarını gözden geçirin.
- RTSP sunucusunun temel kimlik doğrulaması gerekiyorsa URL'yi `rtsp://user:pass@host/stream` şeklinde yazın ve parolada özel karakter varsa URL encode edin.
- GPU hızlandırmalı kartlar için `ffmpeg.inputArgs` kısmına `-hwaccel cuda` gibi argümanlar ekleyerek sistem kaynaklarını dengeleyebilirsiniz.

### Retention beklenen dosyaları silmiyor
- `config/default.json` içindeki `retention` alanında gün sayısını ve `maxArchives` değerini doğrulayın.
- `pnpm tsx src/run-guard.ts --max-runtime 60000` komutuyla guard’ı kısa süreliğine çalıştırarak loglarda `Retention task completed` satırını arayın.
- Snapshot klasörlerinin tarih bazlı (`YYYY-MM-DD`) olarak oluştuğunu ve eski klasörlerin silindiğini denetleyin.

### Dashboard boş görünüyor
- HTTP sunucusunu `pnpm exec tsx src/server/http.ts` komutuyla başlattığınızdan emin olun.
- Tarayıcı geliştirici araçlarında SSE isteğinin (`/api/events/stream`) açık olduğundan emin olun. CORS veya reverse proxy kullanıyorsanız SSE başlıklarını (`Cache-Control: no-cache`, `Connection: keep-alive`) iletmeyi unutmayın.
- Filtre alanlarını temizlemek için dashboard’daki **Reset** butonuna tıklayın; yanlış kanal/şiddet filtresi genellikle boş listeye sebep olur.

Guardian ile ilgili geri bildirimlerinizi veya hata raporlarınızı Issues sekmesinden paylaşabilirsiniz. İyi gözlemler!
