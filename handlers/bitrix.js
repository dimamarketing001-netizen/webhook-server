import axios from 'axios';
import dotenv from 'dotenv';
import {
  notificationExists,
  createNotification,
  invoiceNotificationExists,
  createInvoiceNotification,
  stageNotificationExists,
  createStageNotification,
} from '../db.js';
dotenv.config();

const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
const DEAL_CONTRACT_FIELD = process.env.DEAL_CONTRACT_FIELD;
const DEAL_INVOICE_TRIGGER = process.env.DEAL_INVOICE_TRIGGER;
const APP_TOKEN = process.env.BITRIX_APP_TOKEN;

// Категории
const CONTRACT_CATEGORIES = (process.env.CONTRACT_CATEGORY_IDS || '0').split(',').map(s => s.trim());
const INVOICE_CATEGORIES = (process.env.INVOICE_CATEGORY_IDS || '0,16,18').split(',').map(s => s.trim());
const STAGE_CATEGORIES = (process.env.STAGE_CATEGORY_IDS || '2,4,6,8,10,12').split(',').map(s => s.trim());

// Статусы счетов
const INVOICE_STATUSES = {
  'DT31_2:N': 'invoice_unconfirmed',
  'DT31_2:P': 'invoice_confirmed',
};

// Исключаемые суффиксы стадий (без префикса категории)
const EXCLUDED_STAGE_SUFFIXES = ['NEW', 'PREPARATION', '1'];

// Кэш стадий { categoryId: { stageId: stageName } }
const stagesCache = new Map();

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

// ─── Главный обработчик ───────────────────────────────────────────────────────

export async function handleDealUpdate(data) {
  console.log('\n[HANDLER] === ONCRMDEALUPDATE ===');

  const dealId = data?.FIELDS?.ID;
  if (!dealId) {
    console.log('[HANDLER] ❌ Нет ID сделки');
    return;
  }

  console.log(`[HANDLER] Deal ID: ${dealId}`);

  const deal = await getDeal(dealId);
  if (!deal) {
    console.log(`[HANDLER] ❌ Сделка ${dealId} не найдена`);
    return;
  }

  const categoryId = deal.CATEGORY_ID;
  console.log(`[HANDLER] Category_id: ${categoryId}`);

  // WON — только Category_id=0
  if (categoryId === '0') {
    await checkDealWon(deal);
  }

  // Договор — только Category_id=0
  if (CONTRACT_CATEGORIES.includes(categoryId)) {
    await checkContractField(deal);
  }

  // Триггер счёта — Category_id=0,16,18
  if (INVOICE_CATEGORIES.includes(categoryId)) {
    await checkInvoiceTrigger(deal);
  }

  // Стадии — Category_id=2,4,6,8,10,12
  if (STAGE_CATEGORIES.includes(categoryId)) {
    await checkDealStage(deal);
  }
}

// ─── WON ──────────────────────────────────────────────────────────────────────

async function checkDealWon(deal) {
  const dealId = deal.ID;
  const stageId = deal.STAGE_ID;

  console.log(`\n[HANDLER] Проверка WON: STAGE_ID="${stageId}"`);

  if (stageId !== 'WON') {
    console.log(`[HANDLER] ℹ️ Стадия не WON`);
    return;
  }

  const existing = await notificationExists(dealId, 'deal_won');
  if (existing?.status === 'sent') {
    console.log(`[HANDLER] ℹ️ WON уже отправлено`);
    return;
  }
  if (existing?.status === 'pending') {
    console.log(`[HANDLER] ℹ️ WON уже в очереди`);
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
    type: 'deal_won',
    contactId,
    leadId,
    dealTitle: deal.TITLE || `Сделка #${dealId}`,
    dealTypeId: deal.TYPE_ID ? String(deal.TYPE_ID) : null,
  });

  console.log(`✅ [HANDLER] WON → уведомление в очереди`);
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

  const existing = await notificationExists(dealId, 'contract_ready');
  if (existing?.status === 'sent') {
    console.log(`[HANDLER] ℹ️ Договор уже отправлен`);
    return;
  }
  if (existing?.status === 'pending') {
    console.log(`[HANDLER] ℹ️ Договор уже в очереди`);
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
    dealTypeId: deal.TYPE_ID ? String(deal.TYPE_ID) : null,
  });

  console.log(`✅ [HANDLER] Договор → уведомление в очереди`);
}

// ─── СТАДИИ ───────────────────────────────────────────────────────────────────

async function checkDealStage(deal) {
  const dealId = deal.ID;
  const stageId = deal.STAGE_ID;
  const categoryId = deal.CATEGORY_ID;

  console.log(`\n[HANDLER] Проверка стадии: STAGE_ID="${stageId}", Category_id="${categoryId}"`);

  // Проверяем исключённые стадии
  // Стадия имеет вид C2:NEW — берём суффикс после ":"
  const stageSuffix = stageId.includes(':') ? stageId.split(':')[1] : stageId;
  console.log(`[HANDLER] Суффикс стадии: "${stageSuffix}"`);

  if (EXCLUDED_STAGE_SUFFIXES.includes(stageSuffix)) {
    console.log(`[HANDLER] ℹ️ Стадия "${stageId}" исключена из уведомлений`);
    return;
  }

  // Проверяем дубль
  const existing = await stageNotificationExists(dealId, stageId);
  if (existing?.status === 'sent') {
    console.log(`[HANDLER] ℹ️ Стадия "${stageId}" уже отправлена`);
    return;
  }
  if (existing?.status === 'pending') {
    console.log(`[HANDLER] ℹ️ Стадия "${stageId}" уже в очереди`);
    return;
  }

  const contactId = deal.CONTACT_ID ? parseInt(deal.CONTACT_ID) : null;
  const leadId = deal.LEAD_ID ? parseInt(deal.LEAD_ID) : null;

  if (!contactId && !leadId) {
    console.log(`[HANDLER] ❌ Нет CONTACT_ID и LEAD_ID`);
    return;
  }

  // Получаем название стадии через API
  const stageName = await getStageName(categoryId, stageId);
  console.log(`[HANDLER] Название стадии: "${stageName}"`);

  await createStageNotification({
    dealId: parseInt(dealId),
    stageId,
    stageName,
    contactId,
    leadId,
    dealTypeId: deal.TYPE_ID ? String(deal.TYPE_ID) : null,
  });

  console.log(`✅ [HANDLER] Стадия "${stageId}" → уведомление в очереди`);
}

