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

İlk çalıştırmada Guardian, örnek konfigürasyon ve veri dizinlerini otomatik oluşturur. `config/default.json` dosyası guard'ın varsayılan akışını tanımlar.

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
    "cameras": {
      "lobby": {
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
    }
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
          "windowMs": 30000,
          "maxEvents": 3
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
- `video.cameras` nesnesine her kamera için benzersiz bir anahtar ekleyin. `input` alanı RTSP, HTTP MJPEG, yerel dosya veya `pipe:` önekiyle bir ffmpeg komutunu destekler.
- `channel` değeri, olayların EventBus üzerinde yayınlanacağı kanalı belirler (`video:lobby`, `video:parking` gibi). Dashboard filtreleri ve metriklerdeki `pipelines.ffmpeg.byChannel` haritası bu alanı kullanır.
- `ffmpeg` altındaki `idleTimeoutMs`, `watchdogTimeoutMs`, `startTimeoutMs`, `forceKillTimeoutMs`, `restartDelayMs`, `restartMaxDelayMs` ve `restartJitterFactor` seçenekleri boru hattının yeniden deneme davranışını ve watchdog zamanlamalarını kontrol eder.
- Kamera bazlı `motion` ve `person` blokları debounce/backoff gibi gürültü bastırma katsayılarını içerir; aynı dosyada birden fazla kamera tanımlayarak her kanal için farklı eşikler uygulayabilirsiniz.

### Retention ve arşiv döngüsü
Guardian, veritabanı ve snapshot dizinlerini periyodik olarak temizleyen bir retention görevine sahiptir:
- `events.retention.retentionDays`: SQLite üzerindeki olay kayıtlarının kaç gün saklanacağını belirtir. Silinen satır sayısı `VACUUM`/`VACUUM FULL` adımlarının tetiklenip tetiklenmeyeceğini belirler.
- `events.retention.archiveDir` ve `events.retention.maxArchives`: Snapshot arşivleri tarih bazlı klasörlerde toplanır (`snapshots/2024-03-18/` gibi). Limit aşıldığında en eski klasörler taşınır ve silinir.
- Görev her çalıştırmada loglara `Retention task completed` satırını bırakır; `archivedSnapshots` değeri 0’dan büyükse arşiv döngüsünün devrede olduğu anlaşılır.

Retention ayarlarını değiştirip dosyayı kaydettiğinizde hot reload mekanizması yeni değerleri uygular.

## Guardian'ı çalıştırma
Guardian CLI, servis kontrolü ve sağlık kontrollerini yönetir:

```bash
# Guard boru hattını başlatır (arka planda çalışır)
pnpm start

# Çalışan sürecin sağlık özetini JSON olarak yazdırır
pnpm exec tsx src/cli.ts --health

# Graceful shutdown tetikler
pnpm exec tsx src/cli.ts stop

# Servis durumunu exit kodlarıyla raporlar
pnpm exec tsx src/cli.ts status
```

`--health` çıktısı `status`, `events.byDetector.motion`, `pipelines.ffmpeg.byChannel`, `metrics.detectors.pose.counters.forecasts` gibi anahtarları içerir. Sağlık kodları; `0=ok`, `1=degraded`, `2=starting`, `3=stopping` olarak döner ve Docker/systemd healthcheck tarafından kullanılır. Komut satırında `guardian health` alias’ı aynı JSON çıktısını verir.

## Dashboard
`pnpm exec tsx src/server/http.ts` komutu HTTP sunucusunu başlatır. Ardından `http://localhost:3000` adresine giderek dashboard’u açabilirsiniz:

- Üstteki filtre alanları kaynak, kanal veya şiddete göre REST API istekleri yapar (`/api/events?channel=video:lobby`).
- Sağ taraftaki snapshot önizlemesi seçilen olayın en güncel görüntüsünü `/snapshots/<id>.jpg` üzerinden yükler.
- SSE akışı (`/api/events/stream`) heartbeat ile açık tutulur; bağlantı koptuğunda istemci otomatik yeniden bağlanır ve son filtreleri uygular.

Bu sayfa, guard’ın gerçek zamanlı olaylarını izlemenin en hızlı yoludur.

## Metrikler ve sağlık çıktısı
Guardian tüm metrikleri JSON olarak üretir:

- CLI `--health` komutu saniyelik özet verir.
- HTTP sunucusu `/api/metrics` uç noktasıyla Prometheus uyumlu bir çıktıyı paylaşacak şekilde genişletilebilir.
- `metrics.events` altında dedektör başına tetik sayıları, `metrics.detectors.pose.counters.forecasts` / `metrics.detectors.face.counters.matches` / `metrics.detectors.object.counters.threats` gibi değerler gerçek zamanlı çıkarımları raporlar.
- `metrics.latency.detector.person` altında histogramlar, `metrics.pipelines.ffmpeg.byChannel['video:lobby']` altında kanal bazlı yeniden başlatma sayaçları bulunur.
- Log düzeyleri `metrics.logs.byLevel.error` ve `metrics.logs.byDetector.motion.warning` gibi anahtarlarla etiketlenir; suppression kuralları için `metrics.suppression.rules['rule-id'].total` değeri takip edilir.

## Video ve ses boru hatları
- `pnpm tsx src/run-video-detectors.ts` komutu test videosunu çalıştırır ve motion/light/person dedektörlerini tetikleyerek snapshot üretir. Kare akışı 5 saniye durursa loglarda `Video source reconnecting (reason=watchdog-timeout)` mesajı görülür; artan gecikmeli yeniden denemeler `delayMs` alanında raporlanır.
- `pnpm tsx src/run-audio-detector.ts` komutu platforma özel ffmpeg argümanlarıyla mikrofonu okur. Cihaz bulunamadığında veya akış sessiz kaldığında `Audio source recovering (reason=ffmpeg-missing|stream-idle)` logları üretilir, watchdog zamanlayıcıları tetiklenir ve metriklerde ilgili kanalın yeniden deneme sayaçları artar.

## Docker ile çalışma
Proje kökünde çok aşamalı bir Dockerfile bulunur:

```bash
docker build -t guardian:latest .
docker run --rm -p 3000:3000 -v $(pwd)/config:/app/config guardian:latest
```

İmaj derlemesi sırasında `ffmpeg` ve `onnxruntime-node` varlığı doğrulanır; eksik olduklarında build başarısız olur. Runner katmanı CLI’yi başlatır ve healthcheck `pnpm exec tsx src/cli.ts --health` komutunu çağırarak `status: "ok"` bekler.

Guard’ı donanım hızlandırma veya RTSP kimlik bilgileriyle çalıştırmak için `config/` klasörünü volume olarak bağlayabilirsiniz.

## systemd servisi
`deploy/systemd.service` unit dosyası aşağıdaki adımlarla devreye alınabilir:

```bash
sudo cp deploy/systemd.service /etc/systemd/system/guardian.service
sudo systemctl daemon-reload
sudo systemctl enable --now guardian
```

Servis, ortam değişkenlerini unit dosyasındaki `Environment=` satırlarından alır ve `ExecStop=/usr/bin/env pnpm exec tsx src/cli.ts stop` satırı sayesinde CLI’nın graceful shutdown yolunu kullanır.

## Sorun giderme
### ffmpeg / onnxruntime hatası
1. Sistem paketlerini kurun: Debian/Ubuntu için `sudo apt-get install -y ffmpeg libgomp1`, macOS için `brew install ffmpeg`, Windows için resmi ffmpeg paketini PATH’e ekleyin.
2. ONNX modeli için doğru mimariye uygun dosyayı indirin (`models/yolov8n.onnx`). Yanlış bir dosya `onnxruntime: Failed to load model` hatasına yol açar.
3. Değişikliklerden sonra `pnpm install` komutunu yeniden çalıştırıp CLI’yi `pnpm exec tsx src/cli.ts --health` ile doğrulayın; sağlık çıktısında `status: "ok"` ve `checks` bölümünde hook sonuçları görülmelidir.

### RTSP akışı bağlanmıyor
- `ffmpeg -rtsp_transport tcp -i rtsp://...` komutunu elle çalıştırarak ağ gecikmesini test edin.
- Konfigürasyonda `ffmpeg.inputArgs` içerisine `-stimeout 5000000` gibi değerler ekleyerek bağlantı süresini kısaltın.
- Watchdog yeniden bağlanmayı tetikliyorsa loglar ve `pipelines.ffmpegRestarts` metriği artacaktır; çok sık artıyorsa ağ veya kamera ayarlarını gözden geçirin.

### Retention beklenen dosyaları silmiyor
- `config/default.json` içindeki `retention` alanında gün sayısını ve `maxArchives` değerini doğrulayın.
- `pnpm tsx src/run-guard.ts --max-runtime 60000` komutuyla guard’ı kısa süreliğine çalıştırarak loglarda `Retention task completed` satırını arayın.
- Snapshot klasörlerinin tarih bazlı (`YYYY-MM-DD`) olarak oluştuğunu ve eski klasörlerin silindiğini denetleyin.

### Dashboard boş görünüyor
- HTTP sunucusunu `pnpm exec tsx src/server/http.ts` komutuyla başlattığınızdan emin olun.
- Tarayıcı geliştirici araçlarında SSE isteğinin (`/api/events/stream`) açık olduğundan emin olun. CORS veya reverse proxy kullanıyorsanız SSE başlıklarını (`Cache-Control: no-cache`, `Connection: keep-alive`) iletmeyi unutmayın.
- Filtre alanlarını temizlemek için dashboard’daki **Reset** butonuna tıklayın; yanlış kanal/şiddet filtresi genellikle boş listeye sebep olur.

Guardian ile ilgili geri bildirimlerinizi veya hata raporlarınızı Issues sekmesinden paylaşabilirsiniz. İyi gözlemler!
