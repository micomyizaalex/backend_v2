// seeders/04-routes.js
const Route = require('../models/Route');
const Company = require('../models/Company');

const seedRoutes = async () => {
  const kigaliBus = await Company.findOne({ where: { name: 'Kigali Bus Express Ltd' } });
  const volcanoRides = await Company.findOne({ where: { name: 'Volcano Rides Rwanda' } });

  await Route.bulkCreate([
    {
      company_id: kigaliBus.id,
      name: 'Kigali - Musanze',
      origin: 'Kigali',
      destination: 'Musanze',
      distance_km: 120,
      estimated_duration_minutes: 180
    },
    {
      company_id: kigaliBus.id,
      name: 'Kigali - Rubavu',
      origin: 'Kigali',
      destination: 'Rubavu',
      distance_km: 160,
      estimated_duration_minutes: 240
    },
    {
      company_id: kigaliBus.id,
      name: 'Kigali - Rusizi',
      origin: 'Kigali',
      destination: 'Rusizi',
      distance_km: 280,
      estimated_duration_minutes: 360
    },
    {
      company_id: kigaliBus.id,
      name: 'Kigali - Nyagatare',
      origin: 'Kigali',
      destination: 'Nyagatare',
      distance_km: 180,
      estimated_duration_minutes: 270
    },
    {
      company_id: volcanoRides.id,
      name: 'Kigali - Volcanoes Park',
      origin: 'Kigali',
      destination: 'Volcanoes National Park',
      distance_km: 110,
      estimated_duration_minutes: 150
    },
    {
      company_id: volcanoRides.id,
      name: 'Musanze - Rubavu',
      origin: 'Musanze',
      destination: 'Rubavu',
      distance_km: 70,
      estimated_duration_minutes: 90
    }
  ]);
  console.log('6 Routes seeded');
};

seedRoutes();