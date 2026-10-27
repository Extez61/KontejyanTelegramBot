> **Kurulumla uğraşmak istemiyorsan doğrudan [@KontejyanKontrolBot](https://t.me/KontejyanKontrolBot) kullanabilirsin.**

# Kontenjan Kontrol Botu

MEB e-Okul sayfasındaki lise boş kontenjanlarını takip eden **Node.js Telegram botu**.
Okulunu ve sınıflarını seç; kontenjan değişince etiketli bildirim al.

## Neler yapar?

- Birden fazla sınıfı veya **Hepsi** seçeneğini takip eder.
- Yalnızca artışta, yalnızca azalışta veya her iki durumda bildirim gönderir.
- Aynı takip tekrar eklenirse **Zaten ekli**, ayarı değişirse **Güncellendi** der.
- İl/ilçe listelerini yerelden açar. İller **İSTANBUL (34)** biçimindedir; adla veya plakayla aranabilir.
- İlçedeki seçilen türden okulların kontenjanlarını listeler.
- Proxy, önbellek, hazır oturum ve sınırlı paralel denemelerle beklemeyi azaltır.
- Saatleri Türkiye saatine göre **23:25:53** biçiminde, saniyeli gösterir.

## Gerekenler

- **Node.js 24 veya üzeri** ve npm — Python gerekmez.
- [BotFather](https://t.me/BotFather) üzerinden alınmış Telegram bot token'ı.
- Proxy kullanacaksan çalışan bir proxy listesi.
- Arka planda çalıştırmak için isteğe bağlı PM2.

```bash
node -v
npm -v
```

Node sürümün 24'ten küçükse önce yükselt. nvm zaten kuruluysa `nvm install 24` ve `nvm use 24` yeterlidir.

## Kurulum

### 1. Dosyaları aç

GitHub'dan projeyi indir veya klonla. ZIP'i açtıktan sonra `package.json` dosyasının bulunduğu klasörde terminal aç:

```bash
cd eokul_bot
npm ci --omit=dev
```

### 2. Ayarları doldur

`.env` yoksa örnekten oluştur:

```bash
[ -f .env ] || cp .env.example .env
nano .env
```

`BOT_TOKEN` alanına BotFather token'ını yaz.

**Proxy kullanmayacaksan** şu ayarı yap:

```dotenv
USE_PROXY=0
```

**Proxy kullanacaksan** `USE_PROXY=1` bırak ve aşağıdaki proxy bölümünü uygula.

### 3. Kontrol et ve başlat

```bash
npm run check
npm start
```

`npm run check` yalnızca bağımlılıkları kontrol eder; gerçek token'ı veya MEB bağlantısını doğrulamaz.
Bot çalışınca Telegram'dan `/start` gönder. Terminalde çalışan botu durdurmak için `Ctrl+C` kullan.

**Ubuntu için kısa yol:** `bash setup_ubuntu.sh` paketleri kurar ve bağımlılık kontrolünü yapar.
Mevcut `.env`, proxy ve veritabanını korur. Token/proxy ayarlarını yine sen doldurmalısın.

## PM2 ile arka planda çalıştırma

Node 24 seçiliyken PM2'yi kur ve botu başlat:

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs --only ebot
pm2 save
```

Günlük ve yönetim komutları:

```bash
pm2 logs ebot --lines 30
pm2 restart ebot --update-env
pm2 stop ebot
```

Sunucu açılışında otomatik başlatmak için `pm2 startup` komutunun verdiği talimatı uygula, ardından `pm2 save` çalıştır.

**Eski Python sürümünden geçiyorsan:** Önce eski botu durdur. `.env`, `proxies.txt` ve SQLite dosyalarını yedekle.
Yeni dosyaları aynı klasöre koyup kurulumu tamamla. Sonra yalnızca eski `ebot` tanımını yenile:

```bash
pm2 delete ebot
pm2 start ecosystem.config.cjs --only ebot
pm2 save
```

Aynı token ile iki botu aynı anda çalıştırma. Eski SQLite verileri okunabilir; geçişten önce mutlaka yedek al.

## Proxy ayarları

**Proxy zorunlu değildir.** Proxy kullanmadan da botu çalıştırabilirsin.
Kapatmak için `.env` dosyasında şu ayarı yap:

```dotenv
USE_PROXY=0
```

Bu durumda MEB sorguları sunucunun kendi internet bağlantısından yapılır;
`proxies.txt` veya `PROXY_LIST_URL` doldurman gerekmez.
Ayarı değiştirdikten sonra botu yeniden başlat. PM2 kullanıyorsan:

```bash
pm2 restart ebot --update-env
```

Tekrar proxy kullanmak için `USE_PROXY=1` yapıp geçerli proxy bilgilerini gir.
Proxy kullanımı isteğe bağlıdır; doğrudan bağlantı da MEB'in erişim ve istek sınırlarına tabidir.

ZIP'teki `proxies.txt` **yalnızca örnektir**, çalışan proxy içermez.
Git ile klonladığında dosya yoksa oluştur:

```bash
[ -f proxies.txt ] || cp proxies.example.txt proxies.txt
nano proxies.txt
```

Örnek satırı silip gerçek proxylerini, her satıra bir tane olacak şekilde yaz:

```text
IP:PORT:USERNAME:PASSWORD
```

Örnek biçim:

```text
192.0.2.1:8080:exampleusername:examplepass11
```

**Port zorunludur.** Bu IP ve bilgiler gösterim içindir; bağlantı için kullanılamaz.

`.env` ayarları:

```dotenv
USE_PROXY=1
PROXY_FILE=proxies.txt
PROXY_SCHEME=http
PROXY_LIST_URL=
DIRECT_FALLBACK=0
DIRECT_FIRST=0
```

- Şemasız satırlar HTTP proxy kabul edilir. Sağlayıcın SOCKS5 veriyorsa `PROXY_SCHEME=socks5` yap.
- `DIRECT_FALLBACK=0` iken proxy arızasında MEB'e doğrudan bağlanılmaz.
- Çalışmayan proxy geçici olarak devre dışı bırakılır. Ücretsiz proxy kaynağı kullanılmaz.
- Dosya yerine Webshare HTTPS indirme bağlantısı kullanabilirsin: `PROXY_FILE=` alanını boşalt, gizli bağlantını `PROXY_LIST_URL` alanına yaz.
- İkisini birlikte doldurursan dosya önceliklidir.
- Proxy listesi indirmesi ve Telegram bağlantısı doğrudandır; MEB sorguları için seçilen proxy ayarı geçerlidir.

## Komutlar

| Komut | Ne yapar? |
| --- | --- |
| `/start` | Açılış mesajını gösterir, aktif menüyü sıfırlar. |
| `/takip_et` | Okul ve sınıf seçerek takip ekler veya günceller. |
| `/takiplerim` | Takipleri gösterir; ❌ ile silinebilir. |
| `/durum` | Son bilinen kontenjanı ve kontrol saatini gösterir. |
| `/kontejyanlistesi` | Sınıf → okul türü → il → ilçe seçtirip okulları listeler. |
| `/kontenjanlistesi` | Yukarıdaki komutun alternatif yazımı. |
| `/clear` | Kayıtlı özel sohbet mesajlarını temizler; takipleri silmez. |
| `/yardim` | Kısa kullanım açıklamasını gösterir. |

**Takip ekleme:** Tür → il → ilçe → okul → sınıf(lar) → Devam → bildirim tercihi.
Sınıf butonlarına basarak birden fazla seçim yapabilirsin. **Hepsi**, diğer seçimleri kaldırır.

Aynı okul, sınıflar ve bildirim tercihi varsa **Zaten ekli** denir.
Sınıf veya bildirim tercihi değişirse o okulun eski kaydı değiştirilir ve **Güncellendi** denir.
Diğer okullar etkilenmez. Yeni tercihte seçmediğin eski sınıflar artık takip edilmez.

İlk alınan kontenjan başlangıç değeridir; ilk kayıtta değişiklik bildirimi gönderilmez.
Sonraki değişiklikler seçtiğin sınıf ve artış/azalış tercihine göre bildirilir.

## Kontrol aralığı ve hız

| Ayar | Varsayılan | Açıklama |
| --- | --- | --- |
| `CHECK_INTERVAL` | `120` | İki kontrol arasındaki saniye. |
| `MAX_CONCURRENCY` | `4` | Sorgu kapasitesi; okul menüsü için yuva ayrılır. |
| `MAX_SUBS_PER_USER` | `15` | Sohbet başına takip sınırı. |
| `GROUP_TIMEOUT` | `90` | Takip grubu sorgu bütçesi, saniye. |
| `LIST_TIMEOUT` | `120` | İlçe kontenjan listesi sorgu bütçesi, saniye. |
| `DB_PATH` | `eokul_bot.db` | SQLite veritabanı dosyası. |

Önceki kontrol sürüyorsa yeni tur atlanır; bu nedenle gerçek aralık uzayabilir.

İl/ilçe menüleri MEB isteği yapmaz. Okul listeleri önbellektedir; il seçilince oturum arka planda hazırlanır.
Varsayılan kapasitede yavaş okul sorgusunda 750 ms sonra farklı proxyyle ikinci bağımsız oturum denenebilir.
İlk başarılı sonuç kullanılır, diğeri iptal edilir. Hızlı sonuçta ikinci deneme açılmaz.

**MEB veya proxy yavaşsa bekleme yine olabilir; anlık sonuç garantisi yoktur.**
Veri alınamayan okul yanlışlıkla sıfır kontenjan olarak gösterilmez.

## Sohbet temizliği

Takip kurulumu tamamlanınca kayıtlı özel sohbet mesajları temizlenir ve takip sonucu bırakılır.
`/clear` başarılı olduğunda ek onay mesajı bırakmaz. Temizlik 100 mesajlık paketlerle yapılır.

Telegram Bot API sohbet geçmişinin tamamını okuyamaz. Yalnızca botun kaydettiği son 48 saatlik ve
Telegram'ın silmeye izin verdiği mesajlar temizlenebilir. Bilinmeyen eski mesajlar silinemez.
Gruplar topluca temizlenmez. Takipler ve sonraki kontenjan bildirimleri devam eder.

## Güncelleme ve güvenlik

- Güncellemeden önce botu durdur; `.env`, `proxies.txt`, SQLite ve varsa `-wal` / `-shm` dosyalarını yedekle.
- Kodları güncelle, `npm ci --omit=dev` çalıştır ve botu yeniden başlat.
- **Token, gerçek proxy şifresi, gizli indirme bağlantısı veya gerçek veritabanını GitHub'a yükleme.**
- `.gitignore` bu yerel dosyaları dışarıda bırakır. Daha önce Git'e eklenmiş dosyalar otomatik gizlenmez.
- ZIP'teki örnek `proxies.txt` yerel kullanım içindir; Git reposunda `proxies.example.txt` şablonu tutulur.
- Hata loglarında token ve proxy kimlik bilgileri gizlenir. Ayrıntılı HTTP hata nesnelerini ayrıca loglama.

## Loglar: hata nerede, neden oluştu?

Loglar Türkiye saatiyle, saniyeli yazılır. Hata kaydı şunları içerir:

- **İşlem:** `school.selection_failed`, `proxy.load_failed`, `telegram.polling_retry` gibi.
- **Yer:** Dosya/satır (`where`), varsa MEB aşaması (`province`, `district`, `quota`).
- **Neden:** Hata kodu, varsa HTTP durumu ve asıl hataya uzanan `cause` zinciri.
- **Bağlam:** Süre, okul/ilçe kimliği; kullanıcı işleminde `trace_id` ile ilgili kayıtları eşleştirme.
- **İpucu:** Bilinen hatalarda `hint` alanında kontrol edilecek ayar.

PM2 yapılandırması çıktıları `logs/bot-out.log` ve `logs/bot-error.log` dosyalarına yazar:

```bash
pm2 logs ebot --lines 50
# veya yalnızca hatalar:
tail -n 80 logs/bot-error.log
```

Örnek (temsili):

```text
2026-10-27 23:25:53+03:00 ERROR [school.selection_failed] ... | trace_id="abc12345" where="at ... (eokul.js:27:28)" hint="Proxy/hedef bağlantısını, portu ve ağ erişimini kontrol et."
  error[0]: Error stage=school.cache_load: ...
  cause[1]: Error code=ECONNREFUSED stage=district: ...
```

Normal kullanımda `.env` içinde `LOG_LEVEL=info` bırak. Daha ayrıntılı istek süreleri için
geçici olarak `LOG_LEVEL=debug` yapıp botu yeniden başlat; sonra `info` seviyesine dön.
`warn` ve `error` seviyeleri de kullanılabilir. `info` seviyesinde her takip turunun
başarılı/başarısız okul sayısı, değişen okul sayısı ve toplam süresi kaydedilir.

Token, kayıtlı proxy kullanıcı adı/şifresi, çerezler ve gizli indirme bağlantıları maskelenir;
HTTP yanıt gövdeleri ve tüm istek nesneleri loglanmaz. Loglarda sohbet/kullanıcı kimliği bulunabilir;
paylaşmadan önce kontrol et. Loglar Git'e eklenmez. Uzun süreli kullanımda log döndürme/retention
ayarla; dosyalar kendiliğinden sınırlanmaz. Eski PM2 tanımın varsa yukarıdaki geçiş adımlarıyla
yalnızca `ebot` tanımını yeniden oluştur ki yeni log yolları uygulansın.

## Sık karşılaşılan sorunlar

| Sorun | Kontrol et |
| --- | --- |
| `Node.js 24+ gerekli` | `node -v`; eski Node sürümünü yükselt. |
| `proxies.txt bulunamadı` | Dosyayı oluştur veya proxy kullanmıyorsan `USE_PROXY=0` yap. |
| Bot başlatılamıyor | `.env` token'ı, proxy dosyası ve `npm run check` çıktısını kontrol et. |
| Telegram `401` | Token geçersiz olabilir; BotFather token'ını kontrol et. |
| Telegram `409` | Aynı token ile çalışan eski bot sürecini durdur. |
| Liste gelmiyor | Örnek proxyleri gerçek bilgilerle değiştirdiğini ve proxylerinin çalıştığını kontrol et. |

## Test ve veri kaynağı

```bash
npm test
```

132 yerel test; takip ekleme/güncelleme, SQLite, proxy, paralel istek iptali, önbellek ve komut akışlarını kapsar.
Testlerde Telegram/MEB bağlantıları taklit edilir; canlı sunucu ve hız doğrulaması yerine geçmez.

Hazır il/ilçe verisi [Türkiye API](https://turkiyeapi.dev/api/v1/provinces) üzerinden alınmıştır.
İdari listeler nadiren değişebilir; yerel dosyanın güncellenmesi gerekebilir.
Bu proje MEB'in resmi hizmeti değildir. Kontenjan bilgileri bilgilendirme amaçlıdır.


## Lisans

Bu proje **MIT Lisansı** ile sunulur. Kullanabilir, değiştirebilir ve dağıtabilirsin;
telif ve lisans metnini korumalısın. Yazılım garanti verilmeden sağlanır.
Tam metin: [LICENSE](LICENSE).
