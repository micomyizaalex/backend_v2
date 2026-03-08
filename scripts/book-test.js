
(async () => {
  try {
    const email = process.env.EMAIL || process.argv[2];
    const password = process.env.PASSWORD || process.argv[3];
    const scheduleId = process.env.SCHEDULE_ID || process.argv[4];
    const seatNumber = process.env.SEAT_NUMBER || process.argv[5] || '5';
    const price = process.env.PRICE || process.argv[6] || 0;
    const host = (process.env.HOST || process.argv[7] || 'https://backend-7cxc.onrender.com/api/$1').replace(/\/$/, '');

    if (!email || !password || !scheduleId) {
      console.error('Usage: node scripts/book-test.js <email> <password> <scheduleId> [seatNumber] [price] [host]');
      process.exit(1);
    }

    if (typeof fetch !== 'function') {
      console.error('This script requires Node 18+ with global fetch. Alternatively use the curl script in README.');
      process.exit(1);
    }

    console.log('Logging in as', email);
    const loginRes = await fetch(`${host}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const loginJson = await loginRes.json().catch(() => null);
    if (!loginRes.ok) {
      console.error('Login failed', loginRes.status, loginJson || await loginRes.text());
      process.exit(1);
    }

    const token = loginJson && loginJson.token;
    if (!token) {
      console.error('No token returned from login:', JSON.stringify(loginJson, null, 2));
      process.exit(1);
    }

    console.log('Logged in, token acquired. Attempting to book seat', seatNumber, 'on schedule', scheduleId);

    const bookRes = await fetch(`${host}/api/seats/schedules/${scheduleId}/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ seat_number: String(seatNumber), price }),
    });

    let bookJson;
    try { bookJson = await bookRes.json(); } catch (e) { bookJson = await bookRes.text(); }

    console.log('Booking response status:', bookRes.status);
    console.log('Booking response body:', typeof bookJson === 'string' ? bookJson : JSON.stringify(bookJson, null, 2));

    process.exit(bookRes.ok ? 0 : 2);
  } catch (err) {
    console.error('Script error:', err && err.stack ? err.stack : err);
    process.exit(3);
  }
})();
