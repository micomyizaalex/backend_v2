// seeders/04-buses.js
const Bus = require('../models/Bus');
const Company = require('../models/Company');
const Driver = require('../models/Driver');

const seedBuses = async () => {
  const kigaliBus = await Company.findOne({ where: { name: 'Kigali Bus Express Ltd' } });
  const volcanoRides = await Company.findOne({ where: { name: 'Volcano Rides Rwanda' } });
  
  const driver1 = await Driver.findOne({ where: { license_number: 'DLRW001234' } });
  const driver2 = await Driver.findOne({ where: { license_number: 'DLRW001235' } });
  const driver3 = await Driver.findOne({ where: { license_number: 'DLRW001236' } });

  await Bus.bulkCreate([
    {
      company_id: kigaliBus.id,
      driver_id: driver1.user_id,
      plate_number: 'RAB001A',
      model: 'Toyota Coaster',
      seat_layout: '30',
      capacity: 30,
      status: 'ACTIVE'
    },
    {
      company_id: kigaliBus.id,
      driver_id: driver2.user_id,
      plate_number: 'RAB002B',
      model: 'Isuzu Journey',
      seat_layout: '50',
      capacity: 50,
      status: 'ACTIVE'
    },
    {
      company_id: kigaliBus.id,
      driver_id: null,
      plate_number: 'RAB003C',
      model: 'Toyota Coaster',
      seat_layout: '30',
      capacity: 30,
      status: 'ACTIVE'
    },
    {
      company_id: kigaliBus.id,
      driver_id: null,
      plate_number: 'RAB004D',
      model: 'Higer Bus',
      seat_layout: '50',
      capacity: 50,
      status: 'INACTIVE'
    },
    {
      company_id: volcanoRides.id,
      driver_id: driver3.user_id,
      plate_number: 'RAB005E',
      model: 'Toyota Hiace',
      seat_layout: '25',
      capacity: 25,
      status: 'ACTIVE'
    },
    {
      company_id: volcanoRides.id,
      driver_id: null,
      plate_number: 'RAB006F',
      model: 'Toyota Hiace',
      seat_layout: '25',
      capacity: 25,
      status: 'ACTIVE'
    },
    {
      company_id: kigaliBus.id,
      driver_id: null,
      plate_number: 'RAB007G',
      model: 'Golden Dragon',
      seat_layout: '30',
      capacity: 30,
      status: 'ACTIVE'
    },
    {
      company_id: volcanoRides.id,
      driver_id: null,
      plate_number: 'RAB008H',
      model: 'Toyota Coaster',
      seat_layout: '30',
      capacity: 30,
      status: 'INACTIVE'
    }
  ]);
  console.log('8 Buses seeded');
};

seedBuses();