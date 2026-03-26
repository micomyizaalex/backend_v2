require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const readEnv = (key) => String(process.env[key] || '').trim();

const CONFIG = {
  primaryKey: readEnv('PAYMENT_PRIMARY_KEY'),
  secondaryKey: readEnv('PAYMENT_SECONDARY_KEY'),
  apiUser: readEnv('MTN_API_USER'),
  environment: (readEnv('MTN_ENV') || 'sandbox').toLowerCase(),
  targetEnvironment: readEnv('MTN_TARGET_ENVIRONMENT'),
};

const API_BASE =
  CONFIG.environment === 'production'
    ? 'https://proxy.momoapi.mtn.com/collection'
    : 'https://sandbox.momodeveloper.mtn.com/collection';

const TARGET_ENVIRONMENT =
  CONFIG.targetEnvironment ||
  (CONFIG.environment === 'production' ? 'mtnrwanda' : 'sandbox');

const normalizeMsisdn = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('250')) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `250${digits.slice(1)}`;
  if (digits.length === 9) return `250${digits}`;
  return digits;
};

const looksLikeUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());

const randomUuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

async function requestMobileMoneyPayment({
  amount,
  currency = 'RWF',
  externalId,
  phoneNumber,
  payerMessage,
  payeeNote,
}) {
  if (!CONFIG.primaryKey || !CONFIG.secondaryKey || !CONFIG.apiUser) {
    throw new Error(
      'Missing required env vars. Set PAYMENT_PRIMARY_KEY, PAYMENT_SECONDARY_KEY, and MTN_API_USER in .env.'
    );
  }

  if (!looksLikeUuid(CONFIG.apiUser)) {
    console.warn(
      'Warning: MTN_API_USER is not a UUID. MTN usually requires a UUID API user generated via provisioning.'
    );
  }

  if (!amount || Number(amount) <= 0) {
    throw new Error('Amount must be a positive number.');
  }

  if (!externalId) {
    throw new Error('externalId/reference is required.');
  }

  const msisdn = normalizeMsisdn(phoneNumber);
  if (!msisdn) {
    throw new Error('A valid phone number is required.');
  }

  const referenceId = randomUuid();
  const basicAuth = Buffer.from(`${CONFIG.primaryKey}:${CONFIG.secondaryKey}`).toString('base64');

  const getAccessToken = async () => {
    const tokenResponse = await axios.post(
      `${API_BASE}/token/`,
      {},
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': CONFIG.primaryKey,
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    if (tokenResponse.status < 200 || tokenResponse.status >= 300 || !tokenResponse.data?.access_token) {
      if (tokenResponse.status === 401) {
        throw new Error(
          'Token request failed (401 invalid subscription key). ' +
          'PAYMENT_PRIMARY_KEY must be a valid Ocp-Apim-Subscription-Key from an active MTN Collection subscription.'
        );
      }
      throw new Error(
        `Token request failed (${tokenResponse.status}). ` +
        `Body: ${typeof tokenResponse.data === 'string' ? tokenResponse.data.slice(0, 200) : JSON.stringify(tokenResponse.data)}`
      );
    }

    return tokenResponse.data.access_token;
  };

  const payload = {
    amount: String(amount),
    currency,
    externalId,
    payer: {
      partyIdType: 'MSISDN',
      partyId: msisdn,
    },
    payerMessage: payerMessage || `Payment for ${externalId}`,
    payeeNote: payeeNote || `SafariTix booking ${externalId}`,
  };

  const accessToken = await getAccessToken();

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'X-Reference-Id': referenceId,
    'X-Target-Environment': TARGET_ENVIRONMENT,
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': CONFIG.primaryKey,
  };

  console.log('Sending MTN RequestToPay...');
  console.log({
    apiBase: API_BASE,
    environment: CONFIG.environment,
    targetEnvironment: TARGET_ENVIRONMENT,
    referenceId,
    externalId,
    amount: payload.amount,
    currency: payload.currency,
    phone: `***${msisdn.slice(-4)}`,
  });

  try {
    const response = await axios.post(`${API_BASE}/v1_0/requesttopay`, payload, {
      headers,
      timeout: 30000,
      validateStatus: () => true,
    });

    const success = response.status >= 200 && response.status < 300;

    if (success) {
      console.log('Payment request accepted by MTN provider.');
      console.log('HTTP Status:', response.status);
      console.log('Response:', response.data || '(empty body)');
      return {
        success: true,
        statusCode: response.status,
        referenceId,
        data: response.data,
      };
    }

    console.error('Payment request failed.');
    console.error('HTTP Status:', response.status);
    console.error('Response:', response.data);

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    if (contentType.includes('text/html')) {
      console.error(
        'Hint: Received HTML from a portal page. Check MTN_ENV / MTN_TARGET_ENVIRONMENT and ensure you are using API gateway credentials, not portal login keys.'
      );
    }

    return {
      success: false,
      statusCode: response.status,
      referenceId,
      data: response.data,
    };
  } catch (error) {
    console.error('Payment request error:', error.message);
    if (error.response) {
      console.error('HTTP Status:', error.response.status);
      console.error('Response:', error.response.data);
    }
    return {
      success: false,
      referenceId,
      error: error.message,
    };
  }
}

async function runExample() {
  const result = await requestMobileMoneyPayment({
    amount: 1000,
    currency: 'RWF',
    externalId: 'INV-001',
    phoneNumber: '250788123456',
    payerMessage: 'SafariTix payment INV-001',
    payeeNote: 'Bus booking payment',
  });

  console.log('Final Result:', result);
}

if (require.main === module) {
  runExample().catch((error) => {
    console.error('Script failed:', error.message);
    process.exit(1);
  });
}

module.exports = {
  requestMobileMoneyPayment,
};
