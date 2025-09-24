# Guardian

Guardian, olayları tek bir veri akışında toplayan ve video test kaynağını PNG karelere dönüştüren küçük bir çalışma iskeletidir.

## Kurulum

Projeyi çalıştırmak için bağımlılıkları yükleyin:

```bash
pnpm install
```

## Kullanım

Guardian CLI, dedektör omurgasını `start` komutu ile başlatır ve kapatma sinyallerini yakalayarak tüm kaynakları kibarca serbest bırakır.

### Servisi başlatma

```bash
pnpm start
```

Komut, `src/cli.ts` üzerinden guard boru hattını tetikler, log seviyelerini metriklere işler ve `SIGINT`/`SIGTERM` sinyallerinde kaynakları kapatır. Çalışan servisi durdurmak için terminalde `Ctrl+C` yeterlidir; CLI, kapatma süresini `guard.shutdown.ms` metriğinde raporlar.

### Sağlık kontrolü

Çalışan örnekten metrikleri ve durum kodlarını JSON olarak almak için:

```bash
pnpm health
```

CLI çıktısı, log seviyelerine göre sayaçlar, EventBus tetik sayıları ve hizmet durumunu (`ok`, `starting`, `degraded`) içeren tek satırlık bir JSON döndürür. Aynı komutu Docker healthcheck veya ters proxy kontrol uç noktalarında kullanabilirsiniz.

### Sistem önyüklemesi

Guard servisinin dışında kalan temel sistem önyüklemesi hâlâ `app` komutu ile tetiklenebilir. Çalıştırıldığında `data/events.sqlite` veritabanı oluşturulur ve `system up` mesajlı bir kayıt eklenir.

```bash
pnpm app
```

Oluşturulan olay günlüğünü `data/events.sqlite` içinde görebilir veya SQLite araçlarıyla sorgulayabilirsiniz.

### Docker imajı

Kapsayıcı ortamlarda servisi çalıştırmak için yerleşik Dockerfile kullanılır:

```bash
docker build -t guardian:latest .
docker run --rm -p 3000:3000 guardian:latest
```

İmaj, sağlık kontrolü için `pnpm exec tsx src/cli.ts --health` komutunu kullanır ve varsayılan giriş noktası CLI `start` komutudur.

### systemd servisi

