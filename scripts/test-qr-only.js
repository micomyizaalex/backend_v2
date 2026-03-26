require('dotenv').config();
const QRCode = require('qrcode');

async function testQRCode() {
  console.log('🧪 Testing QR Code Generation\n');
  
  // Test data (simplified)
  const qrData = {
    t: 'test-ticket-001',
    b: 'BK-2026-TEST001',
    s: 'A1',
    o: 'Kigali',
    d: 'Musanze',
    dt: '2026-02-25T10:00:00',
    v: 'https://backend-v2-wjcs.onrender.com/api/$1/api/tickets/verify/test-ticket-001'
  };
  
  console.log('📦 QR Data:', qrData);
  console.log('📏 JSON size:', JSON.stringify(qrData).length, 'bytes\n');
  
  try {
    // Generate QR code
    const qrDataURL = await QRCode.toDataURL(JSON.stringify(qrData), {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      width: 140,
      color: {
        dark: '#2B2D42',
        light: '#FFFFFF'
      }
    });
    
    const sizeKB = (qrDataURL.length * 0.75 / 1024).toFixed(2);
    
    console.log('✅ QR Code Generated Successfully!');
    console.log('📊 Stats:');
    console.log('   - Size:', sizeKB, 'KB');
    console.log('   - Total length:', qrDataURL.length, 'characters');
    console.log('   - Starts with:', qrDataURL.substring(0, 50));
    console.log('   - Format:', qrDataURL.substring(0, 22));
    
    // Test if it's a valid base64 image
    if (qrDataURL.startsWith('data:image/png;base64,')) {
      console.log('\n✅ Valid PNG base64 data URL format');
      
      // Extract just the base64 part (without the prefix)
      const base64Data = qrDataURL.split(',')[1];
      console.log('📝 Base64 data length:', base64Data.length);
      
      // Test HTML embedding
      const testHTML = `
<!DOCTYPE html>
<html>
<body>
  <h1>QR Code Test</h1>
  <img src="${qrDataURL}" alt="Test QR" width="140" height="140" />
  <p>If you see a QR code above, it works!</p>
</body>
</html>
      `;
      
      const fs = require('fs');
      fs.writeFileSync('test-qr.html', testHTML);
      console.log('\n📄 Test HTML file created: test-qr.html');
      console.log('👉 Open this file in your browser to verify QR renders');
      
    } else {
      console.log('\n❌ Invalid data URL format!');
    }
    
  } catch (error) {
    console.error('\n❌ QR Code Generation Failed:');
    console.error(error);
  }
}

testQRCode().then(() => {
  console.log('\n✅ Test complete');
  process.exit(0);
}).catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
