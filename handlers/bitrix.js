import axios from 'axios';
import dotenv from 'dotenv';
import {
  notificationExists,
  createNotification,
  invoiceNotificationExists,
  createInvoiceNotification,
  stageNotificationExists,
  createStageNotification,
  getActiveOverdueCycle,
  getCycleByPaymentDate,
  getOrCreateOverdueClient,
  updateOverdueClientStatus,
  createOverdueCycle,
  createOverdueNotifications,
  savePaymentSchedule,
  updateOverdueCycleStatus,
  updateOverdueCycleAmount,
} from '../db.js';
dotenv.config();

const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
const DEAL_CONTRACT_FIELD = process.env.DEAL_CONTRACT_FIELD;
const DEAL_INVOICE_TRIGGER = process.env.DEAL_INVOICE_TRIGGER;
const APP_TOKEN = process.env.BITRIX_APP_TOKEN;

const CONTRACT_CATEGORIES = (process.env.CONTRACT_CATEGORY_IDS || '0').split(',').map(s => s.trim());
const INVOICE_CATEGORIES = (process.env.INVOICE_CATEGORY_IDS || '0,16,18').split(',').map(s => s.trim());
const STAGE_CATEGORIES = (process.env.STAGE_CATEGORY_IDS || '2,4,6,8,10,12').split(',').map(s => s.trim());

const INVOICE_STATUSES = {
  'DT31_2:N': 'invoice_unconfirmed',
  'DT31_2:P': 'invoice_confirmed',
};

const EXCLUDED_STAGE_SUFFIXES = ['NEW', 'PREPARATION', '1'];
const OVERDUE_DAYS = [1, 3, 7, 14, 20, 30, 37];

const stagesCache = new Map();

// ─── Проверка токена ──────────────────────────────────────────────────────────