`deploy/guardian.service` ünitesi, Linux ana makinelerde Guardian’ı sistem servisi olarak tanımlar. Unit dosyasını `/etc/systemd/system/guardian.service` konumuna kopyalayıp aşağıdaki komutlarla devreye alabilirsiniz:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now guardian
```

Unit, çalışma dizininde `pnpm start` komutunu kullanır; durdurma isteğinde CLI’nın graceful shutdown kancaları tetiklenir.

## Video testleri ve dedektörleri

Varsayılan yapılandırma `assets/test-video.mp4` yoluna yazılan küçük bir örnek videoyu saniyede iki kare olacak şekilde PNG formatında ayrıştırır. `pnpm tsx src/run-video-detectors.ts` komutu bu akışı Motion ve Light dedektörleriyle analiz eder.

Dedektörler, olay yakalandığında `event` kanalına olay düşer ve otomatik olarak SQLite veritabanına kaydedilir.

### MotionDetector

- **diffThreshold**: Piksel başına minimum fark (varsayılan 25). Bu değeri azaltmak küçük hareketleri yakalar, yükseltmek gürültüyü filtreler.
- **areaThreshold**: Toplam kareye göre yüzde olarak değişen piksel oranı (varsayılan %1.5). %0.02 = %2 alan anlamına gelir.
- **minIntervalMs**: Aynı hareketin tekrar raporlanmaması için minimum bekleme süresi.

### LightDetector

- **deltaThreshold**: Ortalama lüminansta beklenmeyen sıçramayı tetikleyen fark (varsayılan 40/255).
- **normalHours**: Aydınlığın normal kabul edildiği saat aralıkları. Saatler dışında kalan tüm değişimler eşik ile karşılaştırılır. Örneğin `{ start: 7, end: 22 }` gündüz ışığını, `{ start: 22, end: 6 }` gece ışığını tanımlar.
- **smoothingFactor**: Lüminans baz çizgisini yumuşatmak için EMA katsayısı.
- **minIntervalMs**: Aynı ışık olayının tekrarlanmasını sınırlar.

### PersonDetector

- **modelPath**: `models/yolov8n.onnx` benzeri YOLOv8 tabanlı ONNX modelinin yolu. Model dosyasını bu klasöre kendiniz yerleştirmelisiniz.
- **score**: Kişi sınıfı için minimum güven skoru. Örneğin `0.5` üzerindeki sonuçlar kişi olarak raporlanır.
- **checkEveryNFrames**: Hareket algılandıktan sonra her N. karede kişi analizi yapılır.
- **maxDetections**: Tek bir hareket tetiklemesinden sonra kaç kareye kadar kişi analizi yapılacağını sınırlar.
- **snapshotDir**: `snapshots/` varsayılanına yazılan kişi görüntülerinin klasörü.

Dedektör, kareleri 640x640 çözünürlüğe `letterbox` yöntemiyle ölçeklendirir ve YOLOv8 çıktısındaki kişi skorunu eşiğin üzerinde bulduğunda `snapshots/<timestamp>-person.png` dosyası oluşturup olaya kutu koordinatlarını ekler.

Farklı bir test videosu veya kare hızı kullanmak isterseniz `config/default.json` altındaki `video.testFile` ve `video.framesPerSecond` ayarlarını güncelleyin. Dedektör eşikleri kod içinde parametre olarak belirtilmiştir, gerekirse scripti düzenleyin.

Örnek komut:

```bash
pnpm tsx src/run-video-detectors.ts
```

Örnek video üzerinde bu komut en az bir motion veya light olayını terminale ve veritabanına yazar.

## Hareket → kişi tetik zinciri

`pnpm tsx src/run-guard.ts` komutu, MotionDetector tetiklendikten sonra yapılandırmadaki her `checkEveryNFrames` karede PersonDetector'ı devreye alır. Maksimum deneme sayısı aşılana kadar kişi analizleri sürer. Eşik aşılırsa olay kayıt defterine kişi olayı düşer ve eş zamanlı olarak snapshot klasöründe görüntü saklanır.

## Metrikler

Guardian’ın metrik koleksiyonu üç ana başlıkta toplanır ve tamamı CLI sağlık çıktısında gözlemlenebilir:

- **Log seviyeleri**: Pino logger’ı her kayıt yazdığında `logs.byLevel` haritasındaki sayaçlar artar. Örneğin `error` veya `fatal` seviyeleri `degraded` durumuna işaret eder ve alarm sistemlerine bağlanabilir.
- **EventBus tetik sayıları**: `metrics.events` alanı toplam olay, dedektör başına dağılım ve en son tetik zamanını raporlar. Motion/Person dedektör zincirleri bu sayaçlarla izlenebilir.
- **Gecikme ölçümleri**: `guard.startup.ms` ve `guard.shutdown.ms` gibi süreli işlemler `latencies` altında toplanır. `metrics.time()` yardımcı fonksiyonu, boru hattı adımlarını sarmalayarak ortalama/min/maks süreleri verir.

Metrikler, Prometheus gibi sistemlere aktarım için JSON çıktısı, sistem günlükleri veya kendi toplayıcınız üzerinden kolayca tüketilebilir.

## Testler

Birimin doğru kare ayrıştırmasını doğrulamak için Vitest testleri bulunmaktadır:

```bash
pnpm vitest run -t Bootstrap
pnpm vitest run -t VideoSource
pnpm vitest run -t "(Motion|Light)Detector"
pnpm vitest run -t AudioAnomaly
pnpm vitest run -t PersonDetector
```

`Bootstrap` testi uygulama başlangıcını, `VideoSource` testi sahte bir PNG akışını; `MotionDetector` ve `LightDetector` sentetik karelerle video eşiklerini; `PersonDetector` hareket sonrası kişi senaryosunu; `AudioAnomaly` ise sentetik PCM örnekleriyle ses dedektörünü doğrular.

## Ses dedektörü

`pnpm tsx src/run-audio-detector.ts` komutu mikrofon akışını (veya uygun şekilde yönlendirilmiş `ffmpeg` girişini) 16 kHz tek kanal PCM formatında alır ve RMS / spektral centroid (Meyda ile) hesaplayarak olağan dışı durumlarda `audio-anomaly` olayı üretir.

Varsayılan olarak işletim sistemine göre şu ffmpeg seçenekleri kullanılır:

- **Linux (ALSA)**: `-f alsa -i default`
- **macOS (AVFoundation)**: `-f avfoundation -i :0`
- **Windows (DirectShow)**: `-f dshow -i audio="default"`

Ses dedektöründe kullanılan temel parametreler:

- **rmsThreshold** ≈ 0.25: Ses seviyesinin (0-1 aralığı) aşması hâlinde `critical` seviye üretir.
- **centroidJumpThreshold** ≈ 200 Hz: Spektral centroidte ani sıçramaları `warning` olarak raporlar.
- **minIntervalMs**: Aynı anomali tekrarının bastırılması için bekleme süresi.

Farklı bir cihaz kullanmak istiyorsanız `src/run-audio-detector.ts` içindeki `AudioSource` yapılandırmasını güncelleyin. Windows kullanıcılarının ffmpeg'in DirectShow cihaz adını doğru girdiğinden emin olması gerekir (`ffmpeg -list_devices true -f dshow -i dummy`). ALSA altında sanal cihaz veya `plughw` kullanabilirsiniz. Ayrıca `type: 'ffmpeg'` seçeneği ile boru hattından (`pipe:0`) gelen PCM akışları da okunabilir.

Komut çalışırken el çırpma veya ani ses değişimleri en az bir `audio-anomaly` olayını oluşturur.

## Sorun Giderme

### ffmpeg / onnxruntime hatası

Kapsayıcı dışında çalıştırırken `ffmpeg` ikilisi veya `onnxruntime-node` yerel eklentileri yüklenemezse aşağıdaki adımları uygulayın:

1. Sistem paketlerini kurun: Debian/Ubuntu tabanlı dağıtımlarda `sudo apt-get install -y ffmpeg libgomp1` komutu eksik bağımlılıkları tamamlar.
2. ONNX modeli için doğru mimariye uygun dosyayı indirdiğinizden emin olun (`models/yolov8n.onnx`). Yanlış bir dosya `onnxruntime: Failed to load model` hatasına yol açar.
3. Değişikliklerden sonra `pnpm install` komutunu yeniden çalıştırıp CLI’yi `pnpm health` ile doğrulayın; sağlık çıktısında `status: "ok"` görülmelidir.
