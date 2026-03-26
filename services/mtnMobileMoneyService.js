/**
 * MTN Mobile Money Payment Service
 * Integrates with MTN Mobile Money API for payment processing.
 *
 * Credential detection is LAZY (checked at call time, not at module load)
 * so that dotenv has a chance to populate process.env before we read it.
 *
 * Auto-fallback rules:
 *   MTN_USE_MOCK=true                      -> always use mock service
 *   Credentials incomplete + non-production -> auto-use mock with a warning
 *   Credentials incomplete + production     -> throw clearly
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const readEnv = (...keys) => {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (!value) continue;
    if (value.startsWith('REPLACE_')) continue;
    return value;
  }
  return '';
};

const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  );

// Resolved lazily on first call so dotenv has already run
let _mockService = null;
function getMockService() {
  if (!_mockService) _mockService = require('./mtnMockService');
  return _mockService;
}

function credentialsComplete() {
  return Boolean(
    readEnv('MTN_CONSUMER_KEY', 'PAYMENT_PRIMARY_KEY') &&
    readEnv('MTN_CONSUMER_SECRET', 'PAYMENT_SECONDARY_KEY') &&
    readEnv('MTN_API_USER')
  );
}

function shouldUseMock() {
  if (process.env.MTN_USE_MOCK === 'true') return true;
  // In non-production: gracefully fall back to mock so development keeps working
  if (!credentialsComplete() && process.env.NODE_ENV !== 'production') {
    console.warn(
      '[MTN] Credentials incomplete (MTN_CONSUMER_SECRET empty?). ' +
      'Falling back to mock service for this request. ' +
      'Fill MTN_CONSUMER_KEY, MTN_CONSUMER_SECRET and MTN_API_USER in .env to use real payments.'
    );
    return true;
  }
  return false;
}

const MTN_CONFIG = {
  SANDBOX_COLLECTION_URL: 'https://sandbox.momodeveloper.mtn.com/collection',
  PRODUCTION_COLLECTION_URL: 'https://proxy.momoapi.mtn.com/collection',
  API_VERSION: 'v1_0',
};

function getBaseUrl() {
  return (process.env.MTN_ENV || 'sandbox') === 'production'
    ? MTN_CONFIG.PRODUCTION_COLLECTION_URL
    : MTN_CONFIG.SANDBOX_COLLECTION_URL;
}

async function generateAccessToken() {
  const consumerKey = readEnv('MTN_CONSUMER_KEY', 'PAYMENT_PRIMARY_KEY');
  const consumerSecret = readEnv('MTN_CONSUMER_SECRET', 'PAYMENT_SECONDARY_KEY');
  const apiUser = readEnv('MTN_API_USER');

  if (!consumerKey || !consumerSecret || !apiUser) {
    throw new Error(
      'Missing MTN API credentials. Set MTN_CONSUMER_KEY, MTN_CONSUMER_SECRET and MTN_API_USER in .env'
    );
  }

  if (!isUuid(apiUser)) {
    throw new Error(
      'MTN_API_USER must be a UUID from MTN sandbox provisioning (current value is not UUID format).'
    );
  }

  // MTN token endpoint: Basic Auth = base64(apiUser:consumerSecret)
  const authString = Buffer.from(`${apiUser}:${consumerSecret}`).toString('base64');

  try {
    const response = await axios.post(
      `${getBaseUrl()}/token/`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${authString}`,
          'Ocp-Apim-Subscription-Key': consumerKey,
        },
        timeout: 30000,
      }
    );

    if (!response.data || !response.data.access_token) {
      throw new Error('Invalid token response from MTN API');
    }

    console.log('[MTN] Access token generated successfully');
    return response.data.access_token;
  } catch (error) {
    if (error.response) {
      const s = error.response.status;
      console.error('[MTN] Token request failed', s, error.response.data);
      if (s === 401) {
        const keyPreview = consumerKey ? `${consumerKey.slice(0, 6)}...` : '(empty)';
        const userPreview = apiUser ? `${apiUser.slice(0, 8)}...` : '(empty)';
        throw new Error(
          `MTN authentication failed (401). Active credentials: key=${keyPreview}, apiUser=${userPreview}. ` +
          'Check that MTN_API_USER and MTN_CONSUMER_SECRET were generated together from MTN sandbox provisioning.'
        );
      }
      if (s === 403) throw new Error('MTN access forbidden - check MTN_CONSUMER_KEY (Ocp-Apim-Subscription-Key)');
      throw new Error(`MTN token request failed (HTTP ${s}): ${JSON.stringify(error.response.data)}`);
    }
    if (error.code === 'ECONNABORTED') throw new Error('MTN API timeout - sandbox may be slow, retry later');
    throw new Error(`Failed to generate MTN access token: ${error.message}`);
  }
}

async function requestToPay(paymentData) {
  if (shouldUseMock()) return getMockService().requestToPay(paymentData);

  const { amount, currency, externalId } = paymentData;

  // Accept phone from payer.partyId (MTN shape) or top-level phoneNumber
  const rawPhone =
    (paymentData.payer && paymentData.payer.partyId) ||
    paymentData.phoneNumber ||
    '';

  if (!amount || Number(amount) <= 0) throw new Error('Invalid amount. Amount must be greater than 0.');
  if (!currency) throw new Error('Currency is required.');
  if (!rawPhone) throw new Error('Phone number is required.');
  if (!externalId) throw new Error('externalId (transaction reference) is required.');

  const referenceId = uuidv4();
  const accessToken = await generateAccessToken();
  const formattedPhone = String(rawPhone).replace(/[\s+]/g, '');

  const requestBody = {
    amount: String(amount),
    currency: currency,
    externalId: externalId,
    payer: { partyIdType: 'MSISDN', partyId: formattedPhone },
    payerMessage: paymentData.payerMessage || 'SafariTix Bus Ticket Payment',
    payeeNote: paymentData.payeeNote || ('Payment for ' + externalId),
  };

  console.log('[MTN] Request-to-Pay:', {
    referenceId: referenceId,
    amount: requestBody.amount,
    currency: currency,
    phone: '***' + formattedPhone.slice(-4),
  });

  try {
    const subscriptionKey = readEnv('MTN_CONSUMER_KEY', 'PAYMENT_PRIMARY_KEY');
    const targetEnvironment =
      (process.env.MTN_ENV || 'sandbox') === 'production'
        ? (process.env.MTN_TARGET_ENVIRONMENT || 'mtnrwanda')
        : 'sandbox';

    const response = await axios.post(
      `${getBaseUrl()}/${MTN_CONFIG.API_VERSION}/requesttopay`,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Reference-Id': referenceId,
          'X-Target-Environment': targetEnvironment,
          'Ocp-Apim-Subscription-Key': subscriptionKey,
        },
        timeout: 30000,
      }
    );

    if (response.status !== 202) {
      throw new Error('Unexpected response status: ' + response.status);
    }

    console.log('[MTN] Request-to-Pay initiated successfully (202 Accepted)');
    return {
      success: true,
      referenceId: referenceId,
      status: 'PENDING',
      message: 'Payment request sent successfully. Waiting for customer approval.',
      externalId: externalId,
    };
  } catch (error) {
    if (error.response) {
      const s = error.response.status;
      const d = error.response.data;
      console.error('[MTN] Request-to-Pay error', s, d);
      if (s === 400) throw new Error('Invalid request: ' + (d && d.message ? d.message : 'bad request to MTN API'));
      if (s === 409) throw new Error('Duplicate transaction. This payment reference already exists.');
      if (s === 500) throw new Error('MTN API server error. Please try again later.');
      throw new Error('MTN request-to-pay failed (HTTP ' + s + ')');
    }
    throw new Error('Payment request failed: ' + error.message);
  }
}

async function checkTransactionStatus(referenceId) {
  if (shouldUseMock()) return getMockService().checkTransactionStatus(referenceId);

  if (!referenceId) throw new Error('Reference ID is required to check transaction status.');

  const accessToken = await generateAccessToken();
  console.log('[MTN] Checking transaction status:', referenceId);

  try {
    const subscriptionKey = readEnv('MTN_CONSUMER_KEY', 'PAYMENT_PRIMARY_KEY');
    const targetEnvironment =
      (process.env.MTN_ENV || 'sandbox') === 'production'
        ? (process.env.MTN_TARGET_ENVIRONMENT || 'mtnrwanda')
        : 'sandbox';

    const response = await axios.get(
      `${getBaseUrl()}/${MTN_CONFIG.API_VERSION}/requesttopay/${referenceId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Target-Environment': targetEnvironment,
          'Ocp-Apim-Subscription-Key': subscriptionKey,
        },
        timeout: 10000,
      }
    );

    const data = response.data;
    console.log('[MTN] Transaction Status:', { referenceId: referenceId, status: data.status });

    return {
      success: true,
      referenceId: referenceId,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      financialTransactionId: data.financialTransactionId,
      externalId: data.externalId,
      reason: data.reason,
    };
  } catch (error) {
    if (error.response && error.response.status === 404) {
      throw new Error('Transaction not found. Invalid reference ID.');
    }
    throw new Error('Failed to check transaction status: ' + error.message);
  }
}

async function getAccountBalance() {
  if (shouldUseMock()) {
    var mock = getMockService();
    return (mock.getAccountBalance && mock.getAccountBalance()) || { success: true, availableBalance: '0', currency: 'RWF' };
  }
  const accessToken = await generateAccessToken();
  const subscriptionKey = readEnv('MTN_CONSUMER_KEY', 'PAYMENT_PRIMARY_KEY');
  const targetEnvironment =
    (process.env.MTN_ENV || 'sandbox') === 'production'
      ? (process.env.MTN_TARGET_ENVIRONMENT || 'mtnrwanda')
      : 'sandbox';
  const response = await axios.get(
    `${getBaseUrl()}/${MTN_CONFIG.API_VERSION}/account/balance`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Target-Environment': targetEnvironment,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
      },
      timeout: 10000,
    }
  );
  return { success: true, availableBalance: response.data.availableBalance, currency: response.data.currency };
}

async function validateAccountHolder(phoneNumber, accountHolderIdType) {
  if (!accountHolderIdType) accountHolderIdType = 'msisdn';
  if (shouldUseMock()) return { success: true, isActive: true, phoneNumber: phoneNumber };
  if (!phoneNumber) throw new Error('Phone number is required for validation.');

  const accessToken = await generateAccessToken();
  const subscriptionKey = readEnv('MTN_CONSUMER_KEY', 'PAYMENT_PRIMARY_KEY');
  const targetEnvironment =
    (process.env.MTN_ENV || 'sandbox') === 'production'
      ? (process.env.MTN_TARGET_ENVIRONMENT || 'mtnrwanda')
      : 'sandbox';
  const formattedPhone = String(phoneNumber).replace(/[\s+]/g, '');

  try {
    const response = await axios.get(
      `${getBaseUrl()}/${MTN_CONFIG.API_VERSION}/accountholder/${accountHolderIdType}/${formattedPhone}/active`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Target-Environment': targetEnvironment,
          'Ocp-Apim-Subscription-Key': subscriptionKey,
        },
        timeout: 10000,
      }
    );
    return { success: true, isActive: response.data.result === true, phoneNumber: formattedPhone };
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return { success: false, isActive: false, phoneNumber: phoneNumber, message: 'Phone number not registered with MTN Mobile Money' };
    }
    throw new Error('Account validation failed: ' + error.message);
  }
}

async function processPayment(paymentData) {
  try {
    const paymentRequest = await requestToPay(paymentData);
    return {
      success: true,
      referenceId: paymentRequest.referenceId,
      status: paymentRequest.status,
      message: 'Payment request sent. Customer needs to approve on their phone.',
      externalId: paymentRequest.externalId,
    };
  } catch (error) {
    console.error('[MTN] processPayment error:', error.message);
    return { success: false, error: error.message, status: 'FAILED' };
  }
}

module.exports = {
  generateAccessToken,
  requestToPay,
  checkTransactionStatus,
  getAccountBalance,
  validateAccountHolder,
  processPayment,
};