export function validateToken(auth) {
  if (!APP_TOKEN) {
    console.log('[AUTH] ⚠️ BITRIX_APP_TOKEN не задан');
    return true;
  }
  const incoming = auth?.application_token;
  if (incoming !== APP_TOKEN) {
    console.log(`[AUTH] ❌ Неверный токен`);
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
    console.log(`[HANDLER] ❌ Сделка не найдена`);
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
    console.log(`[HANDLER] ℹ️ Не WON`);
    return;
  }

  const existing = await notificationExists(dealId, 'deal_won');
  if (existing?.status === 'sent' || existing?.status === 'pending') {
    console.log(`[HANDLER] ℹ️ WON уже в очереди или отправлено`);
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

  console.log(`✅ [HANDLER] WON → в очереди`);
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

  const contactId = deal.CONTACT_ID ? parseInt(deal.CONTACT_ID) : null;
  const leadId = deal.LEAD_ID ? parseInt(deal.LEAD_ID) : null;

  if (!contactId && !leadId) {
    console.log(`[HANDLER] ❌ Нет CONTACT_ID и LEAD_ID`);
    return;
  }

  // Уведомление о договоре
  await createNotification({
    dealId: parseInt(dealId),
    type: 'contract_ready',
    contactId,
    leadId,
    dealTitle: deal.TITLE || `Сделка #${dealId}`,
    dealTypeId: deal.TYPE_ID ? String(deal.TYPE_ID) : null,
  });

  console.log(`✅ [HANDLER] Договор → уведомление в очереди`);

  // Сохраняем новый график платежей
  await updatePaymentSchedule(deal);

  // Если был активный цикл просрочки — закрываем (договор переформирован)
  const activeCycle = await getActiveOverdueCycle(parseInt(dealId));
  if (activeCycle) {
    console.log(`[HANDLER] ℹ️ Найден активный цикл id=${activeCycle.id} — закрываем (договор переформирован)`);
    await updateOverdueCycleStatus(activeCycle.id, 'resolved');
    if (contactId) {
      await updateOverdueClientStatus(contactId, 'active');
    }
  }

  // Сбрасываем поле договора = 0
  await resetContractField(dealId);
}

/**
 * Обновляем график платежей при формировании договора
 */
async function updatePaymentSchedule(deal) {
  const dealId = deal.ID;
  const contactId = deal.CONTACT_ID ? parseInt(deal.CONTACT_ID) : null;

  console.log(`\n[HANDLER] Обновление графика платежей для сделки ${dealId}`);

  // Получаем товары (график платежей)
  const products = await getProductRows(dealId);
  if (!products || products.length === 0) {
    console.log(`[HANDLER] ℹ️ Нет товаров в сделке`);
    return;
  }

  console.log(`[HANDLER] Товаров: ${products.length}`);

  // Получаем номер договора
  const contractInfo = await getContractInfo(dealId);

  // Сортируем по дате
  const sorted = [...products].sort((a, b) => getProductDate(a) - getProductDate(b));

  // Строим график
  let cumulative = 0;
  const schedule = [];

  for (let i = 0; i < sorted.length; i++) {
    const product = sorted[i];
    const amount = getProductAmount(product);
    const paymentDate = getProductDate(product);

    // Пропускаем если нет даты
    if (paymentDate.getFullYear() === 9999) {
      console.log(`[HANDLER] ⚠️ Товар ${i + 1} без даты — пропускаем`);
      continue;
    }

    cumulative = Math.round((cumulative + amount) * 100) / 100;

    const checkDate = addDays(paymentDate, 1); // просрочка = дата + 1 день

    schedule.push({
      dealId: parseInt(dealId),
      contactId,
      dealTypeId: deal.TYPE_ID ? String(deal.TYPE_ID) : null,
      dealTitle: deal.TITLE || `Сделка #${dealId}`,
      contractNumber: contractInfo.number,
      paymentNumber: i + 1,
      paymentDate: formatDateForDB(paymentDate),
      checkDate: formatDateForDB(checkDate),
      amount,
      cumulativeAmount: cumulative,
    });

    console.log(`[HANDLER] Платёж ${i + 1}: ${formatDateForDB(paymentDate)} → ${amount} руб, кумулятив ${cumulative}`);
  }

  if (schedule.length === 0) {
    console.log(`[HANDLER] ⚠️ График пустой`);
    return;
  }

  // Сохраняем в БД (перезаписываем)
  await savePaymentSchedule(dealId, schedule);
  console.log(`✅ [HANDLER] График сохранён: ${schedule.length} платежей`);
}

/**
 * Сброс поля договора = 0
 */
async function resetContractField(dealId) {
  try {
    console.log(`[B24] Сброс поля договора для сделки ${dealId}`);
    await axios.post(
      `${BITRIX_WEBHOOK}/crm.deal.update`,
      {
        id: dealId,
        fields: { [DEAL_CONTRACT_FIELD]: '0' },
      }
    );
    console.log(`[B24] ✅ Поле договора сброшено`);
  } catch (error) {
    console.error('[B24] Ошибка сброса поля договора:', error.message);
  }
}

// ─── ТРИГГЕР СЧЁТА ────────────────────────────────────────────────────────────

async function checkInvoiceTrigger(deal) {
  const dealId = deal.ID;
  const triggerValue = deal[DEAL_INVOICE_TRIGGER];
  const categoryId = deal.CATEGORY_ID;

  console.log(`\n[HANDLER] Триггер счёта: ${DEAL_INVOICE_TRIGGER} = "${triggerValue}"`);

  if (triggerValue !== '1') {
    console.log(`[HANDLER] ℹ️ Триггер не активен`);
    return;
  }

  const contactId = deal.CONTACT_ID ? parseInt(deal.CONTACT_ID) : null;
  const leadId = deal.LEAD_ID ? parseInt(deal.LEAD_ID) : null;
  const dealTypeId = deal.TYPE_ID ? String(deal.TYPE_ID) : null;

  if (!contactId && !leadId) {
    console.log(`[HANDLER] ❌ Нет CONTACT_ID и LEAD_ID`);
    await resetInvoiceTrigger(dealId);
    return;
  }

  // Получаем все счета сделки
  const invoices = await getInvoicesByDeal(dealId);

  // Считаем оплаченную сумму (только подтверждённые DT31_2:P)
  const paidAmount = invoices
    .filter(inv => inv.stageId === 'DT31_2:P')
    .reduce((sum, inv) => sum + parseFloat(inv.opportunity || 0), 0);

  console.log(`[HANDLER] Оплачено подтверждённых: ${paidAmount} руб`);

  // Обрабатываем уведомления по счетам
  for (const invoice of invoices) {
    await processInvoice(invoice, {
      dealId: parseInt(dealId),
      contactId,
      leadId,
      dealTitle: deal.TITLE || `Сделка #${dealId}`,
      dealTypeId,
    });
  }

  // Пересчёт просрочки — только Category_id=0
  if (categoryId === '0') {
    await recalcOverdue(deal, paidAmount);
  }

  await resetInvoiceTrigger(dealId);
}

/**
 * Пересчёт просрочки при получении нового счёта
 */
// Добавить в recalcOverdue после закрытия цикла:
async function recalcOverdue(deal, paidAmount) {
  const dealId = deal.ID;
  const contactId = deal.CONTACT_ID ? parseInt(deal.CONTACT_ID) : null;

  console.log(`\n[HANDLER] Пересчёт просрочки для сделки ${dealId}`);
  console.log(`[HANDLER] Оплачено (подтверждённые): ${paidAmount} руб`);

  const activeCycle = await getActiveOverdueCycle(dealId);

  if (activeCycle) {
    console.log(`[HANDLER] Активный цикл: id=${activeCycle.id}`);

    const cumulativeNeeded = parseFloat(activeCycle.paid_amount_at_start) +
      parseFloat(activeCycle.overdue_amount);

    console.log(`[HANDLER] Нужно: ${cumulativeNeeded}, оплачено: ${paidAmount}`);

    if (paidAmount >= cumulativeNeeded) {
      console.log(`[HANDLER] ✅ Просрочка погашена! Закрываем цикл`);
      await updateOverdueCycleStatus(activeCycle.id, 'resolved');
      await updateOverdueClientStatus(contactId, 'active');
      await markPaymentAsPaid(dealId, activeCycle.overdue_payment_date, paidAmount);
    } else {
      const newOverdueAmount = cumulativeNeeded - paidAmount;
      console.log(`[HANDLER] ℹ️ Частичная оплата, новая сумма: ${newOverdueAmount}`);
      await updateOverdueCycleAmount(activeCycle.id, newOverdueAmount);
    }
  } else {
    console.log(`[HANDLER] ℹ️ Активных циклов нет`);
  }
}

// ─── СТАДИИ ───────────────────────────────────────────────────────────────────

async function checkDealStage(deal) {
  const dealId = deal.ID;
  const stageId = deal.STAGE_ID;
  const categoryId = deal.CATEGORY_ID;

  console.log(`\n[HANDLER] Проверка стадии: "${stageId}", cat="${categoryId}"`);

  const stageSuffix = stageId.includes(':') ? stageId.split(':')[1] : stageId;

  if (EXCLUDED_STAGE_SUFFIXES.includes(stageSuffix)) {
    console.log(`[HANDLER] ℹ️ Стадия исключена`);
    return;
  }

  const existing = await stageNotificationExists(dealId, stageId);
  if (existing?.status === 'sent' || existing?.status === 'pending') {
    console.log(`[HANDLER] ℹ️ Стадия уже в очереди или отправлена`);
    return;
  }

  const contactId = deal.CONTACT_ID ? parseInt(deal.CONTACT_ID) : null;
  const leadId = deal.LEAD_ID ? parseInt(deal.LEAD_ID) : null;

  if (!contactId && !leadId) {
    console.log(`[HANDLER] ❌ Нет CONTACT_ID и LEAD_ID`);
    return;
  }

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

  console.log(`✅ [HANDLER] Стадия → в очереди`);
}

async function getStageName(categoryId, stageId) {
  if (stagesCache.has(categoryId)) {
    const cached = stagesCache.get(categoryId);
    if (cached[stageId]) return cached[stageId];
  }

  try {
    let stages = [];

    if (categoryId === '0') {
      const response = await axios.post(
        `${BITRIX_WEBHOOK}/crm.dealcategory.stages`,
        { id: 0 }
      );
      stages = response.data?.result || [];
    } else {
      const entityId = `DEAL_STAGE_${categoryId}`;
      const response = await axios.post(
        `${BITRIX_WEBHOOK}/crm.status.list`,
        { filter: { ENTITY_ID: entityId } }
      );
      stages = response.data?.result || [];
    }

    const stageMap = {};
    for (const stage of stages) {
      stageMap[stage.STATUS_ID] = stage.NAME;
    }

    stagesCache.set(categoryId, stageMap);
    return stageMap[stageId] || stageId;

  } catch (error) {
    console.error('[B24] Ошибка getStageName:', error.message);
    return stageId;
  }
}

// ─── СЧЕТА ────────────────────────────────────────────────────────────────────

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
    console.log(`[HANDLER] ℹ️ Уведомление уже есть`);
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

  console.log(`✅ [HANDLER] Счёт → "${notificationType}" в очереди`);
}

