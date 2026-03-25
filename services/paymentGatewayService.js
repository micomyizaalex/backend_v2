const axios = require('axios');
const mtnService = require('./mtnMobileMoneyService');

const readEnv = (...keys) => {
  for (const key of keys) {
    if (typeof process.env[key] === 'string' && process.env[key].trim()) {
      return process.env[key].trim();
    }
  }
  return '';
};

const PROVIDER_KIND = readEnv('PAYMENT_PROVIDER', 'PAYMENT_GATEWAY', 'MOBILE_MONEY_PROVIDER') || 'auto';
const PAYMENT_API_ID = readEnv('PAYMENT_API_ID', 'API ID');
const PAYMENT_API_KEY = readEnv('PAYMENT_API_KEY', 'API Key');
const PAYMENT_API_BASE_URL = readEnv('PAYMENT_API_BASE_URL', 'PAYMENT_PROVIDER_BASE_URL', 'PAYMENT_COLLECTION_BASE_URL');
const PAYMENT_INITIATE_PATH = readEnv('PAYMENT_INITIATE_PATH') || '/payments/initiate';
const PAYMENT_STATUS_PATH = readEnv('PAYMENT_STATUS_PATH') || '/payments/status';
const PAYMENT_INITIATE_FALLBACK_PATHS = (readEnv('PAYMENT_INITIATE_FALLBACK_PATHS') || '/pay,/initiate,/payments/initiate')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const PAYMENT_STATUS_FALLBACK_PATHS = (readEnv('PAYMENT_STATUS_FALLBACK_PATHS') || '/get_pay,/status,/payments/status')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const IS_HDEV_CREDENTIAL = /^HDEV-/i.test(PAYMENT_API_ID) || /^HDEV-/i.test(PAYMENT_API_KEY);

const normalizeStatus = (rawStatus) => {
  const value = String(rawStatus || '').trim().toLowerCase();
  if (!value) return 'pending';
  if (['pending', 'processing', 'initiated', 'requested', 'waiting', 'queued'].includes(value)) return 'pending';
  if (['success', 'successful', 'completed', 'paid', 'approved', 'ok', 'done'].includes(value)) return 'success';
  if (['failed', 'error', 'rejected', 'cancelled', 'canceled', 'expired', 'timeout', 'declined', 'fail'].includes(value)) return 'failed';
  return 'pending';
};

const extractProviderReference = (data) => {
  if (!data || typeof data !== 'object') return null;
  return (
    data.provider_reference ||
    data.providerReference ||
    data.reference ||
    data.transaction_id ||
    data.transactionId ||
    data.tx_ref ||
    data.txRef ||
    data.transaction_ref ||
    data?.data?.provider_reference ||
    data?.data?.reference ||
    data?.data?.transaction_id ||
    data?.result?.provider_reference ||
    data?.result?.reference ||
    null
  );
};

const extractStatusValue = (data) => {
  if (!data) return '';
  if (typeof data === 'string') return data;
  return (
    data.status ||
    data.payment_status ||
    data.transaction_status ||
    data.state ||
    data.result ||
    data?.data?.status ||
    data?.data?.payment_status ||
    data?.result?.status ||
    ''
  );
};

const hasPositiveProviderAck = (data) => {
  if (!data) return false;

  const status = normalizeStatus(extractStatusValue(data));
  const hasRef = Boolean(extractProviderReference(data));

  const successFlag = data.success;
  const successLike = successFlag === true || successFlag === 'true' || successFlag === 1 || successFlag === '1';

  const code = Number(data.code || data.status_code || data.statusCode || 0);
  const codeLike = code >= 200 && code < 300;

  const msg = String(data.message || data.msg || data.description || '').toLowerCase();
  const messageLike = /(success|initiat|request sent|processing|accepted|queued|pending)/i.test(msg);

  if (hasRef) return true;
  if (successLike && (status === 'pending' || status === 'success')) return true;
  if (codeLike && (status === 'pending' || status === 'success')) return true;
  if (messageLike && (status === 'pending' || status === 'success')) return true;

  return false;
};

const buildGenericHeaders = () => {
  if (!PAYMENT_API_ID || !PAYMENT_API_KEY) {
    throw new Error('Missing payment provider credentials. Configure PAYMENT_API_ID and PAYMENT_API_KEY.');
  }

  return {
    'Content-Type': 'application/json',
    'X-API-ID': PAYMENT_API_ID,
    'X-API-KEY': PAYMENT_API_KEY,
    'x-api-id': PAYMENT_API_ID,
    'x-api-key': PAYMENT_API_KEY,
    Authorization: `Bearer ${PAYMENT_API_KEY}`,
  };
};

