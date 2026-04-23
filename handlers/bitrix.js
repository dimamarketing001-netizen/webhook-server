import axios from 'axios';
import dotenv from 'dotenv';
import {
  notificationExists,
  createNotification,
  invoiceNotificationExists,
  createInvoiceNotification,
} from '../db.js';
dotenv.config();

const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
const DEAL_CONTRACT_FIELD = process.env.DEAL_CONTRACT_FIELD;
const DEAL_INVOICE_TRIGGER = process.env.DEAL_INVOICE_TRIGGER;
const APP_TOKEN = process.env.BITRIX_APP_TOKEN;

// Категории сделок
const CONTRACT_CATEGORIES = (process.env.CONTRACT_CATEGORY_IDS || '0').split(',').map(s => s.trim());
const INVOICE_CATEGORIES = (process.env.INVOICE_CATEGORY_IDS || '0,18,16').split(',').map(s => s.trim());

// Статусы счетов которые нас интересуют
const INVOICE_STATUSES = {
  'DT31_2:N': 'invoice_unconfirmed',
  'DT31_2:P': 'invoice_confirmed',
};

/**
 * Проверка токена
 */
export function validateToken(auth) {
  if (!APP_TOKEN) {
    console.log('[AUTH] ⚠️ BITRIX_APP_TOKEN не задан — проверка отключена');
    return true;
  }
  const incoming = auth?.application_token;
  if (incoming !== APP_TOKEN) {
    console.log(`[AUTH] ❌ Неверный токен: "${incoming}"`);
    return false;
  }
  console.log('[AUTH] ✅ Токен верный');
  return true;
}

// ─── СДЕЛКИ ───────────────────────────────────────────────────────────────────

export async function handleDealUpdate(data) {
  console.log('\n[HANDLER] === ONCRMDEALUPDATE ===');

  const dealId = data?.FIELDS?.ID;
  if (!dealId) {
    console.log('[HANDLER] ❌ Нет ID сделки');
    return;
  }

  console.log(`[HANDLER] Deal ID: ${dealId}`);

  // Получаем сделку
  const deal = await getDeal(dealId);
  if (!deal) {
    console.log(`[HANDLER] ❌ Сделка ${dealId} не найдена`);
    return;
  }

  const categoryId = deal.CATEGORY_ID;
  console.log(`[HANDLER] Category_id: ${categoryId}`);

  // ── Проверяем договор (только Category_id=0) ──────────────────────────────
  if (CONTRACT_CATEGORIES.includes(categoryId)) {
    await checkContractField(deal);
  }

  // ── Проверяем триггер счёта (Category_id=0,18,16) ─────────────────────────
  if (INVOICE_CATEGORIES.includes(categoryId)) {
    await checkInvoiceTrigger(deal);
  }
}

// ─── ДОГОВОР ──────────────────────────────────────────────────────────────────

async function checkContractField(deal) {
  const dealId = deal.ID;
  const fieldValue = deal[DEAL_CONTRACT_FIELD];

  console.log(`\n[HANDLER] Проверка договора: ${DEAL_CONTRACT_FIELD} = "${fieldValue}"`);

  if (fieldValue !== '1') {
    console.log(`[HANDLER] ℹ️ Поле договора не активно`);
    return;
  }

  console.log(`[HANDLER] ✅ Договор сформирован!`);

  const existing = await notificationExists(dealId, 'contract_ready');
  if (existing?.status === 'sent') {
    console.log(`[HANDLER] ℹ️ Уведомление уже отправлено`);
    return;
  }
  if (existing?.status === 'pending') {
    console.log(`[HANDLER] ℹ️ Уведомление уже в очереди`);
    return;
  }

  const contactId = deal.CONTACT_ID ? parseInt(deal.CONTACT_ID) : null;
  const leadId = deal.LEAD_ID ? parseInt(deal.LEAD_ID) : null;

  if (!contactId && !leadId) {
    console.log(`[HANDLER] ❌ Нет CONTACT_ID и LEAD_ID`);
    return;
  }

  await createNotification({
    dealId: parseInt(dealId),
    type: 'contract_ready',
    contactId,
    leadId,
    dealTitle: deal.TITLE || `Сделка #${dealId}`,
  });

  console.log(`✅ [HANDLER] Договор → уведомление в очереди`);
}

// ─── СЧЕТА ────────────────────────────────────────────────────────────────────

