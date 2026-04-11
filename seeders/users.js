// seeders/01-users.js
const User = require('../models/User');

const seedUsers = async () => {
  await User.bulkCreate([
    {
      email: 'admin@kigalibus.rw',
      password: 'Admin123!',  // Plain password - hook will hash it
      full_name: 'Jean Paul Habimana',
      phone_number: '+250788111222',
      role: 'admin',
      account_status: 'approved',
      email_verified: true
    },
    {
      email: 'peter@kigalibus.rw',
      password: 'Company123!',  // Plain password - hook will hash it
      full_name: 'Peter Ndayishimiye',
      phone_number: '+250788333444',
      role: 'company_admin',
      account_status: 'approved',
      email_verified: true
    },
    {
      email: 'emmanuel@volcano.rw',
      password: 'Company123!',
      full_name: 'Emmanuel Uwimana',
      phone_number: '+250788555666',
      role: 'company_admin',
      account_status: 'approved',
      email_verified: true
    },
    {
      email: 'jean@gorilla.rw',
      password: 'Company123!',
      full_name: 'Jean Mugabo',
      phone_number: '+250788777888',
      role: 'company_admin',
      account_status: 'pending',
      email_verified: true
    },
    {
      email: 'driver1@kigalibus.rw',
      password: 'Driver123!',
      full_name: 'Eric Nshimiyimana',
      phone_number: '+250788999000',
      role: 'driver',
      license_number: 'DLRW001234',
      license_expiry: new Date('2026-12-31'),
      driver_notes: 'Experienced long distance driver',
      account_status: 'approved',
      email_verified: true
    },
    {
      email: 'driver2@kigalibus.rw',
      password: 'Driver123!',
      full_name: 'Olivier Hategekimana',
      phone_number: '+250788111333',
      role: 'driver',
      license_number: 'DLRW001235',
      license_expiry: new Date('2025-10-15'),
      driver_notes: null,
      account_status: 'approved',
      email_verified: true
    },
    {
      email: 'driver3@volcano.rw',
      password: 'Driver123!',
      full_name: 'Claude Niyonshuti',
      phone_number: '+250788222444',
      role: 'driver',
      license_number: 'DLRW001236',
      license_expiry: new Date('2026-05-20'),
      driver_notes: 'Tourist route specialist',
      account_status: 'approved',
      email_verified: true
    },
    {
      email: 'driver4@kigalibus.rw',
      password: 'Driver123!',
      full_name: 'Jean Paul Uwimana',
      phone_number: '+250788333555',
      role: 'driver',
      license_number: 'DLRW001237',
      license_expiry: new Date('2025-08-30'),
      driver_notes: 'New driver',
      account_status: 'pending',
      email_verified: false
    },
    {
      email: 'alice@example.com',
      password: 'Commuter123!',
      full_name: 'Alice Mukamana',
      phone_number: '+250788555777',
      role: 'commuter',
      account_status: 'approved',
      email_verified: true
    },
    {
      email: 'john@example.com',
      password: 'Commuter123!',
      full_name: 'John Niyomugabo',
      phone_number: '+250788666888',
      role: 'commuter',
      account_status: 'approved',
      email_verified: true
    },
    {
      email: 'grace@example.com',
      password: 'Commuter123!',
      full_name: 'Grace Umutesi',
      phone_number: '+250788777999',
      role: 'commuter',
      account_status: 'approved',
      email_verified: true
    }
  ]);
  console.log('11 Users seeded ');
};

seedUsers();