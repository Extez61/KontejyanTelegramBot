#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Önce Node.js 24 LTS ve npm kurun. Bu bot Python kullanmaz.' >&2
  exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0])<24){console.error("Node.js 24+ gerekli.");process.exit(1);}'
npm ci --omit=dev
npm run check
if [[ ! -e .env ]]; then
  (umask 077; cp .env.example .env)
  echo '.env oluşturuldu. Başlatmadan önce BOT_TOKEN ve proxy ayarlarını doldurun.'
else
  echo 'Mevcut .env korundu.'
fi
if [[ ! -e proxies.txt && -f proxies.example.txt ]]; then
  (umask 077; cp proxies.example.txt proxies.txt)
  echo 'Örnek proxies.txt oluşturuldu. Proxy kullanacaksanız gerçek bilgilerle değiştirin.'
else
  echo 'Mevcut proxies.txt korundu.'
fi
echo 'Mevcut veritabanı değiştirilmedi.' 
echo 'Aynı token ile başka bot çalışmadığından emin olun.'
echo 'Başlat: npm start | PM2: pm2 start ecosystem.config.cjs --only ebot'
