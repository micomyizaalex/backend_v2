// seeders/03-drivers.js
const Driver = require('../models/Driver');
const User = require('../models/User');
const Company = require('../models/Company');

const seedDrivers = async () => {
  const driver1 = await User.findOne({ where: { email: 'driver1@kigalibus.rw' } });
  const driver2 = await User.findOne({ where: { email: 'driver2@kigalibus.rw' } });
  const driver3 = await User.findOne({ where: { email: 'driver3@volcano.rw' } });
  
  const kigaliBus = await Company.findOne({ where: { name: 'Kigali Bus Express Ltd' } });
  const volcanoRides = await Company.findOne({ where: { name: 'Volcano Rides Rwanda' } });

  await Driver.bulkCreate([
    {
      company_id: kigaliBus.id,
      user_id: driver1.id,
      name: 'Eric Nshimiyimana',
      license_number: 'DLRW001234',
      phone: '+250788999000',
      email: 'driver1@kigalibus.rw',
      is_active: true,
      license_expiry: new Date('2026-12-31'),
      notes: 'Experienced long distance driver'
    },
    {
      company_id: kigaliBus.id,
      user_id: driver2.id,
      name: 'Olivier Hategekimana',
      license_number: 'DLRW001235',
      phone: '+250788111333',
      email: 'driver2@kigalibus.rw',
      is_active: true,
      license_expiry: new Date('2025-10-15'),
      notes: null
    },
    {
      company_id: volcanoRides.id,
      user_id: driver3.id,
      name: 'Claude Niyonshuti',
      license_number: 'DLRW001236',
      phone: '+250788222444',
      email: 'driver3@volcano.rw',
      is_active: true,
      license_expiry: new Date('2026-05-20'),
      notes: 'Tourist route specialist'
    },
    {
      company_id: kigaliBus.id,
      user_id: null,
      name: 'Jean Paul Uwimana',
      license_number: 'DLRW001237',
      phone: '+250788333555',
      email: 'jeanpaul@example.com',
      is_active: true,
      license_expiry: new Date('2025-08-30'),
      notes: 'New driver, pending user account'
    },
    {
      company_id: volcanoRides.id,
      user_id: null,
      name: 'Theogene Niyomugabo',
      license_number: 'DLRW001238',
      phone: '+250788444666',
      email: 'theogene@example.com',
      is_active: false,
      license_expiry: new Date('2024-12-01'),
      notes: 'License renewal pending'
    }
  ]);
  console.log('5 Drivers seeded');
};

seedDrivers();