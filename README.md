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
  "cameras": {
    "lobby": {
      "channel": "video:lobby",
      "input": "rtsp://192.168.1.10/stream1",
      "person": { "scoreThreshold": 0.35 },
      "motion": { "diffThreshold": 18 },
      "ffmpeg": { "rtspTransport": "tcp" }
    }
  },
  "retention": {
    "events": { "days": 14 },
    "snapshots": { "maxArchives": 10 }
  }
}
```

Varsayılan dosya, örnek video akışını PNG karelere dönüştüren test kamerasını içerir. Üretimde kendi kameralarınızı tanımlamak için aşağıdaki bölümlere göz atın.

### RTSP ve çoklu kamera
- `cameras` nesnesine her kamera için benzersiz bir anahtar ekleyin. `input` alanı RTSP, HTTP MJPEG, yerel dosya veya `pipe:` önekiyle bir ffmpeg komutunu destekler.
- `channel` değeri, olayların EventBus üzerinde yayınlanacağı kanalı belirler (`video:lobby`, `video:parking` gibi). Dashboard filtreleri bu alanı kullanır.
- `ffmpeg` altındaki `rtspTransport`, `inputArgs` veya `hardwareAccel` gibi seçeneklerle ağ koşullarına göre ffmpeg’i ayarlayabilirsiniz. Watchdog mekanizması kare akışı durursa yeniden başlatmayı tetikler ve metriklere `pipelines.ffmpegRestarts` olarak yansır.
- Aynı konfigürasyon dosyasında birden fazla kamera tanımlayarak çoklu kanal akışlarını aynı guard süreç içinde izleyebilirsiniz. Her kamera kendi motion/person eşiklerini (`motion.diffThreshold`, `person.scoreThreshold`) ve suppression kurallarını kullanır.

### Retention ve arşiv döngüsü
Guardian, veritabanı ve snapshot dizinlerini periyodik olarak temizleyen bir retention görevine sahiptir:
- `retention.events.days`: SQLite üzerindeki olay kayıtlarının kaç gün saklanacağını belirtir. Süre dolunca kayıtlar silinir ve `VACUUM`/`VACUUM FULL` çağrıları ile dosya boyutu sıkıştırılır.
- `retention.snapshots.days` veya `maxArchives`: Snapshot arşivleri tarih bazlı klasörlerde toplanır (`snapshots/2024-03-18/` gibi). Maksimum arşiv sayısı aşıldığında en eski klasörler silinir.
- Guard başlatıldığında görev planlayıcısı çalışır ve her çalıştırma sonunda loglara `Retention task completed` satırını bırakır.

Retention ayarlarını değiştirip dosyayı kaydettiğinizde hot reload mekanizması yeni değerleri uygular.

## Guardian'ı çalıştırma
Guardian CLI, servis kontrolü ve sağlık kontrollerini yönetir:

```bash
# Guard boru hattını başlatır
pnpm start

# Çalışan sürecin sağlık özetini yazdırır
pnpm exec tsx src/cli.ts --health

# systemd veya Docker konteyneri içinden zarif şekilde durdurur
pnpm exec tsx src/cli.ts --stop

# Servis durumunu exit kodlarıyla raporlar
pnpm exec tsx src/cli.ts --status
```

`--health` çıktısı `status`, `events.byDetector.motion`, `events.byDetector.person` ve `pipelines.ffmpegRestarts` gibi anahtarları içerir. Sağlık kodları; `0=ok`, `3=degraded`, `4=stopped` gibi anlamlar taşır ve Docker healthcheck tarafından kullanılır.

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
- `metrics.events` altında dedektör başına tetik sayıları, `metrics.latency.detectors.person` altında histogramlar, `metrics.pipelines.ffmpegRestarts` altında yeniden başlatma sayaçları bulunur.
- Log düzeyleri `metrics.logs.byLevel.error` gibi anahtarlarla etiketlenir; hata sayacının artması durumunda durum `degraded` olarak işaretlenir.

## Video ve ses boru hatları
- `pnpm tsx src/run-video-detectors.ts` komutu test videosunu çalıştırır ve motion/light/person dedektörlerini tetikleyerek snapshot üretir. Kare akışı 5 saniye durursa loglarda `Video source reconnecting (reason=watchdog-timeout)` mesajı görülür.
- `pnpm tsx src/run-audio-detector.ts` komutu platforma özel ffmpeg argümanlarıyla mikrofonu okur. Cihaz bulunamadığında `Audio source recovering (reason=ffmpeg-missing)` logu yazılır ve yeniden deneme sayaçları metriklere işlenir.

## Docker ile çalışma
Proje kökünde çok aşamalı bir Dockerfile bulunur:

```bash
docker build -t guardian:latest .
docker run --rm -p 3000:3000 -v $(pwd)/config:/app/config guardian:latest
```

İmaj derlemesi sırasında `ffmpeg` ve `onnxruntime-node` varlığı doğrulanır; eksik olduklarında build başarısız olur. Container sağlık kontrolü `pnpm exec tsx src/cli.ts --health` komutuyla çalışır ve `status: "ok"` bekler.

Guard’ı donanım hızlandırma veya RTSP kimlik bilgileriyle çalıştırmak için `config/` klasörünü volume olarak bağlayabilirsiniz.

## systemd servisi
`deploy/guardian.service` unit dosyası aşağıdaki adımlarla devreye alınabilir:

```bash
sudo cp deploy/guardian.service /etc/systemd/system/guardian.service
sudo systemctl daemon-reload
sudo systemctl enable --now guardian
```

Servis, ortam değişkenlerini unit dosyasındaki `Environment=` satırlarından alır ve stop komutunda CLI’nın graceful shutdown yolunu kullanır.

## Sorun giderme
### ffmpeg / onnxruntime hatası
1. Sistem paketlerini kurun: Debian/Ubuntu için `sudo apt-get install -y ffmpeg libgomp1`, macOS için `brew install ffmpeg`, Windows için resmi ffmpeg paketini PATH’e ekleyin.
2. ONNX modeli için doğru mimariye uygun dosyayı indirin (`models/yolov8n.onnx`). Yanlış bir dosya `onnxruntime: Failed to load model` hatasına yol açar.
3. Değişikliklerden sonra `pnpm install` komutunu yeniden çalıştırıp CLI’yi `pnpm exec tsx src/cli.ts --health` ile doğrulayın; sağlık çıktısında `status: "ok"` görülmelidir.

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
