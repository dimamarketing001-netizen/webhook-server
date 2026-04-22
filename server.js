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

// Проверка работы сервера
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    server: 'webhook-server',
    port: PORT,
    time: new Date().toISOString(),
  });
});

// Вебхук от Битрикс24
app.post('/bitrix', async (req, res) => {
  console.log('\n[WEBHOOK] ← Получен запрос от Битрикс24');

  // Сразу отвечаем Б24 — он не должен ждать
  res.json({ status: 'ok' });

  try {
    const body = req.body;
    const event = body?.event;

    console.log(`[WEBHOOK] Событие: "${event}"`);

    if (!event) {
      console.log('[WEBHOOK] ❌ Нет поля event в запросе');
      return;
    }

    // Роутинг событий
    switch (event) {
      case 'ONCRMDEALUPDATE':
        console.log('[WEBHOOK] → handleDealUpdate');
        await handleDealUpdate(body.data);
        break;

      // Сюда добавляем новые события
      // case 'ONCRMCONTACTUPDATE':
      //   await handleContactUpdate(body.data);
      //   break;

      default:
        console.log(`[WEBHOOK] ℹ️ Событие "${event}" не обрабатывается`);
    }
  } catch (error) {
    console.error('[WEBHOOK] ❌ Ошибка обработки:');
    console.error('  message:', error.message);
    console.error('  stack:', error.stack);
  }
});

// 404
app.use((req, res) => {
  console.log(`[SERVER] 404: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Not found' });
});

// Запуск
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 Webhook сервер запущен`);
  console.log(`📡 Локальный: http://127.0.0.1:${PORT}`);
  console.log(`🌐 Внешний URL для Б24:`);
  console.log(`   https://домен/webhook/bitrix`);
  console.log(`🔑 Поле договора: ${process.env.DEAL_CONTRACT_FIELD}`);
  console.log(`${'='.repeat(50)}\n`);
});