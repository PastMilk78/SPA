require('dotenv').config();
const https = require('https');

const token = process.env.TELEGRAM_BOT_TOKEN || '7815849359:AAGubzVdPphHXq0ocUqF4UuLCNg1bMcOz6g';
const url = process.env.WEBHOOK_URL || 'https://spa-six-mu.vercel.app/api/telegram';

const webhookUrl = `https://api.telegram.org/bot${token}/setWebhook?url=${url}`;

console.log('Configurando webhook...');
console.log('URL:', url);

https.get(webhookUrl, (resp) => {
  let data = '';

  resp.on('data', (chunk) => {
    data += chunk;
  });

  resp.on('end', () => {
    console.log('Respuesta de Telegram:', JSON.parse(data));
  });

}).on("error", (err) => {
  console.error("Error: ", err.message);
}); 