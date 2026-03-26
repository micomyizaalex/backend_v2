/**
 * provision-mtn-sandbox.js
 *
 * Run ONCE to create a sandbox API user and generate its key.
 * Prints the three env values you need to paste into .env.
 *
 * Usage:
 *   1. Set MTN_CONSUMER_KEY in .env to your Ocp-Apim-Subscription-Key
 *      (from the "Collection" product on https://momodeveloper.mtn.com)
 *   2. node scripts/provision-mtn-sandbox.js
 */

require('dotenv').config();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const firstRealValue = (...values) => {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    if (normalized.startsWith('REPLACE_')) continue;
    return normalized;
  }
  return '';
};

const SUBSCRIPTION_KEY = firstRealValue(
  process.env.MTN_CONSUMER_KEY,
  process.env.PAYMENT_PRIMARY_KEY
);
const BASE_URL = 'https://sandbox.momodeveloper.mtn.com';

if (!SUBSCRIPTION_KEY || SUBSCRIPTION_KEY.startsWith('REPLACE_')) {
  console.error(
    '\nERROR: subscription key is not set.\n' +
    'Go to https://momodeveloper.mtn.com, subscribe to the "Collection" product,\n' +
    'copy the Ocp-Apim-Subscription-Key and set it as MTN_CONSUMER_KEY or PAYMENT_PRIMARY_KEY in .env.\n'
  );
  process.exit(1);
}

async function provision() {
  const apiUser = uuidv4();

  console.log('\nProvisioning MTN sandbox API user...');
  console.log('API User UUID:', apiUser);
  console.log('Subscription Key:', SUBSCRIPTION_KEY.substring(0, 6) + '...\n');

  // Step 1: Create API user
  try {
    await axios.post(
      `${BASE_URL}/v1_0/apiuser`,
      { providerCallbackHost: 'webhook.site' },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Reference-Id': apiUser,
          'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
        },
      }
    );
    console.log('Step 1/3: API user created');
  } catch (err) {
    if (err.response && err.response.status === 409) {
      // 409 = already exists, safe to continue
      console.log('Step 1/3: API user already exists (409) - continuing');
    } else {
      const detail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
      console.error('\nFailed to create API user:', detail);
      console.error('\nTroubleshooting:');
      console.error('  - 401: Invalid MTN_CONSUMER_KEY. Get it from the "Collection" product subscription.');
      console.error('  - 403: You have not subscribed to "Sandbox User Provisioning" product.');
      process.exit(1);
    }
  }

  // Step 2: Generate API key for the user
  let apiKey;
  try {
    const keyRes = await axios.post(
      `${BASE_URL}/v1_0/apiuser/${apiUser}/apikey`,
      {},
      {
        headers: {
          'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
        },
      }
    );
    apiKey = keyRes.data.apiKey;
    console.log('Step 2/3: API key generated');
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    console.error('\nFailed to generate API key:', detail);
    process.exit(1);
  }

  // Step 3: Verify by fetching user info
  try {
    const infoRes = await axios.get(
      `${BASE_URL}/v1_0/apiuser/${apiUser}`,
      {
        headers: { 'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY },
      }
    );
    console.log('Step 3/3: API user verified:', JSON.stringify(infoRes.data));
  } catch (err) {
    console.warn('Step 3/3: Could not verify (non-fatal):', err.message);
  }

  console.log('\n======================================================');
  console.log('SUCCESS! Paste these values into your .env:\n');
  console.log(`MTN_CONSUMER_KEY=${SUBSCRIPTION_KEY}`);
  console.log(`MTN_API_USER=${apiUser}`);
  console.log(`MTN_CONSUMER_SECRET=${apiKey}`);
  console.log(`PAYMENT_PRIMARY_KEY=${SUBSCRIPTION_KEY}`);
  console.log(`PAYMENT_SECONDARY_KEY=${apiKey}`);
  console.log('MTN_ENV=sandbox');
  console.log('MTN_USE_MOCK=false');
  console.log('======================================================\n');
}

provision().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
