// seeders/02-companies.js
const Company = require('../models/Company');
const User = require('../models/User');
const { Op } = require('sequelize');

const seedCompanies = async () => {
  try {
    // Check if companies already exist
    const existingCompanies = await Company.findAll();
    if (existingCompanies.length > 0) {
      console.log('Companies already seeded. Skipping...');
      return;
    }

    const admin = await User.findOne({ where: { email: 'admin@kigalibus.rw' } });
    const peter = await User.findOne({ where: { email: 'peter@kigalibus.rw' } });
    const emmanuel = await User.findOne({ where: { email: 'emmanuel@volcano.rw' } });
    const jean = await User.findOne({ where: { email: 'jean@gorilla.rw' } });

    if (!admin || !peter || !emmanuel || !jean) {
      console.log('Required users not found. Please run users seeder first.');
      return;
    }

    const companies = await Company.bulkCreate([
      {
        owner_id: peter.id,
        name: 'Kigali Bus Express Ltd',
        email: 'info@kigalibus.rw',
        phone: '+250788123456',
        address: 'KG 541 St, Kigali Heights, Kigali',
        country: 'Rwanda',
        status: 'approved',
        approved_by: admin.id,
        approval_date: new Date(),
        subscription_status: 'active',
        subscription_start_date: new Date('2024-01-01'),
        subscription_expires_at: new Date('2025-01-01'),
        plan: 'Enterprise'
      },
      {
        owner_id: emmanuel.id,
        name: 'Volcano Rides Rwanda',
        email: 'contact@volcanorides.rw',
        phone: '+250788654321',
        address: 'KN 82 St, Remera, Kigali',
        country: 'Rwanda',
        status: 'approved',
        approved_by: admin.id,
        approval_date: new Date(),
        subscription_status: 'active',
        subscription_start_date: new Date('2024-02-15'),
        subscription_expires_at: new Date('2025-02-15'),
        plan: 'Growth'
      },
      {
        owner_id: jean.id,
        name: 'Gorilla Express Shuttle',
        email: 'hello@gorillaexpress.rw',
        phone: '+250788987654',
        address: 'Musanze District, Northern Province',
        country: 'Rwanda',
        status: 'pending',
        subscription_status: 'inactive',
        plan: 'Starter'
      }
    ]);

    // Update only users that exist and have correct roles
    const kigaliEmails = ['peter@kigalibus.rw', 'driver1@kigalibus.rw', 'driver2@kigalibus.rw', 'driver4@kigalibus.rw'];
    const volcanoEmails = ['emmanuel@volcano.rw', 'driver3@volcano.rw'];

    // Check which users exist before updating
    const kigaliUsers = await User.findAll({
      where: {
        email: { [Op.in]: kigaliEmails },
        role: { [Op.in]: ['company_admin', 'driver'] }
      }
    });

    const volcanoUsers = await User.findAll({
      where: {
        email: { [Op.in]: volcanoEmails },
        role: { [Op.in]: ['company_admin', 'driver'] }
      }
    });

    if (kigaliUsers.length > 0) {
      await User.update(
        { company_id: companies[0].id },
        { where: { id: { [Op.in]: kigaliUsers.map(u => u.id) } } }
      );
      console.log(`Updated ${kigaliUsers.length} users for Kigali Bus Express`);
    }

    if (volcanoUsers.length > 0) {
      await User.update(
        { company_id: companies[1].id },
        { where: { id: { [Op.in]: volcanoUsers.map(u => u.id) } } }
      );
      console.log(`Updated ${volcanoUsers.length} users for Volcano Rides`);
    }

    console.log('3 Companies seeded successfully');
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      console.log('Companies already exist in database. Skipping...');
    } else {
      console.error('Error seeding companies:', error.message);
    }
  }
};

seedCompanies();