async function checkInvoiceTrigger(deal) {
  const dealId = deal.ID;
  const triggerValue = deal[DEAL_INVOICE_TRIGGER];

  console.log(`\n[HANDLER] Проверка триггера счёта: ${DEAL_INVOICE_TRIGGER} = "${triggerValue}"`);

  if (triggerValue !== '1') {
    console.log(`[HANDLER] ℹ️ Триггер счёта не активен`);
    return;
  }

  console.log(`[HANDLER] ✅ Триггер счёта активен — загружаем счета сделки`);

  const contactId = deal.CONTACT_ID ? parseInt(deal.CONTACT_ID) : null;
  const leadId = deal.LEAD_ID ? parseInt(deal.LEAD_ID) : null;
  const dealTitle = deal.TITLE || `Сделка #${dealId}`;

  if (!contactId && !leadId) {
    console.log(`[HANDLER] ❌ Нет CONTACT_ID и LEAD_ID — некому отправлять`);
    await resetInvoiceTrigger(dealId);
    return;
  }

  // Получаем все счета сделки
  const invoices = await getInvoicesByDeal(dealId);
  console.log(`[HANDLER] Найдено счетов: ${invoices.length}`);

  if (invoices.length === 0) {
    console.log(`[HANDLER] ℹ️ Счета не найдены`);
    await resetInvoiceTrigger(dealId);
    return;
  }

  // Обрабатываем каждый счёт
  for (const invoice of invoices) {
    await processInvoice(invoice, {
      dealId: parseInt(dealId),
      contactId,
      leadId,
      dealTitle,
    });
  }

  // Сбрасываем триггер через API
  await resetInvoiceTrigger(dealId);
}

/**
 * Обработка одного счёта
 */
async function processInvoice(invoice, dealData) {
  const invoiceId = parseInt(invoice.id);
  const status = invoice.stageId || invoice.STATUS_ID;
  const amount = parseFloat(invoice.opportunity || invoice.PRICE || 0);
  const currency = invoice.currencyId || invoice.CURRENCY_ID || 'RUB';

  console.log(`\n[HANDLER] Счёт ID=${invoiceId}`);
  console.log(`[HANDLER]   status:   ${status}`);
  console.log(`[HANDLER]   amount:   ${amount}`);
  console.log(`[HANDLER]   currency: ${currency}`);

  // Проверяем интересует ли нас этот статус
  const notificationType = INVOICE_STATUSES[status];
  if (!notificationType) {
    console.log(`[HANDLER] ℹ️ Статус "${status}" не отслеживается`);
    return;
  }

  // Проверяем не отправляли ли уже
  const existing = await invoiceNotificationExists(invoiceId, status);
  if (existing) {
    console.log(`[HANDLER] ℹ️ Уведомление для счёта ${invoiceId} со статусом ${status} уже существует (${existing.status})`);
    return;
  }

  // Создаём уведомление
  await createInvoiceNotification({
    invoiceId,
    dealId: dealData.dealId,
    contactId: dealData.contactId,
    leadId: dealData.leadId,
    invoiceStatus: status,
    amount,
    currency,
    notificationType,
  });

  console.log(`✅ [HANDLER] Счёт ${invoiceId} → уведомление "${notificationType}" в очереди`);
}

/**
 * Сбросить триггер счёта в сделке через API
 */
async function resetInvoiceTrigger(dealId) {
  try {
    console.log(`\n[B24] Сброс триггера счёта в сделке ${dealId}`);
    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.deal.update`,
      {
        id: dealId,
        fields: {
          [DEAL_INVOICE_TRIGGER]: '0',
        },
      }
    );
    console.log(`[B24] Триггер сброшен:`, JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('[B24] Ошибка сброса триггера:', error.message);
  }
}

// ─── Запросы к Б24 ────────────────────────────────────────────────────────────

async function getDeal(dealId) {
  try {
    console.log(`[B24] crm.deal.get ID=${dealId}`);
    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.deal.get`,
      { id: dealId }
    );
    console.log(`[B24] Сделка:`, JSON.stringify(response.data?.result, null, 2));
    return response.data?.result || null;
  } catch (error) {
    console.error('[B24] Ошибка crm.deal.get:', error.message);
    return null;
  }
}

/**
 * Получить все счета по сделке
 */
async function getInvoicesByDeal(dealId) {
  try {
    console.log(`[B24] Запрос счетов для сделки ${dealId}`);

    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.item.list`,
      {
        entityTypeId: 31,
        filter: { parentId2: dealId },
        select: ['id', 'stageId', 'opportunity', 'currencyId', 'title', 'createdTime'],
        order: { createdTime: 'DESC' },
      }
    );

    console.log(`[B24] Ответ счетов:`, JSON.stringify(response.data, null, 2));

    const items = response.data?.result?.items || [];
    console.log(`[B24] Найдено счетов: ${items.length}`);
    return items;

  } catch (error) {
    console.error('[B24] Ошибка получения счетов:', error.message);
    console.error('[B24] Response:', JSON.stringify(error.response?.data, null, 2));
    return [];
  }
}