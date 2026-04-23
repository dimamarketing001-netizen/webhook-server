import axios from 'axios';
import dotenv from 'dotenv';
import { notificationExists, createNotification } from '../db.js';
dotenv.config();

const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
const DEAL_CONTRACT_FIELD = process.env.DEAL_CONTRACT_FIELD;
const APP_TOKEN = process.env.BITRIX_APP_TOKEN;
const ALLOWED_CATEGORY_ID = '0'; // Только сделки Category_id=0

/**
 * Проверка токена Б24
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

/**
 * Обработчик ONCRMDEALUPDATE — договор
 */
export async function handleDealUpdate(data) {
  console.log('\n[HANDLER] === ONCRMDEALUPDATE ===');
  console.log('[HANDLER] Данные:', JSON.stringify(data, null, 2));

  const dealId = data?.FIELDS?.ID;
  if (!dealId) {
    console.log('[HANDLER] ❌ Нет ID сделки');
    return;
  }

  const deal = await getDeal(dealId);
  if (!deal) {
    console.log(`[HANDLER] ❌ Сделка ${dealId} не найдена`);
    return;
  }

  // Проверяем Category_id — только 0
  if (deal.CATEGORY_ID !== ALLOWED_CATEGORY_ID) {
    console.log(`[HANDLER] ℹ️ Сделка Category_id=${deal.CATEGORY_ID} — пропускаем (нужен 0)`);
    return;
  }

  console.log(`[HANDLER] ✅ Category_id=0 — обрабатываем`);

  // Проверяем поле договора
  await checkContractField(deal);
}

/**
 * Проверяем поле договора в сделке
 */
async function checkContractField(deal) {
  const dealId = deal.ID;
  const fieldValue = deal[DEAL_CONTRACT_FIELD];

  console.log(`\n[HANDLER] Проверка поля договора`);
  console.log(`[HANDLER] Поле: ${DEAL_CONTRACT_FIELD} = "${fieldValue}"`);

  if (fieldValue !== '1') {
    console.log(`[HANDLER] ℹ️ Поле договора не активно, пропускаем`);
    return;
  }

  console.log(`[HANDLER] ✅ Договор сформирован!`);

  // Проверяем дубль
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
  const dealTitle = deal.TITLE || `Сделка #${dealId}`;

  console.log(`[HANDLER] contact_id=${contactId}, lead_id=${leadId}`);

  if (!contactId && !leadId) {
    console.log(`[HANDLER] ❌ Нет CONTACT_ID и LEAD_ID`);
    return;
  }

  await createNotification({
    dealId: parseInt(dealId),
    type: 'contract_ready',
    contactId,
    leadId,
    dealTitle,
  });

  console.log(`✅ [HANDLER] Договор → уведомление в очереди`);
}

// ─── СЧЕТА ────────────────────────────────────────────────────────────────────

/**
 * Обработчик ONCRMINVOICEADD — создание счёта
 */
export async function handleInvoiceAdd(data) {
  console.log('\n[HANDLER] === ONCRMINVOICEADD ===');
  console.log('[HANDLER] Данные:', JSON.stringify(data, null, 2));

  const invoiceId = data?.FIELDS?.ID;
  if (!invoiceId) {
    console.log('[HANDLER] ❌ Нет ID счёта');
    return;
  }

  await processInvoice(invoiceId, 'add');
}

/**
 * Обработчик ONCRMINVOICEUPDATE — изменение счёта
 */
export async function handleInvoiceUpdate(data) {
  console.log('\n[HANDLER] === ONCRMINVOICEUPDATE ===');
  console.log('[HANDLER] Данные:', JSON.stringify(data, null, 2));

  const invoiceId = data?.FIELDS?.ID;
  if (!invoiceId) {
    console.log('[HANDLER] ❌ Нет ID счёта');
    return;
  }

  await processInvoice(invoiceId, 'update');
}

/**
 * Общая логика обработки счёта
 */
