// Quick test: Find schedule with tickets
require('dotenv').config();
const pool = require('./config/pgPool');

async function findBookedSchedule() {
  try {
    const query = `
      SELECT 
        s.id as schedule_id,
        COUNT(t.id) as ticket_count
      FROM schedules s
      LEFT JOIN tickets t ON t.schedule_id = s.id AND t.status IN ('CONFIRMED', 'CHECKED_IN')
      GROUP BY s.id
      HAVING COUNT(t.id) > 0
      ORDER BY COUNT(t.id) DESC
      LIMIT 1
    `;
    
    const result = await pool.query(query);
    
    if (result.rows.length > 0) {
      const scheduleId = result.rows[0].schedule_id;
      const count = result.rows[0].ticket_count;
      console.log(`\nSchedule with ${count} booked tickets:`);
      console.log(`ID: ${scheduleId}`);
      
      // Get the actual seat numbers
      const seatsQuery = `
        SELECT seat_number, status
        FROM tickets
        WHERE schedule_id = $1
        AND status IN ('CONFIRMED', 'CHECKED_IN')
        ORDER BY CAST(seat_number AS INTEGER)
      `;
      
      const seats = await pool.query(seatsQuery, [scheduleId]);
      console.log(`\nBooked seats:`);
      seats.rows.forEach(row => {
        console.log(`  Seat ${row.seat_number}: ${row.status}`);
      });
      
      console.log(`\n✅ Test with: https://backend-v2-wjcs.onrender.com/api/$1/api/seats/schedules/${scheduleId}/booked-seats`);
    } else {
      console.log('\n❌ No schedules with booked tickets found');
    }
    
    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

findBookedSchedule();
