// seeders/07-tickets.js
const Ticket = require('../models/Ticket');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const { v4: uuidv4 } = require('uuid');

const seedTickets = async () => {
  const schedule2 = await Schedule.findOne({ where: { departure_time: '14:00:00' } });
  const schedule4 = await Schedule.findOne({ where: { departure_time: '08:00:00' } });
  
  const alice = await User.findOne({ where: { email: 'alice@example.com' } });
  const john = await User.findOne({ where: { email: 'john@example.com' } });
  const grace = await User.findOne({ where: { email: 'grace@example.com' } });

  // Get route info for the schedules
  const schedule2WithRoute = await Schedule.findOne({
    where: { departure_time: '14:00:00' },
    include: ['route']
  });
  
  const schedule4WithRoute = await Schedule.findOne({
    where: { departure_time: '08:00:00' },
    include: ['route']
  });

  await Ticket.bulkCreate([
    {
      passenger_id: alice.id,
      schedule_id: schedule2.id,
      company_id: schedule2.company_id,
      payment_id: null,
      seat_number: 'A1',
      route_id: schedule2WithRoute.route.id,
      trip_date: schedule2.schedule_date,
      from_stop: schedule2WithRoute.route.origin,
      to_stop: schedule2WithRoute.route.destination,
      booking_ref: `TKT-${Date.now()}-001`,
      price: schedule2.price_per_seat,
      status: 'CONFIRMED',
      booked_at: new Date()
    },
    {
      passenger_id: john.id,
      schedule_id: schedule2.id,
      company_id: schedule2.company_id,
      payment_id: null,
      seat_number: 'A2',
      route_id: schedule2WithRoute.route.id,
      trip_date: schedule2.schedule_date,
      from_stop: schedule2WithRoute.route.origin,
      to_stop: schedule2WithRoute.route.destination,
      booking_ref: `TKT-${Date.now()}-002`,
      price: schedule2.price_per_seat,
      status: 'CONFIRMED',
      booked_at: new Date()
    },
    {
      passenger_id: grace.id,
      schedule_id: schedule4.id,
      company_id: schedule4.company_id,
      payment_id: null,
      seat_number: 'B1',
      route_id: schedule4WithRoute.route.id,
      trip_date: schedule4.schedule_date,
      from_stop: schedule4WithRoute.route.origin,
      to_stop: schedule4WithRoute.route.destination,
      booking_ref: `TKT-${Date.now()}-003`,
      price: schedule4.price_per_seat,
      status: 'PENDING_PAYMENT',
      booked_at: new Date()
    }
  ]);
  console.log('3 Tickets seeded');
};

seedTickets();