const detectNetworkFromPhone = (phoneNumber, paymentMethod) => {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  const local = digits.startsWith('250') ? digits.slice(3) : digits;
  const prefix = local.slice(0, 3);

  if (paymentMethod === 'airtel_money') return 'airtel';
  if (prefix === '078' || prefix === '079') return 'mtn';
  if (prefix === '072' || prefix === '073') return 'airtel';

  if (paymentMethod === 'mobile_money') return '';
  return '';
};

const enrichProviderError = (error, actionLabel) => {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '');

  if (code === 'EPROTO' || /packet length too long/i.test(message)) {
    throw new Error(
      `${actionLabel} failed due to TLS handshake error (EPROTO). ` +
      `Check PAYMENT_API_BASE_URL protocol/port and network filtering for ${PAYMENT_API_BASE_URL || 'provider URL'}.`
    );
  }

  if (error?.response?.status) {
    const status = error.response.status;
    const body = typeof error.response.data === 'string'
      ? error.response.data
      : JSON.stringify(error.response.data || {});
    throw new Error(`${actionLabel} failed (HTTP ${status}): ${body}`);
  }

  if (code) {
    throw new Error(`${actionLabel} failed (${code}): ${message || 'Unknown provider error'}`);
  }

  throw new Error(`${actionLabel} failed: ${message || 'Unknown provider error'}`);
};

const detectProviderKind = () => {
  if (PROVIDER_KIND !== 'auto') return PROVIDER_KIND;
  if (PAYMENT_API_BASE_URL) return 'generic';

  const hasMtnConfig = Boolean(
    readEnv('MTN_CONSUMER_KEY') &&
    readEnv('MTN_CONSUMER_SECRET') &&
    readEnv('MTN_API_USER')
  );

  if (hasMtnConfig || process.env.MTN_USE_MOCK === 'true') {
    return 'mtn';
  }

  return 'mtn';
};

const verifyAckWithStatusProbe = async ({ reference }) => {
  if (!reference || !PAYMENT_API_BASE_URL) return { acknowledged: false };

  const baseUrl = PAYMENT_API_BASE_URL.replace(/\/$/, '');
  const statusPaths = [PAYMENT_STATUS_PATH, ...PAYMENT_STATUS_FALLBACK_PATHS]
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  const urls = [];
  for (const path of statusPaths) {
    const ref = encodeURIComponent(reference);
    urls.push(`${baseUrl}${path}/${ref}`);
    urls.push(`${baseUrl}${path}?provider_reference=${ref}`);
    urls.push(`${baseUrl}${path}?reference=${ref}`);
    urls.push(`${baseUrl}${path}?tx_ref=${ref}`);
    urls.push(`${baseUrl}${path}?transaction_ref=${ref}`);
  }

  for (const url of urls) {
    try {
      const resp = await axios.get(url, {
        headers: buildGenericHeaders(),
        timeout: 10000,
      });
      const data = resp.data || {};
      const status = normalizeStatus(extractStatusValue(data));
      if (status === 'pending' || status === 'success') {
        return {
          acknowledged: true,
          status,
          raw: data,
          providerReference: extractProviderReference(data) || reference,
          via: 'status_probe',
        };
      }
    } catch (error) {
      const http = Number(error?.response?.status || 0);
      if (http && http !== 404) {
        break;
      }
    }
  }

  return { acknowledged: false };
};