/**
 * Получить название стадии через API с кэшированием
 */
async function getStageName(categoryId, stageId) {
  // Проверяем кэш
  if (stagesCache.has(categoryId)) {
    const cached = stagesCache.get(categoryId);
    if (cached[stageId]) {
      console.log(`[B24] Стадия из кэша: "${cached[stageId]}"`);
      return cached[stageId];
    }
  }

  // Запрашиваем стадии категории
  try {
    console.log(`[B24] crm.dealcategory.stages categoryId=${categoryId}`);
    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.dealcategory.stages`,
      { id: categoryId }
    );

    console.log(`[B24] Стадии:`, JSON.stringify(response.data, null, 2));

    const stages = response.data?.result;
    if (!stages || stages.length === 0) {
      console.log(`[B24] Стадии не найдены для category=${categoryId}`);
      return stageId;
    }

    // Строим маппинг { stageId: stageName }
    const stageMap = {};
    for (const stage of stages) {
      stageMap[stage.STATUS_ID] = stage.NAME;
    }

    // Сохраняем в кэш
    stagesCache.set(categoryId, stageMap);
    console.log(`[B24] Кэш стадий для category=${categoryId}:`, stageMap);

    return stageMap[stageId] || stageId;

  } catch (error) {
    console.error('[B24] Ошибка crm.dealcategory.stages:', error.message);
    return stageId;
  }
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

  console.log(`[HANDLER] ✅ Триггер активен — загружаем счета`);

  const contactId = deal.CONTACT_ID ? parseInt(deal.CONTACT_ID) : null;
  const leadId = deal.LEAD_ID ? parseInt(deal.LEAD_ID) : null;
  const dealTypeId = deal.TYPE_ID ? String(deal.TYPE_ID) : null;

  if (!contactId && !leadId) {
    console.log(`[HANDLER] ❌ Нет CONTACT_ID и LEAD_ID`);
    await resetInvoiceTrigger(dealId);
    return;
  }

  const invoices = await getInvoicesByDeal(dealId);
  console.log(`[HANDLER] Найдено счетов: ${invoices.length}`);

  if (invoices.length === 0) {
    console.log(`[HANDLER] ℹ️ Счета не найдены`);
    await resetInvoiceTrigger(dealId);
    return;
  }

  for (const invoice of invoices) {
    await processInvoice(invoice, {
      dealId: parseInt(dealId),
      contactId,
      leadId,
      dealTitle: deal.TITLE || `Сделка #${dealId}`,
      dealTypeId,
    });
  }

  await resetInvoiceTrigger(dealId);
}

async function processInvoice(invoice, dealData) {
  const invoiceId = parseInt(invoice.id);
  const status = invoice.stageId || invoice.STATUS_ID;
  const amount = parseFloat(invoice.opportunity || invoice.PRICE || 0);
  const currency = invoice.currencyId || invoice.CURRENCY_ID || 'RUB';

  console.log(`\n[HANDLER] Счёт ID=${invoiceId}, status="${status}", amount=${amount}`);

  const notificationType = INVOICE_STATUSES[status];
  if (!notificationType) {
    console.log(`[HANDLER] ℹ️ Статус "${status}" не отслеживается`);
    return;
  }

  const existing = await invoiceNotificationExists(invoiceId, status);
  if (existing) {
    console.log(`[HANDLER] ℹ️ Счёт ${invoiceId} статус ${status} уже в БД`);
    return;
  }

  await createInvoiceNotification({
    invoiceId,
    dealId: dealData.dealId,
    contactId: dealData.contactId,
    leadId: dealData.leadId,
    invoiceStatus: status,
    amount,
    currency,
    notificationType,
    dealTypeId: dealData.dealTypeId,
  });

  console.log(`✅ [HANDLER] Счёт ${invoiceId} → "${notificationType}" в очереди`);
}

async function resetInvoiceTrigger(dealId) {
  try {
    console.log(`[B24] Сброс триггера сделки ${dealId}`);
    await axios.post(
      `${BITRIX_WEBHOOK}/crm.deal.update`,
      {
        id: dealId,
        fields: { [DEAL_INVOICE_TRIGGER]: '0' },
      }
    );
    console.log(`[B24] ✅ Триггер сброшен`);
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

async function getInvoicesByDeal(dealId) {
  try {
    console.log(`[B24] Счета для сделки ${dealId}`);
    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.item.list`,
      {
        entityTypeId: 31,
        filter: { parentId2: dealId },
        select: ['id', 'stageId', 'opportunity', 'currencyId', 'title', 'createdTime'],
        order: { createdTime: 'DESC' },
      }
    );
    console.log(`[B24] Счета:`, JSON.stringify(response.data, null, 2));
    return response.data?.result?.items || [];
  } catch (error) {
    console.error('[B24] Ошибка getInvoicesByDeal:', error.message);
    return [];
  }
}