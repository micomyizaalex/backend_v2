
// 05-driver-assignments.js
const DriverAssignment = require('../models/DriverAssignment');
const User = require('../models/User');
const Bus = require('../models/Bus');
const Company = require('../models/Company');

const seedDriverAssignments = async () => {
  const peter = await User.findOne({ where: { email: 'peter@kigalibus.rw' } });
  const driver1 = await User.findOne({ where: { email: 'driver1@kigalibus.rw' } });
  const driver2 = await User.findOne({ where: { email: 'driver2@kigalibus.rw' } });
  const driver3 = await User.findOne({ where: { email: 'driver3@volcano.rw' } });
  
  const bus1 = await Bus.findOne({ where: { plate_number: 'RAB001A' } });
  const bus2 = await Bus.findOne({ where: { plate_number: 'RAB002B' } });
  const bus5 = await Bus.findOne({ where: { plate_number: 'RAB005E' } });
  
  const kigaliBus = await Company.findOne({ where: { name: 'Kigali Bus Express Ltd' } });
  const volcanoRides = await Company.findOne({ where: { name: 'Volcano Rides Rwanda' } });

  await DriverAssignment.bulkCreate([
    {
      bus_id: bus1.id,
      driver_id: driver1.id,
      company_id: kigaliBus.id,
      assigned_by: peter.id,
      assigned_at: new Date()
    },
    {
      bus_id: bus2.id,
      driver_id: driver2.id,
      company_id: kigaliBus.id,
      assigned_by: peter.id,
      assigned_at: new Date()
    },
    {
      bus_id: bus5.id,
      driver_id: driver3.id,
      company_id: volcanoRides.id,
      assigned_by: (await User.findOne({ where: { email: 'emmanuel@volcano.rw' } })).id,
      assigned_at: new Date()
    }
  ]);
  console.log('Driver assignments seeded');
};

seedDriverAssignments();
