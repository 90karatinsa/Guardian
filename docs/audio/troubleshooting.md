# Audio Troubleshooting

## Discovery Timeout Behaviour

When audio device discovery times out the system now performs a controlled recovery so operators do not need to intervene manually.

### What happens automatically

- The cached device list for the affected format is cleared so the next discovery attempts run a fresh probe.
- A guarded retry is scheduled using the configured timeout window (minimum 1.5 seconds) to avoid hammering the hardware.
- The raised error is a `DeviceDiscoveryTimeoutError` carrying `code = "AUDIO_DEVICE_DISCOVERY_TIMEOUT"`, `exhausted = true`, and `handled = true` so higher layers can present user-facing fallbacks without rethrowing the rejection.
- Microphone pipelines record the timeout in metrics and surface a temporary empty device list until the retry completes.

### Expected user impact

- The UI may briefly show no microphones or continue using the previously working input.
- Within a short delay (matching the retry schedule) the next probe repopulates the list if hardware is available again.

### Diagnosing repeated timeouts

1. Check the audio logs for `device-discovery-timeout` recoveries and confirm the channel that is failing.
2. Ensure the underlying OS device (`arecord -l`, `pactl list sources`, etc.) is reachable and not locked by another process.
3. Verify the configured discovery timeout is high enough for the hardware. Slow USB devices can need >2s to respond.
4. Look at the metrics dashboard for `pipelines.audio.deviceDiscovery` to confirm retries are being scheduled and executed.

### Developer notes

- Tests assert that no `Unhandled Rejection` is emitted when timeouts occur. If you add new discovery flows, reuse `DeviceDiscoveryTimeoutError` and the guarded retry helper.
- Call `AudioSource.clearDeviceCache(format)` when you know the OS-level device configuration changed to cancel pending retries.

## Audio anomaly hot-reload

### Başlık

Audio anomaly dedektörünün pencere boyutu veya eşik planı çalışma sırasında değiştirildiğinde, dedektör mevcut analiz tamponlarını güvenli şekilde yeniden hizalar.

### Kısa açıklama

- `updateOptions` çağrıları yeni RMS/spektral pencere değerlerini daha küçük bir değere indirirse FIFO buffer'lardaki eski örnekleri keser.
- Güncel day/night eşik planı hemen uygulanır ve `threatThreshold` bilgisi event meta verisine yansır.
- Geçmiş süre/geri kazanım sayaçları sıfırlanır, böylece sonraki tetiklemeler yeni yapılandırmaya göre hesaplanır.

### Beklenen davranış

- `AudioAnomalyHotReload` testleri, yeni pencere süreleri uygulanana kadar olay yayınlanmadığını doğrular.
- `metrics.detectors['audio-anomaly']` sayaçları yeniden başlatma sırasında sıfırlanır ve ilk tetiklemede yeniden artar.
- `events[].meta.thresholds.profile` alanı, yeni plan gece profilini seçmişse `night` olarak güncellenir.

### Teşhis adımları

1. `audio.anomaly` yapılandırmasını değiştirip `guardian daemon reload audio` (veya uygun CLI komutu) ile hot-reload tetikleyin.
2. Günlüklerde pencere sıfırlamasına dair bilgi mesajlarını ve buffer kırpma sayaçlarının sıfırlandığını doğrulayın.
3. İzleyen olayda `meta.state.rms.windowMs` alanının yeni pencere uzunluğunu rapor ettiğini ve `durationAboveThresholdMs` değerinin yeni minimum tetik süresini karşıladığını kontrol edin.

### Geliştirici notları

- `updateWindowGeometry` içindeki buffer kırpma ve `resolveThresholds(Date.now())` çağrısı Vitest hot-reload senaryolarının yeşil kalması için gereklidir.
- Yeni seçenekler eklerseniz `updateOptions` içinde `scheduleChanged` ve `windowSettingsChanged` kontrollerini güncelleyerek metriklerin sıfırlanmasını sağlayın.