async function processInvoice(invoiceId, action) {
  console.log(`\n[HANDLER] Обработка счёта ID=${invoiceId}, action=${action}`);

  // Получаем данные счёта
  const invoice = await getInvoice(invoiceId);
  if (!invoice) {
    console.log(`[HANDLER] ❌ Счёт ${invoiceId} не найден`);
    return;
  }

  const status = invoice.STATUS_ID;
  console.log(`[HANDLER] Статус счёта: "${status}"`);

  // Определяем тип уведомления по статусу
  let notificationType = null;

  if (status === 'DT31_2:N' && action === 'add') {
    // Новый неподтверждённый счёт
    notificationType = 'invoice_new';
    console.log(`[HANDLER] → Новый счёт (неподтверждённый)`);
  } else if (status === 'DT31_2:P' && action === 'update') {
    // Счёт подтверждён
    notificationType = 'invoice_confirmed';
    console.log(`[HANDLER] → Счёт подтверждён`);
  } else {
    console.log(`[HANDLER] ℹ️ Статус "${status}" + action="${action}" — пропускаем`);
    return;
  }

  // Получаем DEAL_ID из счёта
  const dealId = invoice.UF_DEAL_ID
    ? parseInt(invoice.UF_DEAL_ID)
    : null;

  console.log(`[HANDLER] DEAL_ID счёта: ${dealId}`);

  if (!dealId) {
    console.log(`[HANDLER] ❌ У счёта нет привязки к сделке`);
    return;
  }

  // Получаем сделку чтобы узнать контакт и проверить category
  const deal = await getDeal(dealId);
  if (!deal) {
    console.log(`[HANDLER] ❌ Сделка ${dealId} не найдена`);
    return;
  }

  // Проверяем Category_id — только 0
  if (deal.CATEGORY_ID !== ALLOWED_CATEGORY_ID) {
    console.log(`[HANDLER] ℹ️ Сделка Category_id=${deal.CATEGORY_ID} — пропускаем`);
    return;
  }

  const contactId = deal.CONTACT_ID ? parseInt(deal.CONTACT_ID) : null;
  const leadId = deal.LEAD_ID ? parseInt(deal.LEAD_ID) : null;
  const dealTitle = deal.TITLE || `Сделка #${dealId}`;

  console.log(`[HANDLER] contact_id=${contactId}, lead_id=${leadId}`);

  if (!contactId && !leadId) {
    console.log(`[HANDLER] ❌ Нет CONTACT_ID и LEAD_ID в сделке`);
    return;
  }

  // Проверяем дубль
  const existing = await notificationExists(invoiceId, notificationType);
  if (existing?.status === 'sent') {
    console.log(`[HANDLER] ℹ️ Уведомление "${notificationType}" уже отправлено`);
    return;
  }
  if (existing?.status === 'pending') {
    console.log(`[HANDLER] ℹ️ Уведомление "${notificationType}" уже в очереди`);
    return;
  }

  // Создаём уведомление
  await createNotification({
    dealId: parseInt(dealId),
    invoiceId: parseInt(invoiceId),
    invoiceStatus: status,
    type: notificationType,
    contactId,
    leadId,
    dealTitle,
  });

  console.log(`✅ [HANDLER] Счёт → уведомление "${notificationType}" в очереди`);
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

async function getInvoice(invoiceId) {
  try {
    console.log(`[B24] crm.item.get invoice ID=${invoiceId}`);
    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.item.get`,
      {
        entityTypeId: 31, // Счёт в Б24
        id: invoiceId,
      }
    );
    console.log(`[B24] Счёт:`, JSON.stringify(response.data?.result, null, 2));
    return response.data?.result?.item || null;
  } catch (error) {
    console.error('[B24] Ошибка crm.item.get (invoice):', error.message);
    // Пробуем старый метод
    return await getInvoiceLegacy(invoiceId);
  }
}

async function getInvoiceLegacy(invoiceId) {
  try {
    console.log(`[B24] crm.invoice.get ID=${invoiceId} (legacy)`);
    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.invoice.get`,
      { id: invoiceId }
    );
    console.log(`[B24] Счёт (legacy):`, JSON.stringify(response.data?.result, null, 2));
    return response.data?.result || null;
  } catch (error) {
    console.error('[B24] Ошибка crm.invoice.get:', error.message);
    return null;
  }
}