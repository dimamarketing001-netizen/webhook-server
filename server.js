import express from 'express';
import dotenv from 'dotenv';
import { handleDealUpdate } from './handlers/bitrix.js';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5005;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Лог всех входящих запросов
app.use((req, res, next) => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[SERVER] ${new Date().toISOString()}`);
  console.log(`[SERVER] ${req.method} ${req.url}`);
  console.log(`[SERVER] Body:`, JSON.stringify(req.body, null, 2));
  console.log(`${'='.repeat(50)}`);
  next();
});

// Проверка работы
app.get('/webhook/', (req, res) => {
  res.json({
    status: 'ok',
    server: 'webhook-server',
    port: PORT,
    time: new Date().toISOString(),
  });
});

// Вебхук от Битрикс24 ← исправили путь
app.post('/webhook/bitrix', async (req, res) => {
  console.log('\n[WEBHOOK] ← Получен запрос от Битрикс24');

  // Сразу отвечаем Б24
  res.json({ status: 'ok' });

  try {
    const body = req.body;
    const event = body?.event;

    console.log(`[WEBHOOK] Событие: "${event}"`);

    if (!event) {
      console.log('[WEBHOOK] ❌ Нет поля event');
      return;
    }

    switch (event) {
      case 'ONCRMDEALUPDATE':
        console.log('[WEBHOOK] → handleDealUpdate');
        await handleDealUpdate(body.data);
        break;

      default:
        console.log(`[WEBHOOK] ℹ️ Событие "${event}" не обрабатывается`);
    }
  } catch (error) {
    console.error('[WEBHOOK] ❌ Ошибка:', error.message);
    console.error('[WEBHOOK] Stack:', error.stack);
  }
});

// 404
app.use((req, res) => {
  console.log(`[SERVER] 404: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Not found', path: req.url });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 Webhook сервер запущен на порту ${PORT}`);
  console.log(`${'='.repeat(50)}\n`);
});