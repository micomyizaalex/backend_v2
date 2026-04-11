// seeders/04-buses.js
const Bus = require('../models/Bus');
const Company = require('../models/Company');
const { Op } = require('sequelize');

const seedBuses = async () => {
  try {
    // Check if buses already exist
    const existingBuses = await Bus.findAll();
    if (existingBuses.length > 0) {
      console.log('Buses already seeded. Skipping...');
      return;
    }

    // Find companies
    const kigaliBus = await Company.findOne({ where: { name: 'Kigali Bus Express Ltd' } });
    const volcanoRides = await Company.findOne({ where: { name: 'Volcano Rides Rwanda' } });

    if (!kigaliBus || !volcanoRides) {
      console.log('Required companies not found. Please run companies seeder first.');
      return;
    }

    // Check if any buses with these plate numbers already exist
    const plateNumbers = ['RAB001A', 'RAB002B', 'RAB003C', 'RAB004D', 'RAB005E', 'RAB006F', 'RAB007G', 'RAB008H'];
    const existingPlates = await Bus.findAll({
      where: { plate_number: { [Op.in]: plateNumbers } }
    });

    if (existingPlates.length > 0) {
      console.log(`Some buses already exist (${existingPlates.map(b => b.plate_number).join(', ')}). Skipping...`);
      return;
    }

    await Bus.bulkCreate([
      {
        company_id: kigaliBus.id,
        plate_number: 'RAB001A',
        model: 'Toyota Coaster',
        seat_layout: '30',
        capacity: 30,
        status: 'ACTIVE'
      },
      {
        company_id: kigaliBus.id,
        plate_number: 'RAB002B',
        model: 'Isuzu Journey',
        seat_layout: '50',
        capacity: 50,
        status: 'ACTIVE'
      },
      {
        company_id: kigaliBus.id,
        plate_number: 'RAB003C',
        model: 'Toyota Coaster',
        seat_layout: '30',
        capacity: 30,
        status: 'ACTIVE'
      },
      {
        company_id: kigaliBus.id,
        plate_number: 'RAB004D',
        model: 'Higer Bus',
        seat_layout: '50',
        capacity: 50,
        status: 'INACTIVE'
      },
      {
        company_id: volcanoRides.id,
        plate_number: 'RAB005E',
        model: 'Toyota Hiace',
        seat_layout: '25',
        capacity: 25,
        status: 'ACTIVE'
      },
      {
        company_id: volcanoRides.id,
        plate_number: 'RAB006F',
        model: 'Toyota Hiace',
        seat_layout: '25',
        capacity: 25,
        status: 'ACTIVE'
      },
      {
        company_id: kigaliBus.id,
        plate_number: 'RAB007G',
        model: 'Golden Dragon',
        seat_layout: '30',
        capacity: 30,
        status: 'ACTIVE'
      },
      {
        company_id: volcanoRides.id,
        plate_number: 'RAB008H',
        model: 'Toyota Coaster',
        seat_layout: '30',
        capacity: 30,
        status: 'INACTIVE'
      }
    ]);
    
    console.log('8 Buses seeded successfully');
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      console.log('Some buses already exist in database. Skipping...');
    } else {
      console.error('Error seeding buses:', error.message);
    }
  }
};

seedBuses();