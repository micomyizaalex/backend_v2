const fetch = require('node-fetch');

async function testTicketsAPI() {
  try {
    // You'll need to replace this with a real token
    const token = 'YOUR_TOKEN_HERE';
    
    const response = await fetch('https://backend-7cxc.onrender.com/api/$1/api/company/tickets', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    console.log('\n📊 API Response:');
    console.log(JSON.stringify(data, null, 2));

    if (data.tickets) {
      console.log(`\n✅ Found ${data.tickets.length} tickets`);
      
      if (data.tickets.length > 0) {
        console.log('\nFirst ticket structure:');
        console.log(JSON.stringify(data.tickets[0], null, 2));
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

console.log('⚠️  MANUAL TEST REQUIRED');
console.log('1. Login to the company dashboard');
console.log('2. Open browser DevTools (F12)');
console.log('3. Go to Console tab');
console.log('4. Run: localStorage.getItem("token")');
console.log('5. Copy the token value');
console.log('6. Replace YOUR_TOKEN_HERE in this script');
console.log('7. Run: node scripts/test-tickets-api.js\n');

// testTicketsAPI();
