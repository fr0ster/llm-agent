import { request } from 'node:http';

const PORT = process.env.PORT || 4004;
const HOST = '127.0.0.1';

const payload = {
  model: 'smart-agent',
  stream: true,
  messages: [
    { role: 'user', content: 'Розкажи дуже коротку казку про робота, який вчився програмувати.' }
  ]
};

console.log(`🚀 Надсилаю стрімінговий запит до http://${HOST}:${PORT}/v1/chat/completions... 
`);

const req = request({
  hostname: HOST,
  port: PORT,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
}, (res) => {
  res.on('data', (chunk) => {
    const lines = chunk.toString().split('
');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          console.log('

✅ Стрім завершено [DONE]');
          process.exit(0);
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices[0]?.delta?.content || '';
          process.stdout.write(content);
        } catch (e) {
          // Неповний JSON чанк, ігноруємо
        }
      }
    }
  });
});

req.on('error', (e) => {
  console.error(`❌ Помилка: ${e.message}`);
  process.exit(1);
});

req.write(JSON.stringify(payload));
req.end();