const initiateCollection = async ({ amount, currency, phoneNumber, reference, description, paymentMethod, callbackUrl }) => {
  const providerKind = detectProviderKind();

  if (providerKind === 'mtn') {
    const response = await mtnService.requestToPay({
      amount,
      currency,
      externalId: reference,
      payerMessage: description,
      payeeNote: description,
      payer: {
        partyIdType: 'MSISDN',
        partyId: phoneNumber,
      },
      phoneNumber,
    });

    return {
      provider: 'mtn',
      providerReference: response.referenceId,
      externalReference: response.externalId || reference,
      status: normalizeStatus(response.status),
      acknowledged: true,
      raw: response,
    };
  }

  if (!PAYMENT_API_BASE_URL) {
    throw new Error('Missing PAYMENT_API_BASE_URL for generic payment provider integration.');
  }

  const network = detectNetworkFromPhone(phoneNumber, paymentMethod);

  const payload = {
    amount,
    currency,
    phone_number: phoneNumber,
    phone: phoneNumber,
    msisdn: phoneNumber,
    mobile: phoneNumber,
    customer_msisdn: phoneNumber,
    payment_method: paymentMethod,
    channel: 'mobile_money',
    reference,
    description,
    callback_url: callbackUrl,
    tel: phoneNumber,
    transaction_ref: reference,
    callback: callbackUrl,
    operator: network,
    network,
  };

  const baseUrl = PAYMENT_API_BASE_URL.replace(/\/$/, '');
  const initiatePaths = [PAYMENT_INITIATE_PATH, ...PAYMENT_INITIATE_FALLBACK_PATHS]
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  let response;
  let lastError;
  for (const path of initiatePaths) {
    try {
      response = await axios.post(
        `${baseUrl}${path}`,
        payload,
        {
          headers: buildGenericHeaders(),
          timeout: 30000,
        }
      );
      break;
    } catch (error) {
      lastError = error;
      const status = Number(error?.response?.status || 0);
      if (status !== 404) {
        enrichProviderError(error, 'Payment initiation');
      }
    }
  }

  if (!response) {
    enrichProviderError(lastError || new Error('No initiate endpoint responded'), 'Payment initiation');
  }

  const data = response.data || {};
  const status = normalizeStatus(extractStatusValue(data) || 'pending');
  let providerReference = extractProviderReference(data);
  let pushAcknowledged = hasPositiveProviderAck(data);

  if (!pushAcknowledged && IS_HDEV_CREDENTIAL) {
    const probe = await verifyAckWithStatusProbe({ reference });
    if (probe.acknowledged) {
      pushAcknowledged = true;
      providerReference = probe.providerReference || providerReference;
    }
  }

  if (!providerReference && IS_HDEV_CREDENTIAL && pushAcknowledged) {
    providerReference = reference;
  }

  return {
    provider: 'generic',
    providerReference,
    externalReference: data.external_reference || data.reference || reference,
    status,
    acknowledged: pushAcknowledged,
    raw: data,
  };
};

const getCollectionStatus = async ({ providerReference }) => {
  const providerKind = detectProviderKind();

  if (!providerReference) {
    throw new Error('providerReference is required to fetch payment status');
  }

  if (providerKind === 'mtn') {
    const response = await mtnService.checkTransactionStatus(providerReference);
    return {
      provider: 'mtn',
      providerReference,
      status: normalizeStatus(response.status),
      raw: response,
    };
  }

  if (!PAYMENT_API_BASE_URL) {
    throw new Error('Missing PAYMENT_API_BASE_URL for generic payment provider integration.');
  }

  const baseUrl = PAYMENT_API_BASE_URL.replace(/\/$/, '');
  const statusPaths = [PAYMENT_STATUS_PATH, ...PAYMENT_STATUS_FALLBACK_PATHS]
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  const statusUrls = [];
  for (const path of statusPaths) {
    const ref = encodeURIComponent(providerReference);
    statusUrls.push(`${baseUrl}${path}/${ref}`);
    statusUrls.push(`${baseUrl}${path}?provider_reference=${ref}`);
    statusUrls.push(`${baseUrl}${path}?reference=${ref}`);
    statusUrls.push(`${baseUrl}${path}?tx_ref=${ref}`);
    if (IS_HDEV_CREDENTIAL) {
      statusUrls.push(`${baseUrl}${path}?transaction_ref=${ref}`);
    }
  }

  let response;
  let lastError;
  for (const url of statusUrls) {
    try {
      response = await axios.get(url, {
        headers: buildGenericHeaders(),
        timeout: 20000,
      });
      break;
    } catch (error) {
      lastError = error;
      const statusCode = Number(error?.response?.status || 0);
      if (statusCode !== 404) {
        enrichProviderError(error, 'Payment status check');
      }
    }
  }

  if (!response) {
    enrichProviderError(lastError || new Error('No status endpoint responded'), 'Payment status check');
  }

  const data = response.data || {};
  const rawStatus = extractStatusValue(data);
  const asText = typeof data === 'string' ? data : JSON.stringify(data);
  const notFoundLike = /not\s*found/i.test(asText);

  return {
    provider: 'generic',
    providerReference,
    status: notFoundLike ? 'pending' : normalizeStatus(rawStatus),
    raw: data,
  };
};

const extractWebhookEvent = (payload) => {
  const providerReference =
    payload?.provider_reference ||
    payload?.reference ||
    payload?.transaction_id ||
    payload?.data?.provider_reference ||
    payload?.data?.reference ||
    payload?.data?.transaction_id ||
    '';

  const externalReference =
    payload?.external_reference ||
    payload?.externalId ||
    payload?.reference ||
    payload?.data?.external_reference ||
    payload?.data?.externalId ||
    '';

  const rawStatus =
    payload?.status ||
    payload?.payment_status ||
    payload?.transaction_status ||
    payload?.data?.status ||
    payload?.event?.status ||
    '';

  return {
    providerReference,
    externalReference,
    status: normalizeStatus(rawStatus),
    raw: payload,
  };
};

module.exports = {
  initiateCollection,
  getCollectionStatus,
  extractWebhookEvent,
  normalizeStatus,
};
