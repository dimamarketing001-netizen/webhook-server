import express from 'express';
import dotenv from 'dotenv';
import { handleDealUpdate, validateToken } from './handlers/bitrix.js';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5005;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[SERVER] ${new Date().toISOString()}`);
  console.log(`[SERVER] ${req.method} ${req.url}`);
  console.log(`[SERVER] Body:`, JSON.stringify(req.body, null, 2));
  console.log(`${'='.repeat(50)}`);
  next();
});

app.get('/webhook/', (req, res) => {
  res.json({ status: 'ok', server: 'webhook-server', port: PORT });
});

app.post('/webhook/bitrix', async (req, res) => {
  console.log('\n[WEBHOOK] ← Запрос от Битрикс24');

  const auth = req.body?.auth;
  if (!validateToken(auth)) {
    console.log('[WEBHOOK] ❌ Отклонён — неверный токен');
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({ status: 'ok' });

  try {
    const event = req.body?.event;
    const data = req.body?.data;

    console.log(`[WEBHOOK] Событие: "${event}"`);

    switch (event) {
      case 'ONCRMDEALUPDATE':
        await handleDealUpdate(data);
        break;

      default:
        console.log(`[WEBHOOK] ℹ️ Событие "${event}" не обрабатывается`);
    }
  } catch (error) {
    console.error('[WEBHOOK] ❌ Ошибка:', error.message);
    console.error('[WEBHOOK] Stack:', error.stack);
  }
});

app.post('/bot-command', async (req, res) => {
  const { userId, command } = req.body;

  console.log(`[BOT-CMD] userId=${userId}, command=${command}`);

  if (!userId || !command) {
    return res.status(400).json({ error: 'userId и command обязательны' });
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;

  try {
    // Отправляем сообщение пользователю от имени бота
    // Это установит нужное состояние
    let text = '';

    if (command === 'lawyer') {
      text = '__lawyer_request__';
    } else if (command === 'upload') {
      text = '__upload_document__';
    } else {
      return res.status(400).json({ error: 'Неизвестная команда' });
    }

    const response = await axios.post(
      'https://platform-api.max.ru/messages',
      { text },
      {
        headers: {
          Authorization: BOT_TOKEN,
          'Content-Type': 'application/json',
        },
        params: { user_id: userId },
      }
    );

    console.log(`[BOT-CMD] Сообщение отправлено:`, response.data?.message?.body?.mid);
    res.json({ ok: true });

  } catch (error) {
    console.error('[BOT-CMD] Ошибка:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.use((req, res) => {
  console.log(`[SERVER] 404: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Not found', path: req.url });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 Webhook сервер: порт ${PORT}`);
  console.log(`📋 Договор поле: ${process.env.DEAL_CONTRACT_FIELD}`);
  console.log(`🧾 Счёт триггер: ${process.env.DEAL_INVOICE_TRIGGER}`);
  console.log(`📂 Категории договора: ${process.env.CONTRACT_CATEGORY_IDS}`);
  console.log(`📂 Категории счетов:   ${process.env.INVOICE_CATEGORY_IDS}`);
  console.log(`${'='.repeat(50)}\n`);
});