async function resetInvoiceTrigger(dealId) {
  try {
    await axios.post(
      `${BITRIX_WEBHOOK}/crm.deal.update`,
      {
        id: dealId,
        fields: { [DEAL_INVOICE_TRIGGER]: '0' },
      }
    );
    console.log(`[B24] ✅ Триггер счёта сброшен`);
  } catch (error) {
    console.error('[B24] Ошибка сброса триггера:', error.message);
  }
}

// ─── Запросы к Б24 ────────────────────────────────────────────────────────────

async function getDeal(dealId) {
  try {
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

async function getProductRows(dealId) {
  try {
    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.deal.productrows.get`,
      { id: dealId }
    );
    console.log(`[B24] Товаров: ${response.data?.result?.length || 0}`);
    return response.data?.result || [];
  } catch (error) {
    console.error('[B24] Ошибка getProductRows:', error.message);
    return [];
  }
}

async function getInvoicesByDeal(dealId) {
  try {
    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.item.list`,
      {
        entityTypeId: 31,
        filter: { parentId2: dealId },
        select: ['id', 'stageId', 'opportunity', 'currencyId', 'title', 'createdTime'],
        order: { createdTime: 'DESC' },
      }
    );
    return response.data?.result?.items || [];
  } catch (error) {
    console.error('[B24] Ошибка getInvoicesByDeal:', error.message);
    return [];
  }
}

async function getContactInfo(contactId) {
  try {
    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.contact.get`,
      { id: contactId }
    );
    const c = response.data?.result;
    if (!c) return { name: 'Клиент' };
    return {
      name: [c.LAST_NAME, c.NAME, c.SECOND_NAME].filter(Boolean).join(' ').trim() || 'Клиент',
    };
  } catch (error) {
    console.error('[B24] Ошибка getContactInfo:', error.message);
    return { name: 'Клиент' };
  }
}

async function getContractInfo(dealId) {
  try {
    const response = await axios.post(
      `${BITRIX_WEBHOOK}/crm.documentgenerator.document.list`,
      {
        select: ['*'],
        order: { id: 'DESC' },
        filter: { entityTypeId: 2, entityId: dealId },
        start: 0,
      }
    );
    const documents = response.data?.result?.documents || [];
    if (documents.length === 0) return { number: '—', date: '—' };

    const doc = documents[0];
    const date = doc.createTime
      ? new Date(doc.createTime).toLocaleDateString('ru-RU')
      : '—';

    return { number: doc.number || '—', date };
  } catch (error) {
    console.error('[B24] Ошибка getContractInfo:', error.message);
    return { number: '—', date: '—' };
  }
}

// ─── Вспомогательные функции ──────────────────────────────────────────────────

function getProductAmount(product) {
  const price = parseFloat(product.PRICE || product.price || 0);
  const qty = parseFloat(product.QUANTITY || product.quantity || 1);
  return price * qty;
}

function getProductDate(product) {
  const name = product.PRODUCT_NAME || product.productName || '';
  const dateMatch = name.match(/(\d{2})[.\-\/](\d{2})[.\-\/](\d{4})/);
  if (dateMatch) return new Date(`${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`);
  return new Date(9999, 0);
}

function formatDateForDB(date) {
  return date.toISOString().split('T')[0];
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}