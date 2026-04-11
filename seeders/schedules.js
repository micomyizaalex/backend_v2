// seeders/06-schedules.js
const Schedule = require('../models/Schedule');
const Bus = require('../models/Bus');
const Route = require('../models/Route');
const User = require('../models/User');

const seedSchedules = async () => {
  const bus1 = await Bus.findOne({ where: { plate_number: 'RAB001A' } });
  const bus2 = await Bus.findOne({ where: { plate_number: 'RAB002B' } });
  const bus5 = await Bus.findOne({ where: { plate_number: 'RAB005E' } });
  
  const route1 = await Route.findOne({ where: { name: 'Kigali - Musanze' } });
  const route2 = await Route.findOne({ where: { name: 'Kigali - Rubavu' } });
  const route3 = await Route.findOne({ where: { name: 'Kigali - Volcanoes Park' } });
  
  const peter = await User.findOne({ where: { email: 'peter@kigalibus.rw' } });
  const emmanuel = await User.findOne({ where: { email: 'emmanuel@volcano.rw' } });

  // Get today's date and add days
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextWeek = new Date(today);
  nextWeek.setDate(nextWeek.getDate() + 7);

  await Schedule.bulkCreate([
    {
      bus_id: bus1.id,
      route_id: route1.id,
      company_id: bus1.company_id,
      schedule_date: today,
      departure_time: '06:00:00',
      arrival_time: '09:00:00',
      price_per_seat: 5000,
      total_seats: 30,
      available_seats: 30,
      booked_seats: 0,
      status: 'scheduled',
      ticket_status: 'OPEN',
      created_by: peter.id
    },
    {
      bus_id: bus1.id,
      route_id: route1.id,
      company_id: bus1.company_id,
      schedule_date: today,
      departure_time: '14:00:00',
      arrival_time: '17:00:00',
      price_per_seat: 5000,
      total_seats: 30,
      available_seats: 28,
      booked_seats: 2,
      status: 'scheduled',
      ticket_status: 'OPEN',
      created_by: peter.id
    },
    {
      bus_id: bus2.id,
      route_id: route2.id,
      company_id: bus2.company_id,
      schedule_date: tomorrow,
      departure_time: '07:00:00',
      arrival_time: '11:00:00',
      price_per_seat: 7000,
      total_seats: 50,
      available_seats: 50,
      booked_seats: 0,
      status: 'scheduled',
      ticket_status: 'OPEN',
      created_by: peter.id
    },
    {
      bus_id: bus5.id,
      route_id: route3.id,
      company_id: bus5.company_id,
      schedule_date: nextWeek,
      departure_time: '08:00:00',
      arrival_time: '10:30:00',
      price_per_seat: 8000,
      total_seats: 25,
      available_seats: 22,
      booked_seats: 3,
      status: 'scheduled',
      ticket_status: 'OPEN',
      created_by: emmanuel.id
    },
    {
      bus_id: bus1.id,
      route_id: route1.id,
      company_id: bus1.company_id,
      schedule_date: nextWeek,
      departure_time: '06:00:00',
      arrival_time: '09:00:00',
      price_per_seat: 5000,
      total_seats: 30,
      available_seats: 30,
      booked_seats: 0,
      status: 'scheduled',
      ticket_status: 'OPEN',
      created_by: peter.id
    }
  ]);
  console.log('5 Schedules seeded');
};

seedSchedules();